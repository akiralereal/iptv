/** 河南广播电视台（大象新闻）的频道接口与地址缓存；请求签名见 sign.js。 */
import fetch from 'node-fetch'
import { CHANNELS } from './channels.js'
import { buildSignedHeaders } from './sign.js'

export { buildSignedHeaders }

export const CHANNEL_LIST_URL = 'https://pubmod.hntv.tv/program/getAuth/live/class/program/11/'

const CHANNEL_REFRESH_MS = 2 * 60 * 60 * 1000
const CHANNEL_RETRY_MS = 60 * 1000
const EXPIRY_SKEW_MS = 5 * 60 * 1000
const FALLBACK_STREAM_TTL_MS = 3 * 60 * 60 * 1000
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
// 频道接口的 image 是 /anonymous/… 相对路径（logo 字段一直为空）。官网 www.hntv.tv 页面里
// 同一图床的 /anonymous/ 图片都拼这个域名；拼 static.hntv.tv 全是 404。2026-09-25 核对：
// 13 套频道图标都能取到，大陆 10 个探针全部 200。
const LOGO_BASE = 'https://cmsres.dianzhenkeji.com'

const CHANNEL_BY_ID = new Map(CHANNELS.map(channel => [channel.id, channel]))
let channelCache = null
let channelPending = null

function validStreamUrl(raw) {
  try {
    const url = new URL(String(raw || '').trim().replace(/^http:/i, 'https:'))
    const officialHost = url.hostname === 'hndt.com'
      || url.hostname.endsWith('.hndt.com')
      || url.hostname === 'hntv.tv'
      || url.hostname.endsWith('.hntv.tv')
    return url.protocol === 'https:' && officialHost && /\.m3u8$/i.test(url.pathname)
      ? url.href
      : ''
  } catch {
    return ''
  }
}

function normalizeLogo(raw) {
  const text = String(raw || '').trim()
  if (!text) return ''
  try {
    const url = new URL(text, LOGO_BASE)
    return /^https?:$/.test(url.protocol) ? url.href : ''
  } catch {
    return ''
  }
}

/** 只接受白名单 ID 与名称都一致的行，防止后台复用 ID 时把频道静默换掉。 */
export function normalizeRows(rows) {
  const found = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row?.cid ?? row?.id ?? '').trim()
    const definition = CHANNEL_BY_ID.get(id)
    const inputName = String(row?.name || '').trim()
    const nameMatches = inputName === definition?.rawName || inputName === definition?.name
    if (!definition || !nameMatches || found.has(id)) continue
    const url = validStreamUrl(row?.url || row?.video_streams?.[0])
    if (!url) continue
    found.set(id, {
      id,
      name: definition.name,
      url,
      logo: normalizeLogo(row?.image || row?.logo),
    })
  }
  return CHANNELS.flatMap(definition => found.has(definition.id) ? [found.get(definition.id)] : [])
}

export function buildChannels(rows) {
  return normalizeRows(rows).map(row => ({
    name: row.name,
    deferredRef: `hntv-${row.id}`,
    logo: row.logo,
  }))
}

async function requestRows({ timeoutMs = 10000, fetchImpl = fetch, now = Date.now() } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(CHANNEL_LIST_URL, {
      headers: {
        ...buildSignedHeaders(now),
        'User-Agent': UA,
        Origin: 'https://static.hntv.tv',
        Referer: 'https://static.hntv.tv/kds/',
        Accept: 'application/json, text/plain, */*',
      },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = await response.json()
    if (!Array.isArray(payload)) {
      throw new Error(payload?.msg || payload?.message || '返回结构不符合预期')
    }
    const rows = normalizeRows(payload)
    if (!rows.length) throw new Error('没有可用的正式频道')
    return rows
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : (error?.message || String(error))
    throw new Error(`大象新闻频道接口请求失败：${reason}`)
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchChannelList(options = {}) {
  return requestRows(options)
}

function streamHardExpiry(rows, now) {
  const expiries = []
  for (const row of rows) {
    try {
      const url = new URL(row.url)
      const seconds = Number(url.searchParams.get('wsTime') || url.searchParams.get('tokenendtime'))
      if (Number.isFinite(seconds) && seconds * 1000 > now) expiries.push(seconds * 1000)
    } catch { /* 用保守默认值 */ }
  }
  const earliest = expiries.length ? Math.min(...expiries) : now + FALLBACK_STREAM_TTL_MS
  return Math.max(now + 60 * 1000, earliest - EXPIRY_SKEW_MS)
}

export function primeChannelCache(rows, now = Date.now()) {
  const normalized = normalizeRows(rows)
  if (!normalized.length) return
  const timestamp = Number(now)
  channelCache = {
    rows: normalized,
    refreshAt: timestamp + CHANNEL_REFRESH_MS,
    hardExpiresAt: streamHardExpiry(normalized, timestamp),
    retryAt: 0,
  }
}

async function cachedChannelList(options = {}) {
  const now = Number(options.now ?? Date.now())
  if (channelCache?.refreshAt > now && channelCache?.hardExpiresAt > now) return channelCache.rows
  if (channelCache?.retryAt > now && channelCache?.hardExpiresAt > now) return channelCache.rows
  if (!channelPending) {
    channelPending = requestRows(options)
      .then(rows => {
        primeChannelCache(rows, now)
        return channelCache.rows
      })
      .finally(() => { channelPending = null })
  }
  try {
    return await channelPending
  } catch (error) {
    if (!channelCache || channelCache.hardExpiresAt <= now) throw error
    channelCache.retryAt = now + CHANNEL_RETRY_MS
    return channelCache.rows
  }
}

export async function resolveChannel(ref, ctx = {}) {
  try {
    const match = /^hntv-(\d{1,4})$/.exec(String(ref || ''))
    const definition = match && CHANNEL_BY_ID.get(match[1])
    if (!definition) return { url: '', desc: '大象新闻频道引用格式错误' }
    const rows = await cachedChannelList({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl, now: ctx.now })
    const row = rows.find(item => item.id === definition.id)
    if (!row) return { url: '', desc: `${definition.name}当前不在官网频道列表中` }
    return { url: row.url, desc: `${definition.name}播放地址获取成功` }
  } catch (error) {
    return { url: '', desc: `大象新闻链接请求失败：${error?.message || String(error)}` }
  }
}

export function clearCache() {
  channelCache = null
  channelPending = null
}
