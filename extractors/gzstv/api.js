/** 贵州广电官网：固定频道目录与播放时动态签名 HLS。 */
import { proxyAwareFetch } from '../../utils/systemProxy.js'

export const GZSTV_API_ORIGIN = 'https://api.gzstv.com'
export const GZSTV_PAGE_ORIGIN = 'https://www.gzstv.com'
export const GZSTV_MEDIA_ORIGIN = 'https://9bwaz8y2.gzstv.com'

const MEDIA_HOST = '9bwaz8y2.gzstv.com'
const MEDIA_PATH_PREFIX = '/live/'
const TOKEN_REFRESH_MS = 30 * 1000
const TOKEN_HARD_TTL_MS = 2 * 60 * 1000
const TOKEN_RETRY_MS = 5 * 1000
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const LOGO_BASE = 'https://mstatic.gzstv.com/media/streams/images/2021/01/04/'

// 台标是频道接口（/v1/tv/<slug>/）下发的 image 字段，官网播放器拿它当封面：每套一张 500×500 的
// 「贵州-N」频道标，8 张实测都是 JPEG。接口只能逐台查、取流时才调，频道表本身写死，地址也一并写死；
// 经济频道（ch09）接口给的就是「贵州-7」那张，不是抄错。
export const CHANNELS = Object.freeze([
  Object.freeze({ ref: 'gzstv-satellite', slug: 'ch01', streamName: 'CH01_lo.m3u8', rawName: '贵州卫视', name: '贵州卫视',
    logo: `${LOGO_BASE}Wv8DYDU_DFQg.jpg` }),
  Object.freeze({ ref: 'gzstv-public', slug: 'ch02', streamName: 'CH02_lo.m3u8', rawName: '公共频道', name: '贵州公共',
    logo: `${LOGO_BASE}SoNtDtRcuDbR.jpg` }),
  Object.freeze({ ref: 'gzstv-film-arts', slug: 'ch03', streamName: 'CH03_lo.m3u8', rawName: '影视文艺频道', name: '贵州影视文艺',
    logo: `${LOGO_BASE}kq09201cePrU.jpg` }),
  Object.freeze({ ref: 'gzstv-life', slug: 'ch04', streamName: 'CH04_lo.m3u8', rawName: '大众生活频道', name: '贵州大众生活',
    logo: `${LOGO_BASE}TlQgNo6srb2p.jpg` }),
  Object.freeze({ ref: 'gzstv-eco-rural', slug: 'ch05', streamName: 'CH05_lo.m3u8', rawName: '生态·乡村频道', name: '贵州生态乡村',
    logo: `${LOGO_BASE}fGTUM0FqTtzG.jpg` }),
  Object.freeze({ ref: 'gzstv-science-health', slug: 'ch06', streamName: 'CH06_lo.m3u8', rawName: '科教健康频道', name: '贵州科教健康',
    logo: `${LOGO_BASE}sz3062_R-Ma-.jpg` }),
  Object.freeze({ ref: 'gzstv-economy', slug: 'ch09', streamName: 'CH09_lo.m3u8', rawName: '贵州经济频道', name: '贵州经济',
    logo: `${LOGO_BASE}Y2UfPmdykgir.jpg` }),
  Object.freeze({ ref: 'gzstv-mobile', slug: 'ch13', streamName: 'CH13_lo.m3u8', rawName: '贵州移动电视', name: '贵州移动电视',
    logo: `${LOGO_BASE}b9BSCCj5xEsx.jpg` }),
])

const CHANNEL_BY_REF = new Map(CHANNELS.map(channel => [channel.ref, channel]))
const tokenCache = new Map()
const tokenPending = new Map()

/** 全代理登记清单、密钥和分片前统一校验，避免官方清单注入任意回源。 */
export function officialAssetUrl(raw) {
  const url = new URL(String(raw || '').trim())
  if (url.protocol !== 'https:' || url.username || url.password || !['', '443'].includes(url.port)
      || url.hostname !== MEDIA_HOST || !url.pathname.startsWith(MEDIA_PATH_PREFIX)) {
    throw new Error('贵州广电返回了非官方媒体地址')
  }
  return url.href
}

export function officialHlsUrl(raw, expectedStreamName = '') {
  const url = new URL(officialAssetUrl(raw))
  if (!url.pathname.toLowerCase().endsWith('.m3u8')) {
    throw new Error('贵州广电返回的不是 HLS 地址')
  }
  if (expectedStreamName && url.pathname !== `${MEDIA_PATH_PREFIX}${expectedStreamName}`) {
    throw new Error('贵州广电返回的频道与请求不一致')
  }
  if (!/^[a-f0-9]{32}$/i.test(url.searchParams.get('txSecret') || '')
      || !/^[a-f0-9]{8,16}$/i.test(url.searchParams.get('txTime') || '')) {
    throw new Error('贵州广电当前没有返回有效直播签名')
  }
  return url.href
}

export function upstreamHeadersFor(raw) {
  officialAssetUrl(raw)
  return {
    Origin: GZSTV_PAGE_ORIGIN,
    Referer: `${GZSTV_PAGE_ORIGIN}/`,
  }
}

export function parseStreamResponse(payload, channel) {
  let data = payload
  if (typeof payload === 'string') {
    try { data = JSON.parse(payload) } catch { throw new Error('贵州广电接口没有返回有效 JSON') }
  }
  if (!channel || !CHANNEL_BY_REF.has(channel.ref)) throw new Error('未知贵州频道')
  if (!data || String(data.title || '').trim() !== channel.rawName || typeof data.stream_url !== 'string') {
    throw new Error('贵州广电当前没有返回有效直播地址')
  }
  return officialHlsUrl(data.stream_url, channel.streamName)
}

export function buildStreamRequest(channel) {
  if (!channel || !CHANNEL_BY_REF.has(channel.ref)) throw new Error('未知贵州频道')
  return {
    url: `${GZSTV_API_ORIGIN}/v1/tv/${channel.slug}/?fields=title,stream_url`,
    options: {
      redirect: 'manual',
      headers: {
        Accept: 'application/json, text/plain, */*',
        Origin: GZSTV_PAGE_ORIGIN,
        Referer: `${GZSTV_PAGE_ORIGIN}/tv/${channel.slug}`,
        'User-Agent': UA,
      },
    },
  }
}

async function requestSignedStream(channel, {
  timeoutMs = 15000,
  fetchImpl = proxyAwareFetch,
} = {}) {
  const request = buildStreamRequest(channel)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(request.url, { ...request.options, signal: controller.signal })
    const text = await response.text()
    if (!response.ok) throw new Error(`频道接口 HTTP ${response.status}`)
    if (text.length > 64 * 1024) throw new Error('频道接口响应过大')
    return parseStreamResponse(text, channel)
  } finally {
    clearTimeout(timer)
  }
}

async function cachedSignedStream(channel, options = {}) {
  const now = Number(options.now ?? Date.now())
  const fetchImpl = options.fetchImpl || proxyAwareFetch
  const cached = tokenCache.get(channel.ref)
  if (cached?.refreshAt > now || (cached?.retryAt > now && cached?.hardExpiresAt > now)) {
    return cached.url
  }

  let pending = tokenPending.get(channel.ref)
  if (!pending || pending.fetchImpl !== fetchImpl) {
    const promise = requestSignedStream(channel, { ...options, fetchImpl })
      .then(url => {
        tokenCache.set(channel.ref, {
          url,
          fetchImpl,
          refreshAt: now + TOKEN_REFRESH_MS,
          hardExpiresAt: now + TOKEN_HARD_TTL_MS,
          retryAt: 0,
        })
        return url
      })
      .finally(() => {
        if (tokenPending.get(channel.ref)?.promise === promise) tokenPending.delete(channel.ref)
      })
    pending = { promise, fetchImpl }
    tokenPending.set(channel.ref, pending)
  }

  try {
    return await pending.promise
  } catch (error) {
    if (!cached || cached.hardExpiresAt <= now) throw error
    cached.retryAt = now + TOKEN_RETRY_MS
    return cached.url
  }
}

export function buildChannels() {
  return CHANNELS.map(channel => ({
    name: channel.name,
    deferredRef: channel.ref,
    logo: channel.logo,
    opts: ['network-caching=3000'],
    catchup: 'none',
  }))
}

export function claimsRef(ref) {
  return CHANNEL_BY_REF.has(String(ref || ''))
}

export async function resolveChannel(ref, ctx = {}) {
  const channel = CHANNEL_BY_REF.get(String(ref || ''))
  if (!channel) return { url: '', desc: '贵州频道引用格式错误' }
  try {
    const url = await cachedSignedStream(channel, {
      timeoutMs: ctx.timeoutMs,
      fetchImpl: ctx.fetchImpl,
      now: ctx.now,
    })
    return {
      url,
      desc: `${channel.name}短效播放地址获取成功`,
      upstreamHeaders: upstreamHeadersFor,
      upstreamUrlTransform: officialAssetUrl,
    }
  } catch (error) {
    tokenCache.delete(channel.ref)
    const reason = error?.name === 'AbortError'
      ? `超时 ${ctx.timeoutMs || 15000}ms`
      : (error?.message || String(error))
    return { url: '', desc: `贵州广电链接请求失败：${reason}` }
  }
}

export function clearCache() {
  tokenCache.clear()
  tokenPending.clear()
}
