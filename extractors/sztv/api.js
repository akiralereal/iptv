/** 深圳广电「第一现场」官网频道鉴权、直播 Key 与逐路径 CDN 签名。 */
import { createHash, createHmac, randomUUID } from 'node:crypto'
import fetch from 'node-fetch'

export const CATALOG_URL = 'https://apix.scms.sztv.com.cn/api/com/catalog/getCatalogList?isTree=0&tenantId=ysz&types=2&appCode=20'
export const LIVE_KEY_URL = 'https://hls-api.sztv.com.cn/getCutvHlsLiveKey'
export const STREAM_HOST = 'sztv-live.sztv.com.cn'

// 官网 yszsdk 1.0.43 与 LSDPlayer 2.1.3 公开携带的 Web 应用参数。
// 它们不是用户凭据，但都是易变的平台实现细节，故集中在本模块而不散落到通用代理层。
const WEB_HMAC_USER = 'onesz'
const WEB_HMAC_SECRET = Buffer.from('eFVKN0dsczQ1U3QwQ1RuYXRud1p3c0g0VXlZajBycFg=', 'base64').toString('utf8')
const LIVE_TOKEN_SALT = 'cutvLiveStream|Dream2017'
const CDN_SIGN_SECRET = 'ejow6p6p6hmrm9g96beh2knecdq5kyw9bp0zxyg7'
const STREAM_TTL_SECONDS = 2 * 60 * 60
const CHANNEL_TTL_MS = 4 * 60 * 60 * 1000
const CHANNEL_RETRY_MS = 60 * 1000
const LIVE_KEY_TTL_MS = 30 * 60 * 1000
const LIVE_KEY_RETRY_MS = 60 * 1000
// 官网播放页 getReport：打开时请求一次 favicon.ico，之后 setInterval 每 5 分钟一次。
// CDN 把这个请求交给远程鉴权（响应头 x-error-info: auth_remote），相当于向鉴权服务器报到。
// 2026-11-10 实测：模块原先不报到，同一出口播 2～3 分钟后所有直播路径都回空 200（auth_remote），
// 整个出口被拒两小时以上。补报到是照官网对齐，是否就是触发条件尚未做对照验证。
export const REPORT_URL = `https://${STREAM_HOST}/favicon.ico`
const REPORT_INTERVAL_MS = 5 * 60 * 1000
// 超过两个周期没人播，下次起播按「刚打开页面」处理：先报到再取清单
const REPORT_SESSION_GAP_MS = 2 * REPORT_INTERVAL_MS
const REPORT_TIMEOUT_MS = 5000
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export const UPSTREAM_HEADERS = {
  Origin: 'https://www.sztv.com.cn',
  Referer: 'https://www.sztv.com.cn/pindao/',
}

const NAME_OVERRIDES = {
  深圳卫视4K超高清: '深圳卫视4K',
  深圳卫视: '深圳卫视',
  都市频道: '深圳都市',
  电视剧频道: '深圳电视剧',
  少儿频道: '深圳少儿',
  移动电视: '深圳移动电视',
  国际频道: '深圳国际',
}

let channelCache = null
let channelPending = null
const liveKeyCache = new Map()
const liveKeyPending = new Map()
let lastReportAt = 0
let reportPending = null

const md5 = value => createHash('md5').update(value).digest('hex')

function validLiveId(value) {
  return /^[A-Za-z0-9]{3,32}$/.test(String(value || ''))
}

function requestHeaders(liveId = '') {
  return {
    ...UPSTREAM_HEADERS,
    ...(liveId ? { Referer: `https://www.sztv.com.cn/pindao/index.html?liveId=${encodeURIComponent(liveId)}` } : {}),
    'User-Agent': UA,
  }
}

async function requestWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await options.fetchImpl(url, { ...options.init, signal: controller.signal })
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : (error?.message || String(error))
    throw new Error(reason)
  } finally {
    clearTimeout(timer)
  }
}

/** 官网 yszsdk 的匿名 Web HMAC；签名只包含 pathname，查询串不参与。 */
export function buildCatalogAuth(rawUrl = CATALOG_URL, now = Date.now(), nonce = randomUUID()) {
  const url = new URL(rawUrl)
  const date = new Date(Number(now)).toUTCString()
  const canonical = `x-date: ${date}\n@request-target: get ${url.pathname}\nhost: ${url.host}\nnonce: ${nonce}`
  const signature = createHmac('sha512', WEB_HMAC_SECRET).update(canonical).digest('base64')
  return {
    'X-Date': date,
    Nonce: nonce,
    Authorization: `hmac username="${WEB_HMAC_USER}", algorithm="hmac-sha512", headers="x-date @request-target host nonce", signature="${signature}"`,
  }
}

function normalizeRows(payload) {
  const rows = []
  const seen = new Set()
  for (const item of Array.isArray(payload) ? payload : []) {
    const id = String(item?.id || '')
    const sourceName = String(item?.name || item?.extend?.refername || '').trim()
    const name = NAME_OVERRIDES[sourceName]
    const liveId = String(item?.extend?.liveId || '').trim()
    const rate = Number(item?.extend?.liveRate?.[0] || 500)
    if (!/^\d{1,10}$/.test(id) || !name || !validLiveId(liveId) || !Number.isInteger(rate)
      || rate < 1 || rate > 100000 || seen.has(id)) continue
    seen.add(id)
    rows.push({
      id,
      name,
      liveId,
      rate,
      logo: String(item?.logo || item?.extend?.backGroundImageV1 || '').trim(),
    })
  }
  return rows
}

export async function fetchChannelList(options = {}) {
  const now = Number(options.now ?? Date.now())
  const auth = buildCatalogAuth(CATALOG_URL, now, options.nonce)
  const response = await requestWithTimeout(CATALOG_URL, {
    fetchImpl: options.fetchImpl || fetch,
    init: { headers: { ...requestHeaders(), ...auth, Accept: 'application/json' } },
  }, options.timeoutMs || 10000)
  if (!response.ok) throw new Error(`频道接口 HTTP ${response.status}`)
  const payload = await response.json()
  const rows = normalizeRows(payload?.returnData)
  if (payload?.returnCode !== '0000' || !rows.length) {
    throw new Error(`频道接口返回异常：${payload?.returnDesc || payload?.message || '没有可用频道'}`)
  }
  return rows
}

async function cachedChannelList(options = {}) {
  const now = Number(options.now ?? Date.now())
  if (channelCache?.expiresAt > now || channelCache?.retryAt > now) return channelCache.rows
  if (!channelPending) {
    channelPending = fetchChannelList(options)
      .then(rows => {
        channelCache = { rows, expiresAt: now + CHANNEL_TTL_MS, retryAt: 0 }
        return rows
      })
      .finally(() => { channelPending = null })
  }
  try {
    return await channelPending
  } catch (error) {
    if (!channelCache) throw error
    channelCache.retryAt = now + CHANNEL_RETRY_MS
    return channelCache.rows
  }
}

export function primeChannelCache(rows, now = Date.now()) {
  const normalized = (Array.isArray(rows) ? rows : []).filter(row =>
    /^\d{1,10}$/.test(String(row?.id || ''))
    && Object.values(NAME_OVERRIDES).includes(row?.name)
    && validLiveId(row?.liveId)
    && Number.isInteger(row?.rate))
  if (normalized.length) channelCache = { rows: normalized, expiresAt: Number(now) + CHANNEL_TTL_MS, retryAt: 0 }
}

export function buildChannels(rows) {
  return (Array.isArray(rows) ? rows : []).map(row => ({
    name: row.name,
    deferredRef: `sztv-${row.id}`,
    // LSDPlayer 会给每一条清单/分片路径单独签名，普通播放器无法直接复现，必须全代理。
    proxyHls: true,
    logo: row.logo || '',
  }))
}

/** LSDPlayer 把返回值旋转、反转再 Base64 解码，得到当前频道的短播放 Key。 */
export function decodeLiveKey(raw) {
  let value = String(raw ?? '').trim()
  if (value.startsWith('"')) {
    try { value = JSON.parse(value) } catch { /* 后续统一判非法 */ }
  }
  if (!value || value === '0') throw new Error('直播 Key 接口拒绝请求')
  const split = value.length - Math.floor(value.length / 2)
  const rotated = value.slice(split) + value.slice(0, split)
  const decoded = Buffer.from([...rotated].reverse().join(''), 'base64').toString('utf8')
  if (!/^[A-Za-z0-9]{3,32}$/.test(decoded)) throw new Error('直播 Key 返回格式异常')
  return decoded
}

export function buildLiveKeyRequest(liveId, now = Date.now()) {
  if (!validLiveId(liveId)) throw new Error('直播频道 ID 无效')
  const seconds = Math.floor(Number(now) / 1000)
  const url = new URL(LIVE_KEY_URL)
  url.searchParams.set('t', String(seconds))
  url.searchParams.set('id', liveId)
  url.searchParams.set('token', md5(`${seconds}${liveId}${LIVE_TOKEN_SALT}`))
  url.searchParams.set('at', '1')
  return url.href
}

async function fetchLiveKey(row, options = {}) {
  const response = await requestWithTimeout(buildLiveKeyRequest(row.liveId, options.now), {
    fetchImpl: options.fetchImpl || fetch,
    init: { headers: requestHeaders(row.liveId) },
  }, options.timeoutMs || 10000)
  if (!response.ok) throw new Error(`直播 Key 接口 HTTP ${response.status}`)
  return decodeLiveKey(await response.text())
}

async function cachedLiveKey(row, options = {}) {
  const now = Number(options.now ?? Date.now())
  const cached = liveKeyCache.get(row.liveId)
  if (cached?.expiresAt > now || cached?.retryAt > now) return cached.value
  if (!liveKeyPending.has(row.liveId)) {
    liveKeyPending.set(row.liveId, fetchLiveKey(row, options)
      .then(value => {
        liveKeyCache.set(row.liveId, { value, expiresAt: now + LIVE_KEY_TTL_MS, retryAt: 0 })
        return value
      })
      .finally(() => { liveKeyPending.delete(row.liveId) }))
  }
  try {
    return await liveKeyPending.get(row.liveId)
  } catch (error) {
    if (!cached) throw error
    cached.retryAt = now + LIVE_KEY_RETRY_MS
    return cached.value
  }
}

/**
 * 照官网播放页向 CDN 报到。resolve 随播放器每次刷新清单被调用，所以有人在播就按 5 分钟一次续报，
 * 没人播自然停。冷起（长时间没人播）先等报到完成再取清单，与官网「先 getReport 再起播」的顺序一致；
 * 播放中的续报不阻塞清单。报到失败不影响播放，下个周期再报。
 */
export async function reportViewer(options = {}) {
  const now = Number(options.now ?? Date.now())
  const sinceLast = now - lastReportAt
  if (sinceLast < REPORT_INTERVAL_MS) return
  if (!reportPending) {
    lastReportAt = now
    reportPending = requestWithTimeout(REPORT_URL, {
      fetchImpl: options.fetchImpl || fetch,
      init: { headers: { ...requestHeaders(options.liveId), Accept: '*/*' } },
    }, REPORT_TIMEOUT_MS)
      .then(response => response.arrayBuffer?.())
      .catch(() => {})
      .finally(() => { reportPending = null })
  }
  if (sinceLast >= REPORT_SESSION_GAP_MS) await reportPending
}

/** 官网 CDN 对每一条 m3u8、TS 和 Key 路径分别签名，不能把顶层查询串复用到分片。 */
export function signStreamUrl(rawUrl, now = Date.now()) {
  const url = new URL(rawUrl)
  if (url.protocol !== 'https:' || url.hostname !== STREAM_HOST || !/^\/[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(url.pathname)) {
    throw new Error('播放地址不是深圳广电 HTTPS 直播路径')
  }
  const expires = (Math.floor(Number(now) / 1000) + STREAM_TTL_SECONDS).toString(16)
  url.searchParams.set('sign', md5(`${CDN_SIGN_SECRET}${url.pathname}${expires}`))
  url.searchParams.set('t', expires)
  return url.href
}

export async function resolveChannel(ref, ctx = {}) {
  try {
    const match = /^sztv-(\d{1,10})$/.exec(String(ref || ''))
    if (!match) return { url: '', desc: '深圳广电频道引用格式错误' }
    const rows = await cachedChannelList({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl, now: ctx.now })
    const row = rows.find(item => item.id === match[1])
    if (!row) return { url: '', desc: `深圳广电频道 ${match[1]} 当前不在官网列表中` }
    const playKey = await cachedLiveKey(row, { timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl, now: ctx.now })
    await reportViewer({ fetchImpl: ctx.fetchImpl, now: ctx.now, liveId: row.liveId })
    const unsigned = `https://${STREAM_HOST}/${row.liveId}/${row.rate}/${playKey}.m3u8`
    return {
      url: signStreamUrl(unsigned, ctx.now ?? Date.now()),
      desc: `${row.name}短效播放地址生成成功`,
      upstreamHeaders: requestHeaders(row.liveId),
      // 全代理在登记媒体清单里的每条绝对路径前调用；嵌套清单也沿用同一个函数。
      upstreamUrlTransform: signStreamUrl,
    }
  } catch (error) {
    return { url: '', desc: `深圳广电链接请求失败：${error?.message || String(error)}` }
  }
}

export function clearCache() {
  channelCache = null
  channelPending = null
  liveKeyCache.clear()
  liveKeyPending.clear()
  lastReportAt = 0
  reportPending = null
}
