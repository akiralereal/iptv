/** 新疆广播电视台：官网页面签名发现、公开频道接口与实时 HLS 清单。 */
import { proxyAwareFetch } from '../../utils/systemProxy.js'
import {
  createSignedParams,
  extractSigningMaterial,
  scriptUrls,
  shanghaiDate,
} from './signing.js'

export const XINJIANG_PAGE = 'https://www.xjtvs.com.cn/column/tv/434'
export const XINJIANG_API_ORIGIN = 'https://slstapi.xjtvs.com.cn'
export const XINJIANG_CHANNEL_ENDPOINT = '/api/TVLiveV100/TVChannelList'
export const XINJIANG_TIMESTAMP_URL = `${XINJIANG_API_ORIGIN}/api/Func/Timestamp?json=true`

const API_HOST = 'slstapi.xjtvs.com.cn'
const MEDIA_HOST = 'slstplay.xjtvs.com.cn'
const WEB_HOSTS = ['www.xjtvs.com.cn', 'xjtvs.com.cn']
const CHANNEL_CACHE_TTL_MS = 5 * 60 * 1000
const CHANNEL_RETRY_MS = 15 * 1000
const SIGNING_CACHE_TTL_MS = 6 * 60 * 60 * 1000
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

export const CHANNELS = Object.freeze([
  Object.freeze({
    ref: 'xjtv-1', channelId: '1', callSign: 'XJTV-1', name: '新疆卫视',
    path: '/xjtv1/xjtv1stream.m3u8',
    logo: 'https://slststore.xjtvs.com.cn/imgs/2024/09/06/xj_img_2024090610562817*$*1.000',
  }),
  Object.freeze({
    ref: 'xjtv-2', channelId: '3', callSign: 'XJTV-2', name: '维吾尔语新闻综合',
    path: '/xjtv2/xjtv2stream.m3u8',
    logo: 'https://slststore.xjtvs.com.cn/imgs/2024/09/06/xj_img_20240906105701646*$*1.000',
  }),
  Object.freeze({
    ref: 'xjtv-3', channelId: '4', callSign: 'XJTV-3', name: '哈萨克语新闻综合',
    path: '/xjtv3/xjtv3stream.m3u8',
    logo: 'https://slststore.xjtvs.com.cn/imgs/2024/09/06/xj_img_20240906105720257*$*1.000',
  }),
  Object.freeze({
    ref: 'xjtv-7', channelId: '21', callSign: 'XJTV-7', name: '新疆体育健康',
    path: '/xjtv10/xjtv10stream.m3u8',
    logo: 'https://slststore.xjtvs.com.cn/imgs/2024/09/06/xj_img_20240906105823916*$*1.000',
  }),
  Object.freeze({
    ref: 'xjtv-8', channelId: '23', callSign: 'XJTV-8', name: '新疆少儿',
    path: '/xjtv12/xjtv12stream.m3u8',
    logo: 'https://slststore.xjtvs.com.cn/imgs/2024/09/06/xj_img_20240906105836950*$*1.000',
  }),
])

export const UNAVAILABLE_CHANNELS = Object.freeze([
  Object.freeze({ callSign: 'XJTV-4', name: '汉语综艺频道', reason: '官网标记禁播且 CDN 返回 404' }),
  Object.freeze({ callSign: 'XJTV-5', name: '维吾尔语影视频道', reason: '官网标记禁播且 CDN 返回 404' }),
])

const CHANNEL_BY_REF = new Map(CHANNELS.map(channel => [channel.ref, channel]))
const CHANNEL_BY_ID = new Map(CHANNELS.map(channel => [channel.channelId, channel]))
const MEDIA_PREFIXES = CHANNELS.map(channel => channel.path.slice(0, channel.path.lastIndexOf('/') + 1))

function safeUrl(raw, label) {
  try {
    return new URL(String(raw || '').trim())
  } catch {
    throw new Error(`新疆广电返回了无效${label}地址`)
  }
}

function allowUrl(raw, hosts, label = '上游') {
  const url = safeUrl(raw, label)
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
      || !hosts.includes(url.hostname)) {
    throw new Error(`新疆广电返回了非官方${label}地址`)
  }
  return url.href
}

/** 清单、子清单和分片只允许落在已接入频道自己的官方 CDN 目录内。 */
export function officialAssetUrl(raw) {
  const url = new URL(allowUrl(raw, [MEDIA_HOST], '媒体'))
  if (!MEDIA_PREFIXES.some(prefix => url.pathname.startsWith(prefix))
      || /%2f|%5c/i.test(url.pathname)
      || url.pathname.split('/').includes('..')
      || [...url.searchParams.keys()].some(key => !['auth_key', 'aliyun_uuid'].includes(key))) {
    throw new Error('新疆广电返回了非官方媒体地址')
  }
  const auth = url.searchParams.get('auth_key') || ''
  if (!/^\d{10}-\d+-\d+-[a-f0-9]{32}$/i.test(auth)) {
    throw new Error('新疆广电媒体鉴权参数异常')
  }
  return url.href
}

export function officialHlsUrl(raw, channel, now = Date.now()) {
  const url = new URL(officialAssetUrl(raw))
  if (url.pathname !== channel.path) throw new Error(`${channel.callSign} 的直播路径异常`)
  const uuid = url.searchParams.get('aliyun_uuid') || ''
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(uuid)) {
    throw new Error(`${channel.callSign} 的设备参数异常`)
  }
  const expiresAt = Number((url.searchParams.get('auth_key') || '').split('-')[0]) * 1000
  if (!Number.isFinite(expiresAt) || expiresAt <= Number(now) + 60 * 1000) {
    throw new Error(`${channel.callSign} 的直播地址即将过期`)
  }
  return { url: url.href, expiresAt }
}

export function upstreamHeadersFor(raw) {
  officialAssetUrl(raw)
  return {
    Origin: 'https://www.xjtvs.com.cn',
    Referer: XINJIANG_PAGE,
  }
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
    throw new Error('新疆广电上游响应过大')
  }
  if (!response.body) return ''
  const chunks = []
  let total = 0
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk)
    total += bytes.length
    if (total > maxBytes) {
      response.body?.destroy?.()
      throw new Error('新疆广电上游响应过大')
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

async function requestText(raw, {
  fetchImpl = proxyAwareFetch,
  hosts,
  headers = {},
  maxBytes = MAX_RESPONSE_BYTES,
  timeoutMs = 20000,
} = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let url = allowUrl(raw, hosts)
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await fetchImpl(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': UA, ...headers },
      })
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location')
        await discardResponse(response)
        if (!location) throw new Error('新疆广电上游重定向缺少地址')
        url = allowUrl(new URL(location, url).href, hosts)
        continue
      }
      if (!response.ok) {
        await discardResponse(response)
        throw new Error(`${new URL(url).hostname} HTTP ${response.status}`)
      }
      return { text: await responseText(response, maxBytes), url }
    }
    throw new Error('新疆广电上游重定向次数过多')
  } finally {
    clearTimeout(timer)
  }
}

export function parseChannelList(payload, { now = Date.now() } = {}) {
  let response = payload
  if (typeof response === 'string') {
    try { response = JSON.parse(response) } catch { throw new Error('新疆频道接口没有返回有效 JSON') }
  }
  if (response?.success !== true || !Array.isArray(response?.data)) {
    throw new Error('新疆频道接口返回异常')
  }
  const urls = new Map()
  let hardExpiresAt = Infinity
  for (const [channelId, channel] of CHANNEL_BY_ID) {
    const matches = response.data.filter(item => String(item?.Id) === channelId
      && String(item?.SimpleName || '').trim() === channel.callSign)
    if (matches.length !== 1 || matches[0].IsForbidden === true
        || typeof matches[0].PlayStreamUrl !== 'string') continue
    const parsed = officialHlsUrl(matches[0].PlayStreamUrl, channel, now)
    urls.set(channelId, parsed.url)
    hardExpiresAt = Math.min(hardExpiresAt, parsed.expiresAt - 60 * 1000)
  }
  if (urls.size !== CHANNELS.length) {
    throw new Error(`新疆广电当前仅返回 ${urls.size}/${CHANNELS.length} 路可播放频道`)
  }
  return { urls, hardExpiresAt }
}

function hlsRefs(text, baseUrl) {
  const refs = []
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
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
    throw new Error('新疆广电上游不是 HLS 清单')
  }
  for (const ref of hlsRefs(text, baseUrl)) officialAssetUrl(ref)
  return text
}

export function buildChannels() {
  return CHANNELS.map(channel => ({
    name: channel.name,
    deferredRef: channel.ref,
    logo: channel.logo,
    opts: ['network-caching=3000'],
    catchup: 'none',
  }))
}

export function claimsRef(ref) {
  return CHANNEL_BY_REF.has(String(ref || ''))
}

export function createResolver({ fetchImpl: defaultFetch = proxyAwareFetch } = {}) {
  let signingCache = null
  let signingPending = null
  let channelCache = null
  let channelPending = null
  let generation = 0

  async function discoverSigningMaterial(options) {
    const date = options.date || shanghaiDate(options.now)
    const page = await requestText(XINJIANG_PAGE, {
      ...options, hosts: WEB_HOSTS,
    })
    const candidates = scriptUrls(page.text, page.url)
    if (!candidates.length) throw new Error('新疆广电官网没有可检查的 Nuxt 脚本')
    let lastError
    for (const candidate of candidates) {
      try {
        const script = await requestText(candidate, { ...options, hosts: WEB_HOSTS })
        if (!script.text.includes('TVChannelList') || !script.text.includes('random_string')) continue
        return {
          material: extractSigningMaterial(script.text, date),
          date,
          fetchImpl: options.fetchImpl,
          expiresAt: Number(options.now ?? Date.now()) + SIGNING_CACHE_TTL_MS,
        }
      } catch (error) {
        lastError = error
      }
    }
    throw lastError || new Error('新疆广电官网当前脚本没有直播签名配置')
  }

  async function signingMaterial(options, force = false) {
    const now = Number(options.now ?? Date.now())
    const date = options.date || shanghaiDate(now)
    if (!force && signingCache?.fetchImpl === options.fetchImpl
        && signingCache.date === date && signingCache.expiresAt > now) return signingCache.material
    if (!signingPending || signingPending.fetchImpl !== options.fetchImpl
        || signingPending.date !== date || force) {
      const requestGeneration = generation
      const task = discoverSigningMaterial({ ...options, date }).then(cache => {
        if (requestGeneration === generation) signingCache = cache
        return cache.material
      }).finally(() => {
        if (signingPending?.task === task) signingPending = null
      })
      signingPending = { task, fetchImpl: options.fetchImpl, date }
    }
    return signingPending.task
  }

  async function signedChannelRequest(options, force = false) {
    const timestamp = await requestText(XINJIANG_TIMESTAMP_URL, {
      ...options, hosts: [API_HOST],
    })
    let payload
    try { payload = JSON.parse(timestamp.text) } catch { throw new Error('新疆广电时间接口没有返回有效 JSON') }
    const material = await signingMaterial(options, force)
    const signed = createSignedParams(XINJIANG_CHANNEL_ENDPOINT, String(payload?.data || ''), material, options)
    const url = new URL(XINJIANG_CHANNEL_ENDPOINT, XINJIANG_API_ORIGIN)
    for (const [name, value] of Object.entries({ type: 1, ...signed, json: true })) {
      url.searchParams.set(name, String(value))
    }
    return requestText(url.href, {
      ...options,
      hosts: [API_HOST],
      maxBytes: 512 * 1024,
      headers: { Origin: 'https://www.xjtvs.com.cn', Referer: XINJIANG_PAGE },
    })
  }

  async function requestChannelUrls(options) {
    try {
      const response = await signedChannelRequest(options)
      return parseChannelList(response.text, options)
    } catch (firstError) {
      signingCache = null
      try {
        const response = await signedChannelRequest(options, true)
        return parseChannelList(response.text, options)
      } catch (retryError) {
        if (!retryError.cause) retryError.cause = firstError
        throw retryError
      }
    }
  }

  async function cachedChannelUrls(options) {
    const now = Number(options.now ?? Date.now())
    const sameClient = channelCache?.fetchImpl === options.fetchImpl
    if (sameClient && (channelCache.expiresAt > now
        || (channelCache.retryAt > now && channelCache.hardExpiresAt > now))) return channelCache.urls

    if (!channelPending || channelPending.fetchImpl !== options.fetchImpl) {
      const requestGeneration = generation
      const task = requestChannelUrls(options).then(result => {
        if (requestGeneration === generation) {
          channelCache = {
            ...result,
            fetchImpl: options.fetchImpl,
            retryAt: 0,
            expiresAt: Math.min(now + CHANNEL_CACHE_TTL_MS, result.hardExpiresAt),
          }
        }
        return result.urls
      }).finally(() => {
        if (channelPending?.task === task) channelPending = null
      })
      channelPending = { task, fetchImpl: options.fetchImpl, generation: requestGeneration }
    }
    const active = channelPending
    try {
      return await active.task
    } catch (error) {
      if (active.generation !== generation) throw error
      if (sameClient && channelCache.hardExpiresAt > now) {
        channelCache.retryAt = now + CHANNEL_RETRY_MS
        return channelCache.urls
      }
      throw error
    }
  }

  function invalidateChannelUrl(channel, failedUrl, fetchImpl) {
    if (channelCache?.fetchImpl === fetchImpl
        && channelCache.urls.get(channel.channelId) === failedUrl) channelCache.expiresAt = 0
  }

  async function requestManifest(raw, options) {
    const response = await requestText(raw, {
      ...options,
      hosts: [MEDIA_HOST],
      maxBytes: 2 * 1024 * 1024,
      headers: { Origin: 'https://www.xjtvs.com.cn', Referer: XINJIANG_PAGE },
    })
    validateHls(response.text, response.url)
    return response
  }

  async function resolve(ref, ctx = {}) {
    const channel = CHANNEL_BY_REF.get(String(ref || ''))
    if (!channel) return { url: '', desc: '新疆频道引用格式错误' }
    const options = {
      fetchImpl: ctx.fetchImpl || defaultFetch,
      timeoutMs: ctx.timeoutMs || 20000,
      now: ctx.now,
      random: ctx.random,
      date: ctx.date,
    }
    try {
      let streamUrl = (await cachedChannelUrls(options)).get(channel.channelId)
      if (!streamUrl) throw new Error(`${channel.name} 当前不在官网有效直播列表中`)
      let manifest
      try {
        manifest = await requestManifest(streamUrl, options)
      } catch {
        // 短效入口若提前轮换，立即重新签发一次再读清单。
        invalidateChannelUrl(channel, streamUrl, options.fetchImpl)
        streamUrl = (await cachedChannelUrls(options)).get(channel.channelId)
        if (!streamUrl) throw new Error(`${channel.name} 当前不在官网有效直播列表中`)
        manifest = await requestManifest(streamUrl, options)
      }
      return {
        url: manifest.url,
        desc: `${channel.name} 官方直播地址获取成功`,
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
      return { url: '', desc: `新疆广电链接请求失败：${reason}` }
    }
  }

  function clear() {
    generation++
    signingCache = null
    signingPending = null
    channelCache = null
    channelPending = null
  }

  return { resolve, clear }
}

const resolver = createResolver()

export const resolveChannel = resolver.resolve
export const clearCache = resolver.clear
