/**
 * 无锡博报「直播」分享页 → 签名 HLS。
 *
 * 分享页是服务端渲染的，window.LIVE_CHANNELS 里直接带着每路频道签好名的主清单地址
 * （bb-live.wifiwx.com/<stream>/playlist.m3u8?auth_key=<过期时间>-0-0-<md5>，阿里云 A 型鉴权，
 * 实测约 2 小时过期）。一次请求拿到全部频道，不看 Referer 与 UA。实测（2026-09-29）：
 * - 主清单只有一路 hd 子清单，子清单和分片各自带签名，播放器直连不需要任何请求头；
 * - 分享页在美国的探针上回 403，大陆可达；签好名的地址海外也能播。
 *
 * 分享页约 150 KB，而中继模式下播放器每次轮询清单都会走一遍 resolve，所以签名地址在这里缓存到
 * 过期前半小时；轮询时由本机重取主清单并拍平成子清单（utils/appUtils.js fetchManifestDirect），
 * 子清单的签名随之刷新，长时间观看也不会过期。
 *
 * 太湖明珠网（v2.thmz.com，/m2o/channel/channel_info.php）是同一套流的另一个入口，但清单和分片
 * 都要带 thmz.com 的 Referer，只能全代理，不接。
 */
import { proxyAwareFetch } from '../../utils/systemProxy.js'
import { CHANNELS, CHANNEL_BY_REF } from './channels.js'

export { CHANNELS }

export const SHARE_PAGE = 'https://bb-share.wifiwx.com/wxbb/share/live/?channel_id=4'
export const MEDIA_HOST = 'bb-live.wifiwx.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
// 分享页实测约 150 KB，留足余量
const MAX_TEXT_BYTES = 1024 * 1024
// 签名过期前多久停用缓存、重新取分享页
const EXPIRY_MARGIN_MS = 30 * 60 * 1000
// 分享页取失败后这段时间内直接回同一个错误：播放器失败后是 100ms 级别的连环重试
const FAILURE_COOLDOWN_MS = 20 * 1000
const AUTH_KEY_RE = /^(\d{10})-\d+-\d+-[0-9a-f]{32}$/

/** 签名里的过期时间（毫秒）；不是阿里云 A 型鉴权格式时返回 NaN。 */
export function authExpiry(url) {
  const match = AUTH_KEY_RE.exec(url.searchParams.get('auth_key') || '')
  return match ? Number(match[1]) * 1000 : NaN
}

/** 频道的官方签名主清单，统一成 https；主机、路径、签名格式不对都抛错。 */
export function officialMasterUrl(raw, channel) {
  let url
  try { url = new URL(String(raw || ''), 'https://bb-share.wifiwx.com/') } catch { throw new Error('无锡直播地址无效') }
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== MEDIA_HOST
      || url.username || url.password || url.port || url.hash
      || url.pathname !== `/${channel.stream}/playlist.m3u8`) {
    throw new Error('无锡直播地址不在该频道的官方 CDN')
  }
  if (!Number.isFinite(authExpiry(url))) throw new Error('无锡直播地址缺少官方签名')
  url.protocol = 'https:'
  return url.href
}

/** 全代理（?relay=2）时登记的子清单与分片：只放行本频道在官方 CDN 上的路径。 */
export function officialMediaUrl(raw, channel) {
  let url
  try { url = new URL(String(raw || '')) } catch { throw new Error('无锡直播分片地址无效') }
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== MEDIA_HOST
      || url.username || url.password || url.port
      || !(url.pathname.startsWith(`/${channel.stream}/`) || url.pathname.startsWith(`/${channel.stream}_`))
      || !url.searchParams.get('auth_key')) {
    throw new Error('无锡直播分片不在该频道的官方 CDN')
  }
  return url.href
}

/**
 * 分享页 HTML → { stream: 签名主清单 }，只收频道表里的五路电视。
 * 源站不止一台，渲染格式不一样：有的是 window['LIVE_CHANNELS' ] =[…];</script>，
 * 有的带缩进和换行 window[ 'LIVE_CHANNELS' ] = […];\n</script>。取赋值号到本段 </script> 之间的 JSON。
 */
export function parseSharePage(html) {
  const text = String(html || '')
  const match = /window\[\s*['"]LIVE_CHANNELS['"]\s*\]\s*=/.exec(text)
  const end = match ? text.indexOf('</script>', match.index) : -1
  if (!match || end < 0) throw new Error('无锡博报分享页里没有频道表，页面可能改版')
  let rows
  try { rows = JSON.parse(text.slice(match.index + match[0].length, end).trim().replace(/;$/, '')) }
  catch { throw new Error('无锡博报频道表不是有效 JSON') }
  if (!Array.isArray(rows)) throw new Error('无锡博报频道表结构不符合预期')
  const urls = new Map()
  for (const channel of CHANNELS) {
    const row = rows.find(item => Number(item?.id) === channel.id)
    if (!row?.m3u8) continue
    try { urls.set(channel.stream, officialMasterUrl(row.m3u8, channel)) } catch { /* 这一路不收，其余照常 */ }
  }
  if (!urls.size) throw new Error('无锡博报频道表里没有可用的电视直播地址')
  return urls
}

async function requestText(url, { fetchImpl, timeoutMs }) {
  const response = await fetchImpl(url, {
    redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
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
    logo: channel.logo,
    opts: ['network-caching=3000'],
    catchup: 'none',
  }))
}

export function claimsRef(ref) {
  return CHANNEL_BY_REF.has(String(ref || ''))
}

export function createResolver({ fetchImpl: defaultFetch = proxyAwareFetch, now = Date.now } = {}) {
  // { urls: Map<stream, url>, freshUntil }；一页五路，所有频道共用
  let cache = null
  let failure = null
  let inflight = null

  async function loadUrls(options) {
    const html = await requestText(SHARE_PAGE, options)
    const urls = parseSharePage(html)
    const earliest = Math.min(...[...urls.values()].map(url => authExpiry(new URL(url))))
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
    if (!channel) return { url: '', desc: '无锡频道引用格式错误' }
    const options = { fetchImpl: ctx.fetchImpl || defaultFetch, timeoutMs: ctx.timeoutMs || 12000 }
    try {
      const url = (await currentUrls(options)).get(channel.stream)
      if (!url) return { url: '', desc: `${channel.name} 取流失败：无锡博报没有给出这路频道的直播地址` }
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
