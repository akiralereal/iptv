import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { CHANNELS, CHANNEL_BY_REF } from './channels.js'

export { CHANNELS, CHANNEL_BY_REF }
export const CLOUD_API = 'https://cms.sctvcloud.com:37443/api/'
export const ABA_TENANT = 'YzMyMDA='
export const ABA_NODE = '1504641996442759169'
export const BAZHONG_CATALOG = 'https://www.bzgd.com/sctv/tv/index/tv.json'
export const MAX_TEXT_BYTES = 1024 * 1024

function publicIPv4(host) {
  if (isIP(host) !== 4) return false
  const [a, b] = host.split('.').map(Number)
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && [0, 168].includes(b)) || (a === 198 && [18, 19].includes(b)))
}

export const needsProxy = channel => ['遂宁', '达州', '凉山', '资阳'].includes(channel.city)
export function mediaHeaders(raw, channel) {
  officialMedia(raw, channel, { asset: true })
  return { 'User-Agent': 'Mozilla/5.0', Referer: channel.page, Origin: new URL(channel.page).origin }
}

/** 初始清单须和已验证的官方频道匹配；分片只允许同台的官方目录。 */
export function officialMedia(raw, channel, { asset = false } = {}) {
  let url
  try { url = new URL(raw) } catch { throw new Error('官方媒体地址无效') }
  const expected = new URL(channel.media)
  const dir = expected.pathname.slice(0, expected.pathname.lastIndexOf('/') + 1)
  // 绵阳/阿坝官方主清单下发网宿节点：/原始域名/live/本台ID/...。
  // 不钉死会轮换的节点 IP/随机域名；仅媒体阶段允许这个 CDN 与同台完整前缀，私网 IP 拒绝。
  const dispatched = asset && (channel.id === 'mytv1' || channel.kind === 'aba' || channel.dispatch)
    && (/^[a-z0-9-]+\.100ycdn\.com$/.test(url.hostname) || ((channel.id === 'mytv1' || channel.dispatch) && publicIPv4(url.hostname)))
    && url.pathname.startsWith(`/${expected.hostname}${dir}`)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || url.hash
      || (expected.protocol === 'https:' && url.protocol !== 'https:')
      || (!dispatched && (url.hostname !== expected.hostname
        || (asset ? !url.pathname.startsWith(dir) : url.pathname !== expected.pathname)))) {
    throw new Error('官方媒体地址与频道不符')
  }
  if (!asset && channel.id === 'mytv1' && (!url.searchParams.get('wsSecret') || !url.searchParams.get('wsTime'))) {
    throw new Error('绵阳官网未提供当前播放签名')
  }
  return url.href
}

/** 不从注释里的旧播放器或已下线的频道取地址。 */
export function playUrlFromHtml(html, channel) {
  const text = String(html).replace(/<!--[\s\S]*?-->/g, '').replaceAll('&amp;', '&').replaceAll('\\/', '/')
  const urls = text.match(/(?:https?:)?\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/g) || []
  for (const raw of urls) {
    try { return officialMedia(new URL(raw, channel.page).href, channel) } catch {}
  }
  throw new Error('官网没有本频道的有效直播地址')
}

export function nmipUrl(payload, channel) {
  if (String(payload?.id) !== channel.contentId) throw new Error('官方接口返回了其他频道')
  const live = payload.exdata?.lives?.find(row => row.type === 1 && row.m3u8_url)
  if (!live) throw new Error('官方频道当前没有电视直播')
  return officialMedia(live.m3u8_url, channel)
}

export function bazhongUrl(payload, channel) {
  if (Number(payload?.rs) !== 200) throw new Error('巴中官方频道目录异常')
  const row = payload.data?.channel?.find(row => String(row.channelId) === channel.contentId)
  if (!row?.liveUrl) throw new Error('巴中官方目录没有本频道')
  return officialMedia(row.liveUrl, channel)
}

export function dfsxContent(payload, channel) {
  if (String(payload?.id) !== channel.contentId || payload.type !== 'live'
      || Number(payload.fields?.live_id) !== channel.liveId) throw new Error('客户端返回了其他频道')
  return payload.fields
}

export function dfsxComponent(payload, channel) {
  const live = payload?.lives?.find(row => Number(row.id) === channel.liveId && row.type === 1)
  if (!live?.m3u8_url) throw new Error('官方客户端没有本频道直播')
  return officialMedia(live.m3u8_url, channel)
}

export function ziyangUrl(payload, channel) {
  const row = payload?.code === 200 && payload.data
  if (String(row?.tv_id) !== channel.contentId || row.status !== 2) throw new Error('资阳客户端未提供公开电视直播')
  // 和官网 tv_detail_dvw.html 一致：只使用匿名接口明确返回的 url，拒绝时不拼接备用流。
  return officialMedia(row.url, channel)
}

export function deyangUrl(payload, channel) {
  const row = payload?.code === 1 && payload.status === 200 && payload.data?.find(row => String(row.id) === channel.contentId)
  if (!row || row.mark !== 'tv' || row.videoStatus !== 1) throw new Error('德阳客户端没有本频道直播')
  // 官方 H5 明确提供的流；不从 RTMP 字段推测或拼接。
  return officialMedia(row.streamH5, channel)
}

/** 攀枝花官方现用 H5 的匿名请求签名；配置运行时读取，不保存 apiSign。 */
export function panzhihuaRequest(config, channel, now = Date.now(), fields = { type: '1' }) {
  if (config?.id !== channel.siteId || config.domain !== 'https://www.pzhxinwen.cn'
      || typeof config.apiSign !== 'string' || !/^[a-zA-Z0-9]{16,128}$/.test(config.apiSign)) {
    throw new Error('攀枝花客户端公共配置异常')
  }
  const params = { ...fields, siteId: channel.siteId, appId: '', userId: '', currentTimeMillis: String(now) }
  params.signature = createHash('md5').update([...Object.values(params), config.apiSign].sort().join('')).digest('hex')
  return new URLSearchParams(params).toString()
}

export function panzhihuaUrl(payload, channel) {
  const row = payload?.status === '200' && payload.list?.find(row => row.id === channel.contentId)
  if (!row || row.siteId !== channel.siteId || row.type !== 1 || row.status !== 1 || row.checkedStatus !== 1) {
    throw new Error('攀枝花客户端没有本频道直播')
  }
  return officialMedia(row.url, channel)
}

export function abaUrl(payload, channel) {
  if (payload?.code !== 0 || !Array.isArray(payload.data)) throw new Error('阿坝官方目录异常')
  for (const component of payload.data) {
    if (component.componentCode !== 'component_tv_radio_live') continue
    for (const group of component.propValue?.children || []) {
      const row = group.dataList?.find(row => String(row.jumpId) === channel.contentId && row.jumpContentType === 36)
      if (row?.liveStream) return officialMedia(row.liveStream, channel)
    }
  }
  throw new Error('阿坝官方目录没有本频道')
}

/** 官网公开配置 + 官网 a0d8 模块的正常签名流程；不保存密钥或签名。 */
export function signAbaUrl(raw, payload, channel, now = Date.now()) {
  const url = new URL(officialMedia(raw, channel, { asset: true }))
  const config = payload?.code === 0 && payload.data
  const host = String(config?.antiTheftChainAddressHD || config?.antiTheftChainAddress || '').trim()
  let expected
  try { expected = new URL(host) } catch { throw new Error('阿坝官网签名配置异常') }
  const encoded = config?.antiTheftChainKey
  if (expected.hostname !== url.hostname || typeof encoded !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(encoded)) {
    throw new Error('阿坝官网签名配置与媒体不符')
  }
  const key = Buffer.from(encoded, 'base64').toString('utf8')
  if (!key || key.length > 256) throw new Error('阿坝官网签名配置异常')
  const time = String(Math.floor((now + 60000) / 1000))
  url.searchParams.set('wsSecret', createHash('md5').update(key + url.pathname + time).digest('hex'))
  url.searchParams.set('wsTime', time)
  return url.href
}

export async function readOfficial(url, { fetchImpl = fetch, timeoutMs = 10000, ...options } = {}) {
  try {
    const response = await fetchImpl(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*', ...options.headers } })
    if (!response.ok) { await response.body?.cancel?.(); throw new Error(`官方入口 HTTP ${response.status}`) }
    if (Number(response.headers.get('content-length')) > MAX_TEXT_BYTES) {
      await response.body?.cancel?.(); throw new Error('官方响应过大')
    }
    const chunks = []
    let size = 0
    for await (const chunk of response.body || []) {
      size += chunk.byteLength
      if (size > MAX_TEXT_BYTES) throw new Error('官方响应过大')
      chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks, size).toString('utf8')
  } catch (error) {
    if (/^官方(?:入口 HTTP \d{3}|响应过大)$/.test(error?.message)) throw error
    throw new Error(['TimeoutError', 'AbortError'].includes(error?.name) ? '官方请求超时' : '官方网络请求失败')
  }
}

export function parseJson(text) {
  try { return JSON.parse(text) } catch { throw new Error('官方接口返回无效 JSON') }
}
