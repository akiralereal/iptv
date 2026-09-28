/**
 * 广西网络台官方节目单。
 *
 * 官网播放页的节目单取自 POST api2019.gxtv.cn/memberApi/programList/selectListByChannelId，
 * 表单 channelId / channelName / dateStr，不用登录、不带签名。实测（2026-09-25）：
 * - 后端只按 channelName（官网频道接口里的 name）查，channelId 被忽略：乱填 uuid 照样出，
 *   真 uuid 配别台名字出的是别台。仍照播放页原样带上 uuid，请求与官网一致。
 * - dateStr 播放页写成不补零的 YYYY-M-D；补零也认，YYYYMMDD 与缺省回 code 1000。
 *   往前往后都能取，今天起一周以上都有。
 * - 每条只有开始时间 programTime（上海时间文本）与时长 programmeLength（秒）。时长按
 *   节目本身算，节目间的广告/宣传片不计，所以相邻节目之间常有十几二十分钟空档，照实保留。
 *   时长为 0 的（综艺旅游频道一天约五条）要自己补结束时间；当天最后一条可能跨过零点。
 * - 没节目单的频道（移动数字电视频道）与不认识的频道名都回 code 0，data 为空数组或 null。
 *
 * 和取流链路没有任何共享状态：只用频道表 channels.js 和调用方注入的 fetch，
 * 不 import 项目里的其它模块——整份连同 channels.js 拿出去就能单独产出节目单。
 */
import { CHANNELS } from './channels.js'

export const EPG_API = 'https://api2019.gxtv.cn/memberApi/programList/selectListByChannelId'
// 一天三十来条、约 6KB；留足余量，超出按异常处理
const MAX_BYTES = 256 * 1024
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
// 超过一天的时长当作脏数据，与 0 时长同样处理
const MAX_LENGTH_SECONDS = 24 * 60 * 60
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const CHANNEL_ID_BY_NAME = new Map(CHANNELS.map(channel => [channel.rawName, channel.id]))

/** YYYYMMDD → 播放页同款 YYYY-M-D（月、日不补零）。 */
export function dateStrOf(day) {
  const text = String(day)
  if (!/^\d{8}$/.test(text)) throw new Error('广西节目单参数非法')
  return `${text.slice(0, 4)}-${Number(text.slice(4, 6))}-${Number(text.slice(6, 8))}`
}

/** 'YYYY-MM-DD HH:mm:ss'（上海时间）→ 毫秒时间戳；显式按 +08:00 算，与运行机器的时区无关。 */
export function parseShanghaiTime(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(text ?? '').trim())
  if (!match) return null
  const [year, month, date, hour, minute, second = 0] = match.slice(1).map(v => Number(v ?? 0))
  if (hour > 23 || minute > 59 || second > 59) return null
  const ms = Date.UTC(year, month - 1, date, hour, minute, second) - SHANGHAI_OFFSET_MS
  // 拒绝 2026-02-31 这类会被 Date.UTC 顺延的日期
  const check = new Date(ms + SHANGHAI_OFFSET_MS)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) return null
  return ms
}

/** 该时刻之后的第一个上海零点。 */
function nextShanghaiMidnight(ms) {
  return Math.floor((ms + SHANGHAI_OFFSET_MS) / DAY_MS) * DAY_MS + DAY_MS - SHANGHAI_OFFSET_MS
}

/**
 * 接口 JSON → [{ title, start, stop }]，按开始时间升序。
 * 结束 = 开始 + 时长；时长缺失/为 0/为负/超过一天的，结束取下一条的开始，当天最后一条取次日零点。
 * 结束晚于下一条开始的截到下一条开始，不让节目互相重叠；同一开始时间只留一条。
 */
export function parseProgrammes(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('广西节目单数据格式异常')
  if (Number(payload.code) !== 0) {
    throw new Error(`广西节目单接口返回 ${payload.code}：${payload.message || '未知错误'}`)
  }
  if (payload.data == null) return []
  if (!Array.isArray(payload.data)) throw new Error('广西节目单数据格式异常')

  const items = []
  for (const row of payload.data) {
    const start = parseShanghaiTime(row?.programTime)
    const title = String(row?.programName ?? '').trim()
    if (start == null || !title) continue
    const length = Number(row?.programmeLength)
    items.push({ title, start, length: length > 0 && length <= MAX_LENGTH_SECONDS ? length : 0 })
  }
  // 有数据却一条时间都读不出，多半是接口改了格式，报错而不是当成「当天没发」
  if (payload.data.length && !items.length) throw new Error('广西节目单数据格式异常')
  // 同一开始时间只留一条，优先有时长的
  items.sort((a, b) => a.start - b.start || b.length - a.length)
  const unique = items.filter((item, index) => index === 0 || item.start !== items[index - 1].start)

  return unique.map((item, index) => {
    const nextStart = unique[index + 1]?.start
    let stop = item.length ? item.start + item.length * 1000 : (nextStart ?? nextShanghaiMidnight(item.start))
    if (nextStart != null && stop > nextStart) stop = nextStart
    return { title: item.title, start: item.start, stop }
  })
}

/** 读响应体，超过上限就中止，不把整份读进内存再判断。 */
async function readCapped(response) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (declared > MAX_BYTES) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error('广西节目单响应过大')
  }
  if (!response.body?.getReader) {
    const buf = Buffer.from(await response.arrayBuffer())
    if (buf.length > MAX_BYTES) throw new Error('广西节目单响应过大')
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
      throw new Error('广西节目单响应过大')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export default {
  id: 'gxtv',
  // 今天 + 明天：全量更新默认 8 小时一轮，多备一天，跨零点前后播放器仍有节目可显示
  days: 2,

  /** 本模块哪些频道出节目单：频道 ref、显示名 → 节目单接口用的官网频道名。 */
  channels() {
    return CHANNELS
      .filter(channel => channel.epg !== false)
      .map(channel => ({ ref: channel.ref, name: channel.name, key: channel.rawName }))
  },

  /** 取一个频道某一天（上海日期 YYYYMMDD）的节目，按开始时间升序；官方当天没发返回空数组。 */
  async programmes(key, day, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
    const channelName = String(key ?? '')
    if (!channelName || channelName.length > 32 || /[\u0000-\u001f]/.test(channelName)) {
      throw new Error('广西节目单参数非法')
    }
    const form = new URLSearchParams()
    const channelId = CHANNEL_ID_BY_NAME.get(channelName)
    if (channelId) form.set('channelId', channelId)
    form.set('channelName', channelName)
    form.set('dateStr', dateStrOf(day))

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(EPG_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': UA,
          Referer: 'https://tv.gxtv.cn/',
          Accept: 'application/json',
        },
        body: form.toString(),
        // 接口不跳转；真跳了多半是 WAF 拦截页，按失败处理
        redirect: 'manual',
        signal: controller.signal,
      })
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {})
        throw new Error(`广西节目单 HTTP ${response.status}`)
      }
      let payload
      try {
        payload = JSON.parse(await readCapped(response))
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error('广西节目单不是 JSON')
        throw error
      }
      return parseProgrammes(payload)
    } finally {
      clearTimeout(timer)
    }
  },
}
