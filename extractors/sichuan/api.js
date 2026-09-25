/** 四川广播电视台官网频道、账号鉴权与短效 HLS。 */
import { createHash } from 'node:crypto'
import { proxyAwareFetch } from '../../utils/systemProxy.js'

export const SICHUAN_PAGE = 'https://www.sctv.com/channelLive'
export const SICHUAN_LIVE_PAGE = 'https://www.sctv.com/live/list'
export const SICHUAN_LIVE_API = 'https://gw.scgchc.com/app/v1/lives/list'
export const SICHUAN_LIVE_DETAIL_API = 'https://gw.scgchc.com/app/v1/lives'
export const SICHUAN_AUTH_API = 'https://gw.scgchc.com/app/v1/anti/getLiveSecret'
export const SICHUAN_MEDIA_HEADERS = Object.freeze({
  Origin: 'https://www.sctv.com',
  Referer: SICHUAN_PAGE,
})
export const SICHUAN_LIVE_MEDIA_HEADERS = Object.freeze({
  Origin: 'https://www.sctv.com',
  Referer: SICHUAN_LIVE_PAGE,
})

const MEDIA_HOSTS = new Set(['tvshowf.scgczm.com', 'hmmslivef.scgczm.com', 'mmslivef.scgchc.com'])
const CATALOG_TTL_MS = 4 * 60 * 60 * 1000
const SIGNED_REFRESH_MS = 45 * 1000
const SIGNED_HARD_TTL_MS = 4 * 60 * 1000
const RETRY_MS = 10 * 1000
const DEFAULT_HEADERS = Object.freeze({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
})

let catalogCache = null
let catalogPending = null
const signedCache = new Map()
const signedPending = new Map()

export function parseCredential(input) {
  let value = String(input ?? '').trim()
  if (!value) return ''
  value = value.replace(/^authorization\s*:\s*/i, '').replace(/^bearer\s+/i, '').trim()
  const assignment = value.match(/^scgc_useraccountinfo\s*=\s*(.+)$/is)
  if (assignment) value = assignment[1].trim()
  if (/^%7B/i.test(value)) {
    try { value = decodeURIComponent(value) } catch {}
  }
  if (value.startsWith('{')) {
    let parsed
    try { parsed = JSON.parse(value) } catch { throw new Error('四川账号 JSON 格式无效') }
    value = parsed?.access_token || parsed?.data?.access_token || parsed?.user?.access_token || ''
    if (!value) throw new Error('四川账号 JSON 中没有 access_token')
  }
  value = String(value).trim().replace(/^bearer\s+/i, '')
  if (!value || value.length > 12_000 || /[\s\x00-\x1f]/.test(value)) {
    throw new Error('四川 access_token 格式无效')
  }
  return value
}

/** 清单、子清单、AES 密钥和媒体分片统一限制在四川官方 CDN。 */
export function officialAssetUrl(raw) {
  const url = new URL(String(raw || '').trim())
  if (url.protocol !== 'https:' || url.username || url.password || !['', '443'].includes(url.port)
      || !MEDIA_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('四川广电接口返回了非官方媒体地址')
  }
  return url.href
}

export function officialHlsUrl(raw) {
  const url = new URL(officialAssetUrl(raw))
  if (!url.pathname.toLowerCase().endsWith('.m3u8')) {
    throw new Error('四川广电接口返回的不是 HLS 地址')
  }
  return url.href
}

export function upstreamHeadersFor(raw) {
  const url = new URL(officialAssetUrl(raw))
  return url.hostname.toLowerCase() === 'mmslivef.scgchc.com'
    ? SICHUAN_LIVE_MEDIA_HEADERS
    : SICHUAN_MEDIA_HEADERS
}

export function applySichuanSecret(rawUrl, secret) {
  const url = new URL(officialHlsUrl(rawUrl))
  const authKey = String(secret || '').replace(/^auth_key=/, '')
  if (!authKey) throw new Error('四川播放鉴权接口没有返回 auth_key')
  url.searchParams.set('auth_key', authKey)
  return url.href
}

/**
 * 频道图标：官网直播页目录每个频道自带两张官方图，和播放地址同一次请求拿到。
 * squareImg 是 320×320 白底方图（同一个台标 + 各频道名，9 个频道都能区分；4K 是横版台标），
 * pcover 是直播页列表用的横版图，几个频道是透明底白字，浅色播放器里看不见，只在 squareImg 缺失时兜底。
 * 老频道给的是 /sctv/1/image/... 相对路径，按官网前端的 staticPrefixUrl（kscgc.scgchc.com）拼完整。
 */
export const SICHUAN_IMAGE_BASE = 'https://kscgc.scgchc.com/'

export function officialLogoUrl(raw) {
  const text = String(raw || '').trim()
  if (!text) return ''
  try {
    const url = new URL(text, SICHUAN_IMAGE_BASE)
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : ''
  } catch {
    return ''
  }
}

function fieldIn(segment, key) {
  return segment.match(new RegExp(`"${key}":"([^"]*)"`))?.[1] || ''
}

export function parseChannelList(html) {
  const decoded = String(html || '').replaceAll('\\"', '"').replaceAll('\\/', '/')
  const pattern = /\{"id":"([^"]+)","name":"([^"]+)","playAddress":"(https:[^"]+\.m3u8[^"]*)"/g
  const matches = [...decoded.matchAll(pattern)]
  const found = new Map()
  for (const [index, match] of matches.entries()) {
    const id = String(match[1])
    const name = String(match[2]).replace(/\s+/g, ' ').trim()
    if (!/^\d{1,20}$/.test(id) || !name || name.includes('购物') || found.has(id)) continue
    // 图标字段在同一个频道对象里、播放地址之后；截到下一个频道对象为止，缺字段时不会借用下一台的图。
    const end = Math.min(matches[index + 1]?.index ?? decoded.length, match.index + 4000)
    const segment = decoded.slice(match.index + match[0].length, end)
    try {
      found.set(id, {
        id,
        name,
        rawUrl: officialHlsUrl(match[3]),
        logo: officialLogoUrl(fieldIn(segment, 'squareImg')) || officialLogoUrl(fieldIn(segment, 'pcover')),
      })
    } catch {}
  }
  return [...found.values()]
}

async function request(raw, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000)
  try {
    const fetchImpl = options.fetchImpl || proxyAwareFetch
    return await fetchImpl(String(raw), {
      redirect: 'follow',
      headers: { ...DEFAULT_HEADERS, ...options.headers },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

async function requestText(raw, options = {}) {
  const response = await request(raw, options)
  const text = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText || ''}`.trim())
  return { response, text }
}

async function requestChannelList(options = {}) {
  try {
    const { text } = await requestText(SICHUAN_PAGE, options)
    const rows = parseChannelList(text)
    if (rows.length < 8) throw new Error(`官网只解析到 ${rows.length} 个电视频道，页面结构可能已变化`)
    return rows
  } catch (error) {
    const reason = error?.name === 'AbortError'
      ? `超时 ${options.timeoutMs || 15000}ms`
      : (error?.message || String(error))
    throw new Error(`四川频道接口请求失败：${reason}`)
  }
}

function primeCatalogCache(rows, now = Date.now()) {
  if (!Array.isArray(rows) || !rows.length) return
  catalogCache = { rows, expiresAt: Number(now) + CATALOG_TTL_MS }
}

export async function fetchChannelList(options = {}) {
  const rows = await requestChannelList(options)
  primeCatalogCache(rows, options.now ?? Date.now())
  return rows
}

async function cachedChannelList(options = {}) {
  const now = Number(options.now ?? Date.now())
  if (catalogCache?.expiresAt > now) return catalogCache.rows
  if (!catalogPending) {
    catalogPending = requestChannelList(options)
      .then(rows => {
        primeCatalogCache(rows, now)
        return catalogCache.rows
      })
      .finally(() => { catalogPending = null })
  }
  return catalogPending
}

export function buildChannels(rows) {
  return (Array.isArray(rows) ? rows : []).map(row => ({
    name: row.name,
    deferredRef: `sichuan-${row.id}`,
    logo: row.logo || '',
    opts: ['network-caching=3000'],
    catchup: 'none',
  }))
}

export function buildLiveChannels(rows) {
  return (Array.isArray(rows) ? rows : []).map(row => ({
    name: row.name,
    deferredRef: `sichuan-live-${row.id}`,
    logo: row.cover || '',
    opts: ['network-caching=3000'],
    catchup: 'none',
  }))
}

export function parseLiveList(payload) {
  if (Number(payload?.rs) !== 200 || !Array.isArray(payload?.data)) {
    throw new Error(payload?.error || payload?.message || '四川活动直播接口返回异常')
  }
  const seen = new Set()
  return payload.data.flatMap(item => {
    const id = String(item?.id || '')
    const name = String(item?.title || '').replace(/\s+/g, ' ').trim()
    if (!/^\d{1,20}$/.test(id) || !name || seen.has(id)) return []
    seen.add(id)
    return [{ id, name, cover: String(item?.cover || '') }]
  })
}

function extractLiveDetail(payload, expectedId = '') {
  const item = payload?.data
  if (Number(payload?.rs) !== 200 || !item || String(item.id || '') !== String(expectedId)) {
    throw new Error(payload?.error || payload?.message || '四川活动直播详情返回异常')
  }
  if (Number(item.status) !== 1) throw new Error('四川活动直播已经结束')
  const stream = (Array.isArray(item.stream) ? item.stream : [])
    .map(row => row?.address)
    .find(Boolean)
  if (!stream) throw new Error('四川活动直播当前没有播放地址')
  return {
    id: String(item.id),
    name: String(item.title || '').replace(/\s+/g, ' ').trim(),
    cover: String(item.cover || ''),
    url: officialHlsUrl(stream),
  }
}

async function requestLiveDetail(id, options = {}) {
  const { text } = await requestText(`${SICHUAN_LIVE_DETAIL_API}/${id}`, {
    ...options,
    headers: SICHUAN_LIVE_MEDIA_HEADERS,
  })
  let payload
  try { payload = JSON.parse(text) } catch { throw new Error('四川活动直播详情不是有效 JSON') }
  return extractLiveDetail(payload, id)
}

async function liveEventAvailable(item, options = {}) {
  const detail = await requestLiveDetail(item.id, options)
  const response = await request(detail.url, {
    ...options,
    headers: SICHUAN_LIVE_MEDIA_HEADERS,
  })
  if (!response.ok) return null
  const text = await response.text()
  return text.trimStart().startsWith('#EXTM3U') ? { ...item, ...detail } : null
}

export async function fetchLiveEvents(options = {}) {
  const { text } = await requestText(SICHUAN_LIVE_API, {
    ...options,
    headers: SICHUAN_LIVE_MEDIA_HEADERS,
  })
  let payload
  try { payload = JSON.parse(text) } catch { throw new Error('四川活动直播目录不是有效 JSON') }
  const candidates = parseLiveList(payload)
  const checked = await Promise.all(candidates.map(async item => {
    try { return await liveEventAvailable(item, options) } catch { return null }
  }))
  return checked.filter(Boolean)
}

async function requestSignedUrl(row, accessToken, options = {}) {
  const endpoint = new URL(SICHUAN_AUTH_API)
  endpoint.searchParams.set('streamName', new URL(row.rawUrl).pathname)
  endpoint.searchParams.set('txTime', Math.floor(Number(options.now ?? Date.now()) / 1000))
  const { text } = await requestText(endpoint, {
    ...options,
    headers: {
      authorization: `bearer ${accessToken}`,
      ...SICHUAN_MEDIA_HEADERS,
    },
  })
  let payload
  try { payload = JSON.parse(text) } catch { throw new Error('四川播放鉴权接口没有返回有效 JSON') }
  if (Number(payload?.rs) !== 200 || !payload?.data?.secret) {
    throw new Error(payload?.error || payload?.message || '四川播放鉴权接口返回异常')
  }
  return applySichuanSecret(row.rawUrl, payload.data.secret)
}

function credentialKey(accessToken) {
  return createHash('sha256').update(accessToken).digest('base64url').slice(0, 16)
}

async function cachedSignedUrl(row, accessToken, options = {}) {
  const now = Number(options.now ?? Date.now())
  const key = `${credentialKey(accessToken)}:${row.id}`
  const cached = signedCache.get(key)
  if (cached?.refreshAt > now || (cached?.retryAt > now && cached?.hardExpiresAt > now)) return cached.url

  let pending = signedPending.get(key)
  if (!pending) {
    pending = requestSignedUrl(row, accessToken, options)
      .then(url => {
        signedCache.set(key, {
          url,
          refreshAt: now + SIGNED_REFRESH_MS,
          hardExpiresAt: now + SIGNED_HARD_TTL_MS,
          retryAt: 0,
        })
        return url
      })
      .finally(() => {
        if (signedPending.get(key) === pending) signedPending.delete(key)
      })
    signedPending.set(key, pending)
  }
  try {
    return await pending
  } catch (error) {
    if (!cached || cached.hardExpiresAt <= now) throw error
    cached.retryAt = now + RETRY_MS
    return cached.url
  }
}

export function claimsRef(ref) {
  return /^sichuan-\d{1,20}$/.test(String(ref || ''))
    || /^sichuan-live-\d{1,20}$/.test(String(ref || ''))
}

export async function resolveChannel(ref, ctx = {}) {
  try {
    const value = String(ref || '')
    const liveMatch = /^sichuan-live-(\d{1,20})$/.exec(value)
    if (liveMatch) {
      const event = await requestLiveDetail(liveMatch[1], {
        timeoutMs: ctx.timeoutMs,
        fetchImpl: ctx.fetchImpl,
      })
      return {
        url: event.url,
        desc: `${event.name}活动直播地址获取成功`,
        upstreamHeaders: upstreamHeadersFor,
        upstreamUrlTransform: officialAssetUrl,
      }
    }
    const match = /^sichuan-(\d{1,20})$/.exec(value)
    if (!match) return { url: '', desc: '四川频道引用格式错误' }
    const accessToken = parseCredential(ctx.config?.accessToken)
    if (!accessToken) return { url: '', desc: '四川频道需要先在后台关联官网登录 Token' }
    const rows = await cachedChannelList({
      timeoutMs: ctx.timeoutMs,
      fetchImpl: ctx.fetchImpl,
      now: ctx.now,
    })
    const row = rows.find(item => item.id === match[1])
    if (!row) return { url: '', desc: `四川频道 ${match[1]} 当前不在官网公开列表中` }
    const url = await cachedSignedUrl(row, accessToken, {
      timeoutMs: ctx.timeoutMs,
      fetchImpl: ctx.fetchImpl,
      now: ctx.now,
    })
    return {
      url,
      desc: `${row.name}短效播放地址获取成功`,
      upstreamHeaders: upstreamHeadersFor,
      upstreamUrlTransform: officialAssetUrl,
    }
  } catch (error) {
    const message = error?.name === 'AbortError'
      ? '四川官方接口请求超时'
      : (error?.message || String(error))
    return { url: '', desc: `四川广电链接请求失败：${message}` }
  }
}

export function clearCache() {
  catalogCache = null
  catalogPending = null
  signedCache.clear()
  signedPending.clear()
}
