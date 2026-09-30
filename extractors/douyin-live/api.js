/** 抖音公开直播网页的首屏房间与播放地址。 */
import fetch from 'node-fetch'

export const DOUYIN_GROUP = '抖音'
export const CATEGORIES = Object.freeze({
  '101': '聊天', '102': '音乐', '103': '游戏', '104': '二次元',
  '105': '舞蹈', '106': '文化', '107': '生活', '108': '运动',
})
export const QUALITIES = ['FULL_HD1', 'HD1', 'SD2', 'SD1']
// 抖音网页播放器对这四档的叫法（sdk_key 依次为 uhd / hd / sd / ld）；FLV 地址表里没有原画档。
export const QUALITY_LABELS = Object.freeze({ FULL_HD1: '蓝光', HD1: '超清', SD2: '高清', SD1: '标清' })
export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36'
const PAGE_ORIGIN = 'https://live.douyin.com'
const STREAM_HOSTS = ['.douyinliving.com', '.douyincdn.com']
// 官方 FLV 入口实际会 302 到这些媒体 CDN；pipeFlv 每一跳都重新校验。
const FLV_REDIRECT_HOSTS = ['.bytefcdnrd.com', '.jomodns.com', '.ksyungslb.com', '.smtcdns.net']
const REF_RE = /^douyin-([a-zA-Z0-9_-]{1,64})$/
const RESOLVE_TTL_MS = 45_000
const FAIL_TTL_MS = 10_000
const resolveCache = new Map()
const resolvePending = new Map()

export class RoomOfflineError extends Error {}

export function normalizeRoom(value) {
  let text = String(value || '').trim()
  if (/^https?:\/\//i.test(text)) {
    let url
    try { url = new URL(text) } catch { throw new Error('抖音直播间地址无效') }
    if (url.hostname !== 'live.douyin.com') throw new Error('不是 live.douyin.com 直播间地址')
    text = url.pathname.replace(/^\/+|\/+$/g, '')
  }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(text)) throw new Error(`抖音房间号格式不正确：${text}`)
  return text
}

export function parseRoomList(text) {
  const seen = new Set()
  const rooms = []
  for (const raw of String(text || '').split('\n')) {
    const token = raw.trim().split(/\s+#|^#/)[0].trim()
    if (!token) continue
    const room = normalizeRoom(token)
    if (!seen.has(room)) { seen.add(room); rooms.push(room) }
  }
  return rooms
}

async function getPage(path, { timeoutMs = 15000, fetchImpl = fetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${PAGE_ORIGIN}${path}`, {
      signal: controller.signal,
      size: 5_000_000,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: `${PAGE_ORIGIN}/`,
      },
    })
    if (!response.ok) throw new Error(`抖音网页 HTTP ${response.status}`)
    return await response.text()
  } finally {
    clearTimeout(timer)
  }
}

export function flightData(page) {
  const values = []
  for (const match of String(page || '').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const script = match[1].trim()
    const prefix = 'self.__pace_f.push('
    if (!script.startsWith(prefix) || !script.endsWith(')')) continue
    try {
      const chunk = JSON.parse(script.slice(prefix.length, -1))?.[1]
      if (typeof chunk !== 'string' || !/^[0-9a-f]+:/i.test(chunk)) continue
      values.push(JSON.parse(chunk.slice(chunk.indexOf(':') + 1)))
    } catch { /* Other Flight chunks may be references rather than JSON. */ }
  }
  return values
}

function roomRow(item, category = '') {
  const room = item?.room
  const id = String(item?.web_rid || '')
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || !room?.stream_url) return null
  return {
    id,
    roomKey: String(room.id_str || id),
    name: String(room.owner?.nickname || id),
    title: String(room.title || ''),
    logo: String(item.avatar || room.owner?.avatar_thumb?.url_list?.[0] || ''),
    category,
    viewers: Number(room.room_view_stats?.display_value || 0),
    streams: room.stream_url,
  }
}

export function parseCategoryPage(page, category) {
  for (const data of flightData(page)) {
    const rooms = data?.[3]?.roomsData?.data
    if (!Array.isArray(rooms)) continue
    return rooms.map(item => roomRow(item, CATEGORIES[category] || '全部')).filter(Boolean)
  }
  throw new Error('分类页缺少房间列表')
}

export function parseRoomPage(page, requestedId) {
  for (const data of flightData(page)) {
    const info = data?.[3]?.state?.roomStore?.roomInfo
    const room = info?.room
    if (!room?.stream_url) continue
    if (Number(room.status) !== 2) throw new RoomOfflineError(`房间 ${requestedId} 未开播`)
    const row = roomRow({ room, web_rid: info.web_rid || requestedId }, '手动')
    if (row) return row
  }
  throw new RoomOfflineError(`房间 ${requestedId} 未开播或网页缺少播放数据`)
}

export async function fetchCategory(category, options = {}) {
  return parseCategoryPage(await getPage(`/categorynew/4_${category}`, options), category)
}

export async function fetchRoom(roomId, options = {}) {
  return parseRoomPage(await getPage(`/${encodeURIComponent(normalizeRoom(roomId))}`, options), roomId)
}

export function diversifiedOrder(rows, minViewers = 0) {
  const buckets = new Map(Object.values(CATEGORIES).map(category => [category, []]))
  for (const row of rows) {
    if (row.viewers >= minViewers) buckets.get(row.category)?.push(row)
  }
  for (const bucket of buckets.values()) bucket.sort((a, b) => b.viewers - a.viewers)
  const output = []
  const selected = new Set()
  while ([...buckets.values()].some(bucket => bucket.length)) {
    const active = [...buckets.values()].filter(bucket => bucket.length)
      .sort((a, b) => b[0].viewers - a[0].viewers)
    for (const bucket of active) {
      const row = bucket.shift()
      output.push(row)
      selected.add(row.roomKey)
    }
  }
  for (const row of [...rows].sort((a, b) => b.viewers - a.viewers)) {
    if (!selected.has(row.roomKey)) output.push(row)
  }
  return output
}

export function officialMediaUrl(value, format = 'flv', allowRedirect = false) {
  let url
  try { url = new URL(value) } catch { throw new Error('抖音播放地址无效') }
  const hostname = url.hostname.toLowerCase()
  const allowed = allowRedirect && format === 'flv' ? [...STREAM_HOSTS, ...FLV_REDIRECT_HOSTS] : STREAM_HOSTS
  if (!['http:', 'https:'].includes(url.protocol) || !allowed.some(suffix => hostname.endsWith(suffix))) {
    throw new Error('抖音播放地址域名不可信')
  }
  if (!url.pathname.endsWith(format === 'hls' ? '.m3u8' : '.flv')) throw new Error('抖音播放地址格式不正确')
  url.protocol = 'https:'
  return url.href
}

export function selectStream(streams, quality = 'HD1', format = 'flv') {
  const map = format === 'hls' ? streams?.hls_pull_url_map : streams?.flv_pull_url
  for (const tier of new Set([quality, ...QUALITIES])) {
    if (!map?.[tier]) continue
    try { return { url: officialMediaUrl(map[tier], format), quality: tier } } catch { /* Try another tier. */ }
  }
  throw new Error(`房间没有可用的 ${format.toUpperCase()} 播放地址`)
}

/** 优先 FLV 时，抖音偶尔漏发某个房间的 FLV 地址：改用 HLS 播，而不是整间房跳过。 */
export function pickStream(streams, quality = 'HD1', format = 'flv') {
  try { return { ...selectStream(streams, quality, format), format } }
  catch (error) {
    if (format !== 'flv') throw error
    try { return { ...selectStream(streams, quality, 'hls'), format: 'hls' } }
    catch { throw new Error('房间没有可用的播放地址') }
  }
}

export function claimsRef(ref) { return REF_RE.test(String(ref || '')) }

export async function resolveRoom(ref, ctx = {}) {
  try {
    const match = REF_RE.exec(String(ref || ''))
    if (!match) return { url: '', desc: '抖音直播间引用格式错误' }
    const { format = 'flv', quality = 'HD1' } = ctx.config || {}
    const now = Number(ctx.now ?? Date.now())
    const key = `${match[1]}:${format}:${quality}`
    const cached = resolveCache.get(key)
    if (cached && cached.expiresAt > now) return cached.value
    let pending = resolvePending.get(key)
    if (!pending) {
      pending = fetchRoom(match[1], ctx)
        .then(row => {
          const stream = pickStream(row.streams, quality, format)
          const fallback = stream.format !== format ? '，没有 FLV 改用 HLS' : ''
          const value = {
            url: stream.url,
            desc: `抖音房间 ${match[1]}（${QUALITY_LABELS[stream.quality]}${fallback}）地址获取成功`,
            streamType: stream.format,
            ...(stream.format === 'flv'
              ? { validateMediaUrl: url => officialMediaUrl(url, 'flv', true) }
              : { relayHls: true, upstreamHeaders: { Referer: `${PAGE_ORIGIN}/`, 'User-Agent': UA } }),
          }
          resolveCache.set(key, { value, expiresAt: now + RESOLVE_TTL_MS })
          return value
        })
        .catch(error => {
          const value = { url: '', desc: `抖音房间 ${match[1]} 地址获取失败：${error.message}` }
          resolveCache.set(key, { value, expiresAt: now + FAIL_TTL_MS })
          return value
        })
        .finally(() => { if (resolvePending.get(key) === pending) resolvePending.delete(key) })
      resolvePending.set(key, pending)
    }
    return await pending
  } catch (error) {
    return { url: '', desc: `抖音播放地址获取失败：${error.message}` }
  }
}

export function clearResolveCache() { resolveCache.clear(); resolvePending.clear() }
