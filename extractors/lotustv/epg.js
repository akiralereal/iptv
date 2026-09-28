/**
 * 澳门莲花卫视官方节目单。
 *
 * 官网「節目單」页（lotustv.mo/zh/programme）是服务端直接渲染的 HTML，不用登录、不带签名。实测（2026-09-25）：
 * - 一页给本周一到周日七天：顶部 #weekdayTab 七个标签只写「日号 + 星期」（21 一 … 27 日），
 *   下面七个 .programme-content 按 data-id 0–6 对应。没有日期参数，下周的要等到周一官网换页。
 * - 每档只有开始时间 HH:MM（澳门时间，与上海同为 UTC+8）和两段名字：栏目名（「經典影院」）
 *   与本期节目名（「拳王阿里」），第二段有时为空。没有结束时间，结束取下一档开始；
 *   当天最后一档取次日第一档的开始，周日最后一档取当天 24:00。
 * - 节目名是繁体，照官方原样。
 *
 * 和取流链路没有共享状态：只用频道表 channels.js 和调用方注入的 fetch，不 import 项目内其它模块。
 */
import { CHANNEL } from './channels.js'

export const EPG_PAGE = 'https://www.lotustv.mo/zh/programme'
const EPG_KEY = 'lotustv'
// 整页约 30KB；留足余量，超出按异常处理
const MAX_BYTES = 1024 * 1024
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** 上海日期 YYYYMMDD → { 当天零点, 次日零点, 周内序号（周一 0 … 周日 6）, 本周一的日号 }。 */
export function dayInfo(day) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(day ?? ''))
  if (!match) throw new Error('莲花卫视节目单参数非法')
  const [year, month, date] = match.slice(1).map(Number)
  const start = Date.UTC(year, month - 1, date) - SHANGHAI_OFFSET_MS
  const local = new Date(start + SHANGHAI_OFFSET_MS)
  if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== date) {
    throw new Error('莲花卫视节目单参数非法')
  }
  const weekday = (local.getUTCDay() + 6) % 7
  const monday = new Date(start + SHANGHAI_OFFSET_MS - weekday * DAY_MS).getUTCDate()
  return { start, end: start + DAY_MS, weekday, monday }
}

const decode = text => String(text ?? '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim()

/** 整页 → { tabDays: [日号×7], days: [[{ offset(秒), title }]×7] }；结构不对就抛错。 */
export function parsePage(html) {
  const text = String(html ?? '')
  const tabBlock = /id="weekdayTab"[^>]*>([\s\S]*?)<\/div>/.exec(text)?.[1]
  if (!tabBlock) throw new Error('莲花卫视节目单页面格式异常')
  const tabDays = [...tabBlock.matchAll(/<p data-id="(\d)"[^>]*>\s*<span>\s*(\d{1,2})\s*<\/span>/g)]
    .map(m => ({ id: Number(m[1]), date: Number(m[2]) }))
  if (tabDays.length !== 7 || tabDays.some((tab, index) => tab.id !== index)) {
    throw new Error('莲花卫视节目单页面格式异常')
  }

  const parts = text.split(/<div data-id="(\d)" class="programme-content[^"]*">/)
  const days = Array.from({ length: 7 }, () => null)
  for (let i = 1; i < parts.length; i += 2) {
    const id = Number(parts[i])
    const body = parts[i + 1] || ''
    const items = []
    for (const m of body.matchAll(/<p class="time">\s*([^<]*?)\s*<\/p>\s*<p class="name">([\s\S]*?)<\/p>/g)) {
      const time = /^(\d{2}):(\d{2})$/.exec(m[1])
      if (!time || Number(time[1]) > 23 || Number(time[2]) > 59) continue
      const names = [...m[2].matchAll(/<span>([\s\S]*?)<\/span>/g)].map(s => decode(s[1])).filter(Boolean)
      const title = names[1] && names[1] !== names[0] ? `${names[0]} ${names[1]}` : names[0]
      if (!title) continue
      items.push({ offset: Number(time[1]) * 3600 + Number(time[2]) * 60, title })
    }
    if (id >= 0 && id < 7) days[id] = items
  }
  if (days.some(items => items == null)) throw new Error('莲花卫视节目单页面格式异常')
  // 整周有标签却一条都读不出，多半是改版，报错而不是当成「没发」
  if (days.every(items => !items.length)) throw new Error('莲花卫视节目单页面格式异常')
  return { tabDays: tabDays.map(tab => tab.date), days }
}

/** 整页 + 上海日期 → [{ title, start, stop }]；页面不是请求这天所在的周返回空数组。 */
export function parseProgrammes(html, day) {
  const info = dayInfo(day)
  const { tabDays, days } = parsePage(html)
  // 标签只有日号：本周一的日号对不上，说明官网这一页不是请求那天所在的周（周日取「明天」即如此）
  if (tabDays[0] !== info.monday || tabDays[info.weekday] !== new Date(info.start + SHANGHAI_OFFSET_MS).getUTCDate()) {
    return []
  }
  const items = [...days[info.weekday]].sort((a, b) => a.offset - b.offset)
    .filter((item, index, list) => index === 0 || item.offset !== list[index - 1].offset)
  const nextFirst = info.weekday < 6 && days[info.weekday + 1].length
    ? info.end + Math.min(...days[info.weekday + 1].map(item => item.offset)) * 1000
    : info.end
  return items.map((item, index) => ({
    title: item.title,
    start: info.start + item.offset * 1000,
    stop: index + 1 < items.length ? info.start + items[index + 1].offset * 1000 : nextFirst,
  }))
}

async function readCapped(response) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (declared > MAX_BYTES) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error('莲花卫视节目单响应过大')
  }
  const buf = Buffer.from(await response.arrayBuffer())
  if (buf.length > MAX_BYTES) throw new Error('莲花卫视节目单响应过大')
  return buf.toString('utf8')
}

export default {
  id: 'lotustv',
  // 今天 + 明天；周日的「明天」官网还没换页，返回空
  days: 2,

  channels() {
    return [{ ref: CHANNEL.ref, name: CHANNEL.name, key: EPG_KEY }]
  },

  async programmes(key, day, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
    if (key !== EPG_KEY) throw new Error('莲花卫视节目单参数非法')
    dayInfo(day)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(EPG_PAGE, {
        headers: { 'User-Agent': UA, Accept: 'text/html', Referer: 'https://www.lotustv.mo/' },
        redirect: 'manual',
        signal: controller.signal,
      })
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {})
        throw new Error(`莲花卫视节目单 HTTP ${response.status}`)
      }
      return parseProgrammes(await readCapped(response), day)
    } finally {
      clearTimeout(timer)
    }
  },
}
