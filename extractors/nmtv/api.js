/** 内蒙古广播电视台「奔腾融媒」官网：加密频道接口与动态 HLS。 */
import { proxyAwareFetch } from '../../utils/systemProxy.js'
import { decryptBase64, encryptBase64 } from './xxtea.js'

export const NMTV_PAGE = 'https://www.nmtv.cn/liveTv'
export const NMTV_API = 'https://api-bt.nmtv.cn/broadcast/list'
export const NMTV_API_KEY = '5b28bae827e651b3'

const MAX_API_BYTES = 2 * 1024 * 1024
const CHANNEL_LIST_TTL_MS = 30 * 1000
const MEDIA_HOSTS = new Set(['play1-qk.nmtv.cn', 'livestream-bt.nmtv.cn'])
const IMAGE_HOST = 'cdn-bt.nmtv.cn'

function channel(ref, upstreamId, name, fallbackUrl = '') {
  return Object.freeze({ ref, upstreamId, name, fallbackUrl })
}

export const CHANNELS = Object.freeze([
  channel('nmtv-satellite', 3621481, '内蒙古卫视', 'http://play1-qk.nmtv.cn/live/1769652018126032.m3u8'),
  channel('nmtv-mongolian-satellite', 2315, '内蒙古蒙古语卫视'),
  channel('nmtv-news-general', 2316, '新闻综合'),
  channel('nmtv-economy-life', 2317, '经济生活'),
  channel('nmtv-kids', 2318, '少儿频道'),
  channel('nmtv-culture-sports', 2319, '文体娱乐'),
  channel('nmtv-agriculture', 2320, '农牧频道'),
  channel('nmtv-mongolian-culture', 2321, '内蒙古蒙古语文化频道', 'http://play1-qk.nmtv.cn/live/1769652109096027.m3u8'),
  channel('nmtv-hohhot', 2331, '呼和浩特'),
  channel('nmtv-baotou', 2358, '包头'),
  channel('nmtv-wuhai', 2355, '乌海'),
  channel('nmtv-chifeng', 2351, '赤峰'),
  channel('nmtv-hulunbuir', 2356, '呼伦贝尔'),
  channel('nmtv-hinggan', 2357, '兴安盟'),
  channel('nmtv-tongliao', 2353, '通辽'),
  channel('nmtv-xilingol', 2346, '锡林郭勒'),
  channel('nmtv-ulanqab', 2354, '乌兰察布'),
  channel('nmtv-ordos', 2349, '鄂尔多斯'),
  channel('nmtv-bayannur', 2348, '巴彦淖尔'),
  channel('nmtv-alxa', 2347, '阿拉善'),
])

const CHANNEL_BY_REF = new Map(CHANNELS.map(item => [item.ref, item]))
const listCache = new Map()
const listPending = new Map()

export function officialAssetUrl(raw) {
  const url = new URL(String(raw || '').trim())
  const plainFallback = url.hostname === 'play1-qk.nmtv.cn' && url.protocol === 'http:'
  const secureMedia = MEDIA_HOSTS.has(url.hostname) && url.protocol === 'https:'
  if (url.username || url.password || url.port || (!plainFallback && !secureMedia)) {
    throw new Error('内蒙古广电返回了非官方媒体地址')
  }
  if (!/^\/(?:live|nmtv)\/[A-Za-z0-9_./-]+$/.test(url.pathname)) {
    throw new Error('内蒙古广电返回了无效媒体路径')
  }
  return url.href
}

export function officialHlsUrl(raw) {
  const url = new URL(officialAssetUrl(raw))
  if (!url.pathname.toLowerCase().endsWith('.m3u8')) throw new Error('内蒙古广电返回的不是 HLS 地址')
  return url.href
}

export function upstreamHeadersFor(raw) {
  officialAssetUrl(raw)
  return { Referer: 'https://www.nmtv.cn/' }
}

/**
 * 频道图标：频道接口每项的 image 就是官网直播页的频道图标（方图，盟市台是各台台标）。
 * 图床带 CDN 鉴权，sign 每次请求都重签、去掉就 403，所以只能原样用接口当下给的地址，不能写死。
 */
export function officialLogoUrl(raw) {
  try {
    const url = new URL(String(raw || '').trim())
    return url.protocol === 'https:' && url.hostname === IMAGE_HOST
      && !url.username && !url.password && !url.port
      && /^\/saas\/image\/[\w./-]+\.(?:png|jpe?g|webp)$/i.test(url.pathname)
      ? url.href
      : ''
  } catch {
    return ''
  }
}

export function parsePortalResponse(text) {
  let envelope
  try { envelope = JSON.parse(text) } catch { throw new Error('内蒙古广电频道接口没有返回有效 JSON') }
  if (typeof envelope === 'string') {
    try { envelope = JSON.parse(decryptBase64(envelope, NMTV_API_KEY)) } catch (error) {
      if (error instanceof SyntaxError) throw new Error('内蒙古广电频道数据不是有效 JSON')
      throw error
    }
  }
  if (!envelope || envelope.code !== 0 || !Array.isArray(envelope.data)) {
    throw new Error('内蒙古广电频道接口没有返回有效列表')
  }
  return envelope.data
}

export function buildPortalRequest() {
  return {
    url: NMTV_API,
    options: {
      method: 'POST',
      body: encryptBase64(JSON.stringify({ type: 1, size: 100 }), NMTV_API_KEY),
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'Client-Type': 'web',
        'Content-Type': 'application/json',
        Origin: 'https://www.nmtv.cn',
        Referer: NMTV_PAGE,
      },
    },
  }
}

export async function fetchPortalChannels({
  fetchImpl = proxyAwareFetch,
  timeoutMs = 15000,
} = {}) {
  const request = buildPortalRequest()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(request.url, { ...request.options, signal: controller.signal })
    if (!response.ok) {
      response.body?.cancel?.().catch(() => {})
      throw new Error(`内蒙古广电频道接口 HTTP ${response.status}`)
    }
    const declared = Number(response.headers.get('content-length') || 0)
    if (declared > MAX_API_BYTES) throw new Error('内蒙古广电频道接口响应过大')
    const text = await response.text()
    if (Buffer.byteLength(text) > MAX_API_BYTES) throw new Error('内蒙古广电频道接口响应过大')
    return parsePortalResponse(text)
  } finally {
    clearTimeout(timer)
  }
}

function portalStream(entry) {
  return [entry?.data?.streamUrl, entry?.streamUrl, entry?.url]
    .find(value => typeof value === 'string' && value.trim())
}

async function cachedPortalChannels(options = {}) {
  const fetchImpl = options.fetchImpl || proxyAwareFetch
  const now = Number(options.now ?? Date.now())
  const cached = listCache.get(fetchImpl)
  if (cached?.expiresAt > now) return cached.channels

  let pending = listPending.get(fetchImpl)
  if (!pending) {
    pending = fetchPortalChannels({ ...options, fetchImpl }).then(channels => {
      listCache.set(fetchImpl, { channels, expiresAt: now + CHANNEL_LIST_TTL_MS })
      return channels
    }).finally(() => {
      if (listPending.get(fetchImpl) === pending) listPending.delete(fetchImpl)
    })
    listPending.set(fetchImpl, pending)
  }
  return pending
}

function entryFor(channel, entries) {
  return entries.find(item => Number(item?.id) === channel.upstreamId
    && String(item?.title || '').trim() === channel.name)
}

function streamFor(channel, entries) {
  const entry = entryFor(channel, entries)
  const stream = entry && portalStream(entry)
  if (!stream) throw new Error(`官网当前没有返回${channel.name}直播地址`)
  const url = new URL(officialHlsUrl(stream))
  if (url.hostname === 'livestream-bt.nmtv.cn'
      && url.pathname !== `/nmtv/${channel.upstreamId}general.m3u8`) {
    throw new Error('内蒙古广电直播频道与请求不一致')
  }
  return url.href
}

/** 频道表固定；台标按频道 ID 与台名从官网频道列表里认，没认到的留空。 */
export function buildChannels(entries = []) {
  return CHANNELS.map(channel => ({
    name: channel.name,
    deferredRef: channel.ref,
    logo: officialLogoUrl(entryFor(channel, entries)?.image),
    opts: ['network-caching=3000'],
    catchup: 'none',
  }))
}

/**
 * 更新时取一次官网频道列表只为拿台标（签名地址见 officialLogoUrl）；取流仍在播放时做。
 * 列表取不到就让这一轮失败：上一轮的频道和台标原样沿用、几分钟后重试。照常出频道反而会把
 * 已有台标清空一整天——开机时网络还没通就是这样。
 */
export async function fetchChannels(ctx = {}) {
  const timeoutMs = ctx.timeoutMs || 15000
  let entries
  try {
    entries = await cachedPortalChannels({
      fetchImpl: ctx.fetchImpl || proxyAwareFetch,
      timeoutMs,
      now: ctx.now,
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`内蒙古广电频道接口超时 ${timeoutMs}ms`)
    throw error
  }
  const channels = buildChannels(entries)
  const missing = channels.filter(item => !item.logo).length
  const warnings = missing
    ? [`官网频道列表里有 ${missing} 路没认到台标（官网可能改了频道 ID、台名或图床）`]
    : []
  return { channels, warnings }
}

export function claimsRef(ref) {
  return CHANNEL_BY_REF.has(String(ref || ''))
}

export async function resolveChannel(ref, ctx = {}) {
  const channel = CHANNEL_BY_REF.get(String(ref || ''))
  if (!channel) return { url: '', desc: '内蒙古频道引用格式错误' }
  try {
    let url
    let fallback = false
    try {
      url = streamFor(channel, await cachedPortalChannels({
        fetchImpl: ctx.fetchImpl || proxyAwareFetch,
        timeoutMs: ctx.timeoutMs || 15000,
        now: ctx.now,
      }))
    } catch (error) {
      if (!channel.fallbackUrl) throw error
      url = officialHlsUrl(channel.fallbackUrl)
      fallback = true
    }
    return {
      url,
      desc: `${channel.name}官方直播地址获取成功${fallback ? '（备用入口）' : ''}`,
      upstreamHeaders: upstreamHeadersFor,
      upstreamUrlTransform: officialAssetUrl,
    }
  } catch (error) {
    const reason = error?.name === 'AbortError'
      ? `超时 ${ctx.timeoutMs || 15000}ms`
      : (error?.message || String(error))
    return { url: '', desc: `内蒙古广电链接请求失败：${reason}` }
  }
}

export function clearCache() {
  listCache.clear()
  listPending.clear()
}
