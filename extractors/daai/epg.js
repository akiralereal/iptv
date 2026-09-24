/**
 * 大爱电视官方节目单。
 *
 * 官网移动版直播页 (m.daai.tv/v3/live) 的频道配置里，每台带一个 playlist 模板
 * daai.tv/api/live/json/v1.1/<ch1|ch3>/{date}，就是官网的逐日节目表接口，不用登录、不带签名。
 * 实测（2026-09-25）：
 * - date 为 YYYY-MM-DD（台湾日期，与上海同为 UTC+8）；返回 JSON 数组（Content-Type 写的是 text/html）。
 * - 每条只有开始时间 time（台湾时间 'YYYY-MM-DD HH:MM:SS'），没有时长，结束取下一条的开始；
 *   每天从零点前后排到 23:50 前后，当天最后一条到次日零点。
 * - 同一集被广告切成几段时，官方会连着列几条同名、同节目编号（daai_id）的条目，这里并成一条。
 * - 今天起能取五天左右，再往后、以及日期格式不对都回空数组 []。
 * - 站点在 Cloudflare 后面，curl 这类 User-Agent 直接 403，所以带浏览器 UA。
 *
 * 和取流链路没有任何共享状态：只用频道表 channels.js 和调用方注入的 fetch，
 * 不 import 项目里的其它模块——整份连同 channels.js 拿出去就能单独产出节目单。
 */
import { CHANNELS } from './channels.js'

export const EPG_API = 'https://daai.tv/api/live/json/v1.1/'
// 一天七十来条、约 75KB（带节目简介）；留足余量，超出按异常处理
const MAX_BYTES = 1024 * 1024
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const SCHEDULE_KEYS = new Set(CHANNELS.map(channel => channel.schedule))

/** 上海日期 YYYYMMDD → { 接口用的 YYYY-MM-DD, 当天零点, 次日零点 }；与运行机器的时区无关。 */
export function dayInfo(day) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(day ?? ''))
  if (!match) throw new Error('大爱电视节目单参数非法')
  const [year, month, date] = match.slice(1).map(Number)
  const start = Date.UTC(year, month - 1, date) - SHANGHAI_OFFSET_MS
  const check = new Date(start + SHANGHAI_OFFSET_MS)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) {
    throw new Error('大爱电视节目单参数非法')
  }
  return { date: `${match[1]}-${match[2]}-${match[3]}`, start, end: start + DAY_MS }
}

/** 'YYYY-MM-DD HH:mm:ss'（台湾时间，UTC+8）→ 毫秒时间戳；显式按 +08:00 算，与运行机器的时区无关。 */
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
 * 接口 JSON → 该上海日内开始的节目 [{ title, start, stop }]，按开始时间升序。
 * 结束取下一条的开始，当天最后一条取次日零点；同一集连着的几段并成一条。
 */
export function parseProgrammes(payload, day) {
  const range = dayInfo(day)
  if (!Array.isArray(payload)) throw new Error('大爱电视节目单数据格式异常')

  const items = []
  let readable = 0
  for (const row of payload) {
    const start = parseTaiwanTime(row?.time)
    if (start == null) continue
    readable++
    const title = String(row?.title ?? '').trim()
    if (!title || start < range.start || start >= range.end) continue
    items.push({ title, start, id: String(row?.daai_id ?? '') })
  }
  // 有数据却一条时间都读不出，多半是接口改了格式，报错而不是当成「当天没发」
  if (payload.length && !readable) throw new Error('大爱电视节目单数据格式异常')

  items.sort((a, b) => a.start - b.start)
  const merged = []
  for (const item of items) {
    const last = merged[merged.length - 1]
    if (last && last.start === item.start) continue
    // 广告切开的同一集：同名且同一节目编号
    if (last && last.title === item.title && item.id && last.id === item.id) continue
    merged.push(item)
  }
  return merged.map((item, index) => ({
    title: item.title,
    start: item.start,
    stop: merged[index + 1]?.start ?? range.end,
  }))
}

/** 读响应体，超过上限就中止，不把整份读进内存再判断。 */
async function readCapped(response) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (declared > MAX_BYTES) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error('大爱电视节目单响应过大')
  }
  if (!response.body?.getReader) {
    const buf = Buffer.from(await response.arrayBuffer())
    if (buf.length > MAX_BYTES) throw new Error('大爱电视节目单响应过大')
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
      throw new Error('大爱电视节目单响应过大')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export default {
  id: 'daai',
  // 今天 + 明天：全量更新默认 8 小时一轮，多备一天，跨零点前后播放器仍有节目可显示
  days: 2,

  /** 本模块哪些频道出节目单：频道 ref、显示名 → 官网节目表的频道段。 */
  channels() {
    return CHANNELS.map(channel => ({ ref: channel.ref, name: channel.name, key: channel.schedule }))
  },

  /** 取一个频道某一天（上海日期 YYYYMMDD）的节目，按开始时间升序；官方当天没发返回空数组。 */
  async programmes(key, day, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
    if (!SCHEDULE_KEYS.has(key)) throw new Error('大爱电视节目单参数非法')
    const { date } = dayInfo(day)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(`${EPG_API}${key}/${date}`, {
        headers: {
          'User-Agent': UA,
          Accept: 'application/json, text/plain, */*',
          Referer: 'https://m.daai.tv/v3/live',
        },
        // 接口不跳转；真跳了多半是拦截页，按失败处理
        redirect: 'manual',
        signal: controller.signal,
      })
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {})
        throw new Error(`大爱电视节目单 HTTP ${response.status}`)
      }
      let payload
      try {
        payload = JSON.parse(await readCapped(response))
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error('大爱电视节目单不是 JSON')
        throw error
      }
      return parseProgrammes(payload, day)
    } finally {
      clearTimeout(timer)
    }
  },
}
