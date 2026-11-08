/**
 * 自定义源「经网络代理转发」：订阅卡片、直连卡片上的开关（字段 useProxy）。
 *
 * 内置模块走不走代理是声明制（registry.js 的 outbound: 'proxy'，固定四处），用户在这里改不了；
 * 内置的「精选频道」订阅也没有这个开关。这里只管用户自己加的源：用户知道自己的哪份列表在大陆连不上，
 * 交给用户自己勾，比我们替第三方列表判断准。
 *
 * 勾上之后：
 *   1. 拉订阅列表经网络代理（externalSources.updateSubscriptionSource）；
 *   2. 源里的 http(s) 频道在订阅里改写成本机固定入口 ${replace}/proxy/cp-<hex>.m3u8，
 *      播放时：有生效代理 → 服务器经代理取清单，清单和分片都由服务器转发（与海外频道同一条全代理链路）；
 *              没有生效代理 → 302 回原地址，由播放器直连（和没勾时一样）；
 *              取回来不是 HLS（FLV、TS 裸流等）→ 302 回原地址，由播放器直连。
 *   局域网地址（udpxy 之类）、rtmp/rtp/udp 等非 HTTP 地址、.flv 地址不改写，照旧原样输出。
 *
 * 订阅里写的是固定入口而不是按代理状态二选一，是为了让后台改代理设置后不用重新生成订阅、
 * 播放器也不用刷新就跟着变（海外频道同理）。频道的身份（隐藏、改名、归类、排序）仍按原地址算，
 * 写盘时带 identity-url，开关一开一关这些设置都不丢。
 *
 * 引用 cp-<hex> 按「源 id + 频道名 + 剥掉时效参数的原地址」算：订阅刷新换了签名，播放器收藏的地址不变，
 * 播放时总是取最新的原地址。
 */
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { fetch as undiciFetch } from 'undici'

import { sanitizeOpts } from './channelOpts.js'
import { printYellow } from './colorOut.js'
import { fetchUpstreamResponse } from './hlsProxy.js'
import { isPrivateAddress } from './logoCache.js'
import { outboundFetch, outboundProxyUrl } from './outboundProxy.js'
import { stripVolatileParams } from './urlIdentity.js'

export const REF_PREFIX = 'cp-'
const REF_RE = /^cp-[0-9a-f]{16}$/
// 清单是播放器起播（和每次轮询）时现取的，取不到要尽快告诉播放器，别让它干等
const MANIFEST_TIMEOUT_MS = 8000
// 与 appUtils.inlineResolvedManifest 的上限一致：超过它的不当清单处理
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024
// 同一原因的日志多久打一次：播放器失败后是 100ms 级的连环重试，逐次打印会淹没日志
const LOG_EVERY_MS = 30 * 1000

export function claimsRef(ref) {
  return REF_RE.test(String(ref || ''))
}

/** 这个频道的本机固定引用（单个路径段，写成 ${replace}/proxy/<ref>.m3u8）。 */
export function proxyRefFor(sourceId, name, url) {
  const digest = createHash('sha1')
    .update(`${sourceId}\n${name || ''}\n${stripVolatileParams(String(url || ''))}`)
    .digest('hex')
  return REF_PREFIX + digest.slice(0, 16)
}

/**
 * 局域网 / 本机主机名：字面 IP 按私网段判（198.18.0.0/15 的 fake-ip 不算，那是代理软件给域名的假地址），
 * 域名按 localhost、.local、.lan 这类只在家里解析得到的后缀，和不带点的单段主机名判。
 */
export function isLanHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
  if (!host) return true
  if (isIP(host)) return isPrivateAddress(host)
  if (!host.includes('.')) return true
  return /(?:^|\.)(?:localhost|local|lan|home|home\.arpa|internal|localdomain)$/.test(host)
}

function isLanUrl(raw) {
  try { return isLanHost(new URL(String(raw)).hostname) } catch { return false }
}

/** 开了开关的源里，哪些频道改由服务器转发：公网上的 http(s) 地址，FLV 除外（转发链路只管 HLS）。 */
export function proxiableUrl(raw) {
  let url
  try { url = new URL(String(raw || '')) } catch { return false }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (isLanHost(url.hostname)) return false
  return !/\.flv$/i.test(url.pathname)
}

/**
 * 开了开关的源的出站请求：局域网地址直连（代理够不着家里的机器），其余经网络代理
 * （后台填的优先，没填沿用 HTTPS_PROXY / 系统代理，见 outboundProxy.outboundFetch）。
 */
export function customSourceFetch(url, options = {}) {
  return isLanUrl(url) ? undiciFetch(url, options) : outboundFetch(url, options)
}

const OPT_HEADERS = { 'http-user-agent': 'User-Agent', 'http-referrer': 'Referer', 'http-origin': 'Origin' }

/**
 * 频道的 #EXTVLCOPT 请求头（含「播放时也带上这个 UA」补上的那条）→ 服务器回源时发的请求头。
 * 播放器原本会自己带上这些头，改成服务器取流后得由服务器替它带。
 * 返回函数形态：hlsProxy 只有函数形态的 User-Agent 会原样发出（固定对象一律换成统一 UA）。
 */
export function upstreamHeadersOf(opts) {
  const headers = {}
  for (const opt of sanitizeOpts(opts)) {
    const eq = opt.indexOf('=')
    const name = OPT_HEADERS[opt.slice(0, eq)]
    if (name) headers[name] = opt.slice(eq + 1)
  }
  return Object.keys(headers).length ? () => ({ ...headers }) : undefined
}

/** 回看等播放参数接回原地址（播放器把它们拼在本机入口后面）。 */
function withQuery(url, query) {
  const text = new URLSearchParams(query && typeof query === 'object' ? query : {}).toString()
  if (!text) return url
  const hashAt = url.indexOf('#')
  const head = hashAt === -1 ? url : url.slice(0, hashAt)
  const tail = hashAt === -1 ? '' : url.slice(hashAt)
  return `${head}${head.includes('?') ? '&' : '?'}${text}${tail}`
}

function hostOf(url) {
  try { return new URL(url).host } catch { return '' }
}

/**
 * 本机入口 ${replace}/proxy/cp-….m3u8 不带「?」：原地址带 ? 的源常把回看模板写成 &playseek=…，
 * 播放器直接拼在入口后面会拼成 cp-….m3u8&playseek=…，认不出来就 404。写盘时把开头的 & 换成 ?，
 * 参数到了 resolve 再按原地址接回（withQuery 会按原地址重新选 ? 还是 &）。
 */
export function catchupForProxyEntry(channel) {
  const source = channel?.catchupSource
  if (typeof source !== 'string' || !source.startsWith('&')) return channel
  return { ...channel, catchupSource: `?${source.slice(1)}` }
}

/**
 * 读清单正文；开头不是 #EXTM3U（FLV、TS 裸流、网页）就停下返回 null，不把一条直播流读进内存。
 */
async function readHlsText(response) {
  const chunks = []
  let size = 0
  let checked = false
  for await (const chunk of response.body || []) {
    const buf = Buffer.from(chunk)
    chunks.push(buf)
    size += buf.length
    if (!checked) {
      const head = Buffer.concat(chunks, size).toString('utf8').trimStart()
      if (head.length >= 7) {
        if (!head.startsWith('#EXTM3U')) return null
        checked = true
      }
    }
    if (size > MAX_MANIFEST_BYTES) return null
  }
  const text = Buffer.concat(chunks, size).toString('utf8')
  return text.trimStart().startsWith('#EXTM3U') ? text : null
}

/**
 * 播放请求的解析者。不是抓取模块（不进注册表、后台没有卡片），由 app.js 用 registerRefResolver 挂上，
 * resolverFor 在模块都不认领时才问它。
 *
 * @param {object} deps
 * @param {() => Array<{ref, name, url, opts?, sourceId?, sourceName?}>} deps.getChannels 开了开关的源里改写过的频道
 * @param {() => unknown} deps.getVersion 源配置的版本号；变了才重建索引（订阅刷新会换掉原地址里的签名）
 */
export function createCustomProxyResolver({
  getChannels,
  getVersion = () => undefined,
  fetchImpl = customSourceFetch,
  proxyEnabled = () => Boolean(outboundProxyUrl()),
  log = printYellow,
  now = Date.now,
} = {}) {
  let index = null
  let indexVersion
  const lastLogged = new Map()

  function note(key, message) {
    const at = now()
    if (at - (lastLogged.get(key) || 0) < LOG_EVERY_MS) return
    if (lastLogged.size > 2000) lastLogged.clear()
    lastLogged.set(key, at)
    log(message)
  }

  function lookup(ref) {
    const version = getVersion()
    if (!index || version !== indexVersion) {
      index = new Map()
      for (const channel of getChannels() || []) {
        if (channel && claimsRef(channel.ref) && channel.url) index.set(channel.ref, channel)
      }
      indexVersion = version
    }
    return index.get(ref)
  }

  async function resolve(ref, ctx = {}) {
    const entry = claimsRef(ref) ? lookup(String(ref)) : null
    if (!entry) {
      return { url: '', status: 404, desc: '这个自定义源频道已更新，或已关闭「经网络代理转发」，请在播放器里刷新订阅' }
    }
    const label = `${entry.sourceName || '自定义源'}「${entry.name}」`
    const url = withQuery(entry.url, ctx.query)
    if (!proxyEnabled()) {
      note(`direct|${entry.sourceId || ''}`, `${entry.sourceName || '自定义源'}：没有生效的网络代理，开了「经网络代理转发」的频道暂由播放器直连`)
      // directRedirect：app.js 据此直接 302，不因入口在 /proxy/ 下就改由服务器取清单、转发分片
      return { url, directRedirect: 'no-proxy', desc: `${label} 没有生效的网络代理，改由播放器直连` }
    }
    const upstreamHeaders = upstreamHeadersOf(entry.opts)
    try {
      const response = await fetchUpstreamResponse(url, {
        signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
        upstreamHeaders,
        headers: { Accept: 'application/vnd.apple.mpegurl, */*' },
        fetchImpl,
      })
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {})
        throw new Error(`对方回 HTTP ${response.status}`)
      }
      const text = await readHlsText(response)
      if (text == null) {
        // 转发链路只管 HLS；FLV、TS 裸流这类交还给播放器，和没开开关时一样
        note(`nonhls|${entry.ref}`, `${label} 不是 HLS 直播，改由播放器直连（经网络代理转发只支持 HLS）`)
        return { url, directRedirect: 'not-hls', desc: `${label} 不是 HLS 直播，改由播放器直连` }
      }
      const manifestUrl = response.url || url
      return { url: manifestUrl, proxyHls: true, manifestText: text, manifestUrl, upstreamHeaders, desc: `${label} 经网络代理转发` }
    } catch (error) {
      const reason = ['AbortError', 'TimeoutError'].includes(error?.name)
        ? '超时没有响应'
        : (error?.cause?.code || error?.message || String(error))
      // 开了代理就不悄悄绕过它直连：用户勾这个开关，多半正是因为直连不通
      note(`fail|${entry.ref}`, `${label} 经网络代理取清单失败（${hostOf(url)}）：${reason}。代理软件用规则模式的，看看这个域名是否走了代理`)
      return { url: '', status: 502, silent: true, desc: `${label} 经网络代理取清单失败：${reason}` }
    }
  }

  return {
    id: 'custom-source-proxy',
    name: '自定义源（经网络代理转发）',
    // 回看参数由 resolve 自己接回原地址（原地址不一定带 ?，外壳的 & 拼接会拼坏）
    capabilities: { resolve: true, catchup: false },
    claimsRef,
    resolve,
    // 全代理链路的子清单、分片回源：同样经网络代理、带上频道的请求头（请求头已随登记项传进来）
    fetchProxyMedia: (_ref, _config, url, options) => fetchUpstreamResponse(url, { ...options, fetchImpl }),
  }
}
