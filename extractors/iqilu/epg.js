/**
 * 山东广电（齐鲁网）官方节目单。
 *
 * 官网直播页（v.iqilu.com/live/<slug>/）的节目单由 time-shifting-local.js 取自闪电新闻的
 * sdxw.iqilu.com/v1/app/play/program/qilu?channelID=<epgId>&date=YYYY-MM-DD：不用登录、
 * 不带签名、不看来源头，大陆与海外返回一致。epgId 是这个接口自己的编号（卫视 24 … 少儿 32），
 * 和频道页取流用的 _pdCid 不是一套；页面里另一个老接口 module.iqilu.com/media/apis/main/getprograms
 * 按 _pdCid 查一直回空列表，不用它。
 *
 * 返回 { code: 1, data: { infos: [...] | null } }：begintime / endtime 是秒级时间戳，平台在零点
 * 把跨日节目切开，当天最后一条止于 23:59:59；节目名右侧用空格补齐。当天没发时 infos 为 null——
 * 次日的节目单多数频道要到当天晚些时候才有，往前至少能取两周。
 * 编单手工录入的毛病在这里收拾：个别时间写错（「20;09:00」）的那条时间戳是 false，丢掉；
 * 偶有一条起止都是零点的空行，丢掉；偶有一条结束时间写成当天深夜、盖住后面整天，
 * 一个频道同一时刻只播一个节目，把每条的结束截到下一条开始。
 *
 * 和取流链路没有任何共享状态：只用 channels.js 的频道表和调用方注入的 fetch，
 * 不 import 项目里的其它模块——两个文件拿出去就能单独产出节目单。
 */
import { CHANNELS } from './channels.js'

export const EPG_API = 'https://sdxw.iqilu.com/v1/app/play/program/qilu'
// 一天一份实测 5–15 KB
const MAX_BYTES = 1024 * 1024
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const KEY_RE = /^\d{1,4}$/
const DAY_RE = /^(\d{4})(\d{2})(\d{2})$/

/** YYYYMMDD → 上海当天零点的毫秒时间戳；与运行机器的时区无关。非法日期得 NaN。 */
export function shanghaiDayStart(day) {
  const match = DAY_RE.exec(String(day ?? ''))
  if (!match) return NaN
  const [year, month, date] = match.slice(1).map(Number)
  const utc = Date.UTC(year, month - 1, date)
  const d = new Date(utc)
  // Date.UTC 会把 0931 之类顺延成下个月，写回去对不上就是非法
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== date) return NaN
  return utc - SHANGHAI_OFFSET_MS
}

// 秒级时间戳（数字，或纯数字字符串）→ 毫秒；false、空串、0 之类一律 NaN
function seconds(value) {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
  if (!/^\d{9,11}$/.test(text)) return NaN
  return Number(text) * 1000
}

/** 一天的返回 → 该天（上海日期 YYYYMMDD）的节目，按开始时间升序；当天没发返回空数组。 */
export function parseProgrammes(payload, day) {
  const dayStart = shanghaiDayStart(day)
  if (!Number.isFinite(dayStart)) throw new Error('齐鲁网节目单日期非法')
  const dayEnd = dayStart + DAY_MS
  if (!payload || typeof payload !== 'object' || Number(payload.code) !== 1
    || !payload.data || typeof payload.data !== 'object') {
    throw new Error(`齐鲁网节目单返回异常：${payload?.errmsg || '结构不符合预期'}`)
  }
  const rows = payload.data.infos
  if (rows == null) return []
  if (!Array.isArray(rows)) throw new Error('齐鲁网节目单格式异常')

  const items = []
  let listed = 0
  let timed = 0
  for (const row of rows) {
    const title = String(row?.name ?? '').replace(/\s+/g, ' ').trim()
    if (!title) continue
    listed++
    const start = seconds(row?.begintime)
    let stop = seconds(row?.endtime)
    if (!(start < stop)) continue
    timed++
    // 当天最后一条止于 23:59:59，接上次日零点，免得每天末尾空一秒
    if (stop === dayEnd - 1000) stop = dayEnd
    if (start < dayEnd && stop > dayStart) items.push({ title, start, stop })
  }
  // 有条目却一条时间都读不出来，多半是接口改了格式；抛出去比悄悄当成「当天没发」好查
  if (listed && !timed) throw new Error('齐鲁网节目单时间格式异常')

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

async function discard(response) {
  response.body?.destroy?.()
  await response.body?.cancel?.().catch(() => {})
}

async function readText(response) {
  if (Number(response.headers?.get?.('content-length')) > MAX_BYTES) {
    await discard(response)
    throw new Error('齐鲁网节目单响应过大')
  }
  if (!response.body) return ''
  const chunks = []
  let total = 0
  for await (const chunk of response.body) {
    total += chunk.length
    // 在循环里抛出会让迭代器收尾、取消剩下的下载
    if (total > MAX_BYTES) throw new Error('齐鲁网节目单响应过大')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

export default {
  id: 'iqilu',
  // 今天 + 明天：明天的多数频道要到当天晚些时候才发，没发时是空数组，后面几轮会补上
  days: 2,

  /** 本模块哪些频道出节目单：频道 ref、显示名 → 节目单接口的 channelID。 */
  channels() {
    return CHANNELS.map(channel => ({ ref: `iqilu-${channel.slug}`, name: channel.name, key: channel.epgId }))
  },

  /** 取一个频道某一天（上海日期 YYYYMMDD）的节目，按开始时间升序。 */
  async programmes(key, day, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
    const date = String(day ?? '')
    if (!KEY_RE.test(String(key)) || !Number.isFinite(shanghaiDayStart(date))) {
      throw new Error('齐鲁网节目单参数非法')
    }
    const query = `channelID=${key}&date=${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(`${EPG_API}?${query}`, {
        headers: { Accept: 'application/json, text/javascript, */*', Referer: 'https://v.iqilu.com/' },
        redirect: 'manual',
        signal: controller.signal,
      })
      if (!response.ok) {
        await discard(response)
        throw new Error(`齐鲁网节目单 HTTP ${response.status}`)
      }
      let payload
      try {
        // 接口声明 text/html，实际是 JSON
        payload = JSON.parse(await readText(response))
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error('齐鲁网节目单不是 JSON')
        throw error
      }
      return parseProgrammes(payload, date)
    } finally {
      clearTimeout(timer)
    }
  },
}
