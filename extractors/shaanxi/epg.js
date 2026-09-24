/**
 * 陕西广电官方节目单。
 *
 * 官网看电视页的节目单取自 qidian.sxtvs.com/api/v3/program/tv?channel=<频道键>（起点新闻后端），
 * 频道键就是频道目录里的键（star、1、2、3、5、7、nl、11），目录里每路的 playlist 字段也正指着它。
 * 返回一段脚本 `var snr_Playlist = [{ start, end, name, allowLive }, ...];`，时间只有上海时间的
 * 「HH:mm」，没有日期：只给服务器当天的一份，date、day 之类的参数一概忽略；不认识的频道回空正文。
 * 不用登录、不带签名、不看来源头与 UA。官网自己也是零点过后重新拉一次。
 *
 * 所以每轮只取今天，而「今天」按这次响应的 Date 头换算成上海日期——零点前后本机钟与官网
 * 不同步时，宁可当天没有，也不把前一天的节目单安到新的一天上。
 *
 * 数据毛病在这里收拾：
 * - 同一时刻排两条（国歌紧跟新闻联播、两条宣传片、移动电视夜里「晚曲台标」与「彩图」），
 *   两条起止都一样，播出的是后一条，只留后一条；
 * - 起止相同的零时长行（移动电视每天最后一条 23:59 宣传）丢掉；
 * - 每天最后一条止于 23:59，接到当天 24:00，免得零点前空一分钟；
 * - 万一哪条比下一条开始得晚才结束，截到下一条开始。
 *
 * allowLive 为 0 时官网播放器会切到一路垫片，只影响网页播放，节目单照常输出。
 *
 * 和取流链路没有任何共享状态：只用 channels.js 的频道表和调用方注入的 fetch，
 * 不 import 项目里的其它模块——整份连同 channels.js 拿出去就能单独产出节目单。
 */
import { CHANNELS } from './channels.js'

export const EPG_API = 'https://qidian.sxtvs.com/api/v3/program/tv'
// 实测一天最多的移动电视 131 条、11 KB
const MAX_BYTES = 512 * 1024
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const MINUTE_MS = 60 * 1000
const KEY_RE = /^[a-z0-9]{1,8}$/
const CLOCK_RE = /^(\d{1,2}):(\d{2})$/
const SCRIPT_RE = /^var\s+snr_Playlist\s*=\s*([\s\S]*?);?$/

/** 上海日期 YYYYMMDD → 当天 00:00（+08:00）的毫秒时间戳；与运行机器的时区无关，非法日期返回 NaN。 */
export function dayStartMs(day) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(day))
  if (!match) return NaN
  const [year, month, date] = match.slice(1).map(Number)
  const utc = new Date(Date.UTC(year, month - 1, date))
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== date) return NaN
  return utc.getTime() - SHANGHAI_OFFSET_MS
}

/** 毫秒时间戳 → 上海日期 YYYYMMDD。 */
export function shanghaiDay(ms) {
  const d = new Date(Number(ms) + SHANGHAI_OFFSET_MS)
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
}

/** 「HH:mm」→ 距当天零点的毫秒；24:00 也收（当天结束），格式不对返回 NaN。 */
export function clockOffset(value) {
  const match = CLOCK_RE.exec(String(value ?? '').trim())
  if (!match) return NaN
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 24 || minute > 59 || (hour === 24 && minute)) return NaN
  return (hour * 60 + minute) * MINUTE_MS
}

/**
 * 接口正文 + 这份节目单所属的上海日期 → 按开始时间排好的节目。
 * 空正文（官方没发 / 不认识的频道）得空数组；正文不是预期的脚本照实报错。
 */
export function parsePlaylist(text, day) {
  const body = String(text ?? '').trim()
  if (!body) return []
  const match = SCRIPT_RE.exec(body)
  if (!match) throw new Error('陕西广电节目单不是预期的脚本')
  let rows
  try {
    rows = JSON.parse(match[1])
  } catch {
    throw new Error('陕西广电节目单 JSON 无效')
  }
  if (!Array.isArray(rows)) throw new Error('陕西广电节目单格式异常')

  const dayStart = dayStartMs(day)
  if (!Number.isFinite(dayStart)) throw new Error('陕西广电节目单日期非法')
  const dayEnd = dayStart + DAY_MS
  const items = []
  for (const row of rows) {
    const title = String(row?.name ?? '').trim()
    const startOffset = clockOffset(row?.start)
    let stopOffset = clockOffset(row?.end)
    if (!title || !Number.isFinite(startOffset) || !Number.isFinite(stopOffset) || startOffset >= DAY_MS) continue
    // 跨零点写成「23:30–00:30」的，结束算到次日
    if (stopOffset < startOffset) stopOffset += DAY_MS
    if (stopOffset === startOffset) continue
    items.push({ title, start: dayStart + startOffset, stop: dayStart + stopOffset })
  }
  // 有条目却一条都读不出来，多半是时间格式改了；抛出去比悄悄当成「当天没发」好查
  if (rows.length && !items.length) throw new Error('陕西广电节目单时间格式异常')

  // 稳定排序：同一时刻的几条保持官方顺序，后一条覆盖前一条
  items.sort((a, b) => a.start - b.start)
  const programmes = []
  for (const item of items) {
    const previous = programmes.at(-1)
    if (previous?.start === item.start) {
      programmes[programmes.length - 1] = item
      continue
    }
    if (previous && previous.stop > item.start) previous.stop = item.start
    programmes.push(item)
  }
  const last = programmes.at(-1)
  if (last && last.stop === dayEnd - MINUTE_MS) last.stop = dayEnd
  return programmes
}

async function discard(response) {
  await response.body?.cancel?.().catch(() => {})
}

async function readCapped(response) {
  if (Number(response.headers?.get?.('content-length')) > MAX_BYTES) {
    await discard(response)
    throw new Error('陕西广电节目单响应过大')
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
      throw new Error('陕西广电节目单响应过大')
    }
    text += decoder.decode(value, { stream: true })
  }
}

export default {
  id: 'shaanxi',
  // 接口只给服务器当天：只取今天，全量更新每轮重取，零点后的下一轮才有新一天
  days: 1,

  /** 本模块哪些频道出节目单：频道 ref、显示名 → 节目单接口的 channel 参数。 */
  channels() {
    return CHANNELS.map(channel => ({ ref: channel.ref, name: channel.name, key: channel.key }))
  },

  /** 取一个频道某一天（上海日期 YYYYMMDD）的节目，按开始时间升序；官网当天不是这一天就是空数组。 */
  async programmes(key, day, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
    const date = String(day)
    if (!KEY_RE.test(String(key)) || !Number.isFinite(dayStartMs(date))) throw new Error('陕西广电节目单参数非法')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const url = new URL(EPG_API)
      url.searchParams.set('channel', String(key))
      const response = await fetchImpl(url.href, {
        headers: { Accept: '*/*', Referer: 'http://live.snrtv.com/' },
        redirect: 'manual',
        signal: controller.signal,
      })
      if (!response.ok) {
        await discard(response)
        throw new Error(`陕西广电节目单 HTTP ${response.status}`)
      }
      const served = Date.parse(response.headers?.get?.('date') || '')
      const servedDay = shanghaiDay(Number.isFinite(served) ? served : Date.now())
      const text = await readCapped(response)
      return servedDay === date ? parsePlaylist(text, date) : []
    } finally {
      clearTimeout(timer)
    }
  },
}
