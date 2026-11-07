/**
 * 莲花卫视官网首页内嵌播放器的当前签名入口；不保存签名到代码或频道缓存。
 * 2026-11-07 核对：官网首页改嵌趣看直播间页（cloud.quklive.com/cloud/a/embed/<直播间号>，新直播间 11-05 创建），
 * 旧的 /live 页仍在但里面的直播间已停推（CDN 回 stream not found），所以从首页跟着当前直播间走。
 */
import { proxyAwareFetch } from '../../utils/systemProxy.js'
import { CHANNEL } from './channels.js'

export { CHANNEL }

export const HOME_PAGE = 'https://www.lotustv.mo/'
export const ENTRY_TTL_MS = 5 * 60 * 1000

const EMBED_URL_RE = /^https:\/\/cloud\.quklive\.com\/cloud\/a\/embed\/(\d+)$/
const MEDIA_HOST_RE = /^play-[a-z0-9-]+\.quklive\.com$/
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const MAX_TEXT_BYTES = 512 * 1024

export function officialAssetUrl(raw, expectedHost) {
  let url
  try {
    url = new URL(String(raw || ''))
  } catch {
    throw new Error('莲花卫视媒体地址无效')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
      || !MEDIA_HOST_RE.test(url.hostname)
      || (expectedHost && url.hostname !== expectedHost)
      || !/^\/live\/[A-Za-z0-9._-]+\.(?:m3u8|ts)$/.test(url.pathname)
      || !url.searchParams.has('auth_key')) {
    throw new Error('莲花卫视媒体地址不在当前官方签名直播目录')
  }
  return url.href
}

/** 首页 iframe#onlive 指向的趣看直播间页，返回页面地址与直播间号。 */
export function parseEmbedUrl(home) {
  const tags = String(home || '').match(/<iframe\b[^>]*>/gi) || []
  const tag = tags.find(t => /\bid\s*=\s*["']onlive["']/i.test(t))
  if (!tag) throw new Error('莲花卫视官网首页没有直播播放器')
  const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.trim() || ''
  const match = EMBED_URL_RE.exec(src.startsWith('//') ? `https:${src}` : src)
  if (!match) throw new Error('莲花卫视官网首页的直播播放器已变化')
  return { url: match[0], id: match[1] }
}

/** 直播间页里 `var activity = {...};` 写的就是官网播放器正在用的 HLS 入口。 */
export function parseEmbedEntry(page, id) {
  const raw = /\bvar\s+activity\s*=\s*(\{.*\})\s*;/.exec(String(page || ''))?.[1]
  if (!raw) throw new Error('莲花卫视直播间页没有播放配置')
  let activity
  try {
    activity = JSON.parse(raw)
  } catch {
    throw new Error('莲花卫视直播间页的播放配置无法解析')
  }
  if (String(activity?.id) !== String(id)) throw new Error('莲花卫视直播间页与官网首页不一致')
  const url = new URL(officialAssetUrl(activity.urlGroup?.hlsUrl))
  if (url.pathname !== `/live/${id}.m3u8`) {
    throw new Error('莲花卫视官网返回了意外的直播入口')
  }
  return url.href
}

export function validateManifest(text, baseUrl) {
  if (typeof text !== 'string' || !text.trimStart().startsWith('#EXTM3U')) {
    throw new Error('莲花卫视 CDN 没有返回 HLS 清单')
  }
  if (/#EXT-X-(?:KEY|MAP|STREAM-INF)/.test(text)) {
    throw new Error('莲花卫视 HLS 格式已变化，需要检查子清单或加密方式')
  }
  const host = new URL(baseUrl).hostname
  let segments = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const url = new URL(officialAssetUrl(new URL(line, baseUrl).href, host))
    if (!url.pathname.endsWith('.ts')) throw new Error('莲花卫视清单包含意外的媒体类型')
    segments++
  }
  if (!segments || !text.includes('#EXTINF:')) throw new Error('莲花卫视清单没有直播分片')
  return text
}

async function requestText(url, { fetchImpl, timeoutMs, headers = {} }) {
  const response = await fetchImpl(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': UA, Referer: 'https://www.lotustv.mo/', ...headers },
  })
  if (!response.ok || response.status >= 300) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error(`上游 HTTP ${response.status}`)
  }
  const declared = Number(response.headers.get('content-length'))
  if (declared > MAX_TEXT_BYTES) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error('上游响应过大')
  }
  let size = 0
  const chunks = []
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > MAX_TEXT_BYTES) {
      await response.body?.cancel?.().catch(() => {})
      throw new Error('上游响应过大')
    }
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

export async function requestEntry({ fetchImpl = proxyAwareFetch, timeoutMs = 12000 } = {}) {
  const home = await requestText(HOME_PAGE, { fetchImpl, timeoutMs, headers: { Accept: 'text/html' } })
  const embed = parseEmbedUrl(home)
  const page = await requestText(embed.url, { fetchImpl, timeoutMs, headers: { Accept: 'text/html' } })
  return parseEmbedEntry(page, embed.id)
}

export async function requestManifest(url, { fetchImpl = proxyAwareFetch, timeoutMs = 12000 } = {}) {
  const safeUrl = officialAssetUrl(url)
  const text = await requestText(safeUrl, {
    fetchImpl, timeoutMs, headers: { Accept: 'application/vnd.apple.mpegurl' },
  })
  return validateManifest(text, safeUrl)
}

export function buildChannels() {
  return [{
    name: CHANNEL.name,
    deferredRef: CHANNEL.ref,
    logo: CHANNEL.logo,
    groupTitle: '澳门',
    opts: ['network-caching=3000'],
    catchup: 'none',
  }]
}

export function claimsRef(ref) {
  return String(ref || '') === CHANNEL.ref
}

export function createResolver({ fetchImpl: defaultFetch = proxyAwareFetch } = {}) {
  let entry = null
  let pending = null
  let generation = 0

  async function currentEntry(options, force = false) {
    const now = Number(options.now ?? Date.now())
    if (!force && entry && entry.expiresAt > now) return entry.url
    if (!pending) {
      const currentGeneration = generation
      const promise = requestEntry(options).then(url => {
        if (generation === currentGeneration) {
          entry = { url, expiresAt: Number(options.now ?? Date.now()) + ENTRY_TTL_MS }
        }
        return url
      }).finally(() => {
        if (pending === promise) pending = null
      })
      pending = promise
    }
    return pending
  }

  async function resolve(ref, ctx = {}) {
    if (!claimsRef(ref)) return { url: '', desc: '莲花卫视频道引用格式错误' }
    const options = {
      fetchImpl: ctx.fetchImpl || defaultFetch,
      timeoutMs: ctx.timeoutMs || 12000,
      now: ctx.now,
    }
    try {
      let url = await currentEntry(options)
      let manifest
      try {
        manifest = await requestManifest(url, options)
      } catch {
        // 签名或频道换掉时立即重新读官网，不等五分钟缓存到期。
        url = await currentEntry(options, true)
        manifest = await requestManifest(url, options)
      }
      const host = new URL(url).hostname
      return {
        url,
        desc: '澳门莲花卫视官方直播地址',
        relayHls: true,
        manifestText: manifest,
        manifestUrl: url,
        upstreamHeaders: { Referer: 'https://www.lotustv.mo/' },
        upstreamUrlTransform: raw => officialAssetUrl(raw, host),
      }
    } catch (error) {
      // 不把 URL 或 auth_key 拼进错误信息，避免签名进入日志。
      const reason = ['AbortError', 'TimeoutError'].includes(error?.name)
        ? '请求超时' : (error?.message || '上游请求失败')
      return { url: '', desc: `澳门莲花卫视取流失败：${reason}` }
    }
  }

  function clear() {
    generation++
    entry = null
    pending = null
  }

  return { resolve, clear }
}

const resolver = createResolver()
export const resolveChannel = resolver.resolve
export const clearResolveCache = resolver.clear
