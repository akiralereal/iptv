/**
 * 黑龙江广播电视台：极光新闻 App 在用的七套官方直播入口。
 *
 * 地址固定、不带签名。默认由本机转发清单和分片，避免播放器的 fake-IP / 代理
 * 路径连不上官方 4430 端口。网络正常、希望播放器直连的部署可选原来的直连模式。
 */
import { fetchUpstreamResponse } from '../../utils/hlsProxy.js'
import { MEDIA_HOST, MEDIA_ORIGIN, createOfficialTransport } from './transport.js'

export const HLJTV_MEDIA_ORIGIN = MEDIA_ORIGIN

const MEDIA_PORT = '4430'
const MEDIA_PATH_PREFIX = '/live/'
const LOGO_BASE = 'https://imgcdn.hljtv.com/'

// 台标取极光新闻 App 电视直播的频道卡：zmt-api.hljtv.com/live/getTVInfo（POST，按 tvId 逐台查）
// 下发的 imgUrl，400×300、红色台标加频道名，7 张实测都是 JPEG；tvId 依次是 10、50、49、11、16、12、15。
// 东北网（黑龙江网络广播电视台）直播页也有频道卡，但都是带背景的 16:9 宣传图（最大一张 2859×1599），
// 不用；实验台那张是研究占位图，同样不用。
export const CHANNELS = Object.freeze([
  Object.freeze({ name: '黑龙江卫视', stream: 'hljws_own.m3u8',
    logo: `${LOGO_BASE}newscontent-48f3f374-054b-4611-9f2b-f3fc426a50d8-1583018250011.jpeg` }),
  Object.freeze({ name: '黑龙江都市', stream: 'dushi_hd.m3u8',
    logo: `${LOGO_BASE}newscontent-60c83952-0ca3-43b9-b17e-4e109a65fe9d-1626922264107.jpeg` }),
  Object.freeze({ name: '黑龙江新闻法治', stream: 'hljxw_hd.m3u8',
    logo: `${LOGO_BASE}newscontent-972a32ed-fc2e-455a-9863-93ea2fb176a2-1611449642107.jpeg` }),
  Object.freeze({ name: '黑龙江文体', stream: 'hljwy_hd.m3u8',
    logo: `${LOGO_BASE}newscontent-142df96e-616d-402d-a4ba-12ed3338f48c-1583018453221.jpeg` }),
  Object.freeze({ name: '黑龙江少儿', stream: 'hljse_hd.m3u8',
    logo: `${LOGO_BASE}newscontent-1f45b6e9-cce7-4131-b814-e652fdd8aea4-1583018440044.jpeg` }),
  Object.freeze({ name: '黑龙江影视', stream: 'hljys_hd.m3u8',
    logo: `${LOGO_BASE}newscontent-491c84b1-8a81-4e53-8281-139b87522d72-1583018429109.jpeg` }),
  Object.freeze({ name: '黑龙江农业科教', stream: 'hljgg_hd.m3u8',
    logo: `${LOGO_BASE}newscontent-5a51beb0-19da-42b6-90c5-492a30ff312e-1658661402463.jpeg` }),
])

/** 频道表写进播放列表前统一校验，免得改错一条 stream 名就把用户导去别处。 */
export function officialHlsUrl(stream) {
  const url = new URL(`${MEDIA_PATH_PREFIX}${String(stream || '').trim()}`, HLJTV_MEDIA_ORIGIN)
  if (url.protocol !== 'https:' || url.username || url.password || url.port !== MEDIA_PORT
      || url.hostname !== MEDIA_HOST || !url.pathname.startsWith(MEDIA_PATH_PREFIX)
      || !/^[a-z0-9_]+\.m3u8$/i.test(url.pathname.slice(MEDIA_PATH_PREFIX.length))
      || url.search || url.hash) {
    throw new Error('黑龙江广电频道表里有非官方直播地址')
  }
  return url.href
}

export const refOf = channel => `heilongjiang-${channel.stream.replace(/\.m3u8$/, '')}`
export const channelForRef = ref => CHANNELS.find(channel => refOf(channel) === ref)

export function buildChannels(config = {}) {
  return CHANNELS.map(channel => ({
    name: channel.name,
    identityUrl: officialHlsUrl(channel.stream),
    ...(config.networkMode === 'direct'
      ? { url: officialHlsUrl(channel.stream) }
      : { deferredRef: refOf(channel), proxyHls: true }),
    logo: channel.logo,
    groupTitle: '黑龙江',
    opts: ['network-caching=3000'],
    catchup: 'none',
  }))
}

/** 只允许这七路的官方清单及当前序号分片，不开放任意 URL 代理。 */
export function mediaUrl(raw) {
  const url = new URL(raw)
  const filename = url.pathname.slice(MEDIA_PATH_PREFIX.length)
  if (url.origin !== HLJTV_MEDIA_ORIGIN || url.username || url.password || url.search || url.hash
      || !url.pathname.startsWith(MEDIA_PATH_PREFIX)
      || !CHANNELS.some(channel => filename === channel.stream
        || new RegExp(`^${channel.stream.replace(/\.m3u8$/, '')}-[0-9]+\\.ts$`).test(filename))) {
    throw new Error('非黑龙江官方媒体地址')
  }
  return url.href
}

export async function readManifest(response, base) {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`官方直播 HTTP ${response.status}`) }
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 256 * 1024) throw new Error('官方直播清单过大')
      chunks.push(Buffer.from(value))
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trimStart().startsWith('#EXTM3U') || !text.includes('#EXTINF:')) throw new Error('官方没有返回直播媒体清单')
  for (const line of text.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
    const urls = line.startsWith('#') ? [...line.matchAll(/URI="([^"]*)"/g)].map(match => match[1]) : [line]
    for (const raw of urls) mediaUrl(new URL(raw, base).href)
  }
  return text
}

const transport = createOfficialTransport(mediaUrl)

export async function resolveChannel(ref, { fetchImpl = transport.fetch } = {}) {
  const channel = channelForRef(ref)
  if (!channel) return { url: '', status: 404, desc: '黑龙江频道不存在' }
  try {
    const url = officialHlsUrl(channel.stream)
    const response = await fetchUpstreamResponse(url, { fetchImpl, signal: AbortSignal.timeout(12_000) })
    const manifestUrl = mediaUrl(response.url || url)
    return { url, manifestUrl, manifestText: await readManifest(response, manifestUrl), proxyHls: true,
      upstreamUrlTransform: mediaUrl }
  } catch (error) {
    return { url: '', status: 502, desc: `黑龙江直播连接失败：${error.cause?.message || error.message}` }
  }
}

export async function fetchProxyMedia(ref, _config, raw, options = {}) {
  if (!channelForRef(ref)) throw new Error('黑龙江频道不存在')
  mediaUrl(raw)
  const response = await fetchUpstreamResponse(raw, { ...options, fetchImpl: transport.fetch })
  if (response.ok && options.method !== 'HEAD' && new URL(raw).pathname.endsWith('.m3u8')) {
    const text = await readManifest(response, response.url || raw)
    return new Response(text, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } })
  }
  return response
}

export const clearResolveCache = () => transport.clear()
export const shutdown = () => transport.close()
