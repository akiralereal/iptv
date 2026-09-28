/**
 * 广东台（荔枝网）官方节目单。
 *
 * 官网频道页的节目单取自 gdtv-api.gdtv.cn/api/tv/v2/tvMenu?tvChannelPk=<频道 id>&beginAt=<日期>&endAt=<日期>：
 * 日期是上海日期 'YYYY-MM-DD'（首尾都含，一次最多回 14 天），按天分组回
 * resultList[{ dateAt, tvMenus[{ name, beginAt, endAt }] }]，起止是毫秒时间戳，按开始时间归天。
 * 往回至少一周，往后排到约五天，逐集推进，是真编排不是模板。不认识的频道与没排的日子回空 tvMenus。
 *
 * 请求必须带 X-ITOUCHTV-Ca-* 签名头，不签回 401：
 *   Signature = base64(HMAC-SHA256(secret, "GET\n<完整 URL>\n<毫秒时间戳>\n"))
 * 官网把 key / secret 放在页面的 WebAssembly 签名模块里（按接口域名分的 keyset），2026-09 起是下面这组；
 * 早年公开流传的旧组合已回 401。只用 node:crypto，不需要浏览器——取流那套浏览器会话与这里无关。
 * 实测时间戳偏 ±20 分钟仍放行，不带设备号、来源头也放行（仍按官网带上 Referer / Origin）。
 *
 * 官网每天最后一条常排过零点，和次日第一条叠十几二十分钟（广东卫视、体育都有）：一个频道同一时刻
 * 只播一个节目，把每条的结束截到下一条开始。所以取某天时连同前后各一天一起要，前一天的末条
 * 跨进当天的那段、当天末条被次日首条截短，都能算对。
 *
 * 和取流链路没有共享状态：只用 channels.js 的频道表和调用方注入的 fetch，
 * 不 import 项目里的其它模块——连同 channels.js 拿出去就能单独产出节目单。
 */
import { createHmac } from 'node:crypto'
import { CHANNELS } from './channels.js'

export const EPG_API = 'https://gdtv-api.gdtv.cn/api/tv/v2/tvMenu'
// 官网 WebAssembly 签名模块里 gdtv-api.gdtv.cn 的 keyset（2026-09 核对）；不是用户凭据，但属于易变实现细节
export const CA_KEY = '89541943007407288657755311868534'
const CA_SECRET = 'dfkcY1c3sfuw1Cii9DWj8UO3iQy2hqlDxyvDXd1oVMxwYVDSgeB6phO9eW1dfuwX'
const CLIENT = 'WEB_PC'
// 实测最大的 GRTN生活 一天 268 条约 55 KB，三天一次约 170 KB
const MAX_BYTES = 1024 * 1024
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
// 早于 2001-09 的「毫秒」多半是接口换成了秒，宁可报错也不写出 1970 年的节目
const MIN_MS = 1e12
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const pad = n => String(n).padStart(2, '0')

/** 上海日期 YYYYMMDD → 当天 00:00（+08:00）的毫秒时间戳；与运行机器的时区无关，非法日期返回 NaN。 */
export function dayStartMs(day) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(day))
  if (!match) return NaN
  const [year, month, date] = match.slice(1).map(Number)
  const utc = new Date(Date.UTC(year, month - 1, date))
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== date) return NaN
  return utc.getTime() - SHANGHAI_OFFSET_MS
}

/** 毫秒时间戳 → 所在的上海日期 'YYYY-MM-DD'（接口的 beginAt / endAt 格式）。 */
function shanghaiDate(ms) {
  const d = new Date(ms + SHANGHAI_OFFSET_MS)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** 取某天要用的地址：前一天到后一天，一次三天。 */
export function epgUrl(pk, day) {
  const start = dayStartMs(day)
  return `${EPG_API}?tvChannelPk=${pk}&beginAt=${shanghaiDate(start - DAY_MS)}&endAt=${shanghaiDate(start + DAY_MS)}`
}

/** 官网签名请求头；签的是发出去的完整 URL，参数顺序、编码都不能再改。 */
export function signedHeaders(url, now = Date.now()) {
  const timestamp = String(Math.floor(Number(now)))
  if (!/^\d{13}$/.test(timestamp)) throw new Error('请求时间无效')
  return {
    'X-ITOUCHTV-Ca-Key': CA_KEY,
    'X-ITOUCHTV-Ca-Signature': createHmac('sha256', CA_SECRET).update(`GET\n${url}\n${timestamp}\n`).digest('base64'),
    'X-ITOUCHTV-Ca-Timestamp': timestamp,
    'X-ITOUCHTV-CLIENT': CLIENT,
  }
}

/**
 * 接口 JSON → 全部天的节目，按开始时间排好；同一时刻开始的只留第一条，
 * 每条的结束截到下一条开始（跨零点那条与次日首条重叠）。
 */
export function parseMenus(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.resultList)) {
    const reason = payload?.errorMessage || payload?.message
    throw new Error(reason ? `广东台节目单接口拒绝：${reason}` : '广东台节目单返回结构异常')
  }
  const items = []
  let rows = 0
  for (const group of payload.resultList) {
    if (!Array.isArray(group?.tvMenus)) throw new Error('广东台节目单返回结构异常')
    for (const row of group.tvMenus) {
      rows++
      const title = String(row?.name ?? '').trim()
      const start = Number(row?.beginAt)
      const stop = Number(row?.endAt)
      if (title && Number.isSafeInteger(start) && start > MIN_MS && Number.isSafeInteger(stop) && stop > start) {
        items.push({ title, start, stop })
      }
    }
  }
  // 有节目却一条都解不出来，多半是字段或时间单位改了，报错比静默空着好查
  if (rows && !items.length) throw new Error('广东台节目单时间格式异常')
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

/** 读正文，超过上限就断开；先看声明长度，再边读边数。 */
async function readCapped(response) {
  if (Number(response.headers?.get?.('content-length')) > MAX_BYTES) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error('广东台节目单响应过大')
  }
  const reader = response.body?.getReader?.()
  if (!reader) {
    const text = await response.text()
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('广东台节目单响应过大')
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
      throw new Error('广东台节目单响应过大')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export default {
  id: 'gdtv',
  // 今天 + 明天：官方往后排到约五天且是真编排，多备一天，跨零点前后播放器仍有节目可显示
  days: 2,

  /** 模块输出的十七个频道：频道 ref、显示名 → 接口的 tvChannelPk（即官网频道页路由 id）。 */
  channels() {
    return CHANNELS.map(channel => ({ ref: `gdtv-${channel.id}`, name: channel.name, key: channel.id }))
  },

  /**
   * 取一个频道某一天（上海日期 YYYYMMDD）的节目，按开始时间升序。
   * 与当天有交集的都算，跨零点那条两天都带着，由调用方按开始时间去重。
   */
  async programmes(key, day, { fetchImpl = fetch, timeoutMs = 10000, now = Date.now() } = {}) {
    const dayStart = dayStartMs(day)
    if (!/^\d{1,4}$/.test(String(key)) || !Number.isFinite(dayStart)) throw new Error('广东台节目单参数非法')
    const dayEnd = dayStart + DAY_MS
    const url = epgUrl(String(key), String(day))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let programmes
    try {
      const response = await fetchImpl(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          ...signedHeaders(url, now),
          'User-Agent': UA,
          Accept: 'application/json, text/plain, */*',
          Origin: 'https://www.gdtv.cn',
          Referer: 'https://www.gdtv.cn/',
        },
      })
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {})
        throw new Error(response.status === 401
          ? '广东台节目单签名被拒（HTTP 401），官网可能换了密钥'
          : `广东台节目单 HTTP ${response.status}`)
      }
      const text = await readCapped(response)
      let payload
      try {
        payload = JSON.parse(text)
      } catch {
        throw new Error('广东台节目单不是 JSON')
      }
      programmes = parseMenus(payload)
    } finally {
      clearTimeout(timer)
    }
    return programmes.filter(item => item.start < dayEnd && item.stop > dayStart)
  },
}
