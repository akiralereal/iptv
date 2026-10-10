/**
 * 青岛广播电视台官方节目单。
 *
 * 官网播放页（www.qtv.com.cn/live/tv/）用 JSONP 取
 * https://video10.qtv.com.cn/api/v1/bls_adapters?channel=<号>&days=<n>&callback=success_jsonp_callback，
 * channel 就是播放页 playerOption.channel（QTV-1…4 是 1…4，QTV-5 是 6）。实测（2026-10-09）：
 * - 必须带官网的 Referer 与 Origin，否则 403（bravoserver）；连续探测十来次后会被按 IP 拦一阵，
 *   所以这里只按播放页原样请求，不做重试。
 * - days 填几都回「过去 7 天 + 今天」共 8 天（官网用它做回看列表），每天从 00:00 到 23:59 整天，
 *   没有明天的编排，所以只取今天（days: 1）。
 * - 每条 { visible, start_time, end_time, name }，秒级时间戳，已按零点切好、互不重叠，
 *   节目之间偶有空档，照实保留。
 *
 * 和取流链路没有任何共享状态：只用频道表 channels.js 和调用方注入的 fetch。
 */
import { CHANNELS } from './channels.js'

export const EPG_API = 'https://video10.qtv.com.cn/api/v1/bls_adapters'
export const PLAYER_PAGE = 'https://www.qtv.com.cn/live/tv/'
const CALLBACK = 'success_jsonp_callback'
// 一路 8 天约 36KB；留足余量，超出按异常处理
const MAX_BYTES = 512 * 1024
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const KNOWN_KEYS = new Set(CHANNELS.map(channel => channel.epgChannel))

/** 上海日期 YYYYMMDD → 该天 [零点, 次日零点) 的毫秒时间戳；显式按 +08:00 算，与运行机器时区无关。 */
export function shanghaiDayRange(day) {
  const text = String(day)
  if (!/^\d{8}$/.test(text)) throw new Error('青岛节目单参数非法')
  const [year, month, date] = [Number(text.slice(0, 4)), Number(text.slice(4, 6)), Number(text.slice(6, 8))]
  const start = Date.UTC(year, month - 1, date) - SHANGHAI_OFFSET_MS
  const check = new Date(start + SHANGHAI_OFFSET_MS)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) {
    throw new Error('青岛节目单参数非法')
  }
  return { start, stop: start + DAY_MS }
}

/** JSONP 文本 → 对象：剥掉 callback(...) 外壳；裸 JSON 也认。 */
export function parseJsonp(text) {
  const body = String(text ?? '').trim()
  const match = /^[\w$.]+\s*\(([\s\S]*)\)\s*;?$/.exec(body)
  try {
    return JSON.parse(match ? match[1] : body)
  } catch {
    throw new Error('青岛节目单不是 JSON')
  }
}

/**
 * 接口 JSON → 某一天的 [{ title, start, stop }]，按开始时间升序。
 * 只取开始时间落在这一天里的、visible 为真、有名字的条目；结束不晚于下一条开始；同一开始时间只留一条。
 * 响应里没有这一天（接口只给过去 7 天 + 今天）返回空数组。
 */
export function parseProgrammes(payload, day) {
  if (!payload || typeof payload !== 'object') throw new Error('青岛节目单数据格式异常')
  if (Number(payload.status) !== 0) throw new Error(`青岛节目单接口返回 status ${payload.status}`)
  if (!Array.isArray(payload.epg_data)) throw new Error('青岛节目单数据格式异常')
  const range = shanghaiDayRange(day)

  const items = []
  let readable = 0
  for (const row of payload.epg_data) {
    const start = Number(row?.start_time) * 1000
    const stop = Number(row?.end_time) * 1000
    if (!Number.isFinite(start) || !Number.isFinite(stop) || start <= 0) continue
    readable++
    const title = String(row?.name ?? '').trim()
    if (row?.visible === false || !title) continue
    if (start < range.start || start >= range.stop) continue
    items.push({ title, start, stop: stop > start ? stop : 0 })
  }
  // 有数据却一条时间都读不出，多半是接口改了格式，报错而不是当成「当天没发」
  if (payload.epg_data.length && !readable) throw new Error('青岛节目单数据格式异常')

  items.sort((a, b) => a.start - b.start || b.stop - a.stop)
  const unique = items.filter((item, index) => index === 0 || item.start !== items[index - 1].start)
  return unique.map((item, index) => {
    const nextStart = unique[index + 1]?.start
    let stop = item.stop || nextStart || range.stop
    if (nextStart != null && stop > nextStart) stop = nextStart
    return { title: item.title, start: item.start, stop }
  })
}

/** 读响应体，超过上限就中止，不把整份读进内存再判断。 */
async function readCapped(response) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (declared > MAX_BYTES) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error('青岛节目单响应过大')
  }
  if (!response.body?.getReader) {
    const buf = Buffer.from(await response.arrayBuffer())
    if (buf.length > MAX_BYTES) throw new Error('青岛节目单响应过大')
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
      throw new Error('青岛节目单响应过大')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export default {
  id: 'qingdao',
  // 接口只有到今天为止的编排，没有明天
  days: 1,

  /** 本模块哪些频道出节目单：频道 ref、显示名 → 播放页的 channel 号。 */
  channels() {
    return CHANNELS.map(channel => ({ ref: channel.ref, name: channel.name, key: channel.epgChannel }))
  },

  /** 取一个频道某一天（上海日期 YYYYMMDD）的节目，按开始时间升序；接口没有这一天返回空数组。 */
  async programmes(key, day, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
    const channel = String(key ?? '')
    if (!KNOWN_KEYS.has(channel)) throw new Error('青岛节目单参数非法')
    shanghaiDayRange(day)
    const url = new URL(EPG_API)
    url.searchParams.set('channel', channel)
    url.searchParams.set('days', '1')
    url.searchParams.set('callback', CALLBACK)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url.href, {
        headers: {
          'User-Agent': UA,
          Referer: PLAYER_PAGE,
          Origin: 'https://www.qtv.com.cn',
          Accept: '*/*',
        },
        // 接口不跳转；真跳了多半是 WAF 拦截页，按失败处理
        redirect: 'manual',
        signal: controller.signal,
      })
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {})
        throw new Error(`青岛节目单 HTTP ${response.status}`)
      }
      return parseProgrammes(parseJsonp(await readCapped(response)), day)
    } finally {
      clearTimeout(timer)
    }
  },
}
