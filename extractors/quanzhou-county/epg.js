/**
 * 晋江、石狮官方节目单。
 *
 * 两台官网直播页的节目单组件都调同一套云直播接口 cloudlive-manage-mapi/api/topic/program/list，
 * 参数是 topic_id（官网频道 id）、date（YYYY-MM-DD）和官网页面脚本里写死的 app_secret，
 * 石狮页面另带 company_id。不用登录、不看 Referer 与 UA。实测（2026-09-29）：
 * - star_time_timestamp / end_time_timestamp 是 unix 秒；成功时 error_code 为 200。
 * - app_secret 不对回 error_code 10002「客户信息不存在」，HTTP 仍是 200，按出错处理。
 * - 不认识的 topic、没排节目单的日子，回 24 条整点「精彩节目」占位（与福建省级同一平台），当官方没发。
 * - 晋江目前天天都只有占位；石狮今天、明天都是真编排，每天 07:00 到 23:59:59，
 *   偶有标题全是空格的空档条目，丢掉。
 *
 * 两台都是直链频道（没有 deferredRef），流水线按「本模块 + 频道名」对上。
 *
 * 和取流链路没有共享状态：只用 channels.js 的频道表和调用方注入的 fetch，
 * 不 import 项目里的其它模块——连同 channels.js 拿出去就能单独产出节目单。
 */
import { CHANNEL_BY_ID, CHANNELS } from './channels.js'

// 一天三十来条、约 20 KB；留足余量，超出按异常处理
const MAX_BYTES = 512 * 1024
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const PLACEHOLDER_TITLE = '精彩节目'
// 不到 1 分钟的不算节目
const MIN_PROGRAMME_MS = 60 * 1000
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** 上海日期 YYYYMMDD → { start, end, iso: 'YYYY-MM-DD' }；与运行机器的时区无关，非法日期返回 null。 */
export function shanghaiDay(day) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(day ?? ''))
  if (!match) return null
  const [year, month, date] = match.slice(1).map(Number)
  const utc = Date.UTC(year, month - 1, date)
  const check = new Date(utc)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) return null
  const start = utc - SHANGHAI_OFFSET_MS
  return { start, end: start + DAY_MS, iso: `${match[1]}-${match[2]}-${match[3]}` }
}

const cleanTitle = value => String(value ?? '').replace(/\s+/g, ' ').trim()

/** 接口的一天 → [{ title, start, stop }]（毫秒），按开始时间升序、互不重叠。平台拒绝时抛带 code 的错。 */
export function parseProgrammes(payload, day) {
  const range = shanghaiDay(day)
  if (!range) throw new Error('晋江石狮节目单参数非法')
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('晋江石狮节目单返回结构不符合预期')
  if (Number(payload.error_code) !== 200) {
    const error = new Error(`晋江石狮节目单接口拒绝：${payload.error_message || payload.error_code}`)
    error.code = Number(payload.error_code)
    throw error
  }
  if (!Array.isArray(payload.result)) throw new Error('晋江石狮节目单返回结构不符合预期')

  const items = payload.result.map(row => ({
    title: cleanTitle(row?.title),
    start: Number(row?.star_time_timestamp ?? row?.start_time_timestamp) * 1000,
    stop: Number(row?.end_time_timestamp) * 1000,
  }))
  const real = items.filter(item => item.title && item.title !== PLACEHOLDER_TITLE)
  const valid = item => Number.isSafeInteger(item.start) && Number.isSafeInteger(item.stop) && item.stop > item.start
  // 有真节目却一条时间都解不出来，多半是字段改了，报错比静默空着好查
  if (real.length && !real.some(valid)) throw new Error('晋江石狮节目单时间格式异常')

  const kept = real
    .filter(valid)
    .filter(item => item.start >= range.start && item.start < range.end)
    .filter(item => item.stop - item.start >= MIN_PROGRAMME_MS)
    .sort((a, b) => a.start - b.start)
  const programmes = []
  for (const item of kept) {
    const previous = programmes.at(-1)
    if (previous?.start === item.start) continue
    if (previous && previous.stop > item.start) previous.stop = item.start
    programmes.push({ title: item.title, start: item.start, stop: item.stop })
  }
  return programmes
}

/** 读响应体，超过上限就中止。 */
async function readCapped(response) {
  if (Number(response.headers?.get?.('content-length')) > MAX_BYTES) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error('晋江石狮节目单响应过大')
  }
  const buf = Buffer.from(await response.arrayBuffer())
  if (buf.length > MAX_BYTES) throw new Error('晋江石狮节目单响应过大')
  return buf.toString('utf8')
}

/** 官网节目单组件同款请求地址。 */
export function epgUrl(key, day) {
  const channel = CHANNEL_BY_ID.get(String(key ?? ''))
  const range = shanghaiDay(day)
  if (!channel?.epg || !range) throw new Error('晋江石狮节目单参数非法')
  const query = new URLSearchParams({ date: range.iso, topic_id: channel.epg.topicId, app_secret: channel.epg.appSecret })
  if (channel.epg.companyId) query.set('company_id', channel.epg.companyId)
  return `${channel.epg.api}?${query}`
}

export default {
  id: 'quanzhou-county',
  // 今天 + 明天：全量更新默认 8 小时一轮，多备一天，跨零点前后播放器仍有节目可显示
  days: 2,

  /** 两台都是直链频道：ref 只作稳定标识，流水线按名字对上。 */
  channels() {
    return CHANNELS.filter(channel => channel.epg)
      .map(channel => ({ ref: `quanzhou-county-${channel.id}`, name: channel.name, key: channel.id }))
  },

  /** 取一个频道某一天（上海日期 YYYYMMDD）的节目，按开始时间升序；官方当天没发返回空数组。 */
  async programmes(key, day, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
    const url = epgUrl(key, day)
    const channel = CHANNEL_BY_ID.get(String(key))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, {
        headers: { 'User-Agent': UA, Referer: channel.epg.referer, Accept: 'application/json, text/plain, */*' },
        // 接口不跳转；真跳了多半是拦截页，按失败处理
        redirect: 'manual',
        signal: controller.signal,
      })
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {})
        throw new Error(`晋江石狮节目单 HTTP ${response.status}`)
      }
      let payload
      try {
        payload = JSON.parse(await readCapped(response))
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error('晋江石狮节目单不是 JSON')
        throw error
      }
      return parseProgrammes(payload, day)
    } finally {
      clearTimeout(timer)
    }
  },
}
