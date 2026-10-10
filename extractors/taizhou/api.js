/** 和合天台 App → 趣看 H5 公开播放接口；签名只在 resolve 时获取。 */
import { createHash } from 'node:crypto'
import { proxyAwareFetch } from '../../utils/systemProxy.js'
import { CHANNELS, CHANNEL_BY_REF } from './channels.js'

export { CHANNELS }

export const TV_PAGE = 'https://app.ttcmzx.cn/client/lightPage.html?tenant_id=5&id=61&gaze_control=1'
export const PLAY_API = 'https://www.qukanvideo.com/h5/channel/view/item/AntiTheft/playUrl'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const MAX_TEXT_BYTES = 512 * 1024
const MEDIA_HOST_RE = /^play-[a-z0-9-]+\.quklive\.com$/

export function channelSign(id) {
  if (!CHANNELS.some(channel => channel.id === String(id))) throw new Error('台州频道 ID 无效')
  // 趣看当前网页脚本的公开计算方式；网页若调整，接口会拒绝旧签名。
  return createHash('md5').update(`${id}NoFeelings`).digest('hex')
}

function safeUrl(raw) {
  let url
  try { url = new URL(String(raw || '')) } catch { throw new Error('台州媒体地址无效') }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
      || !url.searchParams.get('auth_key')) {
    throw new Error('台州媒体地址缺少官方签名')
  }
  return url
}

function manifestMediaHost(raw, channel) {
  const url = safeUrl(raw)
  if (MEDIA_HOST_RE.test(url.hostname) && url.pathname === `/live/${channel.id}.m3u8`) {
    return url.hostname
  }
  const alias = /^\/live\/(play-[a-z0-9-]+\.quklive\.com)\/(\d+)\.m3u8$/.exec(url.pathname)
  if (url.hostname === 'hls.quklive.com' && alias?.[2] === channel.id && MEDIA_HOST_RE.test(alias[1])) {
    return alias[1]
  }
  throw new Error('台州直播清单不在指定频道的官方 CDN')
}

export function officialManifestUrl(raw, channel) {
  manifestMediaHost(raw, channel)
  return safeUrl(raw).href
}

export function officialSegmentUrl(raw, manifestUrl, channel) {
  const mediaHost = manifestMediaHost(manifestUrl, channel)
  let url
  try { url = safeUrl(new URL(String(raw || ''), `https://${mediaHost}/live/`).href) }
  catch { throw new Error('台州直播分片地址无效') }
  const prefix = `/live/${mediaHost}_${channel.id}-`
  if (url.hostname !== mediaHost || !url.pathname.startsWith(prefix)
      || !/^[0-9]+\.ts$/.test(url.pathname.slice(prefix.length))) {
    throw new Error('台州直播分片不在指定频道的官方 CDN')
  }
  return url.href
}

export function validateManifest(text, manifestUrl, channel) {
  officialManifestUrl(manifestUrl, channel)
  if (typeof text !== 'string' || !text.trimStart().startsWith('#EXTM3U')) {
    throw new Error('台州 CDN 没有返回 HLS 清单')
  }
  if (/#EXT-X-(?:KEY|MAP|STREAM-INF|ENDLIST)/.test(text)) {
    throw new Error('台州 HLS 格式已变化，需要重新检查')
  }
  let segments = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    officialSegmentUrl(line, manifestUrl, channel)
    segments++
  }
  if (!segments || !text.includes('#EXTINF:')) throw new Error('台州直播清单没有分片')
  return text
}

async function requestText(url, { fetchImpl, timeoutMs, method = 'GET', body, headers = {} }) {
  const response = await fetchImpl(url, {
    method, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': UA, ...headers },
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

export async function requestPlayUrl(channel, { fetchImpl = proxyAwareFetch, timeoutMs = 12000 } = {}) {
  const body = new URLSearchParams({ source: 'web', liveId: channel.id, sign: channelSign(channel.id) })
  const text = await requestText(PLAY_API, {
    fetchImpl, timeoutMs, method: 'POST', body,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      Referer: `https://www.qukanvideo.com/cloud/h5/${channel.id}`,
      Origin: 'https://www.qukanvideo.com',
    },
  })
  let payload
  try { payload = JSON.parse(text) } catch { throw new Error('台州播放接口返回无效 JSON') }
  if (payload?.code !== 0 || payload?.value?.playState !== 0 || !payload?.value?.url) {
    throw new Error('台州频道当前没有可用直播信号')
  }
  return officialManifestUrl(payload.value.url, channel)
}

export async function requestManifest(url, channel, { fetchImpl = proxyAwareFetch, timeoutMs = 12000 } = {}) {
  const safe = officialManifestUrl(url, channel)
  const text = await requestText(safe, {
    fetchImpl, timeoutMs,
    headers: { Accept: 'application/vnd.apple.mpegurl', Referer: 'https://www.qukanvideo.com/' },
  })
  return validateManifest(text, safe, channel)
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

export function createResolver({ fetchImpl: defaultFetch = proxyAwareFetch } = {}) {
  async function resolve(ref, ctx = {}) {
    const channel = CHANNEL_BY_REF.get(String(ref || ''))
    if (!channel) return { url: '', desc: '台州频道引用格式错误' }
    const options = { fetchImpl: ctx.fetchImpl || defaultFetch, timeoutMs: ctx.timeoutMs || 12000 }
    try {
      const url = await requestPlayUrl(channel, options)
      const text = await requestManifest(url, channel, options)
      // 趣看有 hls.quklive.com 别名入口；相对分片实际在 play-* 主机，
      // 先按频道校验并转成绝对地址，清单中继与全代理均使用同一份正确清单。
      const manifest = text.split(/\r?\n/).map(line => {
        const raw = line.trim()
        return raw && !raw.startsWith('#') ? officialSegmentUrl(raw, url, channel) : line
      }).join('\n')
      return {
        url,
        desc: `${channel.name} 官方直播地址获取成功`,
        relayHls: true,
        manifestText: manifest,
        manifestUrl: url,
        upstreamHeaders: { Referer: 'https://www.qukanvideo.com/' },
        upstreamUrlTransform: raw => officialSegmentUrl(raw, url, channel),
      }
    } catch (error) {
      const reason = ['AbortError', 'TimeoutError'].includes(error?.name)
        ? '请求超时' : (error?.message || '上游请求失败')
      return { url: '', desc: `${channel.name} 取流失败：${reason}` }
    }
  }
  return { resolve }
}

export const resolveChannel = createResolver().resolve
