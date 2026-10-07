/**
 * 葫芦网频道接口 → 签名 HLS（杭州文广集团）。
 *
 * mapi.hoolo.tv/api/v1/channel_detail.php?channel_id=<id> 回一个频道的详情，channel_stream 里
 * 有 sd / hd 两档签好名的媒体清单（live.hoolo.tv/<code>/hd/live.m3u8?auth_key=<过期秒>-0-0-<md5>，
 * 阿里云 A 型鉴权，实测 2 小时过期）。看电视页静态 HTML 里也嵌着地址，但那是页面生成时签的、早已过期，
 * 播放器自己也是现调这个接口。实测（2026-10-06，上海联通家宽 / 洛杉矶机房）：
 * - 接口、清单、分片都按 Referer 放行（Tengine「denied by Referer ACL」），不带或带别家的一律 403，
 *   带 https://tv.hoolo.tv/ 就过；不看 UA。所以清单和分片都只能由本机带着来源头全代理；
 * - 分片由 CDN 各自签名（/<code>_hd/<n>/<n>.ts?auth_key=…），跟着清单走；
 * - 主清单 playlist.m3u8 里 sd 排在 hd 前面，按第一档起播会先落到标清，所以直接取 hd 媒体清单；
 * - 接口不认识的路径一律 403（openresty WAF），节目单接口没有开放，见 EPG.md。
 *
 * 签名地址缓存到过期前半小时；全代理下播放器每次轮询清单都会走一遍 resolve，由本机重取媒体清单。
 * 清单被拒（签名提前作废）时扔掉缓存、立刻重签一次。
 */
import { proxyAwareFetch } from '../../utils/systemProxy.js'
import { CHANNELS, CHANNEL_BY_REF } from './channels.js'

export { CHANNELS }

export const CHANNEL_API = 'https://mapi.hoolo.tv/api/v1/channel_detail.php'
export const REFERER = 'https://tv.hoolo.tv/'
const MEDIA_HOSTS = new Set(['live.hoolo.tv', 'live3.hoolo.tv'])
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
// 单个频道详情约 3 KB、媒体清单不到 1 KB，留足余量
const MAX_TEXT_BYTES = 256 * 1024
// 签名过期前多久停用缓存、重新签
const EXPIRY_MARGIN_MS = 30 * 60 * 1000
// 接口取失败后这段时间内直接回同一个错误：播放器失败后是 100ms 级别的连环重试
const FAILURE_COOLDOWN_MS = 20 * 1000
const AUTH_KEY_RE = /^(\d{10})-\d+-\d+-[0-9a-f]{32}$/

class UpstreamStatusError extends Error {
  constructor(status) {
    super(`上游 HTTP ${status}`)
    this.status = status
  }
}

/** 签名里的过期时间（毫秒）；不是阿里云 A 型鉴权格式时返回 NaN。 */
export function authExpiry(url) {
  const match = AUTH_KEY_RE.exec(url.searchParams.get('auth_key') || '')
  return match ? Number(match[1]) * 1000 : NaN
}

/** 频道的官方签名 hd 媒体清单，统一成 https；主机、路径、签名格式不对都抛错。 */
export function officialPlaylistUrl(raw, channel) {
  let url
  try { url = new URL(String(raw || '')) } catch { throw new Error('杭州直播地址无效') }
  if (!['http:', 'https:'].includes(url.protocol) || !MEDIA_HOSTS.has(url.hostname)
      || url.username || url.password || url.port || url.hash
      || url.pathname !== `/${channel.code}/hd/live.m3u8`) {
    throw new Error('杭州直播地址不在该频道的官方 CDN')
  }
  if (!Number.isFinite(authExpiry(url))) throw new Error('杭州直播地址缺少官方签名')
  url.protocol = 'https:'
  return url.href
}

/** 清单里的分片（及将来可能出现的密钥等 URI）：只放行本频道 hd 流在同一台 CDN 主机上的路径。 */
export function officialMediaUrl(raw, playlistUrl, channel) {
  const playlist = new URL(officialPlaylistUrl(playlistUrl, channel))
  let url
  try { url = new URL(String(raw || ''), playlist) } catch { throw new Error('杭州直播分片地址无效') }
  if (url.protocol !== 'https:' || url.hostname !== playlist.hostname
      || url.username || url.password || url.port
      || !url.pathname.startsWith(`/${channel.code}_hd/`)) {
    throw new Error('杭州直播分片不在该频道的官方 CDN')
  }
  return url.href
}

/** 频道接口的 JSON → 签名 hd 媒体清单；停播、没有 hd 档、不是这一路都抛错。 */
export function parseChannelDetail(payload, channel) {
  const row = Array.isArray(payload) ? payload.find(item => Number(item?.id) === channel.id) : null
  if (!row) throw new Error('葫芦网频道接口没有返回这一路频道')
  if (String(row.is_stopped) === '1') throw new Error('官方已停播这一路频道')
  const stream = Array.isArray(row.channel_stream)
    ? row.channel_stream.find(item => item?.stream_name === 'hd' && item.m3u8)
    : null
  if (!stream) throw new Error('葫芦网频道接口没有给出高清直播地址')
  return officialPlaylistUrl(stream.m3u8, channel)
}

/** 媒体清单：必须是 HLS 媒体清单，每条地址都在本频道的官方路径上。 */
export function validatePlaylist(text, playlistUrl, channel) {
  if (typeof text !== 'string' || !text.trimStart().startsWith('#EXTM3U')) {
    throw new Error('杭州 CDN 没有返回 HLS 清单')
  }
  if (text.includes('#EXT-X-STREAM-INF')) throw new Error('杭州 HLS 格式已变化，需要重新检查')
  let segments = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#')) {
      for (const match of line.matchAll(/URI="([^"]+)"/g)) officialMediaUrl(match[1], playlistUrl, channel)
      continue
    }
    officialMediaUrl(line, playlistUrl, channel)
    segments++
  }
  if (!segments) throw new Error('杭州直播清单没有分片')
  return text
}

async function requestText(url, { fetchImpl, timeoutMs, accept }) {
  const response = await fetchImpl(url, {
    redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': UA, Accept: accept, Referer: REFERER },
  })
  if (!response.ok || response.status >= 300) {
    await response.body?.cancel?.().catch(() => {})
    throw new UpstreamStatusError(response.status)
  }
  if (Number(response.headers.get('content-length')) > MAX_TEXT_BYTES) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error('上游响应过大')
  }
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > MAX_TEXT_BYTES) {
      await response.body?.cancel?.().catch(() => {})
      throw new Error('上游响应过大')
    }
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks, size).toString('utf8')
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

export function createResolver({ fetchImpl: defaultFetch = proxyAwareFetch, now = Date.now } = {}) {
  // ref -> { url, freshUntil } / { error, until } / Promise
  const cache = new Map()
  const failures = new Map()
  const inflight = new Map()

  async function signedUrl(channel, options) {
    const cached = cache.get(channel.ref)
    if (cached && now() < cached.freshUntil) return cached.url
    const failure = failures.get(channel.ref)
    if (failure && now() < failure.until) throw failure.error
    let task = inflight.get(channel.ref)
    if (!task) {
      // 多个客户端同时开同一路只签一次；一个客户端断开不影响别人共用的这次请求
      task = (async () => {
        const api = `${CHANNEL_API}?channel_id=${channel.id}&_=${now()}`
        const text = await requestText(api, { ...options, accept: 'application/json, text/plain, */*' })
        let payload
        try { payload = JSON.parse(text) } catch { throw new Error('葫芦网频道接口返回无效 JSON') }
        const url = parseChannelDetail(payload, channel)
        cache.set(channel.ref, { url, freshUntil: authExpiry(new URL(url)) - EXPIRY_MARGIN_MS })
        failures.delete(channel.ref)
        return url
      })()
        .catch(error => { failures.set(channel.ref, { error, until: now() + FAILURE_COOLDOWN_MS }); throw error })
        .finally(() => inflight.delete(channel.ref))
      inflight.set(channel.ref, task)
    }
    return task
  }

  async function playlist(channel, options) {
    const url = await signedUrl(channel, options)
    try {
      return { url, text: await requestText(url, { ...options, accept: 'application/vnd.apple.mpegurl' }) }
    } catch (error) {
      // 签名被拒：扔掉缓存重签一次，别等它自然过期
      if (![401, 403, 410].includes(error?.status)) throw error
      cache.delete(channel.ref)
      const fresh = await signedUrl(channel, options)
      return { url: fresh, text: await requestText(fresh, { ...options, accept: 'application/vnd.apple.mpegurl' }) }
    }
  }

  async function resolve(ref, ctx = {}) {
    const channel = CHANNEL_BY_REF.get(String(ref || ''))
    if (!channel) return { url: '', desc: '杭州频道引用格式错误' }
    const options = { fetchImpl: ctx.fetchImpl || defaultFetch, timeoutMs: ctx.timeoutMs || 12000 }
    try {
      const { url, text } = await playlist(channel, options)
      validatePlaylist(text, url, channel)
      return {
        url,
        desc: `${channel.name} 官方直播地址获取成功`,
        relayHls: true,
        manifestText: text,
        manifestUrl: url,
        upstreamHeaders: { Referer: REFERER },
        upstreamUrlTransform: raw => officialMediaUrl(raw, url, channel),
      }
    } catch (error) {
      const reason = ['AbortError', 'TimeoutError'].includes(error?.name)
        ? '请求超时' : (error?.message || '上游请求失败')
      return { url: '', desc: `${channel.name} 取流失败：${reason}` }
    }
  }

  function clearCache() {
    cache.clear()
    failures.clear()
  }

  return { resolve, clearCache }
}

const defaultResolver = createResolver()
export const resolveChannel = defaultResolver.resolve
export const clearResolveCache = defaultResolver.clearCache
