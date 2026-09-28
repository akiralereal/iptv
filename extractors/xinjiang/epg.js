/**
 * 新疆广播电视台官方节目单。
 *
 * 丝路视听网直播页（www.xjtvs.com.cn/column/tv/434）的「节目单」标签取自
 * GET slstapi.xjtvs.com.cn/api/TVLiveV100/TVGuideList?tvChannelId=<Id>&date=<YYYY-M-D 00:00:00>&json=true。
 * 频道列表要走官网那套签名，节目单不用：不登录、不签名、不看来源头与 UA。实测（2026-09-25）：
 * - tvChannelId 是频道接口的 Id（channels.js 的 channelId）；date 照页面写成月、日不补零的
 *   「YYYY-M-D 00:00:00」。日期写坏回 HTTP 500 空响应，不认识的频道回 success 与空数组。
 * - 每行 TVDate（YYYY-MM-DD）加 StartTime / EndTime（HH:mm）。用的是北京时间而不是新疆时间：
 *   新疆卫视转播央视《新闻联播》那条排在 19:00，页面标「正在播」的也按北京时间对得上。
 *   EndTime 含当分钟：下一条总在它后一分钟开始，所以结束取 EndTime 后一分钟。
 * - 当天最后一条的 EndTime 写 00:00，或写成次日零点后几分钟；次日的表从 00:00 起把这条
 *   跨零点的节目再列一遍。于是每天截在零点，两天拼起来正好首尾相接、不重叠。
 * - 往前至少九天、往后到后天都有，再往后是空数组。体育健康每天凌晨一点前后才开始排。
 * - 少儿频道（XJTV-8）往前往后都是空数组，官网节目单标签也是空的——官方本来就没有。
 *   映射仍保留：空数组按当天没发处理（留给外部源），哪天官方补上就自动有了。
 * - 节目名偶有尾随空格。
 *
 * 和取流链路没有任何共享状态：只用 channels.js 的频道表和调用方注入的 fetch，
 * 不 import 项目里的其它模块——整份连同 channels.js 拿出去就能单独产出节目单。
 */
import { CHANNELS } from './channels.js'

export const EPG_API = 'https://slstapi.xjtvs.com.cn/api/TVLiveV100/TVGuideList'
const PAGE = 'https://www.xjtvs.com.cn/column/tv/434'
// 一天二十来条、约 5KB；留足余量，超出按异常处理
const MAX_BYTES = 256 * 1024
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const MINUTE_MS = 60 * 1000
const KEY_RE = /^\d{1,6}$/
const TIME_RE = /^(\d{1,2}):(\d{2})$/
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

/** 上海日期 YYYYMMDD → { dayStart（当天零点的毫秒时间戳）, tvDate: YYYY-MM-DD, query: YYYY-M-D 00:00:00 }；非法日期返回 null。 */
export function guideDay(day) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(day ?? ''))
  if (!match) return null
  const [year, month, date] = match.slice(1).map(Number)
  const utc = Date.UTC(year, month - 1, date)
  const check = new Date(utc)
  // 拒绝 20260230 这类会被 Date.UTC 顺延的日期
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) return null
  return {
    dayStart: utc - SHANGHAI_OFFSET_MS,
    tvDate: `${match[1]}-${match[2]}-${match[3]}`,
    query: `${year}-${month}-${date} 00:00:00`,
  }
}

/** 'HH:mm' → 当天第几分钟；不合法得 NaN。 */
export function minuteOfDay(text) {
  const match = TIME_RE.exec(String(text ?? '').trim())
  if (!match) return NaN
  const hour = Number(match[1])
  const minute = Number(match[2])
  return hour <= 23 && minute <= 59 ? hour * 60 + minute : NaN
}

/**
 * 接口 JSON → 当天（上海日期 YYYYMMDD）的 [{ title, start, stop }]，按开始时间升序。
 * 开始 = 当天零点 + StartTime；结束 = EndTime 后一分钟（EndTime 比开始早就是跨了零点），
 * 再截到下一条开始与次日零点；EndTime 读不出的取下一条开始，最后一条取次日零点。
 * 同一开始时间只留一条；TVDate 不是请求那天的行不要。
 */
export function parseGuide(payload, day) {
  const target = guideDay(day)
  if (!target) throw new Error('新疆节目单参数非法')
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('新疆节目单数据格式异常')
  if (payload.success !== true || Number(payload.code) !== 0) {
    throw new Error(`新疆节目单接口返回异常：${payload.message || payload.code || '未知错误'}`)
  }
  if (payload.data == null) return []
  if (!Array.isArray(payload.data)) throw new Error('新疆节目单数据格式异常')

  const { dayStart, tvDate } = target
  const dayEnd = dayStart + DAY_MS
  const items = []
  for (const row of payload.data) {
    const title = String(row?.Name ?? '').trim()
    const startMinute = minuteOfDay(row?.StartTime)
    if (!title || Number.isNaN(startMinute)) continue
    if (row?.TVDate != null && String(row.TVDate).trim() !== tvDate) continue
    const endMinute = minuteOfDay(row?.EndTime)
    const start = dayStart + startMinute * MINUTE_MS
    let end = NaN
    if (!Number.isNaN(endMinute)) {
      end = dayStart + endMinute * MINUTE_MS + MINUTE_MS
      if (endMinute < startMinute) end += DAY_MS
    }
    items.push({ title, start, end })
  }
  // 有数据却一条都读不出，多半是接口改了格式，报错而不是当成「当天没发」
  if (payload.data.length && !items.length) throw new Error('新疆节目单数据格式异常')

  items.sort((a, b) => a.start - b.start)
  const unique = items.filter((item, index) => index === 0 || item.start !== items[index - 1].start)
  return unique.map((item, index) => {
    const limit = Math.min(unique[index + 1]?.start ?? dayEnd, dayEnd)
    const stop = Number.isNaN(item.end) ? limit : Math.min(item.end, limit)
    return { title: item.title, start: item.start, stop }
  })
}

/** 读响应体，超过上限就中止，不把整份读进内存再判断。 */
async function readCapped(response) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (declared > MAX_BYTES) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error('新疆节目单响应过大')
  }
  if (!response.body?.getReader) {
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > MAX_BYTES) throw new Error('新疆节目单响应过大')
    return text
  }
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
      throw new Error('新疆节目单响应过大')
    }
    text += decoder.decode(value, { stream: true })
  }
}

export default {
  id: 'xinjiang',
  // 今天 + 明天：全量更新默认 8 小时一轮，多备一天，跨零点前后播放器仍有节目可显示
  days: 2,

  /** 本模块哪些频道出节目单：频道 ref、显示名 → 节目单接口的 tvChannelId。 */
  channels() {
    return CHANNELS.map(channel => ({ ref: channel.ref, name: channel.name, key: channel.channelId }))
  },

  /** 取一个频道某一天（上海日期 YYYYMMDD）的节目，按开始时间升序；官方当天没发返回空数组。 */
  async programmes(key, day, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
    const target = guideDay(day)
    if (!KEY_RE.test(String(key ?? '')) || !target) throw new Error('新疆节目单参数非法')
    const url = new URL(EPG_API)
    url.searchParams.set('tvChannelId', String(key))
    url.searchParams.set('date', target.query)
    url.searchParams.set('json', 'true')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url.href, {
        headers: {
          'User-Agent': UA,
          Accept: 'application/json, text/plain, */*',
          Origin: 'https://www.xjtvs.com.cn',
          Referer: PAGE,
        },
        // 接口不跳转；真跳了多半是拦截页，按失败处理
        redirect: 'manual',
        signal: controller.signal,
      })
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {})
        throw new Error(`新疆节目单 HTTP ${response.status}`)
      }
      let payload
      try {
        payload = JSON.parse((await readCapped(response)).replace(/^﻿/, ''))
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error('新疆节目单不是 JSON')
        throw error
      }
      return parseGuide(payload, day)
    } finally {
      clearTimeout(timer)
    }
  },
}
