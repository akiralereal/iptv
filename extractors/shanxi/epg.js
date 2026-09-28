/**
 * 山西广电官方节目单。
 *
 * 官网直播页的节目单取自 apphhplushttps.sxrtv.com/epg/<epgKey>.json：每个频道一份静态文件，
 * JSONP 包着 [{ name, start_time, end_time, liveid, ... }]，时间是上海时间「YYYY-MM-DD HH:mm:ss」。
 * 不用登录、不带签名、不看来源头与 UA；键不存在回 404 页面。一份文件装着往前约 30 天、
 * 往后从次日凌晨（黄河电视台）到两周多（临汾）不等，省级每天傍晚前后整份重写；
 * 按天取时同一轮只下一次。
 *
 * 地市十套里只有太原、晋中、临汾在更新。其余七套的文件自 2024-12-19 建好就是空数组，
 * 官网页面对它们也只画每小时一格的「精彩节目」占位——官方本来就没有。映射仍保留：
 * 空文件按当天没发处理（留给外部源），哪天官方补上就自动有了。
 *
 * 和取流链路没有任何共享状态：只用 channels.js 的频道表和调用方注入的 fetch，
 * 不 import 项目里的其它模块——整份连同 channels.js 拿出去就能单独产出节目单。
 */
import { CHANNELS } from './channels.js'

export const EPG_ORIGIN = 'https://apphhplushttps.sxrtv.com'
// 最大的经济与科技一份约 250 KB
const MAX_BYTES = 2 * 1024 * 1024
// 今天、明天两次调用是同时发出的，共用一次下载；官方 CDN 自己也只缓存 60 秒
const FILE_TTL_MS = 2 * 60 * 1000
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const KEY_RE = /^[A-Za-z0-9]{1,32}$/
const TIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/
const JSONP_RE = /^liveList\.jsonpCallback\(([\s\S]*)\);?$/

/** 上海时间「YYYY-MM-DD HH:mm:ss」→ 毫秒时间戳；显式按 +08:00 算，不看运行机器时区。非法日期得 NaN。 */
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

/**
 * 整份文件 → 按开始时间排好的节目。官方数据里两种毛病在这里收拾：
 * - 起止相同的零时长行（临汾每周一条），后面紧跟同一时刻开始的正经节目，丢掉；
 * - 每天最后一条常被拉长到次日早上六七点，和次日零点后排的节目叠在一起
 *  （太原、文体生活每周都有，最长叠五个多小时）：一个频道同一时刻只播一个节目，
 *   把每条的结束截到下一条开始。
 */
export function parseEpgFile(text) {
  const match = JSONP_RE.exec(String(text).trim())
  if (!match) throw new Error('山西广电节目单不是预期的 JSONP')
  let rows
  try {
    rows = JSON.parse(match[1])
  } catch {
    throw new Error('山西广电节目单 JSON 无效')
  }
  if (!Array.isArray(rows)) throw new Error('山西广电节目单格式异常')

  const items = []
  for (const row of rows) {
    const title = String(row?.name ?? '').trim()
    const start = shanghaiTime(row?.start_time)
    const stop = shanghaiTime(row?.end_time)
    if (title && stop > start) items.push({ title, start, stop })
  }
  items.sort((a, b) => a.start - b.start)
  const programmes = []
  for (const item of items) {
    const previous = programmes.at(-1)
    if (previous?.start === item.start) continue
    if (previous && previous.stop > item.start) previous.stop = item.start
    programmes.push(item)
  }
  return programmes
}

async function readCapped(response) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error('山西广电节目单响应过大')
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
      throw new Error('山西广电节目单响应过大')
    }
    text += decoder.decode(value, { stream: true })
  }
}

async function download(key, fetchImpl, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${EPG_ORIGIN}/epg/${key}.json`, { redirect: 'manual', signal: controller.signal })
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {})
      throw new Error(`山西广电节目单 HTTP ${response.status}`)
    }
    return parseEpgFile(await readCapped(response))
  } finally {
    clearTimeout(timer)
  }
}

// epgKey → { expiresAt, promise }；存的是进行中的下载本身，并发的两天调用拿到同一个
const files = new Map()

function loadFile(key, fetchImpl, timeoutMs) {
  const now = Date.now()
  for (const [cachedKey, entry] of files) if (entry.expiresAt <= now) files.delete(cachedKey)
  let entry = files.get(key)
  if (!entry) {
    entry = { expiresAt: now + FILE_TTL_MS, promise: download(key, fetchImpl, timeoutMs) }
    files.set(key, entry)
    // 失败不留：同一轮已在等的照样拿到这个错误，下一轮重新下载
    const current = entry
    current.promise.catch(() => { if (files.get(key) === current) files.delete(key) })
  }
  return entry.promise
}

export function clearCache() {
  files.clear()
}

export default {
  id: 'shanxi',
  // 今天 + 明天：全量更新默认 8 小时一轮，多备一天，跨零点前后播放器仍有节目可显示
  days: 2,

  /** 本模块哪些频道出节目单：频道 ref、显示名 → 节目单文件名。 */
  channels() {
    return CHANNELS.map(channel => ({ ref: channel.ref, name: channel.name, key: channel.epgKey }))
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
    if (!KEY_RE.test(String(key)) || !Number.isFinite(dayStart)) throw new Error('山西广电节目单参数非法')
    const dayEnd = dayStart + DAY_MS
    const programmes = await loadFile(String(key), fetchImpl, timeoutMs)
    return programmes
      .filter(item => item.start < dayEnd && item.stop > dayStart)
      .map(item => ({ ...item }))
  },
}
