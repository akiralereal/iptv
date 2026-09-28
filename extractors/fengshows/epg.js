/**
 * 凤凰卫视官方节目单。
 *
 * 凤凰秀官网直播页（fengshows.com/live）右侧的节目表取自
 * GET api.fengshows.cn/live/<直播 id>/resources?dir=asc&date=YYYYMMDD&page=1&page_size=N，
 * 与取流用的是同一个官方 API 主机，不用登录、不带签名。实测（2026-09-25）：
 * - date 是香港日期（与上海同为 UTC+8）；每条只有开始时间 event_time（UTC 的 ISO 串），
 *   没有结束时间与时长，官网自己也是拿下一条的开始当本条结束。
 * - 每天从 00:00 排到 23:30 前后，下一天同样从 00:00 开始；今天起能取三天（含今天），再往后回空数组。
 * - 节目名照官网原样，冠名商前缀（「陽光保險 鳳凰焦點新聞 1800」）也是官方标题的一部分，不去猜着删。
 * - 不认识的直播 id 回空数组；date 不是数字回一个 CastError 对象（非数组，按格式异常处理）。
 *
 * 和取流链路没有任何共享状态：只用频道表 channels.js 和调用方注入的 fetch，
 * 不 import 项目里的其它模块——整份连同 channels.js 拿出去就能单独产出节目单。
 */
import { CHANNELS, channelRef } from './channels.js'

export const EPG_API = 'https://api.fengshows.cn/live/'
// 与取流一致的官网客户端标识
const CLIENT = 'app(fs-web,1000000);'
// 一天五六十条已经够用；给足余量，真到了这个数说明接口换了分页习惯
const PAGE_SIZE = 200
// 一天约 45KB，留足余量，超出按异常处理
const MAX_BYTES = 1024 * 1024
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// 只认带时区的 ISO 时间，免得 Date.parse 按运行机器的本地时区猜
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/

/** 上海日期 YYYYMMDD → 当天零点与次日零点的毫秒时间戳；与运行机器的时区无关。 */
export function shanghaiDayRange(day) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(day ?? ''))
  if (!match) throw new Error('凤凰卫视节目单参数非法')
  const [year, month, date] = match.slice(1).map(Number)
  const start = Date.UTC(year, month - 1, date) - SHANGHAI_OFFSET_MS
  const check = new Date(start + SHANGHAI_OFFSET_MS)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) {
    throw new Error('凤凰卫视节目单参数非法')
  }
  return { start, end: start + DAY_MS }
}

/**
 * 接口 JSON → 该上海日内开始的节目 [{ title, start, stop }]，按开始时间升序。
 * 结束取下一条的开始，当天最后一条取次日零点（次日节目表同样从零点排起）。
 */
export function parseProgrammes(payload, day) {
  const range = shanghaiDayRange(day)
  if (!Array.isArray(payload)) throw new Error('凤凰卫视节目单数据格式异常')

  const items = []
  let readable = 0
  for (const row of payload) {
    const time = String(row?.event_time ?? '')
    const start = ISO_RE.test(time) ? Date.parse(time) : NaN
    if (!Number.isFinite(start)) continue
    readable++
    const title = String(row?.title ?? '').trim()
    // 下架的条目官网不显示
    if (!title || row?.available === 0 || (row?.type != null && row.type !== 'schedule')) continue
    if (start < range.start || start >= range.end) continue
    items.push({ title, start })
  }
  // 有数据却一条时间都读不出，多半是接口改了格式，报错而不是当成「当天没发」
  if (payload.length && !readable) throw new Error('凤凰卫视节目单数据格式异常')

  items.sort((a, b) => a.start - b.start)
  const unique = items.filter((item, index) => index === 0 || item.start !== items[index - 1].start)
  return unique.map((item, index) => ({
    title: item.title,
    start: item.start,
    stop: unique[index + 1]?.start ?? range.end,
  }))
}

/** 读响应体，超过上限就中止，不把整份读进内存再判断。 */
async function readCapped(response) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (declared > MAX_BYTES) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error('凤凰卫视节目单响应过大')
  }
  if (!response.body?.getReader) {
    const buf = Buffer.from(await response.arrayBuffer())
    if (buf.length > MAX_BYTES) throw new Error('凤凰卫视节目单响应过大')
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
      throw new Error('凤凰卫视节目单响应过大')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 某台某天（上海日期）的节目表地址；与官网直播页的请求参数一致。 */
export function scheduleUrl(id, day) {
  const url = new URL(`${EPG_API}${id}/resources`)
  url.searchParams.set('dir', 'asc')
  url.searchParams.set('date', String(day))
  url.searchParams.set('page', '1')
  url.searchParams.set('page_size', String(PAGE_SIZE))
  return url.href
}

export default {
  id: 'fengshows',
  // 今天 + 明天：全量更新默认 8 小时一轮，多备一天，跨零点前后播放器仍有节目可显示
  days: 2,

  /** 本模块哪些频道出节目单：频道 ref、显示名 → 官方直播 id。 */
  channels() {
    return CHANNELS.map(channel => ({ ref: channelRef(channel), name: channel.name, key: channel.id }))
  },

  /** 取一个频道某一天（上海日期 YYYYMMDD）的节目，按开始时间升序；官方当天没发返回空数组。 */
  async programmes(key, day, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
    if (!ID_RE.test(String(key ?? ''))) throw new Error('凤凰卫视节目单参数非法')
    shanghaiDayRange(day)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(scheduleUrl(key, day), {
        headers: { Accept: 'application/json', 'fengshows-client': CLIENT },
        // 接口不跳转；真跳了多半是拦截页，按失败处理
        redirect: 'manual',
        signal: controller.signal,
      })
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {})
        throw new Error(`凤凰卫视节目单 HTTP ${response.status}`)
      }
      let payload
      try {
        payload = JSON.parse(await readCapped(response))
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error('凤凰卫视节目单不是 JSON')
        throw error
      }
      return parseProgrammes(payload, day)
    } finally {
      clearTimeout(timer)
    }
  },
}
