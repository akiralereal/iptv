/** 海南网络广播电视台的频道列表、播放签名接口与短效地址缓存。 */
import fetch from 'node-fetch'
import { CHANNELS } from './channels.js'

export const CHANNEL_LIST_URL = 'https://www.hnntv.cn/api/channel?type=1'
export const LIVE_PLAY_URL = 'https://ps.hnntv.cn/ps/livePlayUrl'

const CHANNEL_REFRESH_MS = 4 * 60 * 60 * 1000
const CHANNEL_RETRY_MS = 60 * 1000
const STREAM_REFRESH_MS = 90 * 60 * 1000
const STREAM_RETRY_MS = 60 * 1000
const EXPIRY_SKEW_MS = 5 * 60 * 1000
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const CHANNEL_BY_ID = new Map(CHANNELS.map(channel => [channel.id, channel]))
let channelCache = null
let channelPending = null
const streamCache = new Map()
const streamPending = new Map()

function requestHeaders() {
  return {
    'User-Agent': UA,
    Origin: 'https://www.hnntv.cn',
    Referer: 'https://www.hnntv.cn/',
    Accept: 'application/json, text/plain, */*',
  }
}

function officialStreamUrl(raw) {
  try {
    const url = new URL(String(raw || '').trim())
    return url.protocol === 'https:'
      && (url.hostname === 'hnntv.cn' || url.hostname.endsWith('.hnntv.cn'))
      && /\.m3u8$/i.test(url.pathname)
      ? url.href
      : ''
  } catch {
    return ''
  }
}

/** 只接受官网当前七套电视；返回顺序不依赖接口顺序。 */
export function normalizeRows(rows) {
  const found = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row?.id ?? '').trim()
    const definition = CHANNEL_BY_ID.get(id)
    if (!definition || found.has(id)) continue
    if (Number(row?.type) !== 1) continue
    if (String(row?.name || '').trim() !== definition.rawName) continue
    if (String(row?.code || '').trim() !== definition.code) continue
    const liveUrl = officialStreamUrl(row?.liveUrl)
    if (!liveUrl) continue
    // 保留 type 让 normalizeRows 对自身输出幂等；fetchChannelList 的结果还会被
    // primeChannelCache / buildChannels 再归一一次。
    found.set(id, { id, name: definition.name, code: definition.code, type: 1, liveUrl })
  }
  return CHANNELS.flatMap(definition => found.has(definition.id) ? [found.get(definition.id)] : [])
}

export function buildChannels(rows) {
  return normalizeRows(rows).map(row => ({
    name: row.name,
    deferredRef: `hnntv-${row.id}`,
    logo: CHANNEL_BY_ID.get(row.id).logo,
  }))
}

async function requestChannelList({ timeoutMs = 10000, fetchImpl = fetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(CHANNEL_LIST_URL, {
      headers: requestHeaders(),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = await response.json()
    if (String(payload?.businessCode) !== '00000' || !Array.isArray(payload?.resultSet)) {
      throw new Error(payload?.description || '返回结构不符合预期')
    }
    const rows = normalizeRows(payload.resultSet)
    if (rows.length !== CHANNELS.length) {
      throw new Error(`只找到 ${rows.length}/${CHANNELS.length} 套正式电视频道`)
    }
    return rows
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : (error?.message || String(error))
    throw new Error(`海南网台频道接口请求失败：${reason}`)
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchChannelList(options = {}) {
  return requestChannelList(options)
}

export function primeChannelCache(rows, now = Date.now()) {
  const normalized = normalizeRows(rows)
  if (normalized.length !== CHANNELS.length) return
  channelCache = {
    rows: normalized,
    refreshAt: Number(now) + CHANNEL_REFRESH_MS,
    retryAt: 0,
  }
}

async function cachedChannelList(options = {}) {
  const now = Number(options.now ?? Date.now())
  if (channelCache?.refreshAt > now || channelCache?.retryAt > now) return channelCache.rows
  if (!channelPending) {
    channelPending = requestChannelList(options)
      .then(rows => {
        primeChannelCache(rows, now)
        return channelCache.rows
      })
      .finally(() => { channelPending = null })
  }
  try {
    return await channelPending
  } catch (error) {
    if (!channelCache) throw error
    channelCache.retryAt = now + CHANNEL_RETRY_MS
    return channelCache.rows
  }
}

/** `_upt` 末十位是秒级到期时间；签名地址必须与频道表里的官方裸地址同源同路径。 */
function signedStream(raw, row, now) {
  try {
    const url = new URL(String(raw || '').trim())
    const base = new URL(row.liveUrl)
    if (url.protocol !== base.protocol || url.host !== base.host || url.pathname !== base.pathname) return null
    const token = url.searchParams.get('_upt') || ''
    const match = /^[0-9a-f]{8}(\d{10})$/i.exec(token)
    const expiresAt = Number(match?.[1] || 0) * 1000
    if (!match || expiresAt <= Number(now) + EXPIRY_SKEW_MS) return null
    return { url: url.href, expiresAt }
  } catch {
    return null
  }
}

export async function fetchLiveStream(row, { timeoutMs = 10000, fetchImpl = fetch, now = Date.now() } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const url = new URL(LIVE_PLAY_URL)
  url.searchParams.set('channelCode', row.code)
  url.searchParams.set('appCode', '')
  url.searchParams.set('token', '')
  try {
    const response = await fetchImpl(url.href, {
      headers: requestHeaders(),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = await response.json()
    const stream = Number(payload?.businessCode) === 200
      ? signedStream(payload?.resultSet?.[0]?.url, row, now)
      : null
    if (!stream) throw new Error(payload?.description || '返回中没有可用的短效 HLS')
    return stream
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : (error?.message || String(error))
    throw new Error(`${row.name}播放签名请求失败：${reason}`)
  } finally {
    clearTimeout(timer)
  }
}

async function cachedLiveStream(row, options = {}) {
  const now = Number(options.now ?? Date.now())
  const cached = streamCache.get(row.id)
  if (cached?.refreshAt > now && cached?.validUntil > now) return { ...cached, staleFallback: false }
  if (cached?.retryAt > now && cached?.validUntil > now) return { ...cached, staleFallback: true }

  let pending = streamPending.get(row.id)
  if (!pending) {
    pending = fetchLiveStream(row, options)
      .then(stream => {
        const validUntil = stream.expiresAt - EXPIRY_SKEW_MS
        const entry = {
          url: stream.url,
          refreshAt: Math.min(now + STREAM_REFRESH_MS, validUntil),
          validUntil,
          retryAt: 0,
        }
        streamCache.set(row.id, entry)
        return entry
      })
      .finally(() => {
        if (streamPending.get(row.id) === pending) streamPending.delete(row.id)
      })
    streamPending.set(row.id, pending)
  }
  try {
    return { ...await pending, staleFallback: false }
  } catch (error) {
    if (!cached || cached.validUntil <= now) throw error
    cached.retryAt = now + STREAM_RETRY_MS
    return { ...cached, staleFallback: true }
  }
}

export async function resolveChannel(ref, ctx = {}) {
  try {
    const match = /^hnntv-(\d{1,3})$/.exec(String(ref || ''))
    const definition = match && CHANNEL_BY_ID.get(match[1])
    if (!definition) return { url: '', desc: '海南网台频道引用格式错误' }
    const rows = await cachedChannelList({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl, now: ctx.now })
    const row = rows.find(item => item.id === definition.id)
    if (!row) return { url: '', desc: `${definition.name}当前不在官网频道列表中` }
    const stream = await cachedLiveStream(row, {
      timeoutMs: ctx.timeoutMs,
      fetchImpl: ctx.fetchImpl,
      now: ctx.now,
    })
    return {
      url: stream.url,
      desc: stream.staleFallback
        ? `${definition.name}播放签名暂时失败，沿用上一份可用地址`
        : `${definition.name}播放地址获取成功`,
    }
  } catch (error) {
    return { url: '', desc: `海南网台链接请求失败：${error?.message || String(error)}` }
  }
}

export function clearCache() {
  channelCache = null
  channelPending = null
  streamCache.clear()
  streamPending.clear()
}
