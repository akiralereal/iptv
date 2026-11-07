import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { outboundFetch, outboundProxyKey, outboundProxyUrl, ytDlpProxyArg } from '../../utils/outboundProxy.js'
import { ytDlpCommand } from './runtime.js'
import { fetchUpstreamResponse } from '../../utils/hlsProxy.js'
import { topVariantFirst } from '../../utils/hlsTopFirst.js'
import { hasReplaceToken } from '../../utils/replaceToken.js'

const run = promisify(execFile)
const site = 'https://www.youtube.com'
const channelPattern = /^UC[\w-]{22}$/
const handlePattern = /^[\p{L}\p{N}\p{M}_.·-]{1,100}$/u
const videoPattern = /^[\w-]{11}$/
const youtubeHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'])
const shortHosts = new Set(['youtu.be', 'www.youtu.be'])
const embedHosts = new Set(['youtube-nocookie.com', 'www.youtube-nocookie.com'])
const channelTabs = /\/(?:featured|streams|live|videos|shorts|about|playlists|community|posts|podcasts|releases|search)$/
const reservedPaths = new Set(['watch', 'playlist', 'results', 'feed', 'shorts', 'live', 'embed', 'channel', 'c', 'user',
  'redirect', 'attribution_link', 'clip', 'hashtag', 'premium', 'gaming', 'account', 'settings', 'upload', 'signin', 'logout', 't', 'oembed'])
const watchUrl = id => site + '/watch?v=' + id
const channelUrl = id => site + '/channel/' + id
class NoStreamsTab extends Error {}
class Offline extends Error {}

export function normalizeYouTubeInput(raw) {
  const invalid = () => new Error('请输入 YouTube 用户名（@ 可省略）、频道 ID、频道或视频链接');
  if (typeof raw !== 'string' || raw.length > 2048) throw invalid();
  let value = raw.trim();
  if (!value || /[\x00-\x1f\x7f\\]/.test(value)) throw invalid();
  if (channelPattern.test(value)) value = site + '/channel/' + value;
  else if (handlePattern.test(value)) value = site + '/@' + value;
  else if (value.startsWith('@')) value = site + '/' + value;
  if (value.startsWith('//')) value = 'https:' + value;
  if (/^(?:(?:www\.|m\.|music\.)?youtube\.com|(?:www\.)?youtu\.be|(?:www\.)?youtube-nocookie\.com)\//i.test(value)) value = 'https://' + value;
  return normalizeLink(value);

  function normalizeLink(value, depth = 0) {
    let url, path;
    try {
      url = new URL(value);
      path = decodeURIComponent(url.pathname).replace(/\/+$/, '');
    } catch { throw invalid(); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) throw invalid();
    let videoId;
    if (shortHosts.has(url.hostname)) videoId = path.slice(1);
    else if (embedHosts.has(url.hostname)) {
      if (path === '/embed/live_stream' && channelPattern.test(url.searchParams.get('channel') || '')) return { channelUrl: channelUrl(url.searchParams.get('channel')) };
      videoId = path.match(/^\/embed\/([\w-]{11})$/)?.[1];
    }
    else {
      if (!youtubeHosts.has(url.hostname)) throw invalid();
      // Decode YouTube's own share wrappers locally; never fetch a redirect target.
      if (path === '/attribution_link' || path === '/redirect') {
        const target = url.searchParams.get(path === '/attribution_link' ? 'u' : 'q');
        if (!target || depth >= 2 || /[\x00-\x1f\x7f\\]/.test(target)) throw invalid();
        let next;
        try { next = new URL(target, site).href; } catch { throw invalid(); }
        return normalizeLink(next, depth + 1);
      }
      if (path === '/embed/live_stream' && channelPattern.test(url.searchParams.get('channel') || '')) return { channelUrl: channelUrl(url.searchParams.get('channel')) };
      if (path === '/watch') videoId = url.searchParams.get('v');
      else if (/^\/(live|embed|shorts|v)\//.test(path)) videoId = path.split('/').slice(2).join('/');
      else {
        const base = path.replace(channelTabs, '');
        if (base.startsWith('/@') && handlePattern.test(base.slice(2))) {
          return { channelUrl: site + '/@' + encodeURIComponent(base.slice(2)) };
        }
        if (base.startsWith('/channel/') && channelPattern.test(base.slice(9))) return { channelUrl: site + base };
        const legacy = base.match(/^\/(c|user)\/([^/]+)$/);
        if (legacy && handlePattern.test(legacy[2])) return { channelUrl: site + '/' + legacy[1] + '/' + encodeURIComponent(legacy[2]) };
        if (/^\/[\w.-]+$/.test(base) && !reservedPaths.has(base.slice(1).toLowerCase())) return { channelUrl: site + base };
      }
    }
    if (!videoPattern.test(videoId || '')) throw invalid();
    return { videoId };
  }
}

// Read the JSON assignment only. The watch page may append other JS in the same script.
function playerData(html) {
  const start = /<script\b[^>]*>\s*var ytInitialPlayerResponse\s*=\s*(?=\{)/.exec(html);
  if (start) {
    const from = start.index + start[0].length;
    const tokens = /"(?:\\.|[^"\\])*"|[{}]/g;
    tokens.lastIndex = from;
    let depth = 0, match;
    while ((match = tokens.exec(html))) {
      if (match[0] === '{') depth++;
      if (match[0] === '}' && --depth === 0) return JSON.parse(html.slice(from, tokens.lastIndex));
    }
  }
  throw new Error('无法读取 YouTube 直播页面');
}

/**
 * 连不上 YouTube 时告诉用户去哪儿改：没配代理的指到「网络代理」，配了的让去点「测试」。
 * 大陆部署没配代理是最常见的原因，原来那句「检查部署机器的网络」用户不知道该干什么。
 */
export function unreachableMessage(proxied = Boolean(outboundProxyUrl())) {
  return proxied
    ? '经代理连不上 YouTube，请到「设置 → 网络代理」点「测试」检查代理'
    : '连不上 YouTube。部署在大陆的，请到「设置 → 网络代理」填代理地址'
}

const NETWORK_ERROR = /timed? ?out|Connection (?:refused|reset|aborted)|Network is unreachable|No route to host|getaddrinfo|Name or service not known|Temporary failure in name resolution|nodename nor servname|Tunnel connection failed|ProxyError|Failed to establish|Remote end closed|RemoteDisconnected|EOF occurred|SSLError|SSL: |Unable to connect|Errno (?:101|104|110|111|113)/i

/** 出口 IP 被 YouTube 拦下（人机验证 / 请求过多）。播放侧据 exitBlocked 暂停请求、只记一行日志。 */
const exitBlocked = message => Object.assign(new Error(message), { exitBlocked: true })

/** yt-dlp 的 stderr → 给用户看的原因。返回 Error（Offline/NoStreamsTab 子类型供调用方区分）。 */
export function ytDlpError(stderr = '', { killed = false, code, proxied = Boolean(outboundProxyUrl()) } = {}) {
  if (code === 'ENOENT') return new Error('缺少 yt-dlp，请运行 npm run setup:youtube 或配置 YTDLP_BIN')
  if (/does not have a streams tab/i.test(stderr)) return new NoStreamsTab()
  if (/not currently live|live event will begin|will begin in|already ended/i.test(stderr)) return new Offline('这场直播尚未开始或已经结束')
  // 机房 / 机场出口常被要求人机验证，换节点通常就好；和会员专享、地区限制分开说。
  // 没配代理的是部署机器自己的出口（海外机房常见），「换节点」无从换起，指到「网络代理」
  if (/confirm you.?re not a bot/i.test(stderr)) {
    return exitBlocked(proxied
      ? 'YouTube 要求这个出口 IP 做人机验证，请换一个代理节点再试'
      : 'YouTube 要求这台机器的出口 IP 做人机验证，请到「设置 → 网络代理」填一个代理再试')
  }
  if (/HTTP Error 429|Too Many Requests/i.test(stderr)) {
    return exitBlocked(proxied
      ? 'YouTube 限制了这个出口 IP 的请求次数，稍后再试或换一个代理节点'
      : 'YouTube 限制了这台机器出口 IP 的请求次数，稍后再试或到「设置 → 网络代理」填一个代理')
  }
  if (/sign in|members.only|not available in your country/i.test(stderr)) return new Error('此直播在当前出口无法匿名播放')
  // unreachable：换个客户端重解析也是一样连不上，取流时不再退回默认客户端多等一轮
  if (killed || NETWORK_ERROR.test(stderr)) return Object.assign(new Error(unreachableMessage()), { unreachable: true })
  return new Error('YouTube 解析失败，可能是解析组件过旧：到「源管理 → YouTube 直播」点「检查更新」')
}

/** undici 的网络失败（不是我们自己抛的 HTTP 状态错误）。 */
function isNetworkFailure(err) {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError' || (err instanceof TypeError && /fetch failed/i.test(err.message)) || Boolean(err?.cause?.code)
}

async function metadata(url, args) {
  const { file, args: command } = ytDlpCommand()
  let data
  try {
    const result = await run(file, [...command, '--ignore-config', '--no-cache-dir', '--skip-download', '--dump-single-json',
      '--socket-timeout', '12', '--retries', '0', '--extractor-retries', '0', '--js-runtimes', 'node:' + process.execPath,
      '--proxy', ytDlpProxyArg(), ...args, '--', url], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 })
    data = result.stdout
  } catch (err) {
    // yt-dlp 错误可能带回带签名的播放地址，仅输出分类后的原因。
    throw ytDlpError(String(err.stderr || ''), { killed: err.killed, code: err.code })
  }
  try { return JSON.parse(data) } catch { throw new Error('YouTube 解析结果不是有效的频道或场次数据') }
}

async function readText(response, limit) {
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error('YouTube 上游 HTTP ' + response.status)
  }
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > limit) throw new Error('YouTube 上游响应过大')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function record(channelId, videoId, title) {
  const name = String(title || '').replace(/[\s\x00-\x1f\x7f"]+/g, ' ').replaceAll(',', '，').trim().slice(0, 180)
  if (!channelPattern.test(channelId) || (videoId != null && !videoPattern.test(videoId)) || !name || hasReplaceToken(name)) {
    throw new Error('无效的 YouTube 频道或场次')
  }
  return { channelId, ...(videoId ? { videoId } : {}), name }
}
export function refOf(item) {
  return 'yt-' + createHash('sha256').update(item.videoId || item.channelId).digest('hex').slice(0, 24)
}
export function records(config = {}) {
  const rows = config.subscriptions ? JSON.parse(config.subscriptions) : []
  if (!Array.isArray(rows) || rows.length > 100) throw new Error('最多可保存 100 个 YouTube 订阅')
  return rows.map(r => record(r.channelId, r.videoId, r.name))
}

export function parseVideoChannel(html, id) {
  const data = playerData(html)
  const v = data.videoDetails
  if (!v || v.videoId !== id) throw new Error('无法从此视频识别所属频道，请改用频道主页链接')
  // A video is only a way to identify its owner. Never save its title/ID as a channel.
  return record(v.channelId, null, v.author || data.microformat?.playerMicroformatRenderer?.ownerChannelName)
}

function parseChannel(data, expectedId) {
  const channel = record(data.channel_id, null, data.channel)
  if (expectedId && expectedId !== channel.channelId) throw new Error('频道身份与直播列表不符')
  return channel
}

export function parseBroadcasts(data, expectedId) {
  const channel = parseChannel(data, expectedId)
  if (!Array.isArray(data.entries)) throw new Error('频道身份与直播列表不符')
  const events = data.entries.filter(v => videoPattern.test(v?.id) && (!v.channel_id || v.channel_id === channel.channelId) &&
    (!v.availability || ['public','unlisted'].includes(v.availability)) && ['is_live','is_upcoming'].includes(v.live_status))
    .map(v => ({ ...record(channel.channelId, v.id, v.title), status: v.live_status, url: watchUrl(v.id) }))
  return { channel, events }
}

async function broadcasts(base, expectedId, read = metadata) {
  try { return parseBroadcasts(await read(base + '/streams', ['--flat-playlist','--playlist-end','40']), expectedId) }
  catch (err) {
    if (!(err instanceof NoStreamsTab)) throw err
    const data = await read(base, ['--flat-playlist','--playlist-end','1'])
    return parseBroadcasts({ ...data, entries: [] }, expectedId)
  }
}

export async function inspect(raw, { includeEvents = true, readMetadata = metadata, readWatchPage = watchPage } = {}) {
  const input = normalizeYouTubeInput(raw)
  const owner = input.videoId ? parseVideoChannel(await readWatchPage(input.videoId), input.videoId) : null
  const base = owner ? channelUrl(owner.channelId) : input.channelUrl
  const id = owner?.channelId || base.match(/\/channel\/(UC[\w-]{22})$/)?.[1]
  if (!includeEvents) {
    const item = owner || parseChannel(await readMetadata(base, ['--flat-playlist', '--playlist-end', '1']), id)
    return { item, events: [] }
  }
  const { channel, events } = await broadcasts(base, id, readMetadata)
  return { item: channel, events }
}

async function watchPage(videoId) {
  let resp
  try { resp = await outboundFetch(watchUrl(videoId), { redirect:'error', signal:AbortSignal.timeout(12000) }) }
  catch (err) { throw isNetworkFailure(err) ? new Error(unreachableMessage()) : err }
  return readText(resp, 6 * 1024 * 1024)
}

/**
 * 固定场次现在的状态：live / upcoming / ended / unavailable，看不出来时 unknown。
 * 只读页面里的播放器数据，不调 yt-dlp。后台据此标出已经结束、可以移除的场次。
 */
export function videoStatus(html, id) {
  let data
  try { data = playerData(html) } catch { return 'unknown' }
  const v = data.videoDetails
  const live = data.microformat?.playerMicroformatRenderer?.liveBroadcastDetails
  const status = data.playabilityStatus?.status
  // 删除 / 设为私享才算失效；LOGIN_REQUIRED 多半是出口 IP 被要求人机验证，不能据此说场次没了
  const gone = ['ERROR', 'UNPLAYABLE'].includes(status)
  if (!v || v.videoId !== id) return gone ? 'unavailable' : 'unknown'
  if (live?.endTimestamp) return 'ended'
  if (v.isLive || live?.isLiveNow) return 'live'
  if (v.isUpcoming || status === 'LIVE_STREAM_OFFLINE') return 'upcoming'
  if (gone) return 'unavailable'
  return status === 'OK' && v.isLiveContent ? 'ended' : 'unknown'
}

// 状态缓存 10 分钟：打开源管理页就会查，别每次都把所有固定场次的页面拉一遍
const statusCache = new Map()
const STATUS_TTL = 10 * 60 * 1000
export async function eventStatuses(rows, { concurrency = 3, now = Date.now } = {}) {
  const ids = [...new Set(rows.map(row => row.videoId).filter(id => videoPattern.test(id || '')))]
  const out = {}
  const queue = ids.filter(id => {
    const hit = statusCache.get(id)
    if (hit && hit.until > now()) { out[id] = hit.status; return false }
    return true
  })
  async function worker() {
    for (let id = queue.shift(); id; id = queue.shift()) {
      let status
      try { status = videoStatus(await watchPage(id), id) } catch { status = 'unknown' }
      out[id] = status
      // 查不出来的不缓存，下次再试
      if (status !== 'unknown') statusCache.set(id, { status, until: now() + STATUS_TTL })
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
  if (statusCache.size > 1000) statusCache.clear()
  return out
}

export function mediaUrl(raw) {
  const u = new URL(raw)
  if (u.protocol !== 'https:' || u.port || u.username || u.password ||
      !(u.hostname === 'manifest.googlevideo.com' || /^rr?\d+---sn-[a-z0-9-]+\.googlevideo\.com$/.test(u.hostname))) {
    throw new Error('非 YouTube 官方媒体地址')
  }
  return u.href
}

export function parseLive(data, item, expectedVideoId) {
  if (data.live_status !== 'is_live') throw new Offline('这场直播尚未开始或已经结束')
  if (data.channel_id !== item.channelId || data.id !== expectedVideoId || data.has_drm) throw new Error('直播归属、场次或保护状态不符')
  // 不同客户端可能返回不同的 HLS 主清单，从包含最高视频档的那一份取流；同画质时优先音视频合在一起的那份。
  const formats = (data.formats || []).filter(f => f.protocol?.startsWith('m3u8') && f.vcodec !== 'none' && !f.has_drm && f.manifest_url)
  if (!formats.length) throw new Error('当前直播没有公开 HLS')
  const muxed = f => f.acodec && f.acodec !== 'none' ? 1 : 0
  formats.sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0)
    || muxed(b) - muxed(a) || (b.tbr || 0) - (a.tbr || 0))
  for (const format of formats) {
    let url
    try { url = new URL(mediaUrl(format.manifest_url)) } catch { continue }
    const expires = Number(url.pathname.match(/\/expire\/(\d+)\//)?.[1]) * 1000
    if (url.hostname !== 'manifest.googlevideo.com' || !url.pathname.startsWith('/api/manifest/hls_variant/') ||
        !Number.isFinite(expires) || expires <= Date.now() + 90000) continue
    const headers = {}
    for (const [k,v] of Object.entries(format.http_headers || data.http_headers || {})) {
      if (/^(User-Agent|Accept|Accept-Language)$/i.test(k) && typeof v === 'string' && !/[\r\n]/.test(v)) headers[k] = v
    }
    return { url: url.href, videoId: data.id, expires, upstreamHeaders: raw => { mediaUrl(raw); return headers } }
  }
  throw new Error('YouTube 主清单签名无效')
}

/**
 * 解析一场直播的播放地址。yt-dlp 默认客户端给的是纯视频分片 + 单独一路音轨（HLS 标准写法，主流播放器都认），
 * 但有人用 VSTV（ExoPlayer 内核）只出画面不出声。模块里打开「音视频合流」（muxed）时先用 mweb 客户端：
 * 它给的直播 HLS（itag 91～96）每个分片里音视频都在，代价是解析多两三秒（多拉一份客户端配置和播放器脚本），
 * 所以默认不开。mweb 解析失败、或没给出可用的 HLS 时退回默认客户端；直播没开 / 出口被拦 / 连不上 YouTube
 * 换客户端也一样，直接抛出，不多跑一轮 yt-dlp。
 */
const MUXED_CLIENT = ['--extractor-args', 'youtube:player_client=mweb']
export async function liveInfo(item, videoId, { muxed = false } = {}, read = metadata) {
  if (muxed) {
    try { return parseLive(await read(watchUrl(videoId), ['--no-playlist', ...MUXED_CLIENT]), item, videoId) }
    catch (err) {
      if (err instanceof Offline || err.exitBlocked || err.unreachable) throw err
    }
  }
  return parseLive(await read(watchUrl(videoId), ['--no-playlist']), item, videoId)
}
const muxedOf = config => config?.muxedAudio === true

const sessions = new Map()
// 关注频道时「现在在播哪一场」：列频道直播页要多跑一次 yt-dlp（约 4 秒），重开同一频道时先试上次那场，
// 那场已经结束（Offline）再重新列。10 分钟内频道换成别的场次作为第一场时，会晚一点切过去。
const liveIds = new Map()
const LIVE_ID_TTL = 10 * 60 * 1000
// 出口被拦（人机验证 / 请求过多）后暂停 1 分钟不跑 yt-dlp：失败结果只缓存 2 秒，播放器每隔几秒重试一次，
// 原来每次都重新解析，日志几秒一行，还一直拿被标记的 IP 去碰 YouTube。按出口记：改了代理地址立即重试；
// 代理软件里换节点（地址不变）要等这 1 分钟过去。
const EXIT_COOLDOWN = 60 * 1000
const exitCooldowns = new Map()   // outboundProxyKey → { until, message }
export const clearResolveCache = () => { sessions.clear(); liveIds.clear(); exitCooldowns.clear() }
async function session(item, exactId, rejected, muxed = false) {
  // 播放地址绑定解析时的出口 IP：换了代理，旧解析结果拿去取分片只会 403
  const exit = outboundProxyKey()
  const key = refOf(item) + ':' + (exactId || '') + ':' + exit + (muxed ? ':muxed' : '')
  const cached = sessions.get(key)
  // Only replace the session that actually failed. A late 403 from another
  // request must reuse an already refreshed session, not evict it again.
  if (cached && (cached.pending || ((!rejected || cached.live !== rejected) && cached.until > Date.now()))) return cached.promise
  const blocked = exitCooldowns.get(exit)
  if (blocked && blocked.until > Date.now()) {
    const seconds = Math.ceil((blocked.until - Date.now()) / 1000)
    // reported：冷却期内的重试不再逐条打红字，见 resolve
    throw Object.assign(exitBlocked(`${blocked.message}（已暂停向 YouTube 请求，约 ${seconds} 秒后再试）`), { reported: true })
  }
  if (sessions.size >= 512) sessions.delete(sessions.keys().next().value)
  const state = { pending:true, until:0 }
  state.promise = (async () => {
    let videoId = exactId || item.videoId
    let live
    if (!videoId) {
      const hint = liveIds.get(item.channelId)
      if (hint && hint.until > Date.now()) {
        try { live = await liveInfo(item, hint.videoId, { muxed }) }
        catch (err) {
          if (!(err instanceof Offline)) throw err
          liveIds.delete(item.channelId)
        }
      }
      if (!live) {
        const { events } = await broadcasts(channelUrl(item.channelId), item.channelId)
        videoId = events.find(event => event.status === 'is_live')?.videoId
        if (!videoId) throw new Offline('频道暂未开播，订阅已保留，开播后重新打开即可')
      }
    }
    live ||= await liveInfo(item, videoId, { muxed })
    if (!exactId && !item.videoId) {
      if (liveIds.size >= 512) liveIds.delete(liveIds.keys().next().value)
      liveIds.set(item.channelId, { videoId: live.videoId, until: Date.now() + LIVE_ID_TTL })
    }
    state.until = Math.min(live.expires - 90000, Date.now() + (exactId ? 240000 : 45000))
    state.live = live
    return live
  })().catch(err => {
    state.until = Date.now() + (err instanceof Offline ? 15000 : 2000)
    if (err.exitBlocked) {
      exitCooldowns.set(exit, { until: Date.now() + EXIT_COOLDOWN, message: err.message })
      err.message += '（已暂停向 YouTube 请求 1 分钟）'
    }
    throw err
  }).finally(() => { state.pending = false })
  sessions.set(key, state)
  return state.promise
}

// YouTube can send an hour of DVR for every rendition. Only publish a live window
// so a multi-track player cannot evict its own playlists from the shared proxy.
export function liveWindow(text, count = 12) {
  const lines = text.split(/\r?\n/)
  const ends = []
  for (const [index, line] of lines.entries()) {
    if (line && !line.startsWith('#')) ends.push(index)
  }
  const drop = ends.length - count
  if (drop <= 0 || !/^#EXTINF:/m.test(text) || /^#EXT-X-(?:ENDLIST|BYTERANGE)/m.test(text)) return text
  const cut = ends[drop - 1] + 1
  const prefix = lines.slice(0, cut)
  const head = prefix.filter(line => /^#(?:EXTM3U$|EXT-X-(?:VERSION|TARGETDURATION|INDEPENDENT-SEGMENTS|SERVER-CONTROL)(?:$|:))/.test(line))
  const sequence = Number(text.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m)?.[1] || 0)
  head.push('#EXT-X-MEDIA-SEQUENCE:' + (sequence + drop))
  const discontinuities = Number(text.match(/^#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)/m)?.[1] || 0)
    + prefix.filter(line => line === '#EXT-X-DISCONTINUITY').length
  if (discontinuities) head.push('#EXT-X-DISCONTINUITY-SEQUENCE:' + discontinuities)
  for (const tag of ['#EXT-X-KEY:', '#EXT-X-MAP:']) {
    const last = prefix.findLast(line => line.startsWith(tag))
    if (last) head.push(last)
  }
  // The first retained segment needs a wall clock if YouTube only sent the
  // program date once, so audio/video and captions can still synchronize.
  let clock = NaN
  for (const line of prefix) {
    if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) clock = Date.parse(line.slice(25))
    if (line.startsWith('#EXTINF:')) clock += parseFloat(line.slice(8)) * 1000
    if (line === '#EXT-X-DISCONTINUITY') clock = NaN
  }
  const tail = lines.slice(cut)
  if (Number.isFinite(clock) && !tail.slice(0, ends[drop] - cut).some(line => line.startsWith('#EXT-X-PROGRAM-DATE-TIME:'))) {
    head.push('#EXT-X-PROGRAM-DATE-TIME:' + new Date(clock).toISOString())
  }
  return [...head, ...tail].join('\n')
}

// Resolve and validate every URI before the shared HLS proxy registers it.
export function publicManifest(text, base) {
  if (!text.trimStart().startsWith('#EXTM3U') || /^#EXT-X-(?:SESSION-)?KEY:.*(?:SAMPLE-AES|KEYFORMAT="(?!identity"))/m.test(text)) {
    throw new Error('不是公开的 HLS 清单')
  }
  const absolute = uri => mediaUrl(new URL(uri, base).href)
  return text.split('\n').map(line => {
    const t = line.trim()
    if (!t) return line
    return t.startsWith('#') ? line.replace(/URI="([^"]+)"/g, (_, uri) => 'URI="' + absolute(uri) + '"') : absolute(t)
  }).join('\n')
}

async function playlist(url, live) {
  let resp
  try { resp = await fetchUpstreamResponse(url, { upstreamHeaders:live.upstreamHeaders, signal:AbortSignal.timeout(10000), fetchImpl:outboundFetch }) }
  catch (err) { throw isNetworkFailure(err) ? new Error(unreachableMessage()) : err }
  return publicManifest(await readText(resp, 2 * 1024 * 1024), resp.url || url)
}
class RemovedSubscription extends Error {}
function configured(ref, config) {
  const item = records(config).find(row => refOf(row) === ref)
  if (!item) throw new RemovedSubscription('此 YouTube 订阅已移除')
  return item
}
export async function resolve(ref, {config}) {
  try {
    const item = configured(ref, config)
    const muxed = muxedOf(config)
    let live = await session(item, undefined, undefined, muxed)
    let master
    try { master = await playlist(live.url, live) }
    catch (err) {
      if (!/HTTP (401|403|410)$/.test(err.message)) throw err
      live = await session(item, undefined, live, muxed)
      master = await playlist(live.url, live)
    }
    // 「最高画质」上限：视频全程经服务器和代理转发，限了能省带宽和代理流量；0 = 不限
    const maxHeight = Number(config?.maxHeight) || 0
    return { url:live.url, manifestUrl:live.url, manifestText:topVariantFirst(master, { highestOnly: true, maxHeight }), proxyHls:true,
      upstreamHeaders:live.upstreamHeaders, upstreamUrlTransform:mediaUrl }
  } catch (err) {
    const status = err instanceof RemovedSubscription ? 404 : err instanceof Offline ? 503 : 502
    // 出口被拦只记一行：同一次解析失败由并发请求共用同一个 Error，第一个请求打红字，其余和冷却期内的重试静默
    const silent = err.exitBlocked === true && err.reported === true
    if (err.exitBlocked) err.reported = true
    return { url:'', desc:err.message, status, ...(silent ? { silent:true } : {}) }
  }
}

// Renew the exact rendition/sequence: different languages can share an itag, and a
// broadcaster may already have started another programme on the same channel.
function field(raw, name) {
  return new URL(raw).pathname.split('/' + name + '/')[1]?.split('/')[0]
}
export function renewedLink(text, base, old, segment = false) {
  const links = text.split(/\r?\n/).flatMap(l => {
    if (!l.trim()) return []
    if (!l.startsWith('#')) return [l.trim()]
    return segment ? [] : [...l.matchAll(/URI="([^"]+)"/g)].map(m => m[1])
  })
  const url = links.map(raw => mediaUrl(new URL(raw, base).href)).find(raw =>
    field(raw,'id') === field(old,'id') && field(raw,'itag') === field(old,'itag') && field(raw,'xtags') === field(old,'xtags') &&
    (!segment || field(raw,'sq') === field(old,'sq')))
  if (!url) throw new Error('原直播轨或分片已退出窗口，请重开频道')
  return url
}

export async function fetchProxyMedia(ref, config, raw, options) {
  mediaUrl(raw)
  const item = configured(ref, config)
  const request = async (url, headers = options.upstreamHeaders) => {
    const res = await fetchUpstreamResponse(url, { ...options, upstreamHeaders:headers, fetchImpl:outboundFetch })
    if (res.ok && options.method !== 'HEAD' && new URL(url).pathname.endsWith('.m3u8')) {
      const text = publicManifest(liveWindow(await readText(res, 16 * 1024 * 1024)), res.url || url)
      return new Response(text, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } })
    }
    return res
  }
  const expires = Number(field(raw, 'expire')) * 1000
  if (!(expires < Date.now() + 5000)) {
    const res = await request(raw)
    if (![401,403,410].includes(res.status)) return res
    await res.body?.cancel()
  }
  const videoId = field(raw, 'id')?.split('.')[0]
  if (!videoPattern.test(videoId || '') || (item.videoId && videoId !== item.videoId) || !field(raw, 'itag')) throw new Error('无法更新此直播签名')
  const muxed = muxedOf(config)
  let live = await session(item, videoId, undefined, muxed)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const master = await playlist(live.url, live)
      let url = renewedLink(master, live.url, raw)
      if (field(raw,'sq')) url = renewedLink(await playlist(url, live), url, raw, true)
      const res = await request(url, live.upstreamHeaders)
      if (attempt || ![401,403,410].includes(res.status)) return res
      await res.body?.cancel()
    } catch (err) {
      // A missing track/segment or a changed programme cannot be fixed by
      // replacing its signature. Only retry explicit authorization failures.
      if (attempt || !/HTTP (401|403|410)$/.test(err.message)) throw err
    }
    live = await session(item, videoId, live, muxed)
  }
}
