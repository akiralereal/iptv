/**
 * 南京广电官方节目单。
 *
 * 牛咔视频（南京广电 App / m2.nbs.cn）频道页「节目单」标签的数据：先取 content/detail 的
 * stream_api，即 apigateway.nbs.cn/Liveprogram/getEPGByTaskId?taskId=<任务号>&contentid=<内容号>，
 * 再加 gettime=<当天某刻的 Unix 秒>。不用登录、不带签名、不看 Referer 与 UA。实测（2026-09-25）：
 * - 只按 taskId 查，contentid 被忽略；gettime 取它所在的上海日期，页面传的是当天中午 12 点。
 * - 往前一个月都有；往后只到后天（逐日不同，是真排期，不是复制的模板），再往后与不存在的
 *   任务号都回 { error: -1, msg: '没有数据' }。
 * - start_time / end_time 是 Unix 秒，另有同一时刻的上海时间文本 startTime / endTime。
 *   每天从零点排到 23:59:59，凌晨停播时段直接空着；偶有前一条结束晚于后一条开始几分钟。
 * - 名字常带尾随空格或制表符；夹着台标片头、「收视指南」「动画宣传片」这类几分钟的包装条目。
 *
 * 只有四套电视频道有节目单任务号；Live 南京的景观机位（含音乐台直播间）没有，不登记。
 *
 * 和取流链路没有任何共享状态：只用频道表 channels.js 和调用方注入的 fetch，
 * 不 import 项目里的其它模块——整份连同 channels.js 拿出去就能单独产出节目单。
 */
import { TV_CHANNELS } from './channels.js'

export const EPG_API = 'https://apigateway.nbs.cn/Liveprogram/getEPGByTaskId'
// 一天三十来条、约 12KB；留足余量，超出按异常处理
const MAX_BYTES = 256 * 1024
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const NO_DATA_MSG = '没有数据'
// 台标片头、频道形象片、收视指南、宣传片：十分钟以内的是包装条目，不是节目
const FILLER = /片头|形象片|收视指南|宣传片/
const FILLER_MAX_MS = 10 * 60 * 1000
// 不到 1 分钟的不算节目（总片头 + 形象片 + 收视指南一共 30 秒）
const MIN_PROGRAMME_MS = 60 * 1000
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

const CONTENT_ID_BY_TASK = new Map(TV_CHANNELS.map(channel => [channel.epgTaskId, channel.contentId]))

/** 上海日期 YYYYMMDD 零点的时间戳；与运行机器的时区无关。非法日期得 NaN。 */
export function shanghaiDayStart(day) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(day))
  if (!match) return NaN
  const [year, month, date] = match.slice(1).map(Number)
  const start = Date.UTC(year, month - 1, date) - SHANGHAI_OFFSET_MS
  const check = new Date(start + SHANGHAI_OFFSET_MS)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) return NaN
  return start
}

/** 'YYYY-MM-DD HH:mm:ss'（上海时间）→ 毫秒时间戳；显式按 +08:00 算。非法得 NaN。 */
export function shanghaiTime(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(text ?? '').trim())
  if (!match) return NaN
  const [year, month, date, hour, minute, second] = match.slice(1).map(Number)
  if (hour > 23 || minute > 59 || second > 59) return NaN
  const dayStart = shanghaiDayStart(`${match[1]}${match[2]}${match[3]}`)
  return dayStart + ((hour * 60 + minute) * 60 + second) * 1000
}

/** 优先用 Unix 秒；缺了再读同一时刻的上海时间文本。 */
function timeOf(seconds, text) {
  const value = Number(seconds)
  if (seconds != null && seconds !== '' && Number.isFinite(value) && value > 0) return value * 1000
  return shanghaiTime(text)
}

/** 包装条目返回原因，正经节目返回空串。丢掉后留下的空档照实保留，XMLTV 允许空档。 */
export function fillerReason(title, durationMs) {
  if (durationMs < MIN_PROGRAMME_MS) return 'short'
  if (durationMs <= FILLER_MAX_MS && FILLER.test(title)) return 'filler'
  return ''
}

/**
 * 接口 JSON → 该天的节目，按开始时间升序、互不重叠。
 * 只收开始时间落在所请求那天里的；同一开始时间只留一条；结束晚于下一条开始的截到下一条开始。
 */
export function parseProgrammes(payload, day) {
  const dayStart = shanghaiDayStart(day)
  if (!Number.isFinite(dayStart)) throw new Error('南京广电节目单参数非法')
  if (!payload || typeof payload !== 'object') throw new Error('南京广电节目单数据格式异常')
  if (Number(payload.error) !== 0) {
    if (String(payload.msg ?? '').trim() === NO_DATA_MSG) return []
    throw new Error(`南京广电节目单接口返回 ${payload.error}：${payload.msg || '未知错误'}`)
  }
  if (payload.data == null) return []
  if (!Array.isArray(payload.data)) throw new Error('南京广电节目单数据格式异常')

  const dayEnd = dayStart + DAY_MS
  const rows = []
  let readable = 0
  for (const row of payload.data) {
    const start = timeOf(row?.start_time, row?.startTime)
    const stop = timeOf(row?.end_time, row?.endTime)
    const title = String(row?.name ?? '').trim()
    if (!Number.isFinite(start) || !Number.isFinite(stop) || !title) continue
    readable++
    if (start < dayStart || start >= dayEnd || stop <= start) continue
    if (fillerReason(title, stop - start)) continue
    rows.push({ title, start, stop })
  }
  // 有数据却一条时间都读不出，多半是接口改了格式，报错而不是当成「当天没发」
  if (payload.data.length && !readable) throw new Error('南京广电节目单数据格式异常')

  rows.sort((a, b) => a.start - b.start || b.stop - a.stop)
  const programmes = []
  for (const item of rows) {
    const previous = programmes.at(-1)
    if (previous?.start === item.start) continue
    if (previous && previous.stop > item.start) previous.stop = item.start
    programmes.push(item)
  }
  return programmes
}

/** 读响应体，超过上限就中止，不把整份读进内存再判断。 */
async function readCapped(response) {
  if (Number(response.headers?.get?.('content-length')) > MAX_BYTES) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error('南京广电节目单响应过大')
  }
  if (!response.body?.getReader) {
    const buf = Buffer.from(await response.arrayBuffer())
    if (buf.length > MAX_BYTES) throw new Error('南京广电节目单响应过大')
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
      throw new Error('南京广电节目单响应过大')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 牛咔节目单页同款请求地址：任务号 + 内容号 + 当天中午 12 点（上海）的 Unix 秒。 */
export function epgUrl(taskId, day) {
  const dayStart = shanghaiDayStart(day)
  if (!/^\d{1,6}$/.test(String(taskId ?? '')) || !Number.isFinite(dayStart)) {
    throw new Error('南京广电节目单参数非法')
  }
  const query = new URLSearchParams({ taskId: String(taskId) })
  const contentId = CONTENT_ID_BY_TASK.get(String(taskId))
  if (contentId) query.set('contentid', contentId)
  query.set('gettime', String((dayStart + DAY_MS / 2) / 1000))
  return `${EPG_API}?${query}`
}

export default {
  id: 'njtv',
  // 今天 + 明天：全量更新默认 8 小时一轮，多备一天，跨零点前后播放器仍有节目可显示
  days: 2,

  /**
   * 本模块哪些频道出节目单：显示名 → 节目单任务号。
   * 这四套是直链频道（没有 deferredRef），按来源模块 + 显示名配对；ref 只作稳定标识。
   */
  channels() {
    return TV_CHANNELS.map(channel => ({ ref: `njtv-${channel.contentId}`, name: channel.name, key: channel.epgTaskId }))
  },

  /** 取一个频道某一天（上海日期 YYYYMMDD）的节目，按开始时间升序；官方当天没发返回空数组。 */
  async programmes(key, day, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
    const url = epgUrl(key, day)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, {
        headers: { 'User-Agent': UA, Referer: 'https://m2.nbs.cn/', Accept: 'application/json, text/plain, */*' },
        // 接口不跳转；真跳了多半是拦截页，按失败处理
        redirect: 'manual',
        signal: controller.signal,
      })
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {})
        throw new Error(`南京广电节目单 HTTP ${response.status}`)
      }
      let payload
      try {
        // 接口声明 text/html，正文是 JSON
        payload = JSON.parse(await readCapped(response))
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error('南京广电节目单不是 JSON')
        throw error
      }
      return parseProgrammes(payload, day)
    } finally {
      clearTimeout(timer)
    }
  },
}
