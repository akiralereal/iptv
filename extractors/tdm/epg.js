/**
 * 澳广视（TDM）官方节目单。
 *
 * 官网直播页自己用的 JSON 接口：GET www.tdm.com.mo/api/v1.0/program-list/<YYYY-MM-DD>?channelId=<号>&type=0，
 * 不用登录、不带签名。实测（2026-10-06）：
 * - 一份是一个「播出日」：从当天 07:00 左右排到次日凌晨五六点（澳视澳门 07:00 → 次日 05:25），
 *   日期参数是澳门日期（与上海同为 UTC+8）。
 * - 每档只有开始时间 date（"2026-10-06 07:00:00"，澳门时间）和标题 title；没有结束时间，取下一档开始，
 *   播出日最后一档拿次日那份的第一档补，都没有就记 30 分钟。
 * - 标题是繁体，照官方原样。
 * - 接口和直播一样只对大陆以外开放，大陆部署取不到（模块在大陆默认关）。
 *
 * 上海某一天 0 点到 24 点跨两个播出日，所以取当天和前一天两份，合起来再截出这一天。
 * 只用频道表 channels.js 和调用方注入的 fetch，不 import 项目内其它模块。
 */
import { CHANNELS } from './channels.js'

export const EPG_API = 'https://www.tdm.com.mo/api/v1.0/program-list'
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const LAST_PROGRAMME_MS = 30 * 60 * 1000
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** 上海日期 YYYYMMDD → { 当天零点, 次日零点, 当天与前一天的 YYYY-MM-DD }。 */
export function dayWindow(day) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(day ?? ''))
  if (!match) throw new Error('澳广视节目单参数非法')
  const [year, month, date] = match.slice(1).map(Number)
  const start = Date.UTC(year, month - 1, date) - SHANGHAI_OFFSET_MS
  const local = new Date(start + SHANGHAI_OFFSET_MS)
  if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== date) {
    throw new Error('澳广视节目单参数非法')
  }
  const iso = ms => new Date(ms + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10)
  return { start, end: start + DAY_MS, today: iso(start), yesterday: iso(start - DAY_MS) }
}

/** "2026-10-06 07:00:00"（澳门时间）→ 毫秒；格式不对返回 NaN。 */
export function macauTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value ?? '').trim())
  if (!match) return NaN
  const [year, month, date, hour, minute, second = 0] = match.slice(1).map(Number)
  return Date.UTC(year, month - 1, date, hour, minute, second) - SHANGHAI_OFFSET_MS
}

/** 接口响应 → [{ start, title }]；结构不对就抛错，空数组照常返回（官方当天没排）。 */
export function parseRows(payload) {
  if (!Array.isArray(payload?.data)) throw new Error('澳广视节目单接口数据格式异常')
  return payload.data
    .map(row => ({ start: macauTime(row?.date), title: String(row?.title || row?.programName || '').trim() }))
    .filter(row => Number.isFinite(row.start) && row.title)
}

/** 两个播出日的节目合起来补结束时间，截出上海这一天（开始时间落在当天的）。 */
export function programmesForDay(rows, { start, end }) {
  const seen = new Set()
  const sorted = rows
    .filter(row => (seen.has(row.start) ? false : seen.add(row.start)))
    .sort((a, b) => a.start - b.start)
  return sorted
    .map((row, index) => ({
      title: row.title,
      start: row.start,
      stop: sorted[index + 1]?.start ?? row.start + LAST_PROGRAMME_MS,
    }))
    .filter(item => item.start >= start && item.start < end)
}

async function fetchDay(channelId, date, { fetchImpl, timeoutMs }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${EPG_API}/${date}?channelId=${channelId}&type=0`, {
      headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://www.tdm.com.mo/zh-hans/live?ssr=on' },
      signal: controller.signal,
    })
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {})
      throw new Error(`澳广视节目单 HTTP ${response.status}`)
    }
    return parseRows(await response.json())
  } finally {
    clearTimeout(timer)
  }
}

export default {
  id: 'tdm',
  // 今天 + 明天：明天那份官方通常已经排好
  days: 2,

  channels() {
    return CHANNELS.map(channel => ({ ref: channel.ref, name: channel.name, key: String(channel.channelId) }))
  },

  async programmes(key, day, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
    if (!CHANNELS.some(channel => String(channel.channelId) === String(key))) throw new Error('澳广视节目单参数非法')
    const window = dayWindow(day)
    const options = { fetchImpl, timeoutMs }
    // 前一天那份只管当天凌晨那几档，取不到不连累当天
    const [yesterday, today] = await Promise.allSettled([
      fetchDay(key, window.yesterday, options),
      fetchDay(key, window.today, options),
    ])
    if (today.status === 'rejected') throw today.reason
    return programmesForDay([...(yesterday.status === 'fulfilled' ? yesterday.value : []), ...today.value], window)
  },
}
