import { outboundProxyKey } from '../../utils/outboundProxy.js'
import { Provider, createTransport, claimsRef, refFor, TOPICS, redact, HOME } from './api.js'

let active, key
let injected = new WeakMap()
function providerFor(ctx = {}) {
  if (ctx.fetchImpl) {
    if (!injected.has(ctx.fetchImpl)) injected.set(ctx.fetchImpl, new Provider(ctx))
    return injected.get(ctx.fetchImpl)
  }
  const next = outboundProxyKey()
  if (!active || next !== key) { active = new Provider(); key = next }
  return active
}
const transport = createTransport()
const tidy = text => String(text || '').replace(/\s+/g, ' ').trim()
export function buildGroups(items) {
  const groups = [{ name: '红牛轮播', dataList: [] }, { name: '红牛赛事', dataList: [] }]
  for (const item of items) {
    const linear = item.content_type === 'video_channel'
    groups[linear ? 0 : 1].dataList.push({
      // 官方标题偶有首尾空格（如「Gazir Contra Todos 2026 」），拼频道名前先收拾掉，免得出现双空格
      name: linear ? TOPICS[item.title] || `红牛 ${tidy(item.title)}` : `红牛 ${[item.eventTitle || item.subheading, item.title].map(tidy).filter(Boolean).join(' · ')}`,
      deferredRef: refFor(item.id), catchup: 'none',
      // 轮播使用已核对的官方 Red Bull TV 台标；赛事直播间不用节目海报冒充台标。
      logo: '',
    })
  }
  return groups
}
export default {
  id: 'redbull', name: 'Red Bull TV', category: 'overseas', defaultEnabled: false,
  description: '红牛官方 9 路全天轮播与动态赛事。开播加入、结束移除，不包含预告与回放。清单、音轨、字幕和视频统一由服务器转发，取决于服务器网络及官方地区权限；可在「设置 → 网络代理」配置代理。',
  outbound: 'proxy', proxyProbe: { name: 'Red Bull TV 官网', url: HOME },
  proxyHosts: ['redbull.tv', 'redbull.com', 'akamaized.net', 'liiift.io'],
  capabilities: { cache: 'disk', resolve: true, epg: false, catchup: false },
  catalogVersion: 1, channelHlsMode: 'proxy', playbackRequiresEnabled: true,
  defaultRefreshMinutes: 1, refreshConfigurable: false,
  refreshDescription: '随主项目源刷新检查同步官方在播赛事并复核状态（最短 1 分钟）；轮播目录每小时更新。播放时重新取址，最高画质在前并保留自动降档、多音轨和字幕。',
  configSchema: [],
  async fetch(_config, ctx = {}) {
    const result = await providerFor(ctx).discover()
    return { groups: buildGroups(result.items), meta: { skipped: [], warnings: result.warnings } }
  },
  claimsRef,
  async resolve(ref, ctx = {}) {
    try { return await providerFor(ctx).resolve(ref) }
    catch (error) { return { url: '', status: 502, desc: `Red Bull TV：${redact(error)}；网络异常可检查「设置 → 网络代理」` } }
  },
  fetchProxyMedia(_ref, _config, url, options) { return transport.media(url, options) },
  clearResolveCache() { active = null; key = null; injected = new WeakMap() },
}
