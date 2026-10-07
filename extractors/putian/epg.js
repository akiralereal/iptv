/**
 * 莆田广播电视台官方节目单。
 *
 * 官网直播页与「莆田TV」App 的节目单都调 mapi.ptbtv.com/api/v1/program.php（与厦门看厦门同一套 M2O 接口），
 * 参数 channel_id（频道接口的 id）和 zone（相对服务器今天的天数，-1 昨天、1 明天），不用签名。
 * 和频道接口一样挂在网宿人机验证后面，浏览器 UA 回挑战页，用 Node 自己的 UA。实测（2026-09-30）：
 * - 回数组，每条 start_time 是 unix 秒、toff 是时长（秒）、theme 是节目名、dates 是那天的日期，首尾相接；
 * - 一套、二套是真编排，每天 06:00 开始、排到 23:59，往回至少一周，往后排好了三四天，再往后是占位；
 * - 仙游电视台天天是 24 条整点「精彩节目」占位，当官方没发；照样每轮去取，哪天官方真排了就自动有；
 * - 不认识的 channel_id 回空数组，缺 channel_id 回 {"ErrorCode":"1","ErrorText":"缺少频道 id"}。
 *
 * 和取流链路没有共享状态：只用 channels.js 的频道表和调用方注入的 fetch，
 * 不 import 项目里的其它模块——连同 channels.js 拿出去就能单独产出节目单。
 */
import { CHANNEL_BY_ID, CHANNELS } from './channels.js'

export const EPG_API = 'https://mapi.ptbtv.com/api/v1/program.php'
// 一天三五十条、约 60 KB；留足余量，超出按异常处理
const MAX_BYTES = 1024 * 1024
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
// 实测往回至少一周、往后三四天是真编排；直播只用得上今天、明天
const MIN_ZONE = -7
const MAX_ZONE = 6
const PLACEHOLDER_TITLE = '精彩节目'
// 不到 1 分钟的不算节目
const MIN_PROGRAMME_MS = 60 * 1000
// 网宿人机验证只拦浏览器 UA
const UA = 'node'

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

/** 某个上海日期相对「今天」的天数，即接口的 zone。 */
export function zoneOf(day, now = Date.now()) {
  const range = shanghaiDay(day)
  if (!range) return NaN
  const todayStart = Math.floor((now + SHANGHAI_OFFSET_MS) / DAY_MS) * DAY_MS - SHANGHAI_OFFSET_MS
  return Math.round((range.start - todayStart) / DAY_MS)
}

/** 官网节目单同款请求地址；超出范围的日子返回 null（官方不提供）。 */
export function epgUrl(key, day, now = Date.now()) {
  const channel = CHANNEL_BY_ID.get(String(key ?? ''))
  const zone = zoneOf(day, now)
  if (!channel || !Number.isInteger(zone)) throw new Error('莆田节目单参数非法')
  if (zone < MIN_ZONE || zone > MAX_ZONE) return null
  const query = new URLSearchParams({ channel_id: String(channel.id), zone: String(zone) })
  return `${EPG_API}?${query}`
}

const cleanTitle = value => String(value ?? '').replace(/\s+/g, ' ').trim()

/** 接口的一天 → [{ title, start, stop }]（毫秒），按开始时间升序、互不重叠。平台拒绝时抛带 code 的错。 */
export function parseProgrammes(payload, day) {
  const range = shanghaiDay(day)
  if (!range) throw new Error('莆田节目单参数非法')
  if (!Array.isArray(payload)) {
    if (payload && typeof payload === 'object' && payload.ErrorCode != null) {
      const error = new Error(`莆田节目单接口拒绝：${payload.ErrorText || payload.ErrorCode}`)
      error.code = Number(payload.ErrorCode)
      throw error
    }
    throw new Error('莆田节目单返回结构不符合预期')
  }

  const items = payload.map(row => {
    const start = Number(row?.start_time) * 1000
    return { title: cleanTitle(row?.theme), start, stop: start + Number(row?.toff) * 1000 }
  })
  const real = items.filter(item => item.title && item.title !== PLACEHOLDER_TITLE)
  const valid = item => Number.isSafeInteger(item.start) && Number.isSafeInteger(item.stop) && item.stop > item.start
  // 有真节目却一条时间都解不出来，多半是字段改了，报错比静默空着好查
  if (real.length && !real.some(valid)) throw new Error('莆田节目单时间格式异常')

  const kept = real
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
    throw new Error('莆田节目单响应过大')
  }
  const buf = Buffer.from(await response.arrayBuffer())
  if (buf.length > MAX_BYTES) throw new Error('莆田节目单响应过大')
  return buf.toString('utf8')
}

export default {
  id: 'putian',
  // 今天 + 明天
  days: 2,

  channels() {
    return CHANNELS.map(channel => ({ ref: channel.ref, name: channel.name, key: String(channel.id) }))
  },

  /** 取一个频道某一天（上海日期 YYYYMMDD）的节目，按开始时间升序；官方当天没发返回空数组。 */
  async programmes(key, day, { fetchImpl = fetch, timeoutMs = 10000, now = Date.now() } = {}) {
    const url = epgUrl(key, day, Number(now))
    if (!url) return []
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
        // 接口不跳转；跳了就是人机验证页，按失败处理
        redirect: 'manual',
        signal: controller.signal,
      })
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {})
        throw new Error(`莆田节目单 HTTP ${response.status}`)
      }
      let payload
      try {
        payload = JSON.parse(await readCapped(response))
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error('莆田节目单不是 JSON（可能被人机验证拦下）')
        throw error
      }
      return parseProgrammes(payload, day)
    } finally {
      clearTimeout(timer)
    }
  },
}
