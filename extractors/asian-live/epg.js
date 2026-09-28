/**
 * YTN News 与 NHK World 的官方节目单。
 *
 * 两家都在 UTC+9（韩国 / 日本），官方节目表按当地日期出；上海日 D 是当地 D 日 01:00 到
 * D+1 日 01:00，所以每次取当地 D、D+1 两天，留下上海日 D 内开始的节目和零点时正在播的那一条。
 * 时间一律按 +09:00 换成绝对时刻，与运行机器的时区无关。
 *
 * NHK World：英文直播页（www3.nhk.or.jp/nhkworld/en/live_tv/）的节目表取自
 *   masterpl.hls.nhkworld.jp/epg/w/<YYYYMMDD 日本日期>.json，静态文件，不用登录、不带 key。
 *   实测（2026-09-25）：前后各约一周都有，没发的日期回 404；每条带 +09:00 的起止时间。
 *   extractProgram=1 的是一两分钟的站台宣传（INFO 之类），官网英文页把它们并进前一条、
 *   不单列，这里照做。标题取节目名 title。
 * YTN：官网移动版「TV 편성표」（m.ytn.co.kr/schedule.php?date=YYYY-MM-DD，韩国日期）是
 *   服务端渲染的 HTML，没有 JSON 接口。每条只有「HH:MM」开始时间，结束取下一条的开始；
 *   今天起约一周有数据，再往后页面照常出但列表为空；日期非法回 404。页面会回显所查日期，
 *   拿来核对确实是请求的那一天。
 *
 * 和取流链路没有任何共享状态：只用频道表 channels.js 和调用方注入的 fetch，
 * 不 import 项目里的其它模块——整份连同 channels.js 拿出去就能单独产出节目单。
 */
import { SOURCES, sourceRef } from './channels.js'

export const NHK_EPG_BASE = 'https://masterpl.hls.nhkworld.jp/epg/w/'
export const YTN_SCHEDULE_PAGE = 'https://m.ytn.co.kr/schedule.php'
// NHK 一天约 160KB，YTN 页面约 32KB；留足余量，超出按异常处理
const MAX_BYTES = 2 * 1024 * 1024
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const UTC9_OFFSET_MS = 9 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
// 只认带时区的 ISO 时间，免得 Date.parse 按运行机器的本地时区猜
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/

/**
 * 上海日期 YYYYMMDD → 上海日区间 + 要取的两个当地（UTC+9）日期。
 * 当地日期的数字与上海日 D、D+1 相同，这里用日历运算得出，与运行机器的时区无关。
 */
export function dayWindow(day) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(day ?? ''))
  if (!match) throw new Error('亚洲直播节目单参数非法')
  const [year, month, date] = match.slice(1).map(Number)
  const utcMidnight = Date.UTC(year, month - 1, date)
  const check = new Date(utcMidnight)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) {
    throw new Error('亚洲直播节目单参数非法')
  }
  const localDays = [0, 1].map(offset => {
    const d = new Date(utcMidnight + offset * DAY_MS)
    const y = d.getUTCFullYear()
    const m = String(d.getUTCMonth() + 1).padStart(2, '0')
    const dd = String(d.getUTCDate()).padStart(2, '0')
    // midnight：当地零点的绝对时刻
    return { compact: `${y}${m}${dd}`, dashed: `${y}-${m}-${dd}`, midnight: utcMidnight + offset * DAY_MS - UTC9_OFFSET_MS }
  })
  const start = utcMidnight - SHANGHAI_OFFSET_MS
  return { start, end: start + DAY_MS, localDays }
}

/**
 * 按开始时间排好、同一开始只留一条后，截出上海日内的节目：日内开始的，加上零点时正在播的那一条
 * （当地 D 日 00:00–01:00 开始的归上海前一天，流水线又只从今天取起，不带上它今天零点后会空一段；
 * 相邻两天都带上的同一条由调用方按开始时间去重）。结束晚于下一条开始的截到下一条开始。
 */
function clip(items, window) {
  items.sort((a, b) => a.start - b.start)
  const unique = items.filter((item, index) => index === 0 || item.start !== items[index - 1].start)
  const programmes = []
  unique.forEach((item, index) => {
    if (item.start >= window.end) return
    const nextStart = unique[index + 1]?.start
    let stop = item.stop != null && item.stop > item.start ? item.stop : (nextStart ?? window.end)
    if (nextStart != null && stop > nextStart) stop = nextStart
    if (stop <= window.start) return
    programmes.push({ title: item.title, start: item.start, stop })
  })
  return programmes
}

/** NHK 当地某天的 JSON → [{ title, start, stop, filler }]；时间读不出的跳过。 */
export function parseNhkDay(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.data)) {
    throw new Error('NHK World 节目单数据格式异常')
  }
  const items = []
  for (const row of payload.data) {
    const startText = String(row?.startTime ?? '')
    const endText = String(row?.endTime ?? '')
    const start = ISO_RE.test(startText) ? Date.parse(startText) : NaN
    if (!Number.isFinite(start)) continue
    const stop = ISO_RE.test(endText) ? Date.parse(endText) : NaN
    items.push({
      title: String(row?.title ?? '').trim(),
      start,
      stop: Number.isFinite(stop) ? stop : null,
      filler: row?.extractProgram === 1,
    })
  }
  // 有数据却一条时间都读不出，多半是接口改了格式，报错而不是当成「当天没发」
  if (payload.data.length && !items.length) throw new Error('NHK World 节目单数据格式异常')
  return items
}

/** 当地 D、D+1 两天的条目 → 上海日内的节目；宣传短片并进前一条（与官网英文页一致）。 */
export function nhkProgrammes(days, day) {
  const window = dayWindow(day)
  const rows = days.flat().sort((a, b) => a.start - b.start)
  const merged = []
  for (const row of rows) {
    if (row.filler) {
      const last = merged[merged.length - 1]
      if (last && row.stop != null && (last.stop == null || row.stop > last.stop)) last.stop = row.stop
      continue
    }
    if (row.title) merged.push({ title: row.title, start: row.start, stop: row.stop })
  }
  return clip(merged, window)
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
function decodeHtml(text) {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body) => {
      if (body[0] === '#') {
        const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : Number(body.slice(1))
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity
      }
      return ENTITIES[body.toLowerCase()] ?? entity
    })
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * YTN 편성표页面 → 当地那天的 [{ title, start }]。
 * dayInfo 是 dayWindow().localDays 里的一项；页面回显的日期必须就是它。
 */
export function parseYtnDay(html, dayInfo) {
  const text = String(html ?? '')
  const echoed = /<input[^>]*\bname="date"[^>]*\bvalue="([^"]*)"/.exec(text)?.[1]
  if (echoed !== dayInfo.dashed) throw new Error('YTN 节目单页面与请求日期不符')
  const begin = text.indexOf('<ul class="schedule_list_wrap">')
  if (begin < 0) throw new Error('YTN 节目单页面格式异常')
  const endMark = text.indexOf('<div class="schedule_info">', begin)
  const block = text.slice(begin, endMark < 0 ? undefined : endMark)

  const items = []
  const entries = block.split(/<li class="schedule_list\b/).slice(1)
  for (const entry of entries) {
    const time = /<div class="time">\s*(\d{2}):(\d{2})\s*<\/div>/.exec(entry)
    const rawTitle = /<span class="title">([\s\S]*?)<\/span>/.exec(entry)?.[1]
    if (!time || rawTitle == null) continue
    const [hour, minute] = [Number(time[1]), Number(time[2])]
    if (hour > 23 || minute > 59) continue
    const title = decodeHtml(rawTitle)
    if (!title) continue
    items.push({ title, start: dayInfo.midnight + (hour * 3600 + minute * 60) * 1000 })
  }
  // 有条目却一条都读不出，多半是页面改版，报错而不是当成「当天没发」
  if (entries.length && !items.length) throw new Error('YTN 节目单页面格式异常')
  return items
}

/** 当地 D、D+1 两天的条目 → 上海日内的节目，结束取下一条的开始。 */
export function ytnProgrammes(days, day) {
  return clip(days.flat().map(item => ({ ...item, stop: null })), dayWindow(day))
}

/** 读响应体，超过上限就中止，不把整份读进内存再判断。 */
async function readCapped(response, label) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (declared > MAX_BYTES) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error(`${label} 节目单响应过大`)
  }
  if (!response.body?.getReader) {
    const buf = Buffer.from(await response.arrayBuffer())
    if (buf.length > MAX_BYTES) throw new Error(`${label} 节目单响应过大`)
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
      throw new Error(`${label} 节目单响应过大`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 取一个地址的文本；allow404 时 404 返回 null（NHK 没发的日期）。 */
async function fetchText(url, { fetchImpl, signal, label, headers, allow404 = false }) {
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': UA, ...headers },
    // 两家都不跳转；YTN 非法日期是 404 加脚本跳错误页，真跳了按失败处理
    redirect: 'manual',
    signal,
  })
  if (allow404 && response.status === 404) {
    await response.body?.cancel?.().catch(() => {})
    return null
  }
  if (!response.ok) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error(`${label} 节目单 HTTP ${response.status}`)
  }
  return readCapped(response, label)
}

const FETCHERS = {
  async nhk(day, { fetchImpl, signal }) {
    const { localDays } = dayWindow(day)
    const texts = await Promise.all(localDays.map(local => fetchText(`${NHK_EPG_BASE}${local.compact}.json`, {
      fetchImpl,
      signal,
      label: 'NHK World',
      headers: { Accept: 'application/json', Referer: 'https://www3.nhk.or.jp/nhkworld/en/live_tv/' },
      allow404: true,
    })))
    const days = texts.map(text => {
      if (text == null) return []
      try {
        return parseNhkDay(JSON.parse(text))
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error('NHK World 节目单不是 JSON')
        throw error
      }
    })
    return nhkProgrammes(days, day)
  },

  async ytn(day, { fetchImpl, signal }) {
    const { localDays } = dayWindow(day)
    const pages = await Promise.all(localDays.map(local => fetchText(`${YTN_SCHEDULE_PAGE}?date=${local.dashed}`, {
      fetchImpl,
      signal,
      label: 'YTN',
      headers: { Accept: 'text/html,application/xhtml+xml', Referer: 'https://m.ytn.co.kr/' },
    })))
    return ytnProgrammes(pages.map((html, index) => parseYtnDay(html, localDays[index])), day)
  },
}

const KIND_BY_ID = new Map(SOURCES.filter(source => FETCHERS[source.kind]).map(source => [source.id, source.kind]))

export default {
  id: 'asian-live',
  // 今天 + 明天：全量更新默认 8 小时一轮，多备一天，跨零点前后播放器仍有节目可显示
  days: 2,

  /** 本模块哪些频道出节目单：频道 ref、显示名 → 频道 id（按它选 YTN / NHK 的取法）。 */
  channels() {
    return SOURCES
      .filter(source => KIND_BY_ID.has(source.id))
      .map(source => ({ ref: sourceRef(source), name: source.name, key: source.id }))
  },

  /** 取一个频道某一天（上海日期 YYYYMMDD）的节目，按开始时间升序；官方当天没发返回空数组。 */
  async programmes(key, day, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
    const kind = KIND_BY_ID.get(key)
    if (!kind) throw new Error('亚洲直播节目单参数非法')
    dayWindow(day)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await FETCHERS[kind](day, { fetchImpl, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  },
}
