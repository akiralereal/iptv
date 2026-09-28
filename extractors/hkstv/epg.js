/**
 * 香港卫视官方节目单。
 *
 * 官网直播页（hkstv.tv/live）下方的「節目單」取自 GET hkstv.tv/services/live/epg?date=YYYY-MM-DD，
 * 与取流问入口用的是同一个官网，不用登录、不带签名。实测（2026-09-25）：
 * - 不分频道：出的就是官网当前默认频道（channel_id 12，即取流那一路）的节目。
 * - 每条是当天的 play_time（香港时间 HH:MM:SS，与上海同为 UTC+8）加时长 duration（秒）；
 *   program_date 是当天香港零点的 UTC 时刻，拿来核对后端给的确实是请求的那一天。
 * - 时长按节目本身算，节目间的宣传片不计，相邻节目之间常有几分钟空档，照实保留；
 *   也有时长超过下一条开始的（一天一两条），截到下一条开始。
 * - 往后能取两周左右，再往后回空数组；缺 date 或格式不对回 400 {"error":"缺少有效的日期"}。
 *
 * 和取流链路没有任何共享状态：只用频道表 channels.js 和调用方注入的 fetch，
 * 不 import 项目里的其它模块——整份连同 channels.js 拿出去就能单独产出节目单。
 */
import { CHANNEL } from './channels.js'

export const EPG_API = 'https://hkstv.tv/services/live/epg'
// 官网只有这一路电视直播，节目单接口也不分频道
const EPG_KEY = 'default'
// 一天六十来条、约 16KB；留足余量，超出按异常处理
const MAX_BYTES = 512 * 1024
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
// 超过一天的时长当作脏数据，与 0 时长同样处理
const MAX_LENGTH_SECONDS = 24 * 60 * 60
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** 上海日期 YYYYMMDD → { 接口用的 YYYY-MM-DD, 当天零点, 次日零点 }；与运行机器的时区无关。 */
export function dayInfo(day) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(day ?? ''))
  if (!match) throw new Error('香港卫视节目单参数非法')
  const [year, month, date] = match.slice(1).map(Number)
  const start = Date.UTC(year, month - 1, date) - SHANGHAI_OFFSET_MS
  const check = new Date(start + SHANGHAI_OFFSET_MS)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) {
    throw new Error('香港卫视节目单参数非法')
  }
  return { date: `${match[1]}-${match[2]}-${match[3]}`, start, end: start + DAY_MS }
}

/** 'HH:MM[:SS]' → 当天零点起的秒数；越界返回 null。 */
function secondsOfDay(text) {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(text ?? '').trim())
  if (!match) return null
  const [hour, minute, second = 0] = match.slice(1).map(v => Number(v ?? 0))
  if (hour > 23 || minute > 59 || second > 59) return null
  return hour * 3600 + minute * 60 + second
}

/**
 * 接口 JSON → [{ title, start, stop }]，按开始时间升序。
 * 结束 = 开始 + 时长；时长缺失/为 0/为负/超过一天的，结束取下一条的开始，当天最后一条取次日零点。
 * 结束晚于下一条开始的截到下一条开始，不让节目互相重叠；同一开始时间只留一条。
 */
export function parseProgrammes(payload, day) {
  const info = dayInfo(day)
  if (!payload || typeof payload !== 'object') throw new Error('香港卫视节目单数据格式异常')
  if (payload.error) throw new Error(`香港卫视节目单接口报错：${String(payload.error).slice(0, 80)}`)
  if (!Array.isArray(payload.data)) throw new Error('香港卫视节目单数据格式异常')

  const items = []
  for (const row of payload.data) {
    // 后端会把 2026-02-31 这类日期顺延成别的日子；给的不是请求那天就不能按这天的零点算
    if (row?.program_date != null && Date.parse(row.program_date) !== info.start) {
      throw new Error('香港卫视节目单日期与请求不符')
    }
    const offset = secondsOfDay(row?.play_time)
    const title = String(row?.title ?? '').trim()
    if (offset == null || !title) continue
    const length = Number(row?.duration)
    items.push({
      title,
      start: info.start + offset * 1000,
      length: length > 0 && length <= MAX_LENGTH_SECONDS ? length : 0,
    })
  }
  // 有数据却一条时间都读不出，多半是接口改了格式，报错而不是当成「当天没发」
  if (payload.data.length && !items.length) throw new Error('香港卫视节目单数据格式异常')
  // 同一开始时间只留一条，优先有时长的
  items.sort((a, b) => a.start - b.start || b.length - a.length)
  const unique = items.filter((item, index) => index === 0 || item.start !== items[index - 1].start)

  return unique.map((item, index) => {
    const nextStart = unique[index + 1]?.start
    let stop = item.length ? item.start + item.length * 1000 : (nextStart ?? info.end)
    if (nextStart != null && stop > nextStart) stop = nextStart
    return { title: item.title, start: item.start, stop }
  })
}

/** 读响应体，超过上限就中止，不把整份读进内存再判断。 */
async function readCapped(response) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (declared > MAX_BYTES) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error('香港卫视节目单响应过大')
  }
  if (!response.body?.getReader) {
    const buf = Buffer.from(await response.arrayBuffer())
    if (buf.length > MAX_BYTES) throw new Error('香港卫视节目单响应过大')
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
      throw new Error('香港卫视节目单响应过大')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export default {
  id: 'hkstv',
  // 今天 + 明天：全量更新默认 8 小时一轮，多备一天，跨零点前后播放器仍有节目可显示
  days: 2,

  /** 本模块哪些频道出节目单：官网只有一路，节目单接口也不分频道。 */
  channels() {
    return [{ ref: CHANNEL.ref, name: CHANNEL.name, key: EPG_KEY }]
  },

  /** 取某一天（上海日期 YYYYMMDD）的节目，按开始时间升序；官方当天没发返回空数组。 */
  async programmes(key, day, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
    if (key !== EPG_KEY) throw new Error('香港卫视节目单参数非法')
    const { date } = dayInfo(day)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(`${EPG_API}?date=${date}`, {
        headers: {
          'User-Agent': UA,
          Accept: 'application/json',
          Referer: 'https://hkstv.tv/live',
        },
        // 接口不跳转；真跳了多半是拦截页，按失败处理
        redirect: 'manual',
        signal: controller.signal,
      })
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {})
        throw new Error(`香港卫视节目单 HTTP ${response.status}`)
      }
      let payload
      try {
        payload = JSON.parse(await readCapped(response))
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error('香港卫视节目单不是 JSON')
        throw error
      }
      return parseProgrammes(payload, day)
    } finally {
      clearTimeout(timer)
    }
  },
}
