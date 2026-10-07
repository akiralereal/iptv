/**
 * 莆田TV 频道接口 → 签名 HLS。
 *
 * mapi.ptbtv.com/api/v1/channel.php 不带参数一次回全部频道，每路带签好名的主清单
 * （live1.ptbtv.com/<stream>/playlist.m3u8?_upt=<8 位十六进制><10 位过期秒>，与福建省级同一套平台，
 * 实测约 2 小时 45 分过期）。不用登录、不看 Referer。实测（2026-09-30）：
 * - 接口、图床挂在网宿 CDN 的人机验证后面：浏览器 UA 与 curl 默认 UA 回 302 跳 JS 挑战页 / 403，
 *   App 与程序化客户端（okhttp、node、不带 UA）直接回 JSON。和福建省级一样用 Node 自己的 UA；
 * - 不带 _upt 或签名不对，CDN 302 到 127.0.0.1；主清单只有一路 hd 子清单，子清单和分片由 CDN
 *   各自重新签名，播放器直连不需要任何请求头；
 * - 节目没有网络版权时（比如二套晚间剧场），子清单换成 /forbid/ 下「因版权问题暂时无法观看」的垫片，
 *   地址照常给，和咪咕按节目屏蔽一样，不当失败；
 * - Globalping 美国、大陆探针取得到接口，签好名的主清单美国、日本也取得到。
 *
 * 签名地址缓存到过期前半小时；中继模式下播放器每次轮询清单，本机重取主清单并拍平成子清单
 * （utils/appUtils.js fetchManifestDirect），子清单的签名随之刷新，长时间观看也不会过期。
 */
import { proxyAwareFetch } from '../../utils/systemProxy.js'
import { CHANNELS, CHANNEL_BY_REF } from './channels.js'

export { CHANNELS }

export const CHANNEL_API = 'https://mapi.ptbtv.com/api/v1/channel.php'
const MEDIA_HOST_RE = /^live\d\.ptbtv\.com$/
// 网宿人机验证只拦浏览器 UA，见文件头
const UA = 'node'
// 全表十几路、约 12 KB，留足余量
const MAX_TEXT_BYTES = 512 * 1024
// 签名过期前多久停用缓存、重新取频道表
const EXPIRY_MARGIN_MS = 30 * 60 * 1000
// 频道表取失败后这段时间内直接回同一个错误：播放器失败后是 100ms 级别的连环重试
const FAILURE_COOLDOWN_MS = 20 * 1000
const UPT_RE = /^[0-9a-f]{8}(\d{10})$/i

/** 签名里的过期时间（毫秒）；不是 _upt 签名格式时返回 NaN。 */
export function uptExpiry(url) {
  const match = UPT_RE.exec(url.searchParams.get('_upt') || '')
  return match ? Number(match[1]) * 1000 : NaN
}

/** 频道的官方签名主清单；主机、路径、签名格式不对都抛错。 */
export function officialMasterUrl(raw, channel) {
  let url
  try { url = new URL(String(raw || '')) } catch { throw new Error('莆田直播地址无效') }
  if (url.protocol !== 'https:' || !MEDIA_HOST_RE.test(url.hostname)
      || url.username || url.password || url.port || url.hash
      || url.pathname !== `/${channel.stream}/playlist.m3u8`) {
    throw new Error('莆田直播地址不在该频道的官方 CDN')
  }
  if (!Number.isFinite(uptExpiry(url))) throw new Error('莆田直播地址缺少官方签名')
  return url.href
}

/** 全代理（?relay=2）时登记的子清单与分片：只放行本频道在官方 CDN 上的路径和版权垫片。 */
export function officialMediaUrl(raw, channel) {
  let url
  try { url = new URL(String(raw || '')) } catch { throw new Error('莆田直播分片地址无效') }
  if (url.protocol !== 'https:' || !MEDIA_HOST_RE.test(url.hostname)
      || url.username || url.password || url.port
      || !(url.pathname.startsWith(`/${channel.stream}/`) || url.pathname.startsWith(`/${channel.stream}_`)
        || url.pathname.startsWith('/forbid/'))
      || !url.searchParams.get('_upt')) {
    throw new Error('莆田直播分片不在该频道的官方 CDN')
  }
  return url.href
}

/** 频道接口的 JSON → Map<stream, 签名主清单>，只收频道表里的三路电视。 */
export function parseChannelList(payload) {
  if (!Array.isArray(payload)) throw new Error('莆田TV频道表结构不符合预期')
  const urls = new Map()
  for (const channel of CHANNELS) {
    const row = payload.find(item => Number(item?.id) === channel.id)
    if (!row) continue
    const streams = Array.isArray(row.channel_stream) ? row.channel_stream : []
    const candidates = [row.m3u8, ...streams.flatMap(stream => [stream?.m3u8, stream?.url])]
    for (const raw of candidates) {
      try {
        urls.set(channel.stream, officialMasterUrl(raw, channel))
        break
      } catch { /* 试下一个，都不行这一路就不收，其余照常 */ }
    }
  }
  if (!urls.size) throw new Error('莆田TV频道表里没有可用的电视直播地址')
  return urls
}

async function requestText(url, { fetchImpl, timeoutMs }) {
  const response = await fetchImpl(url, {
    // 人机验证页是 302 跳转，跟过去只会拿到挑战页，按失败处理
    redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
  })
  if (!response.ok || response.status >= 300) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error(`上游 HTTP ${response.status}`)
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
    opts: ['network-caching=3000'],
    catchup: 'none',
  }))
}

export function claimsRef(ref) {
  return CHANNEL_BY_REF.has(String(ref || ''))
}

export function createResolver({ fetchImpl: defaultFetch = proxyAwareFetch, now = Date.now } = {}) {
  // { urls: Map<stream, url>, freshUntil }；一张表三路，所有频道共用
  let cache = null
  let failure = null
  let inflight = null

  async function loadUrls(options) {
    const text = await requestText(CHANNEL_API, options)
    let payload
    try { payload = JSON.parse(text) } catch { throw new Error('莆田TV频道表不是有效 JSON（可能被人机验证拦下）') }
    const urls = parseChannelList(payload)
    const earliest = Math.min(...[...urls.values()].map(url => uptExpiry(new URL(url))))
    return { urls, freshUntil: earliest - EXPIRY_MARGIN_MS }
  }

  async function currentUrls(options) {
    if (cache && now() < cache.freshUntil) return cache.urls
    if (failure && now() < failure.until) throw failure.error
    if (!inflight) {
      inflight = loadUrls(options)
        .then(result => { cache = result; failure = null; return result.urls })
        .catch(error => { failure = { error, until: now() + FAILURE_COOLDOWN_MS }; throw error })
        .finally(() => { inflight = null })
    }
    return inflight
  }

  async function resolve(ref, ctx = {}) {
    const channel = CHANNEL_BY_REF.get(String(ref || ''))
    if (!channel) return { url: '', desc: '莆田频道引用格式错误' }
    const options = { fetchImpl: ctx.fetchImpl || defaultFetch, timeoutMs: ctx.timeoutMs || 12000 }
    try {
      const url = (await currentUrls(options)).get(channel.stream)
      if (!url) return { url: '', desc: `${channel.name} 取流失败：莆田TV没有给出这路频道的直播地址` }
      return {
        url,
        desc: `${channel.name} 官方直播地址获取成功`,
        relayHls: true,
        upstreamUrlTransform: raw => officialMediaUrl(raw, channel),
      }
    } catch (error) {
      const reason = ['AbortError', 'TimeoutError'].includes(error?.name)
        ? '请求超时' : (error?.message || '上游请求失败')
      return { url: '', desc: `${channel.name} 取流失败：${reason}` }
    }
  }

  function clearCache() {
    cache = null
    failure = null
  }

  return { resolve, clearCache }
}

const defaultResolver = createResolver()
export const resolveChannel = defaultResolver.resolve
export const clearResolveCache = defaultResolver.clearCache
