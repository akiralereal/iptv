/** 莲花卫视官网 QPlayer 当前签名入口；不保存签名到代码或频道缓存。 */
import { proxyAwareFetch } from '../../utils/systemProxy.js'
import { CHANNEL } from './channels.js'

export { CHANNEL }

export const LIVE_PAGE = 'https://www.lotustv.mo/live'
export const ENTRY_TTL_MS = 5 * 60 * 1000

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

export function parsePlayerUrl(page) {
  const player = /new\s+QPlayer\s*\(\s*\{([\s\S]*?)\}\s*\)/.exec(page)?.[1]
  if (!player) throw new Error('莲花卫视官网没有 QPlayer 配置')
  // 官网保留了以 //url: 开头的旧线路；只能读取正在使用的属性行。
  const activeLines = player.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/)
    .map(line => line.trim()).filter(line => line && !line.startsWith('//'))
  const matches = activeLines.map(line => /^url:\s*["']([^"']+)["']\s*,?$/.exec(line)?.[1])
    .filter(Boolean)
  if (matches.length !== 1) throw new Error('莲花卫视官网当前 HLS 入口不唯一')
  const raw = matches[0].startsWith('//') ? `https:${matches[0]}` : matches[0]
  const url = new URL(officialAssetUrl(raw))
  if (!/^\/live\/\d+\.m3u8$/.test(url.pathname)) {
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
  const html = await requestText(LIVE_PAGE, { fetchImpl, timeoutMs, headers: { Accept: 'text/html' } })
  return parsePlayerUrl(html)
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
