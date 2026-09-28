/** 江苏网络台（荔枝网）的频道鉴权、短效 HLS 签名与缓存。 */
import { createHash } from 'node:crypto'
import fetch from 'node-fetch'
import { buildAuthRequest, tokenExpiry, UA } from './auth.js'

// 令牌签名是纯计算，挪到 auth.js 与节目单共用；这里照旧导出，原有调用方不用改
export { AUTH_URL, buildAuthRequest, encodeTimestamp } from './auth.js'
export const CHANNEL_LIST_URL = 'https://publish-lizhi.jstv.com/nav/8385'

// 官网网页包公开携带的取流签名参数，属于易变的平台实现细节。
const STREAM_SECRET = 'wrf2yJaCwC8HX3cfJz8P'
const STREAM_HOST = 'litchi-play-encrypted-site.jstv.com'
const CHANNEL_TTL_MS = 4 * 60 * 60 * 1000
const CHANNEL_RETRY_MS = 60 * 1000
const TOKEN_SKEW_SECONDS = 120
const STREAM_TTL_SECONDS = 180

export const UPSTREAM_HEADERS = {
  Origin: 'https://live.jstv.com',
  Referer: 'https://live.jstv.com/',
}

const NAME_OVERRIDES = {
  江苏卫视: '江苏卫视',
  江苏卫视4K超高清: '江苏卫视4K',
  江苏城市: '江苏城市',
  江苏综艺: '江苏综艺',
  江苏影视: '江苏影视',
  江苏新闻: '江苏新闻',
  江苏教育: '江苏教育',
  体育休闲: '江苏体育休闲',
  优漫卡通: '优漫卡通',
  江苏国际: '江苏国际',
}

let tokenCache = null
let channelCache = null
let channelPending = null

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

async function accessToken({ timeoutMs = 10000, fetchImpl = fetch, now = Date.now() } = {}) {
  const timestamp = Number(now)
  if (tokenCache?.expiresAt > timestamp + TOKEN_SKEW_SECONDS * 1000) return tokenCache.value

  const request = buildAuthRequest(timestamp)
  const response = await requestWithTimeout(request.url, {
    fetchImpl,
    init: {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
      body: JSON.stringify(request.body),
    },
  }, timeoutMs)
  if (!response.ok) throw new Error(`鉴权接口 HTTP ${response.status}`)
  const payload = await response.json()
  const token = String(payload?.data?.accessToken || '')
  if (!token) throw new Error(`鉴权接口返回异常：${payload?.message || payload?.code || '没有 accessToken'}`)
  tokenCache = { value: token, expiresAt: tokenExpiry(token) || timestamp + 8 * 60 * 1000 }
  return token
}

function validStreamUrl(raw) {
  try {
    const url = new URL(String(raw || ''))
    return url.protocol === 'https:'
      && (url.hostname === 'jstv.com' || url.hostname.endsWith('.jstv.com'))
      && /\.m3u8$/i.test(url.pathname)
  } catch {
    return false
  }
}

function normalizeRows(articles) {
  const rows = []
  const seen = new Set()
  for (const article of Array.isArray(articles) ? articles : []) {
    const id = String(article?.extraId || '').trim()
    const rawName = String(article?.title || article?.extraJson?.name || '').trim()
    const name = NAME_OVERRIDES[rawName]
    const url = String(article?.extraJson?.url || '').trim()
    if (!/^\d{1,8}$/.test(id) || !name || !validStreamUrl(url) || seen.has(id)) continue
    seen.add(id)
    rows.push({ id, name, url, logo: String(article?.thumbnailsJson?.[0] || '').trim() })
  }
  return rows
}

export async function fetchChannelList(options = {}) {
  const token = await accessToken(options)
  const response = await requestWithTimeout(CHANNEL_LIST_URL, {
    fetchImpl: options.fetchImpl || fetch,
    init: {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
    },
  }, options.timeoutMs || 10000)
  if (!response.ok) throw new Error(`频道接口 HTTP ${response.status}`)
  const payload = await response.json()
  const rows = normalizeRows(payload?.data?.articles)
  if (!rows.length) throw new Error(`频道接口返回异常：${payload?.message || payload?.code || '没有可用频道'}`)
  return rows
}

async function cachedChannelList(options = {}) {
  const now = Number(options.now ?? Date.now())
  if (channelCache?.expiresAt > now) return channelCache.rows
  if (channelCache?.retryAt > now) return channelCache.rows

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
    /^\d{1,8}$/.test(String(row?.id || ''))
    && Object.values(NAME_OVERRIDES).includes(row?.name)
    && validStreamUrl(row?.url))
  if (normalized.length) channelCache = { rows: normalized, expiresAt: Number(now) + CHANNEL_TTL_MS, retryAt: 0 }
}

export function buildChannels(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map(row => ({
      name: row.name,
      deferredRef: `jstv-${row.id}`,
      // CDN 同时校验短签名与 Origin/Referer，必须由本机代理清单和分片。
      proxyHls: true,
      logo: row.logo || '',
    }))
}

export function signStreamUrl(rawUrl, now = Date.now()) {
  const url = new URL(rawUrl)
  if (!validStreamUrl(url.href)) throw new Error('播放地址不是江苏网络台 HTTPS HLS')
  url.hostname = STREAM_HOST
  const stream = url.pathname.split('/').pop().replace(/\.m3u8$/i, '')
  const txTime = (Math.floor(Number(now) / 1000) + STREAM_TTL_SECONDS).toString(16)
  const txSecret = createHash('md5').update(`${STREAM_SECRET}${stream}${txTime}`).digest('hex')
  url.searchParams.set('txSecret', txSecret)
  url.searchParams.set('txTime', txTime)
  return url.href
}

export async function resolveChannel(ref, ctx = {}) {
  try {
    const match = /^jstv-(\d{1,8})$/.exec(String(ref || ''))
    if (!match) return { url: '', desc: '江苏网络台频道引用格式错误' }
    const rows = await cachedChannelList({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl, now: ctx.now })
    const row = rows.find(item => item.id === match[1])
    if (!row) return { url: '', desc: `江苏网络台频道 ${match[1]} 当前不在官网列表中` }
    return {
      url: signStreamUrl(row.url, ctx.now ?? Date.now()),
      desc: `${row.name}短效播放地址生成成功`,
      upstreamHeaders: UPSTREAM_HEADERS,
    }
  } catch (error) {
    return { url: '', desc: `江苏网络台链接请求失败：${error?.message || String(error)}` }
  }
}

export function clearCache() {
  tokenCache = null
  channelCache = null
  channelPending = null
}
