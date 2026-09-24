/**
 * 深圳广电（第一现场）官方节目单。
 *
 * 官网直播播放器 LSDPlayer 的节目单取自 hls-api.sztv.com.cn/api/getEpgs?channelId=<liveId>&daytime=<毫秒>：
 * daytime 必须正好是某天上海零点的毫秒时间戳，回「那天及往前六天」共七天，
 * { done: 'ok', id, list: [{ daytime, programme: [{ s, t }] }] }——s 是距当天零点的毫秒偏移，t 是节目名，
 * 没有结束时间：播放器按「下一条的开始，最后一条到当天 24:00」画，这里照办。
 * 不用签名、不看来源头；只发到今天，明天回 done='日期异常'，不认识的频道回 '频道不存在'（都是 HTTP 200）。
 * 同一时刻常排两条（「开台」紧跟当天第一个节目），前一条在播放器里是零长度，丢掉。
 * 少儿频道官方没有节目单（每天空 programme 列表），映射保留，哪天官方补上就自动有了。
 *
 * 和取流链路没有共享状态：不用取流那套 HMAC / 直播 Key / CDN 签名，只用调用方注入的 fetch，
 * 不 import 项目里的任何模块——整份拿出去就能单独产出节目单。
 */

export const EPG_API = 'https://hls-api.sztv.com.cn/api/getEpgs'
// 七天一次，实测最多的国际频道约 20 KB
const MAX_BYTES = 512 * 1024
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/**
 * 模块发出的全部频道。取流侧的 ref 是 sztv-<栏目 id>，节目单要的是栏目扩展里的 liveId。
 * 取流的频道表是运行时拉官网栏目接口的，这里是 2026-09-25 对着栏目接口核对的静态表（购物频道
 * 取流侧就排除了）。官网若换 id，取流 ref 跟着变、这里对不上，只会缺节目单，不会配错。
 */
export const CHANNELS = [
  { id: '24725', liveId: 'R77mK1v', name: '深圳卫视4K' },
  { id: '7867', liveId: 'AxeFRth', name: '深圳卫视' },
  { id: '7868', liveId: 'ZwxzUXr', name: '深圳都市' },
  { id: '7880', liveId: '4azbkoY', name: '深圳电视剧' },
  { id: '7881', liveId: '1SIQj6s', name: '深圳少儿' },
  { id: '7869', liveId: 'wDF6KJ3', name: '深圳移动电视' },
  { id: '7944', liveId: 'sztvgjpd', name: '深圳国际' },
]

/** 上海日期 YYYYMMDD → 当天 00:00（+08:00）的毫秒时间戳；与运行机器的时区无关，非法日期返回 NaN。 */
export function dayStartMs(day) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(day))
  if (!match) return NaN
  const [year, month, date] = match.slice(1).map(Number)
  const utc = new Date(Date.UTC(year, month - 1, date))
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== date) return NaN
  return utc.getTime() - SHANGHAI_OFFSET_MS
}

/** 一个频道某一天的节目单地址。 */
export function epgUrl(liveId, day) {
  return `${EPG_API}?channelId=${liveId}&daytime=${dayStartMs(day)}`
}

/**
 * 接口 JSON → 指定那天（上海零点 dayStart）的节目，按开始时间升序。
 * 每条的结束是下一条的开始、最后一条到当天 24:00；同一时刻的两条里前一条是零长度，丢掉。
 */
export function parseDay(payload, dayStart) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('深圳节目单返回结构异常')
  if (payload.done !== 'ok') throw new Error(`深圳节目单接口拒绝：${payload.done || '没有 done'}`)
  if (!Array.isArray(payload.list)) throw new Error('深圳节目单返回结构异常')
  const group = payload.list.find(item => Number(item?.daytime) === dayStart)
  if (!group) return []
  if (!Array.isArray(group.programme)) throw new Error('深圳节目单返回结构异常')

  const slots = []
  for (const row of group.programme) {
    const offset = row?.s
    const title = String(row?.t ?? '').trim()
    if (title && Number.isSafeInteger(offset) && offset >= 0 && offset < DAY_MS) {
      slots.push({ title, start: dayStart + offset })
    }
  }
  // 有节目却一条都解不出来，多半是字段或时间单位改了，报错比静默空着好查
  if (group.programme.length && !slots.length) throw new Error('深圳节目单时间格式异常')
  // 稳定排序：同一时刻的两条保持官方先后，前一条随后因零长度被丢掉
  slots.sort((a, b) => a.start - b.start)
  const programmes = []
  slots.forEach((slot, index) => {
    const stop = index + 1 < slots.length ? slots[index + 1].start : dayStart + DAY_MS
    if (stop > slot.start) programmes.push({ title: slot.title, start: slot.start, stop })
  })
  return programmes
}

/** 读正文，超过上限就断开；先看声明长度，再边读边数。 */
async function readCapped(response) {
  if (Number(response.headers?.get?.('content-length')) > MAX_BYTES) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error('深圳节目单响应过大')
  }
  const reader = response.body?.getReader?.()
  if (!reader) {
    const text = await response.text()
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('深圳节目单响应过大')
    return text
  }
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => {})
      throw new Error('深圳节目单响应过大')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export default {
  id: 'sztv',
  // 平台只发到今天，明天回「日期异常」
  days: 1,

  /** 本模块哪些频道出节目单：频道 ref、显示名 → 节目单接口用的 liveId。 */
  channels() {
    return CHANNELS.map(channel => ({ ref: `sztv-${channel.id}`, name: channel.name, key: channel.liveId }))
  },

  /** 取一个频道某一天（上海日期 YYYYMMDD）的节目，按开始时间升序。 */
  async programmes(key, day, { fetchImpl = fetch, timeoutMs = 10000, now = Date.now() } = {}) {
    const dayStart = dayStartMs(day)
    if (!/^[A-Za-z0-9]{3,32}$/.test(String(key)) || !Number.isFinite(dayStart)) throw new Error('深圳节目单参数非法')
    // 明天往后官方不发，问了也只回「日期异常」
    if (dayStart > Number(now)) return []
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(epgUrl(String(key), String(day)), {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': UA,
          Accept: 'application/json, text/javascript, */*; q=0.01',
          Referer: `https://www.sztv.com.cn/pindao/index.html?liveId=${key}`,
        },
      })
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {})
        throw new Error(`深圳节目单 HTTP ${response.status}`)
      }
      const text = await readCapped(response)
      let payload
      try {
        payload = JSON.parse(text)
      } catch {
        throw new Error('深圳节目单不是 JSON')
      }
      return parseDay(payload, dayStart)
    } finally {
      clearTimeout(timer)
    }
  },
}
