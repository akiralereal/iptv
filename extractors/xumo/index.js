import { outboundProxyKey } from '../../utils/outboundProxy.js'
import { Provider, claimsRef, refFor, logoFor } from './api.js'
import { createTransport, HOME, API_HOSTS, MEDIA_HOSTS, redact } from './transport.js'

let active, proxyKey
let injected = new WeakMap()
export function providerFor(ctx = {}) {
  if (ctx.fetchImpl) {
    if (!injected.has(ctx.fetchImpl)) injected.set(ctx.fetchImpl, new Provider(ctx))
    return injected.get(ctx.fetchImpl)
  }
  const next = outboundProxyKey()
  if (!active || next !== proxyKey) { void active?.shutdown(); active = new Provider(ctx); proxyKey = next }
  if (ctx.isEnabled) active.isEnabled = ctx.isEnabled
  return active
}
const transport = createTransport()
export function buildGroups(channels) {
  const groups = new Map()
  for (const c of channels) {
    const name = `Xumo · ${c.genre}`
    if (!groups.has(name)) groups.set(name, { name, dataList: [] })
    groups.get(name).dataList.push({ name: c.name, deferredRef: refFor(c.id), logo: c.logo || logoFor(c.id), catchup: 'none' })
  }
  return [...groups.values()]
}
export default {
  id: 'xumo', name: 'Xumo Play', category: 'overseas', defaultEnabled: false,
  description: 'Xumo 官方直播，持续排除宗教频道。默认最高分辨率，保留音轨与字幕；取址和媒体由服务器经「设置 → 网络代理」转发，能否播放取决于服务器出口及官方地区权限。',
  outbound: 'proxy', proxyProbe: { name: 'Xumo 官方直播指南', url: HOME },
  proxyHosts: [...new Set([...API_HOSTS, ...MEDIA_HOSTS])],
  capabilities: { cache: 'disk', resolve: true, epg: false, catchup: false },
  catalogVersion: 1, channelHlsMode: 'proxy', playbackRequiresEnabled: true,
  defaultRefreshMinutes: 1, refreshConfigurable: false,
  refreshDescription: '后台每天更新频道和地址，每 6 小时检查可用性；由主项目的源刷新检查触发到期任务。新频道或新地址验证音视频及直播推进后发布，失败保留上次有效清单。关闭时停止抓取与播放。',
  configSchema: [], claimsRef,
  async fetch(_config, ctx = {}) {
    const result = providerFor(ctx).poll()
    return { groups: buildGroups(result.channels), meta: { skipped: [], warnings: result.warnings } }
  },
  async resolve(ref, ctx = {}) {
    try { return await providerFor(ctx).resolve(ref) }
    catch (error) { return { url: '', status: 502, desc: `Xumo：${redact(error)}；请检查「设置 → 网络代理」` } }
  },
  fetchProxyMedia(_ref, _config, url, options) { return transport.media(url, options) },
  clearResolveCache() { void active?.shutdown(); active = null; proxyKey = null; injected = new WeakMap() },
  async shutdown() { await active?.shutdown() },
}
