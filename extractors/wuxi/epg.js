/**
 * 无锡广电官方节目单。
 *
 * 无锡博报「直播」分享页的节目表弹窗调 bb-mapi.wifiwx.com/api/open/wxbb/ds_program.php，
 * 参数 channel_id（博报频道号）、zone（相对今天的天数，网页上是 -5 到 1）和 appid / appkey
 * （M2O 开放接口的网页客户端参数，写在分享页公开脚本 global.*.js 里）。不看 Referer 与 UA。实测（2026-09-29）：
 * - 回数组，每条 start_time 是 unix 秒、toff 是时长（秒）、theme 是节目名，前后首尾相接；
 * - 不带 appid / appkey 回 {"error_code":1000,"error_message":"授权验证未通过哦"}，HTTP 仍是 200；
 * - 每天末尾有一条 toff 为 0 的收尾标记，同一时刻偶有两三条重复（只有最后一条时长正常）；
 * - 今天排满到 23:59:59，明天排到傍晚，一天二三十条、约 40 KB。
 *
 * 和取流链路没有共享状态：只用 channels.js 的频道表和调用方注入的 fetch，
 * 不 import 项目里的其它模块——连同 channels.js 拿出去就能单独产出节目单。
 */
import { CHANNEL_BY_ID, CHANNELS } from './channels.js'

export const EPG_API = 'https://bb-mapi.wifiwx.com/api/open/wxbb/ds_program.php'
const APP_ID = 'm2oszr2ukmxzvqr4ai'
const APP_KEY = '7fbab2da9b4c7cd2405ffa7e8097cc22'
const MAX_BYTES = 512 * 1024
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
// 网页日期条的范围：前五天到明天
const MIN_ZONE = -5
const MAX_ZONE = 1
// 不到 1 分钟的不算节目（收尾标记、重复条目）
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

/** 某个上海日期相对「今天」的天数，即接口的 zone。 */
export function zoneOf(day, now = Date.now()) {
  const range = shanghaiDay(day)
  if (!range) return NaN
  const todayStart = Math.floor((now + SHANGHAI_OFFSET_MS) / DAY_MS) * DAY_MS - SHANGHAI_OFFSET_MS
  return Math.round((range.start - todayStart) / DAY_MS)
}

/** 网页节目表同款请求地址；超出网页日期范围的日子返回 null（官方不提供）。 */
export function epgUrl(key, day, now = Date.now()) {
  const channel = CHANNEL_BY_ID.get(String(key ?? ''))
  const zone = zoneOf(day, now)
  if (!channel || !Number.isInteger(zone)) throw new Error('无锡节目单参数非法')
  if (zone < MIN_ZONE || zone > MAX_ZONE) return null
  const query = new URLSearchParams({ channel_id: String(channel.id), zone: String(zone), appid: APP_ID, appkey: APP_KEY })
  return `${EPG_API}?${query}`
}

const cleanTitle = value => String(value ?? '').replace(/\s+/g, ' ').trim()

/** 接口的一天 → [{ title, start, stop }]（毫秒），按开始时间升序、互不重叠。平台拒绝时抛带 code 的错。 */
export function parseProgrammes(payload, day) {
  const range = shanghaiDay(day)
  if (!range) throw new Error('无锡节目单参数非法')
  if (!Array.isArray(payload)) {
    if (payload && typeof payload === 'object' && payload.error_code != null) {
      const error = new Error(`无锡节目单接口拒绝：${payload.error_message || payload.error_code}`)
      error.code = Number(payload.error_code)
      throw error
    }
    throw new Error('无锡节目单返回结构不符合预期')
  }

  const items = payload.map(row => {
    const start = Number(row?.start_time) * 1000
    return { title: cleanTitle(row?.theme), start, stop: start + Number(row?.toff) * 1000 }
  })
  const valid = item => item.title && Number.isSafeInteger(item.start) && Number.isSafeInteger(item.stop)
  // 有条目却一条时间都解不出来，多半是字段改了，报错比静默空着好查
  if (items.length && !items.some(valid)) throw new Error('无锡节目单时间格式异常')

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
    throw new Error('无锡节目单响应过大')
  }
  const buf = Buffer.from(await response.arrayBuffer())
  if (buf.length > MAX_BYTES) throw new Error('无锡节目单响应过大')
  return buf.toString('utf8')
}

export default {
  id: 'wuxi',
  // 今天 + 明天：明天官方一般排到傍晚，跨零点前后播放器仍有节目可显示
  days: 2,

  channels() {
    return CHANNELS.map(channel => ({ ref: channel.ref, name: channel.name, key: String(channel.id) }))
  },

  /** 取一个频道某一天（上海日期 YYYYMMDD）的节目，按开始时间升序；官方当天没发返回空数组。 */
  async programmes(key, day, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
    const url = epgUrl(key, day)
    if (!url) return []
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
        throw new Error(`无锡节目单 HTTP ${response.status}`)
      }
      let payload
      try {
        payload = JSON.parse(await readCapped(response))
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error('无锡节目单不是 JSON')
        throw error
      }
      return parseProgrammes(payload, day)
    } finally {
      clearTimeout(timer)
    }
  },
}
