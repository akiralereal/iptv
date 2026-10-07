/**
 * 澳广视（TDM）直播取流：官网公开 HLS，播放时按官方路由接口换成当前网络可用的 CDN。
 *
 * 官网播放器的做法（2026-10-06 实测，Globalping 多地探针）：
 * - GET www.tdm.com.mo/api/v1/common/get-domain 按访问者网络返回路由：sourceLiveDomain（官网写的
 *   live3）先换成 liveDomain（locallive），再按 domains 表换一次——澳门本地映射到自己（live3 / locallive），
 *   香港、台湾、日本、美国映射到海外 CDN（live5 / globallive）。
 * - 大陆连官网和海外 CDN 都是 TCP 超时，live3 只有澳门本地能连。所以模块默认关闭（defaultEnabled: false），部署在大陆以外的用户自己打开。
 * - 海外 CDN 不看 Referer、UA，地址不带签名：给播放器 302 直连，视频不经过本机。
 *
 * 路由缓存 5 分钟；接口一时取不到时沿用上一次的路由（域名几个月不变），从没取到过才报错。
 */
import { proxyAwareFetch } from '../../utils/systemProxy.js'
import { CHANNELS, CHANNEL_BY_REF } from './channels.js'

export { CHANNELS }

export const LIVE_PAGE = 'https://www.tdm.com.mo/zh-hans/live?ssr=on'
export const ROUTE_API = 'https://www.tdm.com.mo/api/v1/common/get-domain'
export const ROUTE_TTL_MS = 5 * 60 * 1000

const OFFICIAL_HOST_RE = /^[a-z0-9-]+\.tdm\.com\.mo$/
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** 官网播放器同款改写：先 sourceLiveDomain → liveDomain，再按 domains 表逐个替换。 */
export function applyDomainRoute(raw, route) {
  let resolved = String(raw || '')
  if (route?.sourceLiveDomain && route?.liveDomain && resolved.startsWith(route.sourceLiveDomain)) {
    resolved = route.liveDomain + resolved.slice(route.sourceLiveDomain.length)
  }
  for (const [source, target] of Object.entries(route?.domains || {})) {
    if (source && target && resolved.startsWith(source)) resolved = target + resolved.slice(source.length)
  }
  return resolved
}

/** 只放行澳广视自己的 https 域名与 .m3u8 地址：路由接口返回的域名不在白名单就不下发给播放器。 */
export function officialStreamUrl(raw) {
  let url
  try {
    url = new URL(String(raw || ''))
  } catch {
    throw new Error('澳广视直播地址无效')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
      || !OFFICIAL_HOST_RE.test(url.hostname) || !url.pathname.endsWith('.m3u8')) {
    throw new Error('澳广视路由接口返回了意外的直播域名')
  }
  return url.href
}

export function parseRoute(payload) {
  const route = payload?.data
  if (!route?.sourceLiveDomain || !route?.liveDomain) throw new Error('澳广视路由接口没有返回直播域名')
  return {
    sourceLiveDomain: String(route.sourceLiveDomain),
    liveDomain: String(route.liveDomain),
    domains: Object.fromEntries(Object.entries(route.domains || {}).map(([k, v]) => [String(k), String(v)])),
  }
}

export function buildChannels() {
  return CHANNELS.map(channel => ({
    name: channel.name,
    deferredRef: channel.ref,
    logo: channel.logo,
    groupTitle: '澳门',
    catchup: 'none',
  }))
}

export function claimsRef(ref) {
  return CHANNEL_BY_REF.has(String(ref || ''))
}

export function createResolver({ fetchImpl: defaultFetch = proxyAwareFetch } = {}) {
  let route = null
  let expiresAt = 0
  let pending = null

  async function requestRoute({ fetchImpl, timeoutMs }) {
    const response = await fetchImpl(ROUTE_API, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': UA, Referer: LIVE_PAGE, Accept: 'application/json' },
    })
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {})
      throw new Error(`路由接口 HTTP ${response.status}`)
    }
    return parseRoute(await response.json())
  }

  async function currentRoute(options) {
    const now = Number(options.now ?? Date.now())
    if (route && expiresAt > now) return route
    if (!pending) {
      pending = requestRoute(options).then(value => {
        route = value
        expiresAt = Number(options.now ?? Date.now()) + ROUTE_TTL_MS
        return value
      }, error => {
        // 一时取不到：有上一次的就接着用，过一分钟再试
        if (route) {
          expiresAt = Number(options.now ?? Date.now()) + 60 * 1000
          return route
        }
        throw error
      }).finally(() => { pending = null })
    }
    return pending
  }

  async function resolve(ref, ctx = {}) {
    const channel = CHANNEL_BY_REF.get(String(ref || ''))
    if (!channel) return { url: '', desc: '澳广视频道引用格式错误' }
    try {
      const value = await currentRoute({
        fetchImpl: ctx.fetchImpl || defaultFetch,
        timeoutMs: ctx.timeoutMs || 10000,
        now: ctx.now,
      })
      return { url: officialStreamUrl(applyDomainRoute(channel.streamUrl, value)), desc: `${channel.name} 官方直播地址` }
    } catch (error) {
      const reason = ['AbortError', 'TimeoutError'].includes(error?.name)
        ? '请求超时' : (error?.cause?.code || error?.message || '上游请求失败')
      return { url: '', desc: `${channel.name} 取流失败：${reason}（澳广视官网与视频只对大陆以外开放）` }
    }
  }

  function clear() {
    route = null
    expiresAt = 0
    pending = null
  }

  return { resolve, clear }
}

const resolver = createResolver()
export const resolveChannel = resolver.resolve
export const clearResolveCache = resolver.clear
