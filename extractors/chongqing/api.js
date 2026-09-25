/** 重庆广电“重庆手机台”：公开频道目录与匿名短效 HLS 地址。 */
import { proxyAwareFetch } from '../../utils/systemProxy.js'

export const CHONGQING_PAGE = 'https://sj.cbg.cn/wap/list/4918/1.html'
export const CHONGQING_LIST_API = 'https://rmtapi.cbg.cn/list/4918/1.html?pagesize=100'
export const CHONGQING_RESOLVE_API = 'https://web.cbg.cn/live/getLiveUrl'

const MEDIA_HOST = /^sjlivecdn[a-z0-9]*\.cbg\.cn$/i
const CATALOG_TTL_MS = 5 * 60 * 1000
const SIGNED_REFRESH_MS = 45 * 1000
const SIGNED_HARD_TTL_MS = 5 * 60 * 1000
const RETRY_MS = 10 * 1000
const DEFAULT_HEADERS = Object.freeze({
  'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  Referer: CHONGQING_PAGE,
})

let catalogCache = null
let catalogPending = null
const signedCache = new Map()
const signedPending = new Map()

/** 全代理登记每条子清单、AES 密钥和分片前都走这里，避免清单注入任意回源。 */
export function officialAssetUrl(raw) {
  const url = new URL(String(raw || '').trim())
  if (url.protocol !== 'https:' || url.username || url.password || !['', '443'].includes(url.port)
      || !MEDIA_HOST.test(url.hostname)) {
    throw new Error('重庆广电接口返回了非官方媒体地址')
  }
  return url.href
}

export function officialHlsUrl(raw) {
  const url = new URL(officialAssetUrl(raw))
  if (!url.pathname.toLowerCase().endsWith('.m3u8')) {
    throw new Error('重庆广电接口返回的不是 HLS 地址')
  }
  return url.href
}

/** hlsProxy 每次真正回源（包括重定向后的目标）都会重新调用，空对象表示无需防盗链头。 */
export function upstreamHeadersFor(url) {
  officialAssetUrl(url)
  return {}
}

function officialLogo(raw) {
  if (!raw) return ''
  try {
    const url = new URL(String(raw).trim())
    return url.protocol === 'https:'
      && !url.username && !url.password && ['', '443'].includes(url.port)
      && (url.hostname === 'cbg.cn' || url.hostname.endsWith('.cbg.cn'))
      ? url.href
      : ''
  } catch {
    return ''
  }
}

export function parseChannelList(payload) {
  if (payload?.code !== 0 || !Array.isArray(payload?.data?.lists)) {
    throw new Error('重庆频道列表接口返回异常')
  }
  const found = new Map()
  for (const item of payload.data.lists) {
    if (item?.tvorfm !== 'tv') continue
    const id = String(item.id ?? '').trim()
    const name = String(item.title || '').replace(/\s+/g, ' ').trim()
    if (!/^\d{1,10}$/.test(id) || !name || found.has(id)) continue
    const raw = item.ios_HDlive_url || item.android_HDlive_url || item.ios_url || item.android_url
    if (!raw) continue
    found.set(id, {
      id,
      name,
      rawUrl: officialHlsUrl(raw),
      // 台标在 thumb_mob（App 频道卡，cmsimg.cbg.cn 上的重庆广电台标）；pic / thumb / image 目前都是空的
      logo: officialLogo(item.thumb_mob || item.pic || item.thumb || item.image),
    })
  }
  return [...found.values()]
}

async function requestJson(raw, { timeoutMs = 15000, fetchImpl = proxyAwareFetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(String(raw), {
      redirect: 'follow',
      headers: DEFAULT_HEADERS,
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText || ''}`.trim())
    try { return JSON.parse(text) } catch { throw new Error('接口没有返回有效 JSON') }
  } finally {
    clearTimeout(timer)
  }
}

async function requestChannelList(options = {}) {
  try {
    const rows = parseChannelList(await requestJson(CHONGQING_LIST_API, options))
    if (!rows.length) throw new Error('官网当前没有公开电视直播')
    return rows
  } catch (error) {
    const reason = error?.name === 'AbortError'
      ? `超时 ${options.timeoutMs || 15000}ms`
      : (error?.message || String(error))
    throw new Error(`重庆频道接口请求失败：${reason}`)
  }
}

export function primeCatalogCache(rows, now = Date.now()) {
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
    deferredRef: `chongqing-${row.id}`,
    logo: row.logo || '',
    opts: ['network-caching=3000'],
    catchup: 'none',
  }))
}

async function requestSignedUrl(row, options = {}) {
  const endpoint = new URL(CHONGQING_RESOLVE_API)
  endpoint.searchParams.set('url', row.rawUrl)
  const payload = await requestJson(endpoint, options)
  if (payload?.code !== 0 || !payload?.data?.url) {
    throw new Error(payload?.message || '重庆播放地址解析接口返回异常')
  }
  return officialHlsUrl(payload.data.url)
}

async function cachedSignedUrl(row, options = {}) {
  const now = Number(options.now ?? Date.now())
  const cached = signedCache.get(row.id)
  if (cached?.refreshAt > now || (cached?.retryAt > now && cached?.hardExpiresAt > now)) return cached.url

  let pending = signedPending.get(row.id)
  if (!pending) {
    pending = requestSignedUrl(row, options)
      .then(url => {
        signedCache.set(row.id, {
          url,
          refreshAt: now + SIGNED_REFRESH_MS,
          hardExpiresAt: now + SIGNED_HARD_TTL_MS,
          retryAt: 0,
        })
        return url
      })
      .finally(() => {
        if (signedPending.get(row.id) === pending) signedPending.delete(row.id)
      })
    signedPending.set(row.id, pending)
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
  return /^chongqing-\d{1,10}$/.test(String(ref || ''))
}

export async function resolveChannel(ref, ctx = {}) {
  try {
    const match = /^chongqing-(\d{1,10})$/.exec(String(ref || ''))
    if (!match) return { url: '', desc: '重庆频道引用格式错误' }
    const rows = await cachedChannelList({
      timeoutMs: ctx.timeoutMs,
      fetchImpl: ctx.fetchImpl,
      now: ctx.now,
    })
    const row = rows.find(item => item.id === match[1])
    if (!row) return { url: '', desc: `重庆频道 ${match[1]} 当前不在官网公开列表中` }
    const url = await cachedSignedUrl(row, {
      timeoutMs: ctx.timeoutMs,
      fetchImpl: ctx.fetchImpl,
      now: ctx.now,
    })
    return {
      url,
      desc: `${row.name}匿名短效播放地址获取成功`,
      upstreamHeaders: upstreamHeadersFor,
      upstreamUrlTransform: officialAssetUrl,
    }
  } catch (error) {
    return { url: '', desc: `重庆广电链接请求失败：${error?.message || String(error)}` }
  }
}

export function clearCache() {
  catalogCache = null
  catalogPending = null
  signedCache.clear()
  signedPending.clear()
}
