/** 大连云当前公开客户端的电视目录、匿名媒体票据与腾讯云 HLS 地址。 */
import fetch from 'node-fetch'
import { generateSm2KeyPair, sm2Decrypt, sm2Encrypt } from './sm2.js'

const API_ORIGIN = 'https://wan-dlrm.dlrm.cn'
const API_BASE = `${API_ORIGIN}/app/`
const API_HOST = 'wan-dlrm.dlrm.cn'
const STREAM_HOST = 'livepull.dlrm.cn'
const RESOURCE_HOST = 'nginx-dlrm.dlrm.cn'
const APP_VERSION = '5.7.0'
const APP_KEY = 'mediax-dev-app'
const APP_SECRET = '367bde41-4eae-4c59-b151-47fc1ce83153'
const SERVER_PUBLIC_KEY = '04195D1F93F950DDCC8C8384DD47DEBBD19B2897753686DE6B2EC87B583578325DF9191865258EB22A08AEFE4AA5E0EAD59D0EFB0187B0649EEF9008222BD3DA22'
const CATALOG_TTL_MS = 5 * 60 * 1000
const STALE_TTL_MS = 30 * 60 * 1000
const RETRY_TTL_MS = 60 * 1000
const TOKEN_SAFETY_MS = 30 * 1000
const CLIENT_TIME_OFFSET_MS = 3 * 60 * 60 * 1000
const UA = `DalianCloud/${APP_VERSION} (Android; MediaX)`

// IDs and names are fixed to the formal TV services exposed by the current official app.
// A whitelist keeps test/dev rooms, temporary events, radio and any future shopping service out.
const FORMAL_TV = new Map([
  [7, { name: '大连新闻综合', upstreamName: '新闻综合频道' }],
  [8, { name: '大连生活', upstreamName: '生活频道' }],
  [9, { name: '大连文体', upstreamName: '文体频道' }],
])
const FORMAL_TV_ORDER = new Map([...FORMAL_TV.keys()].map((id, index) => [id, index]))

let authCache = null
let authPending = null
let catalogCache = null
let catalogPending = null

function exactHttpsUrl(raw, hostname) {
  try {
    const url = new URL(String(raw || ''))
    return url.protocol === 'https:' && url.hostname === hostname && !url.username && !url.password ? url : null
  } catch { return null }
}

export function officialStreamUrl(raw, now = Date.now()) {
  const url = exactHttpsUrl(raw, STREAM_HOST)
  if (!url || !/^\/dlrm\/[0-9a-f-]{36}\.m3u8$/i.test(url.pathname)) return ''
  const secret = url.searchParams.get('txSecret')
  const expiresHex = url.searchParams.get('txTime')
  if (!/^[0-9a-f]{64}$/i.test(secret || '') || !/^[0-9a-f]{8}$/i.test(expiresHex || '')) return ''
  if ([...url.searchParams.keys()].some(key => key !== 'txSecret' && key !== 'txTime')) return ''
  const expiresAt = Number.parseInt(expiresHex, 16) * 1000
  return Number.isSafeInteger(expiresAt) && expiresAt > Number(now) + 60_000 ? url.href : ''
}

function officialLogo(raw) {
  const url = exactHttpsUrl(raw, RESOURCE_HOST)
  return url && /^\/dlrm\/site1\/resource\/tv\/dlrm\//.test(url.pathname) ? url.href : ''
}

/** Normalize only formal television services; never infer a channel from its display name. */
export function normalizeChannels(payload, now = Date.now()) {
  if (Number(payload?.status) !== 0) return []
  const channels = Array.isArray(payload?.data?.channels) ? payload.data.channels : []
  const output = []
  const seen = new Set()
  for (const channel of channels) {
    const id = Number(channel?.id)
    const formal = FORMAL_TV.get(id)
    if (!formal || seen.has(id) || Number(channel?.siteID) !== 1 || Number(channel?.type) !== 1) continue
    if (String(channel?.name || '').trim() !== formal.upstreamName || /购物|测试|研发/.test(channel.name)) continue
    const url = officialStreamUrl(channel.liveUrl, now)
    if (!url) continue
    seen.add(id)
    output.push({ id, name: formal.name, upstreamName: formal.upstreamName, url, logo: officialLogo(channel.iconTop || channel.icon) })
  }
  return output.sort((left, right) => FORMAL_TV_ORDER.get(left.id) - FORMAL_TV_ORDER.get(right.id))
}

function commonHeaders(extra = {}) {
  return { Accept: 'application/json', 'User-Agent': UA, ...extra }
}

async function timedFetch(url, options = {}, timeoutMs = 10000, fetchImpl = fetch) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal })
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : (error?.message || String(error))
    throw new Error(reason)
  } finally { clearTimeout(timer) }
}

async function readJson(response) {
  if (!response?.ok) throw new Error(`HTTP ${response?.status || 0}`)
  try { return await response.json() }
  catch { throw new Error('上游没有返回有效 JSON') }
}

function assertResponseUrl(response, hostname, pathname) {
  const url = exactHttpsUrl(response?.url, hostname)
  if (!url || (pathname && url.pathname !== pathname)) throw new Error('上游响应被重定向到非官方地址')
  return url
}

export function ticketPlaintext(token, now = Date.now(), secret = APP_SECRET) {
  return JSON.stringify({ token, timestamp: Number(now) + CLIENT_TIME_OFFSET_MS, secret })
}

/** Perform the same anonymous key exchange published in the current Android client. */
export async function requestMediaToken(options = {}) {
  const fetchImpl = options.fetchImpl || fetch
  const serverPublicKey = options.serverPublicKey || SERVER_PUBLIC_KEY
  const keyPair = generateSm2KeyPair(options)
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries({
    type: 'app', key: APP_KEY, secret: APP_SECRET, publicKey: keyPair.publicKey,
  })) query.set(key, sm2Encrypt(serverPublicKey, value, options))
  const endpoint = new URL(`security/token?${query}`, API_BASE)
  if (endpoint.hostname !== API_HOST) throw new Error('媒体令牌接口域名异常')
  const response = await timedFetch(endpoint, { headers: commonHeaders() }, options.timeoutMs, fetchImpl)
  assertResponseUrl(response, API_HOST, '/app/security/token')
  const payload = await readJson(response)
  if (Number(payload?.status) !== 0 || typeof payload?.data !== 'string') {
    throw new Error(payload?.message || `媒体令牌状态 ${payload?.status}`)
  }
  let decoded
  try { decoded = JSON.parse(sm2Decrypt(keyPair.privateKey, payload.data).toString('utf8')) }
  catch (error) { throw new Error(`媒体令牌解密失败：${error?.message || String(error)}`) }
  const token = String(decoded?.token || '')
  const timeout = Number(decoded?.timeout)
  if (!/^app\.[A-Za-z0-9.]+$/.test(token) || !Number.isSafeInteger(timeout) || timeout <= Number(options.now ?? Date.now())) {
    throw new Error('媒体令牌内容无效或已过期')
  }
  return { token, timeout, keyPair }
}

async function mediaAuth(options = {}) {
  const now = Number(options.now ?? Date.now())
  if (authCache?.timeout > now + TOKEN_SAFETY_MS) return authCache
  if (!authPending) {
    authPending = requestMediaToken(options)
      .then(value => { authCache = value; return value })
      .finally(() => { authPending = null })
  }
  return authPending
}

async function requestCatalog(options = {}) {
  const now = Number(options.now ?? Date.now())
  const auth = await mediaAuth(options)
  const endpoint = new URL('tv/channels', API_BASE)
  endpoint.search = new URLSearchParams({
    siteID: '1', type: '1', appID: '1', siteId: '1', curVersions: '2', appVersion: APP_VERSION,
    longitude: '0', latitude: '0', location: '', deviceId: 'iptv-dalian-extractor',
  })
  if (endpoint.hostname !== API_HOST) throw new Error('电视频道接口域名异常')
  const ticket = sm2Encrypt(SERVER_PUBLIC_KEY, ticketPlaintext(auth.token, now))
  const response = await timedFetch(endpoint, {
    headers: commonHeaders({ ticket, source: 'APP' }),
  }, options.timeoutMs, options.fetchImpl || fetch)
  assertResponseUrl(response, API_HOST, '/app/tv/channels')
  const payload = await readJson(response)
  if (Number(payload?.status) !== 0) throw new Error(payload?.message || `频道目录状态 ${payload?.status}`)
  return normalizeChannels(payload, now)
}

function officialSegmentUrl(raw, manifestUrl) {
  try {
    const url = new URL(raw, manifestUrl)
    return url.protocol === 'https:' && url.hostname === STREAM_HOST
      && /^\/dlrm\/[0-9a-f-]{36}-\d+\.ts$/i.test(url.pathname) ? url.href : ''
  } catch { return '' }
}

export async function probeLive(row, options = {}) {
  const response = await timedFetch(row.url, {
    headers: { Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL', 'User-Agent': UA },
  }, Math.min(Number(options.timeoutMs) || 10000, 8000), options.fetchImpl || fetch)
  assertResponseUrl(response, STREAM_HOST)
  if (!response.ok) throw new Error(`HLS HTTP ${response.status}`)
  const text = await response.text()
  const lines = text.trim().split(/\r?\n/)
  const segments = lines.filter(line => line && !line.startsWith('#'))
  if (lines[0] !== '#EXTM3U' || !lines.some(line => line.startsWith('#EXTINF:')) || !segments.length
      || !officialSegmentUrl(segments.at(-1), response.url || row.url)) {
    throw new Error('官方地址没有返回正在产出的 HLS 清单')
  }
  return true
}

async function freshRows(options = {}) {
  const catalog = await requestCatalog(options)
  const checked = await Promise.all(catalog.map(async row => {
    try { await probeLive(row, options); return { row, error: '' } }
    catch (error) { return { row: null, name: row.name, error: error?.message || String(error) } }
  }))
  return {
    rows: checked.flatMap(item => item.row ? [item.row] : []),
    skipped: checked.flatMap(item => item.row ? [] : [{ name: item.name, reason: item.error }]),
  }
}

async function cachedCatalog(options = {}) {
  const now = Number(options.now ?? Date.now())
  if (catalogCache?.expiresAt > now || catalogCache?.retryAt > now) {
    return { rows: catalogCache.rows, skipped: [], warnings: catalogCache.retryAt > now ? ['本轮使用最近一次成功目录'] : [] }
  }
  if (!catalogPending) {
    catalogPending = freshRows(options).then(result => {
      catalogCache = { rows: result.rows, expiresAt: now + CATALOG_TTL_MS, staleUntil: now + STALE_TTL_MS, retryAt: 0 }
      return { ...result, warnings: [] }
    }).finally(() => { catalogPending = null })
  }
  try { return await catalogPending }
  catch (error) {
    if (!catalogCache || catalogCache.staleUntil <= now) throw error
    catalogCache.retryAt = now + RETRY_TTL_MS
    return { rows: catalogCache.rows, skipped: [], warnings: [`官方接口暂时失败，使用最近一次成功目录：${error?.message || String(error)}`] }
  }
}

export async function fetchChannelRows(options = {}) {
  return cachedCatalog(options)
}

export function buildChannelGroups(rows) {
  const dataList = (Array.isArray(rows) ? rows : []).map(row => ({
    name: row.name,
    deferredRef: `dalian-${row.id}`,
    proxyHls: true,
    logo: row.logo || '',
    opts: ['network-caching=3000'],
  }))
  return dataList.length ? [{ name: '辽宁', dataList }] : []
}

export async function resolveChannel(ref, ctx = {}) {
  try {
    const match = /^dalian-(7|8|9)$/.exec(String(ref || ''))
    if (!match) return { url: '', desc: '大连云频道引用格式错误' }
    const result = await cachedCatalog({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl, now: ctx.now })
    const row = result.rows.find(item => item.id === Number(match[1]))
    if (!row) return { url: '', desc: '该大连频道当前没有真实在线直播' }
    const url = officialStreamUrl(row.url, ctx.now ?? Date.now())
    if (!url) return { url: '', desc: '大连云返回的播放地址已过期或域名异常' }
    return {
      url,
      desc: `${row.name}官方直播地址获取成功`,
      upstreamHeaders: { Referer: `${API_ORIGIN}/`, 'User-Agent': UA },
    }
  } catch (error) {
    return { url: '', desc: `大连云链接请求失败：${error?.message || String(error)}` }
  }
}

export function clearCache() {
  authCache = null
  authPending = null
  catalogCache = null
  catalogPending = null
}
