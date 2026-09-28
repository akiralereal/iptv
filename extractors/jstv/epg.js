/**
 * 江苏网络台（荔枝网）官方节目单。
 *
 * 官网直播页的节目单取自 live-lizhi.jstv.com/api/Channel/Epg：必须带匿名 Web 令牌
 * （Bearer JWT，与取流同一个 GetWebToken 接口签发，15 分钟有效），不带回 401。
 * channelId 要用频道表 nav/8385 里的 extraId（江苏卫视 670）；页面脚本里写死的旧 id
 * （534 …）只回空 epg。days=N 回「往前 N 天 + 今天」，按日期分组，时间是上海时间的
 * 'YYYY-MM-DD HH:mm:ss' 文本；平台不发明天（带 isNeedTomorrow=1 也没有）。
 *
 * 和取流链路不共享状态：只共用 auth.js 里的纯签名计算，令牌自己取、自己缓存，
 * 只用调用方注入的 fetch——连同 auth.js 拿出去就能单独产出节目单。
 */
import { buildAuthRequest, tokenExpiry, UA } from './auth.js'

export const EPG_API = 'https://live-lizhi.jstv.com/api/Channel/Epg'
const MAX_BYTES = 256 * 1024
const TOKEN_SKEW_MS = 2 * 60 * 1000
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
// 实测往回至少留 30 天；直播只用得上今天，更早的不取
const MAX_DAYS_BACK = 30

/**
 * 模块发出的全部频道。取流侧的 ref 就是 jstv-<extraId>，extraId 也正是节目单要的 channelId。
 * 取流的频道表是运行时拉的，这里是 2026-09-25 对着 nav/8385 核对的静态表：10 个频道都有
 * 节目单，4K 与江苏卫视同一套。官网若换 id，取流 ref 跟着变、这里对不上，只会缺节目单，不会配错。
 */
export const CHANNELS = [
  { id: '670', name: '江苏卫视' },
  { id: '676', name: '江苏卫视4K' },
  { id: '669', name: '江苏城市' },
  { id: '663', name: '江苏综艺' },
  { id: '664', name: '江苏影视' },
  { id: '668', name: '江苏新闻' },
  { id: '666', name: '江苏教育' },
  { id: '665', name: '江苏体育休闲' },
  { id: '667', name: '优漫卡通' },
  { id: '671', name: '江苏国际' },
]

let tokenCache = null
let tokenPending = null

const TIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/

/** 'YYYY-MM-DD HH:mm:ss'（上海时间）→ 毫秒时间戳；显式按 +08:00 算，与运行机器的时区无关。 */
export function parseShanghaiTime(text) {
  const match = TIME_RE.exec(String(text ?? '').trim())
  if (!match) return NaN
  const [, y, mo, d, h, mi, s] = match.map(Number)
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 24 || mi > 59 || s > 59) return NaN
  return Date.UTC(y, mo - 1, d, h, mi, s) - SHANGHAI_OFFSET_MS
}

/** 从接口 JSON 里取出某一天（YYYYMMDD）的节目，按开始时间升序；那天没有分组返回空数组。 */
export function decodeProgrammes(payload, day) {
  if (payload?.code != null && Number(payload.code) !== 200) {
    throw new Error(`江苏节目单返回异常：${payload?.message || payload.code}`)
  }
  if (!Array.isArray(payload?.data?.epg)) throw new Error('江苏节目单返回异常：没有 epg')
  const date = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`
  const group = payload.data.epg.find(item => String(item?.date ?? '').trim() === date)
  const rows = Array.isArray(group?.data) ? group.data : []
  const programmes = []
  for (const row of rows) {
    const title = String(row?.programName ?? '').trim()
    const start = parseShanghaiTime(row?.startTime)
    const stop = parseShanghaiTime(row?.endTime)
    if (title && start < stop) programmes.push({ title, start, stop })
  }
  // 有节目却一条都解不出来，多半是时间格式改了，报错比静默空着好查
  if (rows.length && !programmes.length) throw new Error('江苏节目单时间格式异常')
  return programmes.sort((a, b) => a.start - b.start)
}

async function readCapped(response) {
  if (Number(response.headers?.get?.('content-length') || 0) > MAX_BYTES) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error('江苏节目单响应过大')
  }
  const reader = response.body?.getReader?.()
  if (!reader) {
    const buf = Buffer.from(await response.arrayBuffer())
    if (buf.length > MAX_BYTES) throw new Error('江苏节目单响应过大')
    return buf.toString('utf8')
  }
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => {})
      throw new Error('江苏节目单响应过大')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 发请求并读 JSON；非 2xx 只回状态码，由调用方决定重试还是报错。 */
async function fetchJson(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { ...init, redirect: 'manual', signal: controller.signal })
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {})
      return { status: response.status, payload: null }
    }
    const text = await readCapped(response)
    try {
      return { status: response.status, payload: JSON.parse(text) }
    } catch {
      throw new Error('江苏节目单返回的不是 JSON')
    }
  } finally {
    clearTimeout(timer)
  }
}

async function webToken({ fetchImpl, timeoutMs, now }) {
  if (tokenCache?.expiresAt > now + TOKEN_SKEW_MS) return tokenCache.value
  // 模块节目单并发取多个频道，同一时刻只签发一次令牌
  tokenPending ??= (async () => {
    const request = buildAuthRequest(now)
    const { status, payload } = await fetchJson(fetchImpl, request.url, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
      body: JSON.stringify(request.body),
    }, timeoutMs)
    if (status < 200 || status > 299) throw new Error(`江苏节目单鉴权 HTTP ${status}`)
    const token = String(payload?.data?.accessToken || '')
    if (!token) throw new Error(`江苏节目单鉴权返回异常：${payload?.message || payload?.code || '没有 accessToken'}`)
    tokenCache = { value: token, expiresAt: tokenExpiry(token) || now + 8 * 60 * 1000 }
    return token
  })().finally(() => { tokenPending = null })
  return tokenPending
}

/** 上海日期 YYYYMMDD 距今天（上海）往回几天；明天为 -1。 */
function daysBack(day, now) {
  const today = new Date(Number(now) + SHANGHAI_OFFSET_MS)
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  const dayUtc = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8)))
  return Math.round((todayUtc - dayUtc) / DAY_MS)
}

export function clearCache() {
  tokenCache = null
  tokenPending = null
}

export default {
  id: 'jstv',
  // 平台只发到今天，多取一天也拿不到明天
  days: 1,

  /** 本模块哪些频道出节目单：频道 ref、显示名 → 节目单接口用的 extraId。 */
  channels() {
    return CHANNELS.map(channel => ({ ref: `jstv-${channel.id}`, name: channel.name, key: channel.id }))
  },

  /** 取一个频道某一天（上海日期 YYYYMMDD）的节目，按开始时间升序。 */
  async programmes(key, day, { fetchImpl = fetch, timeoutMs = 10000, now = Date.now() } = {}) {
    if (!/^\d{1,8}$/.test(String(key)) || !/^\d{8}$/.test(String(day))) {
      throw new Error('江苏节目单参数非法')
    }
    const back = daysBack(String(day), now)
    if (back < 0 || back > MAX_DAYS_BACK) return []
    // 一次调用回 back + 1 天，只要到所需那天为止，再从中挑出那天
    const url = `${EPG_API}?channelId=${key}&days=${back}&isNeedTomorrow=0`
    const get = token => fetchJson(fetchImpl, url, {
      headers: { 'User-Agent': UA, Accept: 'application/json', Authorization: `Bearer ${token}` },
    }, timeoutMs)

    let token = await webToken({ fetchImpl, timeoutMs, now })
    let result = await get(token)
    if (result.status === 401) {
      // 缓存的令牌被提前作废：换一张重试一次（别清掉并发请求刚换来的新令牌）
      if (tokenCache?.value === token) tokenCache = null
      token = await webToken({ fetchImpl, timeoutMs, now })
      result = await get(token)
    }
    if (result.status < 200 || result.status > 299) throw new Error(`江苏节目单 HTTP ${result.status}`)
    return decodeProgrammes(result.payload, String(day))
  },
}
