/**
 * 大连云（大连新闻传媒集团）官方节目单。
 *
 * 大连云 H5 频道页（nginx-dlrm.dlrm.cn/dlrm/site1/h/tv/<id>.html）的「节目单」一栏取自
 * GET wan-dlrm.dlrm.cn/app/tv/programs?channel=<频道号>&date=<当天上海零点的毫秒时间戳>。
 * 和取流的频道目录一样要带 ticket 头：先用客户端内置参数走一次匿名 SM2 换令牌
 * （/app/security/token，令牌 5 分钟有效），每次请求再把令牌 + 时间戳 SM2 加密成 ticket；
 * 不带或令牌失效回 HTTP 200 + status 401「请求未授权」。
 *
 * 每条的 startTime / endTime 是「当天几点」按 +08:00 存成 1970-01-01 的毫秒数（06:35 → -5100000），
 * 页面按 date + startTime + 8 小时还原；date 原样回显请求值，所以请求必须给上海零点。
 * 实测（2026-09-25）：一天之内不跨零点，末档止于 23:59:59（补到次日零点）；往回至少到 8 月，
 * 往后排到 10～17 天，每天的条目 id 各不相同、国庆几天与平日不同，未来日是真编排（文体频道本身
 * 就天天一套）；没排的日子、不认识的频道号回空数组。
 * 数据毛病：生活频道每天五六条 1～3 分钟的「节目预告（…）」，丢掉留作空档；偶有前一条比后一条
 * 开始晚一分钟结束（【动漫星球】至 18:00、首播小螺号 17:59 起），截到下一条开始。
 *
 * 和取流链路不共享状态：只共用 auth.js / sm2.js 里的纯计算（令牌请求与 ticket 加密），令牌自己取、
 * 自己缓存，只用调用方注入的 fetch——连同这两个文件拿出去就能单独产出节目单。
 */
import { API_BASE, UA, buildTicket, buildTokenRequest, decodeTokenPayload } from './auth.js'

export const EPG_API = `${API_BASE}tv/programs`
// 一天四十来条、约 7KB；换令牌的响应不到 1KB。留足余量，超出按异常处理
const MAX_BYTES = 256 * 1024
const TOKEN_SAFETY_MS = 30 * 1000
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
// 1～3 分钟的串联预告，不是节目
const FILLER_RE = /^节目预告/
const FILLER_MAX_MS = 10 * 60 * 1000

/** 模块发出的三个正式电视频道（显示名与 api.js 的 FORMAL_TV 一致）；ref 里的数字就是频道号。 */
export const CHANNELS = Object.freeze([
  { id: '7', name: '大连新闻综合' },
  { id: '8', name: '大连生活' },
  { id: '9', name: '大连文体' },
])

let tokenCache = null
let tokenPending = null

/** 上海日期 YYYYMMDD 零点的毫秒时间戳；与运行机器的时区无关，日期不合法得 NaN。 */
export function shanghaiDayStart(day) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(day))
  if (!match) return NaN
  const [, y, m, d] = match.map(Number)
  const start = Date.UTC(y, m - 1, d) - SHANGHAI_OFFSET_MS
  const check = new Date(start + SHANGHAI_OFFSET_MS)
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return NaN
  return start
}

/**
 * 接口 JSON → 那天的节目，按开始时间升序、互不重叠。
 * 时刻 = 当天上海零点 + startTime + 8 小时；回显的 date 不是这一天的行不收。末档 23:59:59 补到
 * 次日零点、越过零点的截在零点；丢「节目预告」；同一开始时间只留第一条；结束晚于下一条开始的
 * 截到下一条开始。
 * 状态或结构不对抛错，那天没排返回空数组。
 */
export function parseProgrammes(payload, dayStart) {
  if (!payload || typeof payload !== 'object') throw new Error('大连云节目单数据格式异常')
  if (Number(payload.status) !== 0) {
    throw new Error(`大连云节目单返回异常：${payload.message || payload.status}`)
  }
  const rows = payload.data?.programs
  if (rows == null) return []
  if (!Array.isArray(rows)) throw new Error('大连云节目单数据格式异常')

  const dayEnd = dayStart + DAY_MS
  const items = []
  let parsed = 0
  for (const row of rows) {
    const title = String(row?.name ?? '').trim()
    const startOffset = Number(row?.startTime)
    const stopOffset = Number(row?.endTime)
    if (!title || !Number.isSafeInteger(startOffset) || !Number.isSafeInteger(stopOffset)
      || Number(row?.date) !== dayStart) continue
    parsed++
    const start = dayStart + startOffset + SHANGHAI_OFFSET_MS
    // 实测不跨零点；万一跨了截在零点，不伸进次日的单子
    let stop = Math.min(dayStart + stopOffset + SHANGHAI_OFFSET_MS, dayEnd)
    if (stop === dayEnd - 1000) stop = dayEnd
    if (start < dayStart || start >= dayEnd || stop <= start) continue
    if (FILLER_RE.test(title) && stop - start <= FILLER_MAX_MS) continue
    items.push({ title, start, stop })
  }
  // 有数据却一条都读不出（含回显的 date 全对不上），多半是接口改了格式，报错而不是当成「当天没发」
  if (rows.length && !parsed) throw new Error('大连云节目单数据格式异常')

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

/** 读响应体，超过上限就中止，不把整份读进内存再判断。 */
async function readCapped(response) {
  if (Number(response.headers?.get?.('content-length')) > MAX_BYTES) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error('大连云节目单响应过大')
  }
  if (!response.body?.getReader) {
    const buf = Buffer.from(await response.arrayBuffer())
    if (buf.length > MAX_BYTES) throw new Error('大连云节目单响应过大')
    return buf.toString('utf8')
  }
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => {})
      throw new Error('大连云节目单响应过大')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** GET 一个官方接口并读 JSON；不跳转（真跳了多半是拦截页），非 2xx、非 JSON 都抛错。 */
async function getJson(fetchImpl, url, headers, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json', 'User-Agent': UA, ...headers },
      redirect: 'manual',
      signal: controller.signal,
    })
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {})
      throw new Error(`大连云节目单 HTTP ${response.status}`)
    }
    try {
      return JSON.parse(await readCapped(response))
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error('大连云节目单不是 JSON')
      throw error
    }
  } finally {
    clearTimeout(timer)
  }
}

async function mediaToken({ fetchImpl, timeoutMs, now, serverPublicKey }) {
  if (tokenCache?.timeout > now + TOKEN_SAFETY_MS) return tokenCache.token
  // 模块节目单并发取多个频道，同一时刻只换一次令牌
  tokenPending ??= (async () => {
    const { url, keyPair } = buildTokenRequest({ serverPublicKey })
    const payload = await getJson(fetchImpl, url.href, {}, timeoutMs)
    tokenCache = decodeTokenPayload(payload, keyPair, now)
    return tokenCache.token
  })().finally(() => { tokenPending = null })
  return tokenPending
}

export function clearCache() {
  tokenCache = null
  tokenPending = null
}

export default {
  id: 'dalian',
  // 今天 + 明天：全量更新默认 8 小时一轮，多备一天，跨零点前后播放器仍有节目可显示
  days: 2,

  /** 本模块哪些频道出节目单：频道 ref、显示名 → 频道号。 */
  channels() {
    return CHANNELS.map(channel => ({ ref: `dalian-${channel.id}`, name: channel.name, key: channel.id }))
  },

  /**
   * 取一个频道某一天（上海日期 YYYYMMDD）的节目，按开始时间升序；官方当天没排返回空数组。
   * serverPublicKey 只给离线测试换成自造的服务端密钥用。
   */
  async programmes(key, day, { fetchImpl = fetch, timeoutMs = 10000, now = Date.now(), serverPublicKey } = {}) {
    const channel = String(key ?? '')
    const dayStart = shanghaiDayStart(day)
    if (!/^\d{1,6}$/.test(channel) || !Number.isFinite(dayStart)) throw new Error('大连云节目单参数非法')
    const url = `${EPG_API}?${new URLSearchParams({ channel, date: String(dayStart) })}`
    const get = token => getJson(fetchImpl, url, {
      ticket: buildTicket(token, now, serverPublicKey),
      source: 'APP',
    }, timeoutMs)

    let token = await mediaToken({ fetchImpl, timeoutMs, now, serverPublicKey })
    let payload = await get(token)
    if (Number(payload?.status) === 401) {
      // 缓存的令牌被提前作废：换一张重试一次（别清掉并发请求刚换来的新令牌）
      if (tokenCache?.token === token) tokenCache = null
      token = await mediaToken({ fetchImpl, timeoutMs, now, serverPublicKey })
      payload = await get(token)
    }
    return parseProgrammes(payload, dayStart)
  },
}
