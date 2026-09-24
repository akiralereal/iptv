/**
 * 天津广电（津云 WiseTV）官方节目单。
 *
 * 津云 App 的节目单取自 GET jyapi2.wisetv.com.cn:8684/v3/tv/programs/show/<起>/<止>/<channelId>/timestamp=0，
 * 起止是上海日期 YYYY-MM-DD（含两端），要带与签发直播地址相同的 ak / sk 与设备头（auth.js），
 * 不带回 code 4001「缺少授权认证信息」。区间只能落在「今天往前五天」到「后天」之间，越界回 code 400。
 * 返回 programslist.data[] 按天分组，每条 { text, startTime, endTime, channelId }，
 * 时间是上海时间「YYYY-MM-DD HH:mm:ss」。
 *
 * 实测（2026-09-25，七路各取四天）：今天及以前是播出日志的粒度（天津卫视 19:00《新闻联播》、
 * 18:30《天津新闻》）；明天上午往后、后天全天是编排计划，条目粗，标题带「30’」「2’30”」这种时长批注，
 * 长节目被编排系统切成三小时一段（00:00–03:00、03:00–04:20 同名两条）。
 * 数据毛病在这里收拾：
 * - 每天末条止于 23:59:59，补到次日零点；
 * - 跨零点的节目在两天各记一段，同名的三小时切段也是一个节目：只把这两种「人为切口」上的
 *   同名相邻两段合回一条——同名但时长不是三小时的相邻两条（两集《医探究竟》、体育赛事分段）照原样留着；
 * - 标题末尾的时长批注去掉（「都市报道60分」是栏目名，不动）；
 * - 同一开始时间只留第一条，结束晚于下一条开始的截到下一条开始。
 * 七路四天里没见到重叠、零时长或占位标题，后两条只是兜底。
 *
 * 为了合得上零点切口，取某一天时连同前后各一天一起取（今天 + 明天两次调用正好不越过「后天」）。
 *
 * 和取流链路不共享状态：只用 channels.js、auth.js 里的常量与请求头和调用方注入的 fetch，
 * 不 import 项目里的其它模块——连同这两个文件拿出去就能单独产出节目单。
 */
import { API_ROOT, wiseConfig, wiseHeaders } from './auth.js'
import { CHANNELS } from './channels.js'

export const EPG_API = `${API_ROOT}/tv/programs/show`
// 一路三天约 20KB
const MAX_BYTES = 512 * 1024
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const PLAN_CHUNK_MS = 3 * 60 * 60 * 1000
const KEY_RE = /^\d{32}$/
const TIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/
const DURATION_NOTE_RE = /\s*\d{1,3}’(?:\d{1,2}”)?$/

/** 上海时间「YYYY-MM-DD HH:mm:ss」→ 毫秒时间戳；显式按 +08:00 算，不看运行机器时区。非法得 NaN。 */
export function shanghaiTime(value) {
  const text = String(value ?? '').trim()
  const match = TIME_RE.exec(text)
  if (!match) return NaN
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number)
  const utc = Date.UTC(year, month - 1, day, hour, minute, second)
  // Date.UTC 会把 02-30、25:00 这类越界值顺延成别的时刻，写回去对不上就是非法
  if (!new Date(utc).toISOString().startsWith(text.replace(' ', 'T'))) return NaN
  return utc - SHANGHAI_OFFSET_MS
}

/** 毫秒时间戳 → 上海日期 YYYY-MM-DD。 */
function shanghaiDate(ms) {
  return new Date(ms + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10)
}

/**
 * 接口 JSON → 按开始时间排好、互不重叠的节目。只收这个频道的行；
 * 状态码不是 200 或结构不对抛错，没排节目返回空数组。
 */
export function parseProgrammes(payload, key) {
  if (Number(payload?.code) !== 200) {
    throw new Error(`津云节目单接口失败：${String(payload?.message || payload?.code || '未知错误').slice(0, 80)}`)
  }
  const days = payload?.programslist?.data
  if (!Array.isArray(days)) throw new Error('津云节目单格式异常')

  const rows = []
  for (const day of days) {
    for (const row of Array.isArray(day?.programs) ? day.programs : []) {
      if (String(row?.channelId ?? day?.channelId) !== key) continue
      const title = String(row?.text ?? '').trim().replace(DURATION_NOTE_RE, '').trim()
      const start = shanghaiTime(row?.startTime)
      const cutAtMidnight = /\s23:59:59$/.test(String(row?.endTime ?? '').trim())
      const stop = shanghaiTime(row?.endTime) + (cutAtMidnight ? 1000 : 0)
      if (title && stop > start) rows.push({ title, start, stop, pieceStart: start, cutAtMidnight })
    }
  }
  rows.sort((a, b) => a.start - b.start)

  const merged = []
  for (const row of rows) {
    const previous = merged.at(-1)
    if (previous?.start === row.start) continue
    if (previous && previous.stop > row.start) previous.stop = row.start
    const artificialCut = previous?.cutAtMidnight || previous?.stop - previous?.pieceStart === PLAN_CHUNK_MS
    if (previous && previous.title === row.title && previous.stop === row.start && artificialCut) {
      previous.stop = row.stop
      previous.pieceStart = row.start
      previous.cutAtMidnight = row.cutAtMidnight
      continue
    }
    merged.push({ ...row })
  }
  return merged.map(({ title, start, stop }) => ({ title, start, stop }))
}

async function readCapped(response) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error('津云节目单响应过大')
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text + decoder.decode()
    size += value.byteLength
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => {})
      throw new Error('津云节目单响应过大')
    }
    text += decoder.decode(value, { stream: true })
  }
}

export function programmesUrl(key, from, to) {
  return `${EPG_API}/${from}/${to}/${key}/timestamp=0`
}

export default {
  id: 'tianjin',
  // 今天 + 明天：明天上午往后已是编排计划，后天整天都是，不再往后取
  days: 2,

  /** 本模块哪些频道出节目单：频道 ref、显示名 → 频道 ID。 */
  channels() {
    return CHANNELS.map(channel => ({ ref: channel.ref, name: channel.name, key: channel.channelId }))
  },

  /**
   * 取一个频道某一天（上海日期 YYYYMMDD）的节目，按开始时间升序。
   * 与当天有交集的都算，跨零点那条两天都带着，由调用方按开始时间去重。
   */
  async programmes(key, day, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
    const date = String(day)
    const dayStart = /^\d{8}$/.test(date)
      ? shanghaiTime(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)} 00:00:00`)
      : NaN
    if (!KEY_RE.test(String(key)) || !Number.isFinite(dayStart)) throw new Error('津云节目单参数非法')
    const dayEnd = dayStart + DAY_MS

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let payload
    try {
      const response = await fetchImpl(programmesUrl(String(key), shanghaiDate(dayStart - DAY_MS), shanghaiDate(dayEnd)), {
        redirect: 'manual',
        signal: controller.signal,
        headers: wiseHeaders(wiseConfig()),
      })
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {})
        throw new Error(`津云节目单 HTTP ${response.status}`)
      }
      // 接口声明 text/html，正文是 JSON
      try {
        payload = JSON.parse(await readCapped(response))
      } catch (error) {
        if (/过大/.test(error?.message)) throw error
        throw new Error('津云节目单不是 JSON')
      }
    } finally {
      clearTimeout(timer)
    }
    return parseProgrammes(payload, String(key))
      .filter(item => item.start < dayEnd && item.stop > dayStart)
  },
}
