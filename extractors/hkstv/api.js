/** 香港卫视官网：单路公开电视直播，播放时动态取当前入口与滚动 HLS 清单。 */
import { proxyAwareFetch } from '../../utils/systemProxy.js'
import { CHANNEL } from './channels.js'

export const HKSTV_PAGE = 'https://hkstv.tv/live'
export const HKSTV_CHANNEL_API = 'https://hkstv.tv/services/live/default'
export const HKSTV_PLAYER_API = 'https://hkstv.tv/lives/api/player'

const SITE_HOST = 'hkstv.tv'
const MEDIA_HOST = 'webcast.hkstv.tv'
// 入口无签名、只随官网换台变化，十分钟够新鲜；接口抖动时退避重试并沿用上次成功入口
export const ENTRY_TTL_MS = 10 * 60 * 1000
export const ENTRY_RETRY_MS = 10 * 1000
export const ENTRY_HARD_TTL_MS = 24 * 60 * 60 * 1000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const SOURCE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export { CHANNEL }

function safeUrl(raw, label) {
  try {
    return new URL(String(raw || '').trim())
  } catch {
    throw new Error(`香港卫视返回了无效${label}地址`)
  }
}

/** 媒体白名单：清单、子清单与分片都必须落在官方直播目录下。 */
export function officialAssetUrl(raw) {
  const url = safeUrl(raw, '媒体')
  if (url.protocol !== 'https:' || url.username || url.password || !['', '443'].includes(url.port)
      || url.hostname !== MEDIA_HOST || !url.pathname.startsWith('/livestream/')
      || /%2f|%5c/i.test(url.pathname) || url.hash) {
    throw new Error('香港卫视返回了非官方媒体地址')
  }
  return url.href
}

/** 入口必须是某路直播的 playlist.m3u8；子清单带 hls_ctx 查询串，同样在此校验。 */
export function officialHlsUrl(raw) {
  const url = new URL(officialAssetUrl(raw))
  if (!/^\/livestream\/[A-Za-z0-9_-]{1,64}\/playlist\.m3u8$/.test(url.pathname)) {
    throw new Error('香港卫视返回的不是有效 HLS 入口')
  }
  return url.href
}

/** 本机代取清单或分片时补齐的请求头；User-Agent 由代理层统一改写，这里不声明。 */
export function upstreamHeadersFor(raw) {
  officialAssetUrl(raw)
  return { Referer: `https://${SITE_HOST}/` }
}

function parsePayload(payload, label) {
  if (typeof payload !== 'string') return payload
  try {
    return JSON.parse(payload)
  } catch {
    throw new Error(`香港卫视${label}没有返回有效 JSON`)
  }
}

/** 官网首页拿当前上架的频道；sourceid 会进播放器接口路径，必须先消毒。 */
export function parseDefaultChannel(payload) {
  const channel = parsePayload(payload, '频道接口')?.data
  const sourceId = String(channel?.sourceid || '')
  if (!SOURCE_ID_RE.test(sourceId)) throw new Error('香港卫视没有返回有效 sourceid')
  const name = typeof channel?.channel === 'string' && channel.channel.trim()
    ? channel.channel.trim()
    : CHANNEL.name
  return { sourceId, name, providerChannelId: Number(channel?.id) || null }
}

/** 播放器接口给的是 http，官网播放器自己也升级到 https；路径必须与本轮 sourceid 一致。 */
export function parsePlayerResponse(payload, expectedSourceId) {
  const data = parsePayload(payload, '播放器接口')
  const raw = data?.url || data?.data?.url
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('香港卫视播放器接口没有返回直播地址')
  const url = new URL(officialHlsUrl(raw.trim().replace(/^http:/i, 'https:')))
  if (url.pathname !== `/livestream/${encodeURIComponent(expectedSourceId)}/playlist.m3u8`) {
    throw new Error('香港卫视播放器接口返回了非本频道的媒体路径')
  }
  return url.href
}

async function discardResponse(response) {
  response.body?.destroy?.()
  await response.body?.cancel?.().catch(() => {})
}

async function responseText(response, maxBytes = MAX_RESPONSE_BYTES) {
  const declaredHeader = response.headers?.get?.('content-length')
  const declared = declaredHeader == null ? NaN : Number(declaredHeader)
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discardResponse(response)
    throw new Error('香港卫视上游响应过大')
  }
  if (!response.body) return ''
  const chunks = []
  let total = 0
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk)
    total += bytes.length
    if (total > maxBytes) {
      response.body?.destroy?.()
      throw new Error('香港卫视上游响应过大')
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

async function requestSite(url, { fetchImpl = proxyAwareFetch, signal } = {}) {
  const response = await fetchImpl(url, {
    redirect: 'manual',
    signal,
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      Referer: `https://${SITE_HOST}/`,
    },
  })
  if (REDIRECT_STATUSES.has(response.status)) {
    await discardResponse(response)
    throw new Error('香港卫视官网接口返回了不安全的重定向')
  }
  const text = await responseText(response, 512 * 1024)
  if (!response.ok) throw new Error(`香港卫视官网接口 HTTP ${response.status}`)
  return text
}

/** 取当前入口：先问官网在播的是哪一路，再向播放器接口换这一路的 HLS 地址。 */
export async function requestEntry({ timeoutMs = 15000, fetchImpl = proxyAwareFetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const options = { timeoutMs, fetchImpl, signal: controller.signal }
    const channel = parseDefaultChannel(await requestSite(HKSTV_CHANNEL_API, options))
    const playerUrl = `${HKSTV_PLAYER_API}/${encodeURIComponent(channel.sourceId)}?mode=live&protocal=hls`
    return {
      sourceId: channel.sourceId,
      streamUrl: parsePlayerResponse(await requestSite(playerUrl, options), channel.sourceId),
    }
  } finally {
    clearTimeout(timer)
  }
}

function hlsRefs(text, baseUrl) {
  const refs = []
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const value = line.trim()
    if (!value) continue
    if (value.startsWith('#')) {
      for (const match of value.matchAll(/URI="([^"]+)"/g)) {
        refs.push(new URL(match[1], baseUrl).href)
      }
    } else {
      refs.push(new URL(value, baseUrl).href)
    }
  }
  return refs
}

export function validateHls(text, baseUrl) {
  if (typeof text !== 'string' || !text.trimStart().startsWith('#EXTM3U')) {
    throw new Error('香港卫视上游不是 HLS 清单')
  }
  for (const ref of hlsRefs(text, baseUrl)) officialAssetUrl(ref)
  return text
}

/** master 里的唯一码率行；官网只下发一档，取第一条即全部。 */
export function firstVariant(text, baseUrl) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('#EXT-X-STREAM-INF')) continue
    for (let j = i + 1; j < lines.length; j++) {
      const value = lines[j].trim()
      if (!value || value.startsWith('#')) continue
      return officialHlsUrl(new URL(value, baseUrl).href)
    }
  }
  return null
}

async function requestHls(raw, { fetchImpl = proxyAwareFetch, signal } = {}) {
  let url = officialHlsUrl(raw)
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetchImpl(url, {
      redirect: 'manual',
      signal,
      headers: {
        'User-Agent': UA,
        Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, */*',
        Referer: `https://${SITE_HOST}/`,
      },
    })
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location')
      await discardResponse(response)
      if (!location) throw new Error('香港卫视直播清单重定向缺少地址')
      url = officialHlsUrl(new URL(location, url).href)
      continue
    }
    if (!response.ok) {
      await discardResponse(response)
      throw new Error(`香港卫视直播清单 HTTP ${response.status}`)
    }
    const text = await responseText(response)
    validateHls(text, url)
    return { text, url }
  }
  throw new Error('香港卫视直播清单重定向次数过多')
}

/**
 * 取一份可直接下发的媒体清单。
 *
 * 官网入口是一层 master，里面只有一条带 hls_ctx 的子清单，分片地址又相对于子清单。
 * 服务端在这里就把 master 拍平成媒体清单，播放器少一跳、也不必理解跨主机的绝对地址。
 */
export async function requestManifest(raw, { timeoutMs = 15000, fetchImpl = proxyAwareFetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const options = { timeoutMs, fetchImpl, signal: controller.signal }
    const master = await requestHls(raw, options)
    const variantUrl = firstVariant(master.text, master.url)
    if (!variantUrl) return master
    const media = await requestHls(variantUrl, options)
    if (!media.text.includes('#EXTINF:')) throw new Error('香港卫视子清单里没有直播分片')
    return media
  } finally {
    clearTimeout(timer)
  }
}

export function buildChannels() {
  return [{
    name: CHANNEL.name,
    deferredRef: CHANNEL.ref,
    logo: CHANNEL.logo,
    groupTitle: '香港',
    opts: ['network-caching=3000'],
    catchup: 'none',
  }]
}

export function claimsRef(ref) {
  return String(ref || '') === CHANNEL.ref
}

export function createResolver({ fetchImpl: defaultFetch = proxyAwareFetch } = {}) {
  const caches = new Map()
  const pending = new Map()
  let generation = 0

  async function cachedEntry(options) {
    const fetchImpl = options.fetchImpl || defaultFetch
    const now = Number(options.now ?? Date.now())
    let cached = caches.get(fetchImpl)
    if (cached && cached.hardExpiresAt <= now) {
      caches.delete(fetchImpl)
      cached = undefined
    }
    if (cached && (cached.refreshAt > now || cached.retryAt > now)) return cached.entry

    let active = pending.get(fetchImpl)
    if (!active) {
      const requestGeneration = generation
      const promise = requestEntry({ ...options, fetchImpl }).then(entry => {
        const cachedAt = Number(options.now ?? Date.now())
        if (requestGeneration === generation) {
          caches.set(fetchImpl, {
            entry,
            refreshAt: cachedAt + ENTRY_TTL_MS,
            retryAt: 0,
            hardExpiresAt: cachedAt + ENTRY_HARD_TTL_MS,
          })
        }
        return entry
      }).finally(() => {
        if (pending.get(fetchImpl)?.promise === promise) pending.delete(fetchImpl)
      })
      active = { promise, generation: requestGeneration }
      pending.set(fetchImpl, active)
    }

    try {
      return await active.promise
    } catch (error) {
      // 清过缓存的旧世代请求不得借用或退避新缓存，否则一次过期失败会污染刚建好的状态
      if (active.generation !== generation) throw error
      const failedAt = Number(options.now ?? Date.now())
      cached = caches.get(fetchImpl)
      if (cached && cached.hardExpiresAt > failedAt) {
        cached.retryAt = failedAt + ENTRY_RETRY_MS
        return cached.entry
      }
      throw error
    }
  }

  function invalidateEntry(failedUrl, fetchImpl) {
    const cached = caches.get(fetchImpl)
    if (cached?.entry?.streamUrl === failedUrl) cached.refreshAt = 0
  }

  async function resolve(ref, ctx = {}) {
    if (!claimsRef(ref)) return { url: '', desc: '香港卫视频道引用格式错误' }
    const options = {
      fetchImpl: ctx.fetchImpl || defaultFetch,
      timeoutMs: ctx.timeoutMs || 15000,
      now: ctx.now,
    }
    try {
      let entry = await cachedEntry(options)
      let manifest
      try {
        manifest = await requestManifest(entry.streamUrl, options)
      } catch {
        // 官网换台后旧 sourceid 会 404：立刻重问一次入口，仍失败才报错
        invalidateEntry(entry.streamUrl, options.fetchImpl)
        entry = await cachedEntry(options)
        manifest = await requestManifest(entry.streamUrl, options)
      }
      return {
        url: entry.streamUrl,
        desc: `${CHANNEL.name} 官方直播地址获取成功`,
        relayHls: true,
        manifestText: manifest.text,
        manifestUrl: manifest.url,
        upstreamHeaders: upstreamHeadersFor,
        upstreamUrlTransform: officialAssetUrl,
      }
    } catch (error) {
      const reason = error?.name === 'AbortError'
        ? `超时 ${options.timeoutMs}ms`
        : (error?.message || String(error))
      return { url: '', desc: `香港卫视链接请求失败：${reason}` }
    }
  }

  function clear() {
    generation++
    caches.clear()
    pending.clear()
  }

  return { resolve, clear }
}

const resolver = createResolver()

export const resolveChannel = resolver.resolve
export const clearCache = resolver.clear
