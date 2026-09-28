// 央视网节目单（api.cntv.cn/epg/getEpgInfoByChannelNew）的通用提供者。
//
// 央视网除央视频道外还收着一批省台、地方台的节目单，按代号取：不用登录、不带签名。代号没有公开
// 清单，是逐个试出来的（北京 btv1…btv9、甘肃 gansu、延边 yanbian……），试到的记在各模块的 epg.js 里。
// 返回 { data: { <代号>: { channelName, list: [{ title, startTime, endTime }] } } }，秒级时间戳，
// 当天首尾相接、最后一条止于 23:59；能取到后天（不全）。停播时段写成「频道无节目」，丢掉。
// 不认识的代号回 { errcode: '1001', msg: 'params error' }；有代号但官方没编排的回空 list。
//
// 零依赖：只用调用方注入的 fetch。各模块的 epg.js 只需给出「频道 ref、显示名 → 代号」的表，
// 连同 utils/epgXmltv.js 一起拆出去就能单独产出节目单。

export const CNTV_EPG_API = 'https://api.cntv.cn/epg/getEpgInfoByChannelNew'
// 一天一份实测 3–5 KB
const MAX_BYTES = 512 * 1024
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const MINUTE_MS = 60 * 1000
const KEY_RE = /^[a-z][a-z0-9]{0,23}$/
const OFF_AIR = /^频道无节目$/

/** 上海日期 YYYYMMDD → 当天 00:00（+08:00）的毫秒时间戳；与运行机器的时区无关，非法日期返回 NaN。 */
export function dayStartMs(day) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(day))
  if (!match) return NaN
  const [year, month, date] = match.slice(1).map(Number)
  const utc = new Date(Date.UTC(year, month - 1, date))
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== date) return NaN
  return utc.getTime() - SHANGHAI_OFFSET_MS
}

// 秒级时间戳（数字或纯数字字符串）→ 毫秒；别的一律 NaN
function seconds(value) {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
  return /^\d{9,11}$/.test(text) ? Number(text) * 1000 : NaN
}

/** 接口返回 + 代号 + 上海日期 → 当天的节目，按开始时间升序；当天没有得空数组。 */
export function parseCntvProgrammes(payload, key, day) {
  const dayStart = dayStartMs(day)
  if (!Number.isFinite(dayStart)) throw new Error('央视网节目单日期非法')
  if (!payload || typeof payload !== 'object') throw new Error('央视网节目单返回异常')
  if (payload.errcode) throw new Error(`央视网节目单返回异常：${payload.msg || payload.errcode}`)
  const rows = payload.data?.[key]?.list
  if (rows == null) return []
  if (!Array.isArray(rows)) throw new Error('央视网节目单格式异常')

  const dayEnd = dayStart + DAY_MS
  const items = []
  let timed = 0
  for (const row of rows) {
    const title = String(row?.title ?? '').replace(/\s+/g, ' ').trim()
    const start = seconds(row?.startTime)
    const stop = seconds(row?.endTime)
    if (!title || !(start < stop)) continue
    timed++
    if (OFF_AIR.test(title)) continue
    if (start < dayEnd && stop > dayStart) items.push({ title, start: Math.max(start, dayStart), stop: Math.min(stop, dayEnd) })
  }
  // 有条目却一条时间都读不出来，多半是接口改了格式；抛出去比悄悄当成「当天没有」好查
  if (rows.length && !timed) throw new Error('央视网节目单时间格式异常')

  items.sort((a, b) => a.start - b.start)
  const programmes = []
  for (const item of items) {
    const previous = programmes.at(-1)
    if (previous?.start === item.start) continue
    if (previous && previous.stop > item.start) previous.stop = item.start
    programmes.push(item)
  }
  // 最后一条止于 23:59，接到当天 24:00，免得零点前空一分钟
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
    throw new Error('央视网节目单响应过大')
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
      throw new Error('央视网节目单响应过大')
    }
    text += decoder.decode(value, { stream: true })
  }
}

/**
 * 造一个走央视网的节目单提供者（契约见 extractors/registry.js 的 epg 一节）。
 * @param {{ id: string, channels: ReadonlyArray<{ ref: string, name: string, key: string }>, days?: number }} options
 */
export function createCntvEpg({ id, channels, days = 2 }) {
  const declared = new Set(channels.map(channel => channel.key))
  return {
    id,
    // 今天 + 明天
    days,

    /** 本模块哪些频道出节目单：频道 ref、显示名 → 央视网代号。 */
    channels() {
      return channels.map(channel => ({ ref: channel.ref, name: channel.name, key: channel.key }))
    },

    /** 取一个频道某一天（上海日期 YYYYMMDD）的节目，按开始时间升序。 */
    async programmes(key, day, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
      const date = String(day)
      // 只接受频道表里声明过的代号：调用方只会拿 channels() 给的 key 来，别的都是写错了
      if (!KEY_RE.test(String(key)) || !declared.has(String(key)) || !Number.isFinite(dayStartMs(date))) {
        throw new Error('央视网节目单参数非法')
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const url = new URL(CNTV_EPG_API)
        url.searchParams.set('c', String(key))
        url.searchParams.set('serviceId', 'tvcctv')
        url.searchParams.set('d', date)
        const response = await fetchImpl(url.href, {
          headers: { Accept: 'application/json, */*', Referer: 'https://tv.cctv.com/' },
          redirect: 'manual',
          signal: controller.signal,
        })
        if (!response.ok) {
          await discard(response)
          throw new Error(`央视网节目单 HTTP ${response.status}`)
        }
        let payload
        try {
          payload = JSON.parse(await readCapped(response))
        } catch (error) {
          if (/响应过大/.test(error?.message)) throw error
          throw new Error('央视网节目单不是有效 JSON')
        }
        return parseCntvProgrammes(payload, String(key), date)
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
