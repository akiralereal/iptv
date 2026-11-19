/** 广州广播电视台「花城+」频道接口与短效播放地址缓存。 */
import fetch from 'node-fetch'

export const CHANNEL_LIST_URL = 'https://gzbn.gztv.com:7443/media-cloud-manage-app/liveChannel/queryLiveChannelList?type=1'

const STREAM_CACHE_MS = 60 * 1000
const STREAM_RETRY_MS = 15 * 1000
const STREAM_HARD_TTL_MS = 15 * 60 * 1000
const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'

const CHANNELS = [
  { code: '3001', rawName: '综合频道', name: '广州综合' },
  { code: '3002', rawName: '新闻频道', name: '广州新闻' },
  { code: '3003', rawName: '4K南国都市频道', name: '广州南国都市4K' },
]

const CHANNEL_BY_CODE = new Map(CHANNELS.map(channel => [channel.code, channel]))
let streamCache = null
let streamPending = null

function validStreamUrl(raw) {
  try {
    const url = new URL(String(raw || '').trim().replace(/^http:/i, 'https:'))
    return url.protocol === 'https:'
      && url.hostname === 'tencentplaywebsite.gztv.com'
      && /^\/live\/[A-Za-z0-9_-]+\.m3u8$/i.test(url.pathname)
      && /^[A-Fa-f0-9]+$/.test(url.searchParams.get('txSecret') || '')
      && /^[A-Fa-f0-9]+$/.test(url.searchParams.get('txTime') || '')
      ? url.href
      : ''
  } catch {
    return ''
  }
}

function normalizeLogo(raw) {
  try {
    const url = new URL(String(raw || '').trim().replace(/^http:/i, 'https:'))
    return url.protocol === 'https:' && (url.hostname === 'gztv.com' || url.hostname.endsWith('.gztv.com'))
      ? url.href
      : ''
  } catch {
    return ''
  }
}

/** 固定频道代码与名称要同时吻合，避免接口以后混入活动流或复用代码。 */
export function normalizeRows(rows) {
  const found = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const code = String(row?.code || '').trim()
    const definition = CHANNEL_BY_CODE.get(code)
    const inputName = String(row?.name || '').trim()
    if (!definition || (inputName !== definition.rawName && inputName !== definition.name) || found.has(code)) continue
    const url = validStreamUrl(row?.url) || validStreamUrl(row?.httpUrl) || validStreamUrl(row?.httpBackUrl)
    if (!url) continue
    found.set(code, {
      code,
      name: definition.name,
      url,
      logo: normalizeLogo(row?.logo || row?.pictureUrl),
    })
  }
  return CHANNELS.flatMap(definition => found.has(definition.code) ? [found.get(definition.code)] : [])
}

export function buildChannels(rows) {
  return normalizeRows(rows).map(row => ({
    name: row.name,
    deferredRef: `gztv-${row.code}`,
    catchup: 'none',
    logo: row.logo,
    opts: ['network-caching=3000'],
  }))
}

async function requestRows({ timeoutMs = 10000, fetchImpl = fetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(CHANNEL_LIST_URL, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        Origin: 'https://huacheng.gz-cmc.com',
        Referer: 'https://huacheng.gz-cmc.com/',
        'User-Agent': UA,
      },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = await response.json()
    const rows = normalizeRows(payload?.data)
    if (payload?.code !== 200 || rows.length !== CHANNELS.length) {
      throw new Error(payload?.msg || `只找到 ${rows.length}/${CHANNELS.length} 个正式频道`)
    }
    return rows
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : (error?.message || String(error))
    throw new Error(`花城+频道接口请求失败：${reason}`)
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchChannelList(options = {}) {
  return requestRows(options)
}

export function primeChannelCache(rows, now = Date.now()) {
  const normalized = normalizeRows(rows)
  if (normalized.length === CHANNELS.length) {
    streamCache = {
      rows: normalized,
      expiresAt: Number(now) + STREAM_CACHE_MS,
      hardExpiresAt: Number(now) + STREAM_HARD_TTL_MS,
      retryAt: 0,
    }
  }
}

async function cachedChannelList(options = {}) {
  const now = Number(options.now ?? Date.now())
  if (streamCache?.expiresAt > now || (streamCache?.retryAt > now && streamCache?.hardExpiresAt > now)) {
    return streamCache.rows
  }
  if (!streamPending) {
    streamPending = requestRows(options)
      .then(rows => {
        primeChannelCache(rows, now)
        return streamCache.rows
      })
      .finally(() => { streamPending = null })
  }
  try {
    return await streamPending
  } catch (error) {
    if (!streamCache || streamCache.hardExpiresAt <= now) throw error
    streamCache.retryAt = now + STREAM_RETRY_MS
    return streamCache.rows
  }
}

export async function resolveChannel(ref, ctx = {}) {
  try {
    const match = /^gztv-(300[1-3])$/.exec(String(ref || ''))
    const definition = match && CHANNEL_BY_CODE.get(match[1])
    if (!definition) return { url: '', desc: '花城+频道引用格式错误' }
    const rows = await cachedChannelList({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl, now: ctx.now })
    const row = rows.find(item => item.code === definition.code)
    if (!row) return { url: '', desc: `${definition.name}当前不在官网频道列表中` }
    return { url: row.url, desc: `${definition.name}最新播放地址获取成功` }
  } catch (error) {
    return { url: '', desc: `花城+链接请求失败：${error?.message || String(error)}` }
  }
}

export function clearCache() {
  streamCache = null
  streamPending = null
}
