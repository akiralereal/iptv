/**
 * 宁波广电网直播页 → 中科大洋（chinamcloud）播放器配置 → 官方签名接口 → 签名 HLS。
 *
 * 官网播放器的取流顺序，照做（实测 2026-10-06，上海联通家宽 / 洛杉矶机房都通）：
 * 1. 直播页 www.ncmc.nbtv.cn/gbds/folder8458/NBTV<n>/index.shtml 里 createLivePlayer("<频道 ID>")，
 *    以及播放器配置脚本 web.ncmc.nbtv.cn/vms/site/nbtv/media/playerJson/liveChannel/<播放器 ID>.js；
 * 2. 配置脚本里 player_playerParamProfile 指向 <播放器 ID>_PlayerParamProfile.json，其中 paramsConfig
 *    给出 CDN 列表（发布域名、签名接口 em.chinamcloud.com/player/encryptUrl、有效期 3600 秒）和一段
 *    加密的 CDN 参数 cdnConfigEncrypt（播放器原样回传给签名接口，不解它、不落盘、不打日志）；
 * 3. 频道资料 web.ncmc.nbtv.cn/vms/site/nbtv/liveChannel/PC/<频道 ID>.jsonp 给出未签名的地址
 *    liveplay8.nbtv.cn/live/nbtv<n>_md.m3u8，不签名 CDN 回 403；
 * 4. 把地址、CDN 序号和那段加密参数 POST 给签名接口，回 auth_key=<过期秒>-0-0-<md5>（阿里云 A 型）。
 *
 * CDN 不看 Referer 和 UA，分片由 CDN 在清单里各自签名，播放器可以直连，所以本机只中继清单。
 * 第 1～3 步是频道资料，缓存 6 小时；签名地址缓存到过期前 15 分钟；清单被拒时扔掉签名重签一次。
 * 官网节目单是每周一篇图片文章，没有可读的节目数据，见 EPG.md。
 */
import { proxyAwareFetch } from '../../utils/systemProxy.js'
import { CHANNELS, CHANNEL_BY_REF, livePage } from './channels.js'

export { CHANNELS }

const SITE_HOST = 'www.ncmc.nbtv.cn'
const PLAYER_HOST = 'web.ncmc.nbtv.cn'
const SIGN_URL = 'https://em.chinamcloud.com/player/encryptUrl'
const MEDIA_HOST = 'liveplay8.nbtv.cn'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
// 播放器配置脚本带一整份打包的 jQuery，约 100 KB
const MAX_TEXT_BYTES = 1024 * 1024
const DISCOVERY_TTL_MS = 6 * 60 * 60 * 1000
// 签名标称一小时；过期前多久停用缓存、重新签
const EXPIRY_MARGIN_MS = 15 * 60 * 1000
// 取流失败后这段时间内直接回同一个错误：播放器失败后是 100ms 级别的连环重试
const FAILURE_COOLDOWN_MS = 20 * 1000
const AUTH_KEY_RE = /^(\d{10})-\d+-\d+-[0-9a-f]{32}$/
const PROFILE_PATH_RE = /^\/vms\/site\/nbtv\/media\/playerJson\/liveChannel\/[0-9a-f]{32}_PlayerParamProfile\.json$/

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

/** 频道在官方 CDN 上的媒体清单（签名前后都用它校验）；signed 为真时还要求带 A 型签名。 */
export function officialStreamUrl(raw, channel, { signed = false } = {}) {
  let url
  try { url = new URL(String(raw || '')) } catch { throw new Error('宁波直播地址无效') }
  if (url.protocol !== 'https:' || url.hostname !== MEDIA_HOST
      || url.username || url.password || url.port || url.hash
      || !new RegExp(`^/live/nbtv${channel.number}_[a-z0-9]+\\.m3u8$`).test(url.pathname)) {
    throw new Error('宁波直播地址不在该频道的官方 CDN')
  }
  if (signed && !Number.isFinite(authExpiry(url))) throw new Error('宁波直播地址缺少官方签名')
  return url.href
}

/** 清单里的分片：只放行同一台 CDN 上本频道这一路流的文件（全代理 ?relay=2 时也用它登记）。 */
export function officialMediaUrl(raw, streamUrl, channel) {
  const stream = new URL(officialStreamUrl(streamUrl, channel))
  const name = stream.pathname.slice('/live/'.length, -'.m3u8'.length)
  let url
  try { url = new URL(String(raw || ''), stream) } catch { throw new Error('宁波直播分片地址无效') }
  if (url.protocol !== 'https:' || url.hostname !== MEDIA_HOST
      || url.username || url.password || url.port
      || !url.pathname.startsWith('/live/') || !url.pathname.includes(name)) {
    throw new Error('宁波直播分片不在该频道的官方 CDN')
  }
  return url.href
}

/** 直播页 → { channelId, profileScript }。 */
export function parseLivePage(html) {
  const text = String(html || '')
  const channelId = /createLivePlayer\(\s*["']([0-9a-f]{32})["']/.exec(text)?.[1]
  const profileScript = /https:\/\/web\.ncmc\.nbtv\.cn\/vms\/site\/nbtv\/media\/playerJson\/liveChannel\/[0-9a-f]{32}\.js/.exec(text)?.[0]
  if (!channelId || !profileScript) throw new Error('宁波直播页里没有播放器信息，页面可能改版')
  return { channelId, profileScript }
}

/** 播放器配置脚本（只当文本读，不执行）→ 播放器参数 JSON 的地址。 */
export function parseProfileScript(script) {
  const raw = /player_playerParamProfile\s*:\s*["']([^"']+)["']/.exec(String(script || ''))?.[1]
  let url
  try { url = new URL(raw) } catch { throw new Error('宁波播放器配置里没有 CDN 参数地址') }
  if (url.protocol !== 'https:' || url.hostname !== PLAYER_HOST || url.search || !PROFILE_PATH_RE.test(url.pathname)) {
    throw new Error('宁波播放器 CDN 参数地址不在官方域名')
  }
  return url.href
}

/** 频道资料 JSONP → 未签名的官方媒体清单。 */
export function parseChannelJsonp(text, channelId, channel) {
  const clean = String(text || '').trim().replace(/;$/, '')
  const prefix = `callback_${channelId}(`
  if (!clean.startsWith(prefix) || !clean.endsWith(')')) throw new Error('宁波频道资料格式不符合预期')
  let data
  try { data = JSON.parse(clean.slice(prefix.length, -1)) } catch { throw new Error('宁波频道资料不是有效 JSON') }
  if (data?.C_Id !== channelId || typeof data.C_Address !== 'string' || !data.C_Address.startsWith('mr://j:')) {
    throw new Error('宁波频道资料与该频道不匹配')
  }
  let media
  try { media = JSON.parse(data.C_Address.slice('mr://j:'.length)) } catch { throw new Error('宁波频道地址不是有效 JSON') }
  if (media?.status !== 1) throw new Error('官方已停播这一路频道')
  const entry = Array.isArray(media.playerUrl)
    ? media.playerUrl.find(item => typeof item?.url === 'string' && /\.m3u8(?:$|\?)/.test(item.url))
    : null
  if (!entry) throw new Error('宁波频道资料里没有 HLS 地址')
  return officialStreamUrl(entry.url, channel)
}

/** 播放器参数 JSON → 这路流对应的 CDN 序号与加密参数。 */
export function pickCdn(profile, streamUrl) {
  const config = profile?.paramsConfig
  const list = Array.isArray(config?.cdnConfig) ? config.cdnConfig : []
  const origin = new URL(streamUrl).origin
  const index = list.findIndex(item => item?.H5PublishHost === origin)
  if (index < 0) throw new Error('宁波播放器配置里没有这路流的 CDN')
  if (list[index].getAuthUrl !== SIGN_URL) throw new Error('宁波签名接口地址已变化，需要重新检查')
  if (typeof config.cdnConfigEncrypt !== 'string' || !config.cdnConfigEncrypt) {
    throw new Error('宁波播放器配置里没有 CDN 签名参数')
  }
  return { index, encrypt: config.cdnConfigEncrypt }
}

/** 媒体清单：必须是 HLS 媒体清单，每条地址都在本频道这一路流上。 */
export function validatePlaylist(text, streamUrl, channel) {
  if (typeof text !== 'string' || !text.trimStart().startsWith('#EXTM3U')) {
    throw new Error('宁波 CDN 没有返回 HLS 清单')
  }
  if (text.includes('#EXT-X-STREAM-INF')) throw new Error('宁波 HLS 格式已变化，需要重新检查')
  let segments = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#')) {
      for (const match of line.matchAll(/URI="([^"]+)"/g)) officialMediaUrl(match[1], streamUrl, channel)
      continue
    }
    officialMediaUrl(line, streamUrl, channel)
    segments++
  }
  if (!segments) throw new Error('宁波直播清单没有分片')
  return text
}

async function requestText(url, { fetchImpl, timeoutMs, method = 'GET', body, headers = {} }) {
  const response = await fetchImpl(url, {
    method, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': UA, ...headers },
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

function parseJson(text, what) {
  try { return JSON.parse(text) } catch { throw new Error(`${what}不是有效 JSON`) }
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
  const discovery = new Map()   // ref -> { page, streamUrl, cdnIndex, encrypt, freshUntil }
  const signed = new Map()      // ref -> { url, freshUntil }
  const failures = new Map()    // ref -> { error, until }
  const inflight = new Map()    // ref -> Promise<url>

  async function discover(channel, options) {
    const cached = discovery.get(channel.ref)
    if (cached && now() < cached.freshUntil) return cached
    const page = livePage(channel)
    const { channelId, profileScript } = parseLivePage(await requestText(page, options))
    const profileUrl = parseProfileScript(await requestText(profileScript, options))
    const profile = parseJson(await requestText(profileUrl, options), '宁波播放器 CDN 参数')
    const streamUrl = parseChannelJsonp(
      await requestText(`https://${PLAYER_HOST}/vms/site/nbtv/liveChannel/PC/${channelId}.jsonp`, options),
      channelId, channel,
    )
    const { index, encrypt } = pickCdn(profile, streamUrl)
    const result = { page, streamUrl, cdnIndex: index, encrypt, freshUntil: now() + DISCOVERY_TTL_MS }
    discovery.set(channel.ref, result)
    return result
  }

  async function sign(channel, options) {
    const info = await discover(channel, options)
    const text = await requestText(SIGN_URL, {
      ...options,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=utf-8',
        Referer: info.page,
        Origin: `https://${SITE_HOST}`,
      },
      body: JSON.stringify({ url: info.streamUrl, playType: 'live', type: 'cdn', cdnEncrypt: info.encrypt, cdnIndex: info.cdnIndex }),
    })
    const payload = parseJson(text, '宁波签名接口回应')
    if (payload?.code !== '0000' || !payload.url) {
      // 加密参数可能随播放器配置一起换了：下次重新走一遍频道资料
      discovery.delete(channel.ref)
      throw new Error('宁波签名接口没有给出地址')
    }
    const url = officialStreamUrl(payload.url, channel, { signed: true })
    if (new URL(url).pathname !== new URL(info.streamUrl).pathname) throw new Error('宁波签名接口回了别的频道')
    return url
  }

  async function signedUrl(channel, options) {
    const cached = signed.get(channel.ref)
    if (cached && now() < cached.freshUntil) return cached.url
    const failure = failures.get(channel.ref)
    if (failure && now() < failure.until) throw failure.error
    let task = inflight.get(channel.ref)
    if (!task) {
      // 多个客户端同时开同一路只签一次；一个客户端断开不影响别人共用的这次请求
      task = sign(channel, options)
        .then(url => {
          signed.set(channel.ref, { url, freshUntil: authExpiry(new URL(url)) - EXPIRY_MARGIN_MS })
          failures.delete(channel.ref)
          return url
        })
        .catch(error => { failures.set(channel.ref, { error, until: now() + FAILURE_COOLDOWN_MS }); throw error })
        .finally(() => inflight.delete(channel.ref))
      inflight.set(channel.ref, task)
    }
    return task
  }

  async function playlist(channel, options) {
    const accept = { headers: { Accept: 'application/vnd.apple.mpegurl' } }
    const url = await signedUrl(channel, options)
    try {
      return { url, text: await requestText(url, { ...options, ...accept }) }
    } catch (error) {
      // 签名被拒：扔掉缓存重签一次，别等它自然过期
      if (![401, 403, 410].includes(error?.status)) throw error
      signed.delete(channel.ref)
      const fresh = await signedUrl(channel, options)
      return { url: fresh, text: await requestText(fresh, { ...options, ...accept }) }
    }
  }

  async function resolve(ref, ctx = {}) {
    const channel = CHANNEL_BY_REF.get(String(ref || ''))
    if (!channel) return { url: '', desc: '宁波频道引用格式错误' }
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
        upstreamUrlTransform: raw => officialMediaUrl(raw, url, channel),
      }
    } catch (error) {
      const reason = ['AbortError', 'TimeoutError'].includes(error?.name)
        ? '请求超时' : (error?.message || '上游请求失败')
      return { url: '', desc: `${channel.name} 取流失败：${reason}` }
    }
  }

  function clearCache() {
    discovery.clear()
    signed.clear()
    failures.clear()
  }

  return { resolve, clearCache }
}

const defaultResolver = createResolver()
export const resolveChannel = defaultResolver.resolve
export const clearResolveCache = defaultResolver.clearCache
