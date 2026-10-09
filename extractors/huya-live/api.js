/** 虎牙直播：分类页解析、房间信息读取与 HLS 播放签名。 */
import { createHash } from 'node:crypto'
import fetch from 'node-fetch'
import { printYellow } from '../../utils/colorOut.js'

export const HUYA_GROUP = '虎牙'
export const REFERER = 'https://www.huya.com/'
export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
export const DEFAULT_MIN_HEAT = 3000

export const AREA_PAGES = Object.freeze({
  赛事: 'https://www.huya.com/m',
  网游: 'https://www.huya.com/g/100023',
  手游: 'https://www.huya.com/g/100004',
  单机: 'https://www.huya.com/g/100002',
  娱乐: 'https://www.huya.com/g/100022',
})

const RESOLVE_TTL_MS = 60 * 1000          // 房间页与签名地址复用时长
const LINE_REJECT_MS = 5 * 60 * 1000      // 被 CDN 拒绝的线路冷却时长
const ROOM_RETRY_MS = 10 * 1000           // 所有线路都被拒后，多久再去试一轮；连续失败逐次翻倍
const ROOM_RETRY_MAX_MS = 2 * 60 * 1000
const MANIFEST_TIMEOUT_MS = 8000
const roomCache = new Map()      // room:quality -> { expiresAt, name, presenterUid, bitrate, lines, signed }
const roomPending = new Map()
const rejectedLines = new Map()  // room -> Map<cdn, until>
const preferredLine = new Map()  // room -> 上次能播的线路
const roomFailUntil = new Map()  // room -> { until, desc, streak }

export class HuyaError extends Error {
  constructor(message) {
    super(message)
    this.name = 'HuyaError'
  }
}

export class HuyaOfflineError extends HuyaError {
  constructor(message) {
    super(message)
    this.name = 'HuyaOfflineError'
  }
}

function md5(text) {
  return createHash('md5').update(String(text)).digest('hex')
}

function decodeHtml(text) {
  return String(text || '')
    .replace(/<!--.*?-->/gs, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeImage(raw) {
  const value = decodeHtml(raw).trim()
  if (value.startsWith('//')) return `https:${value}`
  return value.replace(/^http:\/\//i, 'https://')
}

function attributeOf(tag, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(tag)
  return match ? decodeHtml(match[2]) : ''
}

function openingTagWithClass(html, tagName, className) {
  const re = new RegExp(`<${tagName}\\b[^>]*>`, 'gi')
  for (const match of html.matchAll(re)) {
    const classes = attributeOf(match[0], 'class').split(/\s+/)
    if (classes.includes(className)) return match[0]
  }
  return ''
}

/** 从 JS 赋值中取出完整 JSON；字符串里的括号不会提前结束扫描。 */
export function extractAssignedJson(source, marker, fromIndex = 0) {
  const markerIndex = source.indexOf(marker, fromIndex)
  if (markerIndex < 0) throw new HuyaError(`页面缺少 ${marker}`)
  const start = source.slice(markerIndex + marker.length).search(/[\[{]/)
  if (start < 0) throw new HuyaError(`${marker} 后没有 JSON`)
  const absoluteStart = markerIndex + marker.length + start
  const stack = []
  let quote = ''
  let escaped = false
  for (let i = absoluteStart; i < source.length; i++) {
    const ch = source[i]
    if (quote) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '[' || ch === '{') stack.push(ch)
    if (ch === ']' || ch === '}') {
      const expected = ch === ']' ? '[' : '{'
      if (stack.pop() !== expected) throw new HuyaError(`${marker} JSON 括号不匹配`)
    }
    if (stack.length === 0) {
      try {
        return JSON.parse(source.slice(absoluteStart, i + 1))
      } catch (error) {
        throw new HuyaError(`${marker} JSON 解析失败：${error.message}`)
      }
    }
  }
  throw new HuyaError(`${marker} JSON 不完整`)
}

export function normalizeRoom(raw) {
  let value = String(raw || '').normalize('NFKC').trim()
  if (!value) throw new HuyaError('虎牙房间号为空')
  if (/^https?:\/\//i.test(value)) {
    let url
    try { url = new URL(value) } catch { throw new HuyaError(`不是有效的虎牙直播间地址：${value}`) }
    const host = url.hostname.toLowerCase()
    if (host !== 'huya.com' && !host.endsWith('.huya.com')) {
      throw new HuyaError(`不是虎牙直播间地址：${value}`)
    }
    value = url.pathname.split('/').filter(Boolean)[0] || ''
  }
  if (!/^[a-z0-9_-]{1,64}$/i.test(value) || /^(?:g|m)$/i.test(value)) {
    throw new HuyaError(`虎牙房间号格式不正确：${value || raw}`)
  }
  return value
}

export function parseRoomList(text) {
  const seen = new Set()
  const rooms = []
  for (const line of String(text || '').split('\n')) {
    const value = line.trim()
    if (!value || value.startsWith('#')) continue
    const room = normalizeRoom(value)
    if (!seen.has(room)) {
      seen.add(room)
      rooms.push(room)
    }
  }
  return rooms
}

export function parseHeat(raw) {
  const text = decodeHtml(raw).replace(/,/g, '')
  const match = /([\d.]+)\s*(亿|万)?/.exec(text)
  if (!match) return 0
  const multiplier = match[2] === '亿' ? 100000000 : match[2] === '万' ? 10000 : 1
  return Math.round(Number(match[1]) * multiplier) || 0
}

/** 赛事页没有 ALL_LIST_DATA，直播卡片是服务端渲染的，直接从卡片读取。 */
export function parseEventRooms(html) {
  const rooms = []
  const seen = new Set()
  const re = /<li\b[^>]*class=(["'])[^"']*\bmatch-live-item\b[^"']*\1[^>]*>([\s\S]*?)<\/li>/gi
  for (const match of html.matchAll(re)) {
    const body = match[2]
    const videoTag = openingTagWithClass(body, 'a', 'video-info')
    const titleTag = openingTagWithClass(body, 'a', 'title')
    const imageTag = openingTagWithClass(body, 'img', 'pic')
    const roomMatch = /^https?:\/\/(?:www\.)?huya\.com\/([a-z0-9_-]{1,64})(?:[/?#]|$)/i.exec(attributeOf(videoTag, 'href'))
    if (!roomMatch || seen.has(roomMatch[1])) continue
    const heatMatch = /<i\b[^>]*class=(["'])[^"']*\bjs-num\b[^"']*\1[^>]*>([\s\S]*?)<\/i>/i.exec(body)
    const nickTag = openingTagWithClass(body, 'i', 'nick')
    seen.add(roomMatch[1])
    rooms.push({
      roomId: roomMatch[1],
      name: attributeOf(titleTag, 'title') || attributeOf(imageTag, 'alt') || `虎牙 ${roomMatch[1]}`,
      nick: attributeOf(nickTag, 'title'),
      logo: normalizeImage(attributeOf(imageTag, 'data-original') || attributeOf(imageTag, 'src')),
      heat: parseHeat(heatMatch?.[2]),
    })
  }
  return rooms
}

/** 网游/手游/单机/娱乐页把当前直播间放在 ALL_LIST_DATA。 */
export function parseCategoryRooms(html) {
  const rows = extractAssignedJson(html, 'var ALL_LIST_DATA')
  if (!Array.isArray(rows)) throw new HuyaError('虎牙分类页直播列表结构异常')
  const seen = new Set()
  const rooms = []
  for (const row of rows) {
    const rawRoom = row?.lProfileRoom || row?.sPrivateHost || row?.lUid
    let roomId
    try { roomId = normalizeRoom(rawRoom) } catch { continue }
    if (seen.has(roomId)) continue
    seen.add(roomId)
    rooms.push({
      roomId,
      name: decodeHtml(row?.sIntroduction || row?.sRoomName || row?.sNick) || `虎牙 ${roomId}`,
      nick: decodeHtml(row?.sNick),
      logo: normalizeImage(row?.sScreenshot || row?.sAvatar180),
      heat: Number(row?.lTotalCount || row?.lUserCount || row?.lActivityCount || 0) || 0,
      game: decodeHtml(row?.sGameFullName),
    })
  }
  return rooms
}

function selectTopRooms(rooms, limit, minHeat) {
  return [...rooms]
    .filter(room => Number(room.heat || 0) >= Number(minHeat || 0))
    .sort((a, b) => Number(b.heat || 0) - Number(a.heat || 0))
    .slice(0, Math.max(0, Number(limit) || 0))
}

async function fetchText(url, { timeoutMs = 10000, fetchImpl = fetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': UA, Referer: REFERER, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: controller.signal,
    })
    if (!response.ok) throw new HuyaError(`HTTP ${response.status}`)
    return await response.text()
  } catch (error) {
    if (error instanceof HuyaError) throw error
    const reason = error?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : (error?.message || String(error))
    throw new HuyaError(reason)
  } finally {
    clearTimeout(timer)
  }
}

export async function topRoomsOfArea(areaName, limit, options = {}) {
  const url = AREA_PAGES[areaName]
  if (!url) throw new HuyaError(`未知分类「${areaName}」`)
  const html = await fetchText(url, options)
  const rooms = areaName === '赛事' ? parseEventRooms(html) : parseCategoryRooms(html)
  return selectTopRooms(rooms, limit, options.minHeat)
}

/** 只截取 hyPlayerConfig.stream；外层是 JS 对象，不是严格 JSON。 */
export function parseRoomPage(html, requestedRoom = '') {
  const configAt = html.indexOf('var hyPlayerConfig')
  if (configAt < 0) throw new HuyaError('虎牙房间页缺少播放器配置')
  const streamMarker = /\bstream\s*:/.exec(html.slice(configAt))
  if (!streamMarker) throw new HuyaError('虎牙房间页缺少直播流配置')
  const markerAt = configAt + streamMarker.index
  const stream = extractAssignedJson(html, streamMarker[0], markerAt)
  const rows = Array.isArray(stream?.data) ? stream.data : []
  const row = rows.find(item => Array.isArray(item?.gameStreamInfoList) && item.gameStreamInfoList.length)
  if (!row) throw new HuyaOfflineError(`虎牙房间 ${requestedRoom || ''} 当前未开播`.trim())
  const info = row.gameLiveInfo || {}
  const roomId = normalizeRoom(info.profileRoom || requestedRoom || info.uid)
  return {
    roomId,
    name: decodeHtml(info.introduction || info.roomName || info.nick) || `虎牙 ${roomId}`,
    nick: decodeHtml(info.nick),
    logo: normalizeImage(info.screenshot || info.avatar180),
    heat: Number(info.totalCount || info.activityCount || 0) || 0,
    presenterUid: String(info.uid || ''),
    streams: row.gameStreamInfoList,
    bitrates: Array.isArray(stream?.vMultiStreamInfo) ? stream.vMultiStreamInfo : [],
  }
}

export async function fetchRoom(roomRef, options = {}) {
  const room = normalizeRoom(roomRef)
  const html = await fetchText(`https://www.huya.com/${encodeURIComponent(room)}`, options)
  return parseRoomPage(html, room)
}

export function selectBitrate(rows, requested = 2000) {
  const wanted = Math.max(0, Number(requested) || 0)
  if (wanted === 0) return 0
  const rates = [...new Set((Array.isArray(rows) ? rows : [])
    .map(row => Number(row?.iBitRate))
    .filter(rate => Number.isFinite(rate) && rate > 0))]
    .sort((a, b) => b - a)
  if (!rates.length) return wanted
  return rates.find(rate => rate <= wanted) || rates[rates.length - 1]
}

/**
 * 官网 H5 播放器当前的匿名 Web 签名。
 * fm 解码后是一个带 $0..$3 占位符的模板；$2 是 seqid/ctype/platform 的 MD5。
 */
export function signHlsUrl(streamInfo, presenterUid, bitrate = 2000, now = Date.now()) {
  const streamName = String(streamInfo?.sStreamName || '').trim()
  const base = String(streamInfo?.sHlsUrl || '').trim()
  const suffix = String(streamInfo?.sHlsUrlSuffix || 'm3u8').replace(/^\./, '')
  const antiCode = String(streamInfo?.sHlsAntiCode || '')
  if (!streamName || !/^https?:\/\//i.test(base) || !antiCode) {
    throw new HuyaError('虎牙房间没有可用的 HLS 流')
  }
  const baseUrl = new URL(base)
  if (baseUrl.hostname !== 'huya.com' && !baseUrl.hostname.endsWith('.huya.com')) {
    throw new HuyaError('虎牙 HLS 地址不属于官方域名')
  }

  const old = new URLSearchParams(antiCode)
  const wsTime = old.get('wsTime') || ''
  const ctype = old.get('ctype') || 'huya_webh5'
  const fm = old.get('fm') || ''
  if (!/^[0-9a-f]+$/i.test(wsTime) || !fm) throw new HuyaError('虎牙 HLS 签名参数不完整')

  let template
  try { template = Buffer.from(fm.replace(/ /g, '+'), 'base64').toString('utf8') } catch { /* below */ }
  if (!template) throw new HuyaError('虎牙 HLS 签名模板解码失败')

  const seqid = String(Math.trunc(Number(now)))
  const platform = '100'
  const secret = md5(template
    .replaceAll('$0', String(presenterUid || '0'))
    .replaceAll('$1', streamName)
    .replaceAll('$2', md5(`${seqid}|${ctype}|${platform}`))
    .replaceAll('$3', wsTime))

  const params = new URLSearchParams()
  params.set('wsSecret', secret)
  params.set('wsTime', wsTime)
  params.set('seqid', seqid)
  params.set('ctype', ctype)
  params.set('ver', '1')
  const replaced = new Set(['wsSecret', 'wsTime', 'fm', 'seqid', 'ctype', 'ver', 'ratio', 'u', 't'])
  for (const [key, value] of old) if (!replaced.has(key)) params.append(key, value)
  if (Number(bitrate) > 0) params.set('ratio', String(Math.trunc(Number(bitrate))))
  params.set('u', String(presenterUid || '0'))
  params.set('t', platform)

  const url = new URL(`${base.replace(/\/$/, '')}/${streamName}.${suffix}`)
  if (url.protocol === 'http:') url.protocol = 'https:'
  url.search = params.toString()
  return url.href
}

async function fetchManifest(url, { timeoutMs = MANIFEST_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': UA, Referer: REFERER, Accept: 'application/vnd.apple.mpegurl,*/*' },
      redirect: 'follow',
      signal: controller.signal,
    })
    const text = await response.text()
    return { status: response.status, text, finalUrl: response.url || url }
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : (error?.message || String(error))
    throw new HuyaError(reason)
  } finally {
    clearTimeout(timer)
  }
}

/** 只看分片的响应状态，正文不读完：TX 线路有过「清单 200、分片 403」。 */
async function probeSegment(url, { timeoutMs = MANIFEST_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': UA, Referer: REFERER },
      redirect: 'follow',
      signal: controller.signal,
    })
    const status = response.status
    try { await (response.body?.cancel?.() ?? response.body?.destroy?.()) } catch { /* 丢弃正文即可 */ }
    return status
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : (error?.message || String(error))
    throw new HuyaError(reason)
  } finally {
    clearTimeout(timer)
  }
}

export function lastSegmentUrl(manifest, base) {
  const lines = String(manifest || '').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'))
  if (!lines.length) return ''
  try { return new URL(lines[lines.length - 1], base).href } catch { return '' }
}

async function loadRoom(room, quality, ctx) {
  const now = Number(ctx.now ?? Date.now())
  const key = `${room}:${quality}`
  const cached = roomCache.get(key)
  if (cached && cached.expiresAt > now) return cached

  let pending = roomPending.get(key)
  if (!pending) {
    pending = (async () => {
      const data = await fetchRoom(room, { timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl })
      const bitrate = selectBitrate(data.bitrates, quality)
      const lines = data.streams
        .filter(item => item?.sHlsUrl && item?.sHlsAntiCode)
        .map((stream, index) => ({ cdn: String(stream.sCdnType || `line${index + 1}`), stream }))
      if (!lines.length) throw new HuyaError(`虎牙房间 ${room} 当前没有 HLS 流`)
      const entry = { expiresAt: now + RESOLVE_TTL_MS, name: data.name, presenterUid: data.presenterUid, bitrate, lines, signed: new Map() }
      roomCache.set(key, entry)
      return entry
    })().finally(() => {
      if (roomPending.get(key) === pending) roomPending.delete(key)
    })
    roomPending.set(key, pending)
  }
  return pending
}

function signedLineUrl(entry, line, now) {
  let url = entry.signed.get(line.cdn)
  if (!url) {
    url = signHlsUrl(line.stream, entry.presenterUid, entry.bitrate, now)
    entry.signed.set(line.cdn, url)
  }
  return url
}

function rejectLine(room, cdn, now) {
  let map = rejectedLines.get(room)
  if (!map) {
    map = new Map()
    rejectedLines.set(room, map)
  }
  map.set(cdn, now + LINE_REJECT_MS)
}

/**
 * 候选线路顺序：上次能播的线路优先，其余按房间页顺序；冷却中的线路跳过。
 * 全部都在冷却时退回全部线路——总要试一条，万一 CDN 已经恢复。
 */
export function orderLines(lines, preferred, rejected, now) {
  const ordered = [...lines].sort((a, b) => (a.cdn === preferred ? -1 : 0) - (b.cdn === preferred ? -1 : 0))
  const available = ordered.filter(line => !(rejected?.get(line.cdn) > now))
  return available.length ? available : ordered
}

/**
 * 实测（2026-10-09）：房间页首选的 AL 线路播两三分钟后会对同一出口整条 403，之后续签照样被拒，
 * 而同一房间页里的其它线路从同一出口仍然能播；TX 线路还出现过「清单 200、分片 403」。
 * 所以每次播放请求都由这里取回清单：清单被拒就立刻换下一条线路并把被拒线路冷却 5 分钟，
 * 新换上的线路先探一片分片再交给播放器；清单直接随结果交回，本机中继不必再取一次。
 */
async function resolveFresh(room, ctx) {
  const now = Number(ctx.now ?? Date.now())
  const quality = Number(ctx.config?.quality ?? 2000)
  // 整个房间刚被判定全线不可用：短时间内直接回同一结论，别替播放器的连环重试去打上游
  const failed = roomFailUntil.get(room)
  if (failed && failed.until > now) throw new HuyaError(failed.desc)
  const entry = await loadRoom(room, quality, ctx)
  const options = { timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl }
  const preferred = preferredLine.get(room)
  const candidates = orderLines(entry.lines, preferred, rejectedLines.get(room), now)
  const failures = []
  for (const line of candidates) {
    const url = signedLineUrl(entry, line, now)
    let reason = ''
    try {
      const manifest = await fetchManifest(url, options)
      if (manifest.status !== 200) reason = `清单 HTTP ${manifest.status}`
      else if (!manifest.text.trimStart().startsWith('#EXTM3U')) reason = '清单不是 HLS'
      else {
        if (line.cdn !== preferred) {
          const segment = lastSegmentUrl(manifest.text, manifest.finalUrl)
          const status = segment ? await probeSegment(segment, options) : 200
          if (status !== 200) reason = `分片 HTTP ${status}`
        }
        if (!reason) {
          roomFailUntil.delete(room)
          if (line.cdn !== preferred) {
            preferredLine.set(room, line.cdn)
            if (failures.length) printYellow(`虎牙「${entry.name}」${failures.join('、')}，已切换到 ${line.cdn} 线路`)
          }
          return {
            url,
            desc: `虎牙「${entry.name}」${entry.bitrate ? `${entry.bitrate}K` : '原画'}地址获取成功（${line.cdn} 线路）`,
            relayHls: true,
            manifestText: manifest.text,
            manifestUrl: manifest.finalUrl,
            upstreamHeaders: { Referer: REFERER, 'User-Agent': UA },
          }
        }
      }
    } catch (error) {
      reason = error?.message || String(error)
    }
    failures.push(`${line.cdn} 线路${reason}`)
    rejectLine(room, line.cdn, now)
    entry.signed.delete(line.cdn)
    if (line.cdn === preferred) preferredLine.delete(room)
  }
  // 有的线路「首次取清单放行、再取就拒」，会让房间在换线成功与全线失败之间来回抖：
  // 连续全线失败时把重试间隔逐次翻倍，别拿播放器的轮询节奏去打上游、也别刷屏
  const desc = `虎牙「${entry.name}」所有线路都不可用：${failures.join('、')}`
  const streak = (roomFailUntil.get(room)?.streak || 0) + 1
  const delay = Math.min(ROOM_RETRY_MS * 2 ** (streak - 1), ROOM_RETRY_MAX_MS)
  roomFailUntil.set(room, { until: now + delay, desc, streak })
  printYellow(`${desc}，${Math.round(delay / 1000)} 秒后再试`)
  throw new HuyaError(desc)
}

export async function resolveRoom(ref, ctx = {}) {
  try {
    const match = /^huya-([a-z0-9_-]{1,64})$/i.exec(String(ref || ''))
    if (!match) return { url: '', desc: '虎牙房间引用格式错误' }
    const room = normalizeRoom(match[1])
    return await resolveFresh(room, ctx)
  } catch (error) {
    return { url: '', desc: error?.message || '虎牙播放地址获取失败' }
  }
}

export function clearResolveCache() {
  roomCache.clear()
  roomPending.clear()
  rejectedLines.clear()
  preferredLine.clear()
  roomFailUntil.clear()
}
