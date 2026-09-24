/**
 * GOOD TV 官方节目单。
 *
 * 官网直播页（www.goodtv.tv/tv-channel?ch=1|2）的节目表取自 GET api.goodtv.tv/Channel/Live/GOODTV<ch>，
 * 不用登录、不带签名（登录后官网才加 Bearer，节目表不需要）。实测（2026-09-25）：
 * - 一次给出从昨天起约五周的整张表（每台一千七百多条、约 300KB），不能按日期取，
 *   所以同一轮里各天共用一次下载（见 fetchSchedule 的短时缓存）。
 * - 每条带开始、结束（台湾时间 'YYYY-MM-DDTHH:MM:SS'，不带时区，官网自己补 +08:00），
 *   前后首尾相接，没有重叠也没有空档；往后几周的也是逐集排好的真实节目，不是模板。
 * - 标题取节目名 programName；单集名 episodeName 约一成是空的，不拼进标题。
 * - 不认识的频道名回空数组。
 * - www.goodtv.tv 页面在 AWS WAF 后面（脚本请求会被质询），api.goodtv.tv 没有，直接可取。
 *
 * 和取流链路没有任何共享状态：只用频道表 channels.js 和调用方注入的 fetch，
 * 不 import 项目里的其它模块——整份连同 channels.js 拿出去就能单独产出节目单。
 */
import { CHANNELS } from './channels.js'

export const EPG_API = 'https://api.goodtv.tv/Channel/Live/'
// 五周约 300KB；留足余量，超出按异常处理
const MAX_BYTES = 4 * 1024 * 1024
// 一轮节目单更新里今天、明天两次调用共用一次下载；下一轮（默认 8 小时后）早已过期
export const SCHEDULE_TTL_MS = 10 * 60 * 1000
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const SCHEDULE_KEYS = new Set(CHANNELS.map(channel => channel.schedule))

/** 上海日期 YYYYMMDD → 当天零点与次日零点的毫秒时间戳；与运行机器的时区无关。 */
export function shanghaiDayRange(day) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(day ?? ''))
  if (!match) throw new Error('GOOD TV 节目单参数非法')
  const [year, month, date] = match.slice(1).map(Number)
  const start = Date.UTC(year, month - 1, date) - SHANGHAI_OFFSET_MS
  const check = new Date(start + SHANGHAI_OFFSET_MS)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) {
    throw new Error('GOOD TV 节目单参数非法')
  }
  return { start, end: start + DAY_MS }
}

/** 'YYYY-MM-DDTHH:mm:ss'（台湾时间，UTC+8）→ 毫秒时间戳；显式按 +08:00 算，与运行机器的时区无关。 */
export function parseTaiwanTime(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(text ?? '').trim())
  if (!match) return null
  const [year, month, date, hour, minute, second = 0] = match.slice(1).map(v => Number(v ?? 0))
  if (hour > 23 || minute > 59 || second > 59) return null
  const ms = Date.UTC(year, month - 1, date, hour, minute, second) - SHANGHAI_OFFSET_MS
  const check = new Date(ms + SHANGHAI_OFFSET_MS)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) return null
  return ms
}

/**
 * 整张表 → 该上海日内开始的节目 [{ title, start, stop }]，按开始时间升序。
 * 结束用官方给的；缺失或不晚于开始的取下一条开始（没有下一条就到次日零点），
 * 晚于下一条开始的截到下一条开始；同一开始时间只留一条。
 */
export function parseProgrammes(payload, day) {
  const range = shanghaiDayRange(day)
  if (!Array.isArray(payload)) throw new Error('GOOD TV 节目单数据格式异常')

  const all = []
  for (const row of payload) {
    const start = parseTaiwanTime(row?.start)
    if (start == null) continue
    all.push({ title: String(row?.programName ?? '').trim(), start, end: parseTaiwanTime(row?.end) })
  }
  // 有数据却一条时间都读不出，多半是接口改了格式，报错而不是当成「当天没发」
  if (payload.length && !all.length) throw new Error('GOOD TV 节目单数据格式异常')

  all.sort((a, b) => a.start - b.start)
  const unique = all.filter((item, index) => index === 0 || item.start !== all[index - 1].start)
  const programmes = []
  unique.forEach((item, index) => {
    if (!item.title || item.start < range.start || item.start >= range.end) return
    // 下一条可能已在次日，用整张表里的下一条而不是当天的
    const nextStart = unique[index + 1]?.start
    let stop = item.end != null && item.end > item.start ? item.end : (nextStart ?? range.end)
    if (nextStart != null && stop > nextStart) stop = nextStart
    programmes.push({ title: item.title, start: item.start, stop })
  })
  return programmes
}

/** 读响应体，超过上限就中止，不把整份读进内存再判断。 */
async function readCapped(response) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (declared > MAX_BYTES) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error('GOOD TV 节目单响应过大')
  }
  if (!response.body?.getReader) {
    const buf = Buffer.from(await response.arrayBuffer())
    if (buf.length > MAX_BYTES) throw new Error('GOOD TV 节目单响应过大')
    return buf.toString('utf8')
  }
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => {})
      throw new Error('GOOD TV 节目单响应过大')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function requestSchedule(key, fetchImpl, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${EPG_API}${key}`, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        Referer: 'https://www.goodtv.tv/',
        Origin: 'https://www.goodtv.tv',
      },
      // 接口不跳转；真跳了多半是拦截页，按失败处理
      redirect: 'manual',
      signal: controller.signal,
    })
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {})
      throw new Error(`GOOD TV 节目单 HTTP ${response.status}`)
    }
    try {
      return JSON.parse(await readCapped(response))
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error('GOOD TV 节目单不是 JSON')
      throw error
    }
  } finally {
    clearTimeout(timer)
  }
}

// 频道名 → { fetchImpl, expiresAt, promise }：只为同一轮里各天共用一次下载，失败不留
const scheduleCache = new Map()

/** 取一台的整张表；同一 fetch 在有效期内共用同一次请求（含进行中的）。 */
export function fetchSchedule(key, { fetchImpl = fetch, timeoutMs = 10000, now = Date.now() } = {}) {
  const cached = scheduleCache.get(key)
  if (cached && cached.fetchImpl === fetchImpl && cached.expiresAt > now) return cached.promise
  const promise = requestSchedule(key, fetchImpl, timeoutMs)
  const entry = { fetchImpl, expiresAt: now + SCHEDULE_TTL_MS, promise }
  scheduleCache.set(key, entry)
  promise.catch(() => {
    if (scheduleCache.get(key) === entry) scheduleCache.delete(key)
  })
  return promise
}

export default {
  id: 'goodtv',
  // 今天 + 明天：全量更新默认 8 小时一轮，多备一天，跨零点前后播放器仍有节目可显示
  days: 2,

  /** 本模块哪些频道出节目单：频道 ref、显示名 → 官网节目表的频道名。 */
  channels() {
    return CHANNELS.map(channel => ({ ref: channel.ref, name: channel.name, key: channel.schedule }))
  },

  /** 取一个频道某一天（上海日期 YYYYMMDD）的节目，按开始时间升序；官方当天没排返回空数组。 */
  async programmes(key, day, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
    if (!SCHEDULE_KEYS.has(key)) throw new Error('GOOD TV 节目单参数非法')
    shanghaiDayRange(day)
    return parseProgrammes(await fetchSchedule(key, { fetchImpl, timeoutMs }), day)
  },
}
