import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { systemProxyUrl, proxyAwareFetch } from '../../utils/systemProxy.js'
import { fetchUpstreamResponse } from '../../utils/hlsProxy.js'
import { topVariantFirst } from '../../utils/hlsTopFirst.js'
import { hasReplaceToken } from '../../utils/replaceToken.js'

const run = promisify(execFile)
const localBinary = fileURLToPath(new URL('../../.runtime/youtube/bin/yt-dlp', import.meta.url))
const site = 'https://www.youtube.com'
const channelPattern = /^UC[\w-]{22}$/
const handlePattern = /^[\p{L}\p{N}\p{M}_.·-]{1,100}$/u
const videoPattern = /^[\w-]{11}$/
const watchUrl = id => site + '/watch?v=' + id
const channelUrl = id => site + '/channel/' + id
class NoStreamsTab extends Error {}
class Offline extends Error {}

export function normalizeYouTubeInput(raw) {
  const invalid = () => new Error('请输入 YouTube 用户名（@ 可省略）、频道链接或单场直播链接');
  if (typeof raw !== 'string' || raw.length > 2048 || /[\x00-\x1f\x7f]/.test(raw)) throw invalid();
  let value = raw.trim();
  if (channelPattern.test(value)) value = site + '/channel/' + value;
  else if (handlePattern.test(value)) value = site + '/@' + value;
  else if (value.startsWith('@')) value = site + '/' + value;
  if (/^(?:(?:www\.|m\.)?youtube\.com|youtu\.be)\//i.test(value)) value = 'https://' + value;
  let url, path;
  try {
    url = new URL(value);
    path = decodeURIComponent(url.pathname).replace(/\/$/, '');
  } catch { throw invalid(); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) throw invalid();
  let videoId;
  if (url.hostname === 'youtu.be') videoId = path.slice(1);
  else {
    if (!['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(url.hostname)) throw invalid();
    if (path === '/watch') videoId = url.searchParams.get('v');
    else if (/^\/(live|embed)\//.test(path)) videoId = path.split('/').slice(2).join('/');
    else {
      const base = path.replace(/\/(?:featured|streams|live|videos|shorts|about)$/, '');
      if (base.startsWith('/@') && handlePattern.test(base.slice(2))) {
        return { channelUrl: site + '/@' + encodeURIComponent(base.slice(2)) };
      }
      if (base.startsWith('/channel/') && channelPattern.test(base.slice(9))) return { channelUrl: site + base };
      if (/^\/(?:c|user)\/[\w.-]+$/.test(base)) return { channelUrl: site + base };
    }
  }
  if (!videoPattern.test(videoId || '')) throw invalid();
  return { videoId };
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

async function metadata(url, args) {
  const binary = process.env.YTDLP_BIN || (existsSync(localBinary) ? localBinary : 'yt-dlp')
  let data
  try {
    const result = await run(binary, ['--ignore-config', '--no-cache-dir', '--skip-download', '--dump-single-json',
      '--socket-timeout', '12', '--retries', '0', '--extractor-retries', '0', '--js-runtimes', 'node:' + process.execPath,
      '--proxy', systemProxyUrl() || '', ...args, '--', url], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 })
    data = result.stdout
  } catch (err) {
    // yt-dlp 错误可能带回带签名的播放地址，仅输出分类后的原因。
    if (err.code === 'ENOENT') throw new Error('缺少 yt-dlp，请运行 npm run setup:youtube 或配置 YTDLP_BIN')
    if (/does not have a streams tab/i.test(err.stderr)) throw new NoStreamsTab()
    if (/not currently live|live event will begin|will begin in|already ended/i.test(err.stderr)) throw new Offline('这场直播尚未开始或已经结束')
    if (/sign in|members.only|not available in your country/i.test(err.stderr)) throw new Error('此直播在当前出口无法匿名播放')
    throw new Error('YouTube 解析失败，请检查 yt-dlp 及部署机器的网络')
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

export function parseVideo(html, id) {
  const data = playerData(html)
  const v = data.videoDetails
  const live = data.microformat?.playerMicroformatRenderer?.liveBroadcastDetails
  const status = data.playabilityStatus?.status
  if (!v || !['OK', 'LIVE_STREAM_OFFLINE'].includes(status)) throw new Error('此条目无法公开访问')
  if (v.videoId !== id || !v.isLiveContent || live?.endTimestamp || !(v.isLive || live?.isLiveNow || status === 'LIVE_STREAM_OFFLINE')) {
    throw new Error('请选择正在直播或已预约的场次，普通视频和回放不可添加')
  }
  return record(v.channelId, id, v.title)
}

export function parseBroadcasts(data, expectedId) {
  const channel = record(data.channel_id, null, data.channel)
  if ((expectedId && expectedId !== channel.channelId) || !Array.isArray(data.entries)) throw new Error('频道身份与直播列表不符')
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

export async function inspect(raw) {
  const input = normalizeYouTubeInput(raw)
  if (input.channelUrl) {
    const id = input.channelUrl.match(/\/channel\/(UC[\w-]{22})$/)?.[1]
    const { channel, events } = await broadcasts(input.channelUrl, id)
    return { item: channel, events }
  }
  const resp = await proxyAwareFetch(watchUrl(input.videoId), { redirect:'error', signal:AbortSignal.timeout(12000) })
  return { item: parseVideo(await readText(resp, 6 * 1024 * 1024), input.videoId), events: [] }
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
  // 不同客户端可能返回不同的 HLS 主清单，从包含最高视频档的那一份取流。
  const formats = (data.formats || []).filter(f => f.protocol?.startsWith('m3u8') && f.vcodec !== 'none' && !f.has_drm && f.manifest_url)
  if (!formats.length) throw new Error('当前直播没有公开 HLS')
  formats.sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0)
    || (b.tbr || 0) - (a.tbr || 0))
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

const sessions = new Map()
export const clearResolveCache = () => sessions.clear()
async function session(item, exactId, force = false) {
  const key = refOf(item) + ':' + (exactId || '')
  const cached = sessions.get(key)
  if (cached && (cached.pending || (!force && cached.until > Date.now()))) return cached.promise
  if (sessions.size >= 512) sessions.delete(sessions.keys().next().value)
  const state = { pending:true, until:0 }
  state.promise = (async () => {
    let videoId = exactId || item.videoId
    if (!videoId) {
      const { events } = await broadcasts(channelUrl(item.channelId), item.channelId)
      videoId = events.find(event => event.status === 'is_live')?.videoId
      if (!videoId) throw new Offline('频道暂未开播，订阅已保留，开播后重新打开即可')
    }
    const live = parseLive(await metadata(watchUrl(videoId), ['--no-playlist']), item, videoId)
    state.until = Math.min(live.expires - 90000, Date.now() + (exactId ? 240000 : 45000))
    return live
  })().catch(err => {
    state.until = Date.now() + (err instanceof Offline ? 15000 : 2000)
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
  const resp = await fetchUpstreamResponse(url, { upstreamHeaders:live.upstreamHeaders, signal:AbortSignal.timeout(10000) })
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
    let live = await session(item)
    let master
    try { master = await playlist(live.url, live) }
    catch (err) {
      if (!/HTTP (401|403|410)$/.test(err.message)) throw err
      live = await session(item, undefined, true)
      master = await playlist(live.url, live)
    }
    return { url:live.url, manifestUrl:live.url, manifestText:topVariantFirst(master, { highestOnly: true }), proxyHls:true,
      upstreamHeaders:live.upstreamHeaders, upstreamUrlTransform:mediaUrl }
  } catch (err) {
    const status = err instanceof RemovedSubscription ? 404 : err instanceof Offline ? 503 : 502
    return { url:'', desc:err.message, status }
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
    const res = await fetchUpstreamResponse(url, { ...options, upstreamHeaders:headers })
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
  const live = await session(item, videoId)
  const master = await playlist(live.url, live)
  let url = renewedLink(master, live.url, raw)
  if (field(raw,'sq')) url = renewedLink(await playlist(url, live), url, raw, true)
  return request(url, live.upstreamHeaders)
}
