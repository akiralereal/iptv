/** 江西广电官网：固定频道目录、匿名短效 token 与实时 HLS 清单。 */
import { createHash, randomBytes } from 'node:crypto'
import { proxyAwareFetch } from '../../utils/systemProxy.js'

export const JXNTV_PAGE = 'https://www.jxntv.cn/live/'
export const JXNTV_AUTH_API = 'https://cdnauth.jxgdw.com/liveauth/pc'
export const JXNTV_MEDIA_ORIGIN = 'https://yun-live.jxtvcn.com.cn'

const AUTH_SALT = 'gXmNaQROStYfd'
const ETAG_CHARS = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678oOLl9gqVvUuI1'
const MEDIA_HOST = 'yun-live.jxtvcn.com.cn'
const MEDIA_PATH_PREFIX = '/live-jxtv/'
const TOKEN_TTL_MS = 45 * 1000
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// 官网脚本公开下发签名算法和盐值；UUID 只用于匿名防盗链，不是账号凭据。
export const DEVICE_UUID = createHash('md5').update(`jxntv:${UA}`).digest('hex').slice(0, 12)

const LOGO_BASE = 'https://image.jxgdw.com/material/'

// 台标取江西广电「今视频」App 频道目录（share.jxgdw.com/api/tv/channel/page）每路下发的 iconUrl：
// 透明底的频道标，7 张 144×96、移动电视那张 2848×1811，实测都是 PNG。目录给的是 24 小时过期的
// OSS 签名地址，去掉签名照样能取（公共读），所以写死去签名的地址，免得托管缓存每天当成新图重下。
// 官网直播页的频道图标只是 25px 的雪碧图，不用。
export const CHANNELS = Object.freeze([
  Object.freeze({ ref: 'jxntv-satellite', route: 'jxtv1', streamName: 'tv_jxtv1.m3u8', rawName: '江西卫视', name: '江西卫视',
    logo: `${LOGO_BASE}ae00a8764c764390bb58094d46f5b2af` }),
  Object.freeze({ ref: 'jxntv-city', route: 'jxtv2', streamName: 'tv_jxtv2.m3u8', rawName: '都市频道', name: '江西都市',
    logo: `${LOGO_BASE}67d8420f601b4b95bcb3f9c1d2aee40c` }),
  Object.freeze({ ref: 'jxntv-economy-life', route: 'jxtv3', streamName: 'tv_jxtv3_hd.m3u8', rawName: '经济生活频道', name: '江西经济生活',
    logo: `${LOGO_BASE}4294b5a4be2c4958bcf2711430cc483b` }),
  Object.freeze({ ref: 'jxntv-public-agriculture', route: 'jxtv5', streamName: 'tv_jxtv5.m3u8', rawName: '公共·农业频道', name: '江西公共农业',
    logo: `${LOGO_BASE}07e893cd94224d9ebcf4eb588d2a43d1` }),
  Object.freeze({ ref: 'jxntv-kids', route: 'jxtv6', streamName: 'tv_jxtv6.m3u8', rawName: '少儿频道', name: '江西少儿',
    logo: `${LOGO_BASE}aa18d5b48b63473591293aabd67c53be` }),
  Object.freeze({ ref: 'jxntv-news', route: 'jxtv7', streamName: 'tv_jxtv7.m3u8', rawName: '新闻频道', name: '江西新闻',
    logo: `${LOGO_BASE}3d27952c09c44cf3b68cb19863605973` }),
  Object.freeze({ ref: 'jxntv-mobile', route: 'jxtv8', streamName: 'tv_jxtv8.m3u8', rawName: '移动电视频道', name: '江西移动电视',
    logo: `${LOGO_BASE}167e9ebbb9f54cc787db75cbf0bc4aa8` }),
  Object.freeze({ ref: 'jxntv-ceramics', route: 'tcpd', streamName: 'tv_taoci.m3u8', rawName: '陶瓷频道', name: '江西陶瓷',
    logo: `${LOGO_BASE}8eba1c8045384be1bed2f6aef90e4526` }),
])

const CHANNEL_BY_REF = new Map(CHANNELS.map(channel => [channel.ref, channel]))
const tokenCache = new Map()
const tokenPending = new Map()

/** 全代理登记子清单、密钥和分片前都经过这里，避免清单注入任意回源。 */
export function officialAssetUrl(raw) {
  const url = new URL(String(raw || '').trim())
  if (url.protocol !== 'https:' || url.username || url.password || !['', '443'].includes(url.port)
      || url.hostname !== MEDIA_HOST || !url.pathname.startsWith(MEDIA_PATH_PREFIX)) {
    throw new Error('江西广电返回了非官方媒体地址')
  }
  return url.href
}

export function officialHlsUrl(raw) {
  const url = new URL(officialAssetUrl(raw))
  if (!url.pathname.toLowerCase().endsWith('.m3u8')) {
    throw new Error('江西广电返回的不是 HLS 地址')
  }
  return url.href
}

/** hlsProxy 每次实际回源和跟随重定向前都会重新校验目标。 */
export function upstreamHeadersFor(raw) {
  officialAssetUrl(raw)
  return {
    Origin: 'https://www.jxntv.cn',
    Referer: JXNTV_PAGE,
  }
}

function makeEtag() {
  return Array.from(randomBytes(8), value => ETAG_CHARS[value % ETAG_CHARS.length]).join('')
}

export function buildAuthRequest(channel, {
  now = Date.now(),
  etag = makeEtag(),
  uuid = DEVICE_UUID,
} = {}) {
  if (!channel || !CHANNEL_BY_REF.has(channel.ref)) throw new Error('未知江西频道')
  const timestampNumber = Math.floor(Number(now) / 1000)
  if (!Number.isSafeInteger(timestampNumber) || timestampNumber < 0) throw new Error('鉴权时间无效')
  const timestamp = String(timestampNumber)
  if (String(etag).length !== 8 || [...String(etag)].some(char => !ETAG_CHARS.includes(char))) {
    throw new Error('ETag 随机串无效')
  }
  if (!/^[a-f0-9]{12}$/i.test(String(uuid))) throw new Error('匿名设备标识无效')
  const authorization = createHash('md5')
    .update(timestamp + channel.streamName + etag + AUTH_SALT)
    .digest('hex')
  return {
    url: JXNTV_AUTH_API,
    options: {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        Origin: 'https://www.jxntv.cn',
        Referer: JXNTV_PAGE,
        Authorization: authorization,
        ETag: String(etag),
        GPU: 'Apple, Apple M1',
      },
      body: JSON.stringify({ t: timestamp, stream: channel.streamName, uuid: String(uuid) }),
    },
  }
}

export function parseAuth(payload) {
  let data = payload
  if (typeof payload === 'string') {
    try { data = JSON.parse(payload) } catch { throw new Error('江西广电鉴权接口没有返回有效 JSON') }
  }
  if (!data || !/^\d+$/.test(String(data.t)) || !/^[a-f0-9]{32}$/i.test(String(data.token))) {
    throw new Error('江西广电当前没有返回有效直播凭证')
  }
  return { t: String(data.t), token: String(data.token) }
}

function signedStreamUrl(channel, auth) {
  const url = new URL(`${MEDIA_PATH_PREFIX}${channel.streamName}`, JXNTV_MEDIA_ORIGIN)
  url.searchParams.set('source', 'pc')
  url.searchParams.set('t', auth.t)
  url.searchParams.set('token', auth.token)
  url.searchParams.set('uuid', DEVICE_UUID)
  return officialHlsUrl(url.href)
}

async function requestSignedStream(channel, {
  timeoutMs = 15000,
  fetchImpl = proxyAwareFetch,
  now = Date.now(),
  etag,
} = {}) {
  const request = buildAuthRequest(channel, { now, etag })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(request.url, { ...request.options, signal: controller.signal })
    const text = await response.text()
    if (!response.ok) throw new Error(`鉴权接口 HTTP ${response.status}`)
    if (text.length > 64 * 1024) throw new Error('鉴权响应过大')
    return signedStreamUrl(channel, parseAuth(text))
  } finally {
    clearTimeout(timer)
  }
}

async function cachedSignedStream(channel, options = {}, force = false) {
  const now = Number(options.now ?? Date.now())
  const fetchImpl = options.fetchImpl || proxyAwareFetch
  const cached = tokenCache.get(channel.ref)
  if (!force && cached?.expiresAt > now && cached.fetchImpl === fetchImpl) {
    return { url: cached.url, reused: true }
  }
  if (force) tokenCache.delete(channel.ref)

  let active = tokenPending.get(channel.ref)
  if (!active || active.fetchImpl !== fetchImpl) {
    const promise = requestSignedStream(channel, { ...options, fetchImpl })
      .then(url => {
        tokenCache.set(channel.ref, { url, expiresAt: now + TOKEN_TTL_MS, fetchImpl })
        return url
      })
      .finally(() => {
        if (tokenPending.get(channel.ref)?.promise === promise) tokenPending.delete(channel.ref)
      })
    active = { promise, fetchImpl }
    tokenPending.set(channel.ref, active)
  }
  return { url: await active.promise, reused: false }
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
  if (!channel) return { url: '', desc: '江西频道引用格式错误' }
  const options = {
    timeoutMs: ctx.timeoutMs,
    fetchImpl: ctx.fetchImpl,
    now: ctx.now,
    etag: ctx.etag,
  }
  try {
    const signed = await cachedSignedStream(channel, options)
    return {
      url: signed.url,
      desc: `${channel.name}匿名直播凭证获取成功`,
      upstreamHeaders: upstreamHeadersFor,
      upstreamUrlTransform: officialAssetUrl,
    }
  } catch (error) {
    tokenCache.delete(channel.ref)
    const reason = error?.name === 'AbortError'
      ? `超时 ${ctx.timeoutMs || 15000}ms`
      : (error?.message || String(error))
    return { url: '', desc: `江西广电链接请求失败：${reason}` }
  }
}

export function clearCache() {
  tokenCache.clear()
  tokenPending.clear()
}
