/**
 * 扬州官方节目单。
 *
 * 「扬州发布」App 的 H5 频道页调 vapp.96189.com/setsail/external/externalService?service=getProgramList，
 * params 是 JSON：channelId、idx、size 与起止时间 startTime / endTime（yyyyMMddHHmmss，北京时间），
 * 另带 apiVersion=2.9。不用登录、不看 Referer 与 UA。实测（2026-09-29）：
 * - 成功时 state 为 1000，节目在 data.rows，每条 programName + startTime / endTime（同上格式）；
 * - params 不是合法 JSON 回 state 2002「传入的json数据不正确」，HTTP 仍是 200，按出错处理；
 *   不认识的频道回空列表；
 * - 查询窗口按「与这一天有重叠」返回，会带上前一天 22 点开始、跨零点的那档，按开始时间落在当天筛；
 * - 今天排满，明天排到傍晚，后天为空；夜间停播（约 00:30–07:00）没有条目，开播先是不到一分钟的国歌。
 *
 * 四路都是直链频道（没有 deferredRef），流水线按「本模块 + 频道名」对上。
 *
 * 和取流链路没有共享状态：只用 channels.js 的频道表和调用方注入的 fetch，
 * 不 import 项目里的其它模块——连同 channels.js 拿出去就能单独产出节目单。
 */
import { CHANNEL_BY_ID, CHANNELS } from './channels.js'

export const EPG_API = 'https://vapp.96189.com/setsail/external/externalService'
// 一天二十来条、约 35 KB；留足余量，超出按异常处理
const MAX_BYTES = 512 * 1024
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const OK_STATE = 1000
// 不到 1 分钟的不算节目（开播前的国歌）
const MIN_PROGRAMME_MS = 60 * 1000
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** 上海日期 YYYYMMDD → { start, end }；与运行机器的时区无关，非法日期返回 null。 */
export function shanghaiDay(day) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(day ?? ''))
  if (!match) return null
  const [year, month, date] = match.slice(1).map(Number)
  const utc = Date.UTC(year, month - 1, date)
  const check = new Date(utc)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) return null
  const start = utc - SHANGHAI_OFFSET_MS
  return { start, end: start + DAY_MS }
}

/** 接口的北京时间 yyyyMMddHHmmss → 毫秒时间戳；格式不对返回 NaN。 */
export function parseTime(value) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(value ?? ''))
  if (!match) return NaN
  const [year, month, date, hour, minute, second] = match.slice(1).map(Number)
  if (hour > 23 || minute > 59 || second > 59) return NaN
  return Date.UTC(year, month - 1, date, hour, minute, second) - SHANGHAI_OFFSET_MS
}

/** H5 频道页同款请求地址。 */
export function epgUrl(key, day) {
  const channel = CHANNEL_BY_ID.get(String(key ?? ''))
  if (!channel || !shanghaiDay(day)) throw new Error('扬州节目单参数非法')
  const params = JSON.stringify({ channelId: channel.id, idx: 0, size: 200, startTime: `${day}000000`, endTime: `${day}235959` })
  return `${EPG_API}?${new URLSearchParams({ service: 'getProgramList', params, apiVersion: '2.9' })}`
}

const cleanTitle = value => String(value ?? '').replace(/\s+/g, ' ').trim()

/** 接口的一天 → [{ title, start, stop }]（毫秒），按开始时间升序、互不重叠。平台拒绝时抛带 code 的错。 */
export function parseProgrammes(payload, day) {
  const range = shanghaiDay(day)
  if (!range) throw new Error('扬州节目单参数非法')
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('扬州节目单返回结构不符合预期')
  if (Number(payload.state) !== OK_STATE) {
    const error = new Error(`扬州节目单接口拒绝：${payload.message || payload.state}`)
    error.code = Number(payload.state)
    throw error
  }
  const rows = payload.data?.rows
  if (!Array.isArray(rows)) throw new Error('扬州节目单返回结构不符合预期')

  const items = rows.map(row => ({
    title: cleanTitle(row?.programName),
    start: parseTime(row?.startTime),
    stop: parseTime(row?.endTime),
  }))
  const valid = item => item.title && Number.isSafeInteger(item.start) && Number.isSafeInteger(item.stop) && item.stop > item.start
  // 有条目却一条时间都解不出来，多半是字段改了，报错比静默空着好查
  if (items.length && !items.some(valid)) throw new Error('扬州节目单时间格式异常')

  const kept = items
    .filter(valid)
    .filter(item => item.start >= range.start && item.start < range.end)
    .filter(item => item.stop - item.start >= MIN_PROGRAMME_MS)
    .sort((a, b) => a.start - b.start || b.stop - a.stop)
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
    throw new Error('扬州节目单响应过大')
  }
  const buf = Buffer.from(await response.arrayBuffer())
  if (buf.length > MAX_BYTES) throw new Error('扬州节目单响应过大')
  return buf.toString('utf8')
}

export default {
  id: 'yangzhou',
  // 今天 + 明天：明天官方排到傍晚，跨零点前后播放器仍有节目可显示
  days: 2,

  /** 四路都是直链频道：ref 只作稳定标识，流水线按名字对上。 */
  channels() {
    return CHANNELS.map(channel => ({ ref: `yangzhou-${channel.id}`, name: channel.name, key: channel.id }))
  },

  /** 取一个频道某一天（上海日期 YYYYMMDD）的节目，按开始时间升序；官方当天没发返回空数组。 */
  async programmes(key, day, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
    const url = epgUrl(key, day)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
        // 接口不跳转；真跳了多半是拦截页，按失败处理
        redirect: 'manual',
        signal: controller.signal,
      })
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {})
        throw new Error(`扬州节目单 HTTP ${response.status}`)
      }
      let payload
      try {
        payload = JSON.parse(await readCapped(response))
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error('扬州节目单不是 JSON')
        throw error
      }
      return parseProgrammes(payload, day)
    } finally {
      clearTimeout(timer)
    }
  },
}
