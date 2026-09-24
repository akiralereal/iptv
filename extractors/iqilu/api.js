/** 山东网络台（齐鲁网）的官方频道页、AES 鉴权与播放地址缓存。 */
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto'
import fetch from 'node-fetch'

import { CHANNELS } from './channels.js'

export const AUTH_HOST = 'feiying.litenews.cn'
const CHANNEL_TTL_MS = 4 * 60 * 60 * 1000
const CHANNEL_RETRY_MS = 60 * 1000
const STREAM_REFRESH_MS = 30 * 60 * 1000
const STREAM_HARD_TTL_MS = 110 * 60 * 1000
const STREAM_RETRY_MS = 60 * 1000
const ZERO_IV = Buffer.alloc(16, 0x30)
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const CHANNEL_BY_SLUG = new Map(CHANNELS.map(channel => [channel.slug, channel]))
let channelCache = null
let channelPending = null
const streamCache = new Map()
const streamPending = new Map()

function pageUrl(slug) {
  return `https://v.iqilu.com/live/${slug}/`
}

function capture(html, name) {
  const pattern = new RegExp(`\\bvar\\s+${name}\\s*=\\s*["']([^"']+)["']`)
  return pattern.exec(String(html || ''))?.[1]?.trim() || ''
}

function validAuth(auth) {
  try {
    const endpoint = new URL(auth.endpoint)
    return endpoint.protocol === 'https:'
      && endpoint.hostname === AUTH_HOST
      && endpoint.pathname === '/api/v1/auth/exchange'
      && Buffer.byteLength(auth.signSecret, 'utf8') === 16
      && Buffer.byteLength(auth.aesKey, 'utf8') === 16
  } catch {
    return false
  }
}

/** 从官方频道页读取页面 ID 与网页播放器公开携带的鉴权参数。 */
export function parseChannelPage(html, definition) {
  const channel = definition || {}
  const id = capture(html, '_pdCid')
  const pageName = capture(html, '_pdName')
  const apiBase = capture(html, 'dF')
  const apiPath = capture(html, 'aF')
  const auth = {
    endpoint: `${apiBase}${apiPath}`,
    signSecret: capture(html, 'mxpx'),
    aesKey: capture(html, 'aly'),
  }
  if (!/^\d{1,8}$/.test(id)) throw new Error(`${channel.slug || '未知'} 页面没有有效频道 ID`)
  if (pageName !== channel.pageName) throw new Error(`${channel.slug || id} 页面频道名不符合预期`)
  if (!validAuth(auth)) throw new Error(`${channel.slug || id} 页面鉴权参数不符合预期`)
  return { ...channel, id, auth }
}

async function requestPage(definition, { timeoutMs = 10000, fetchImpl = fetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(pageUrl(definition.slug), {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return parseChannelPage(await response.text(), definition)
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : (error?.message || String(error))
    throw new Error(`山东齐鲁网 ${definition.name} 频道页请求失败：${reason}`)
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchChannelList(options = {}) {
  const rows = await Promise.all(CHANNELS.map(channel => requestPage(channel, options)))
  const ids = new Set()
  for (const row of rows) {
    if (ids.has(row.id)) throw new Error(`山东齐鲁网频道 ID 重复：${row.name}（${row.id}）`)
    ids.add(row.id)
  }
  return rows
}

export function buildChannels(rows) {
  const bySlug = new Map((Array.isArray(rows) ? rows : []).map(row => [row?.slug, row]))
  return CHANNELS.flatMap(definition => {
    const row = bySlug.get(definition.slug)
    if (!row || !/^\d{1,8}$/.test(String(row.id || '')) || !validAuth(row.auth || {})) return []
    return [{
      name: definition.name,
      deferredRef: `iqilu-${definition.slug}`,
      logo: definition.logo,
    }]
  })
}

export function primeChannelCache(rows, now = Date.now()) {
  const normalized = (Array.isArray(rows) ? rows : []).filter(row =>
    CHANNEL_BY_SLUG.has(row?.slug)
    && /^\d{1,8}$/.test(String(row?.id || ''))
    && validAuth(row?.auth || {}))
  if (normalized.length === CHANNELS.length) {
    channelCache = { rows: normalized, expiresAt: Number(now) + CHANNEL_TTL_MS, retryAt: 0 }
  }
}

async function cachedChannelList(options = {}) {
  const now = Number(options.now ?? Date.now())
  if (channelCache?.expiresAt > now) return channelCache.rows
  if (channelCache?.retryAt > now) return channelCache.rows
  if (!channelPending) {
    channelPending = fetchChannelList(options)
      .then(rows => {
        primeChannelCache(rows, now)
        return rows
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

function aesEncrypt(text, key) {
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), ZERO_IV)
  return Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]).toString('base64')
}

/** 构造官网 exchange 请求；时间戳必须是毫秒。 */
export function buildExchangeRequest(row, now = Date.now()) {
  const id = String(row?.id || '')
  const auth = row?.auth || {}
  if (!/^\d{1,8}$/.test(id) || !validAuth(auth)) throw new Error('频道鉴权参数无效')
  const timestamp = String(Math.trunc(Number(now)))
  if (!/^\d{13}$/.test(timestamp)) throw new Error('鉴权时间无效')
  const sign = createHash('md5').update(`${id}${timestamp}${auth.signSecret}`).digest('hex')
  const url = new URL(auth.endpoint)
  url.searchParams.set('t', timestamp)
  url.searchParams.set('s', sign)
  return {
    url: url.href,
    body: aesEncrypt(JSON.stringify({ channelMark: id }), auth.aesKey),
  }
}

export function decryptExchangeResponse(ciphertext, aesKey) {
  const decipher = createDecipheriv('aes-128-cbc', Buffer.from(aesKey, 'utf8'), ZERO_IV)
  const plain = Buffer.concat([
    decipher.update(String(ciphertext || '').trim(), 'base64'),
    decipher.final(),
  ]).toString('utf8')
  return JSON.parse(plain)
}

function validStreamUrl(raw) {
  try {
    const url = new URL(String(raw || '').trim())
    return url.protocol === 'https:'
      && (url.hostname === 'iqilu.com' || url.hostname.endsWith('.iqilu.com'))
      && /\.m3u8$/i.test(url.pathname)
  } catch {
    return false
  }
}

export async function fetchLiveStream(row, { timeoutMs = 10000, fetchImpl = fetch, now = Date.now() } = {}) {
  const request = buildExchangeRequest(row, now)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(request.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'User-Agent': UA,
        Origin: 'https://v.iqilu.com',
        Referer: pageUrl(row.slug),
        Accept: '*/*',
      },
      body: request.body,
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = decryptExchangeResponse(await response.text(), row.auth.aesKey)
    if (Number(payload?.code) !== 1 || !validStreamUrl(payload?.data)) {
      throw new Error(payload?.msg || payload?.message || '返回中没有可用 HLS')
    }
    return payload.data
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : (error?.message || String(error))
    throw new Error(`播放鉴权失败：${reason}`)
  } finally {
    clearTimeout(timer)
  }
}

async function cachedLiveStream(row, options = {}) {
  const now = Number(options.now ?? Date.now())
  const key = row.slug
  const cached = streamCache.get(key)
  if (cached?.refreshAt > now) return { ...cached, staleFallback: false }
  if (cached?.retryAt > now && cached?.hardExpiresAt > now) return { ...cached, staleFallback: true }

  let pending = streamPending.get(key)
  if (!pending) {
    pending = fetchLiveStream(row, options)
      .then(url => {
        const entry = {
          url,
          refreshAt: now + STREAM_REFRESH_MS,
          hardExpiresAt: now + STREAM_HARD_TTL_MS,
          retryAt: 0,
        }
        streamCache.set(key, entry)
        return entry
      })
      .finally(() => {
        if (streamPending.get(key) === pending) streamPending.delete(key)
      })
    streamPending.set(key, pending)
  }
  try {
    return { ...await pending, staleFallback: false }
  } catch (error) {
    if (!cached || cached.hardExpiresAt <= now) throw error
    cached.retryAt = now + STREAM_RETRY_MS
    return { ...cached, staleFallback: true }
  }
}

export async function resolveChannel(ref, ctx = {}) {
  try {
    const match = /^iqilu-([a-z0-9]{2,12})$/.exec(String(ref || ''))
    const definition = match && CHANNEL_BY_SLUG.get(match[1])
    if (!definition) return { url: '', desc: '山东齐鲁网频道引用格式错误' }
    const rows = await cachedChannelList({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl, now: ctx.now })
    const row = rows.find(item => item.slug === definition.slug)
    if (!row) return { url: '', desc: `${definition.name}当前不在官网频道页中` }
    const stream = await cachedLiveStream(row, {
      timeoutMs: ctx.timeoutMs,
      fetchImpl: ctx.fetchImpl,
      now: ctx.now,
    })
    return {
      url: stream.url,
      desc: stream.staleFallback
        ? `${definition.name}播放鉴权暂时失败，沿用上一份可用地址`
        : `${definition.name}播放地址获取成功`,
    }
  } catch (error) {
    return { url: '', desc: `山东齐鲁网链接请求失败：${error?.message || String(error)}` }
  }
}

export function clearCache() {
  channelCache = null
  channelPending = null
  streamCache.clear()
  streamPending.clear()
}
