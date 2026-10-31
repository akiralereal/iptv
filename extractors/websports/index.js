import { createProvider, GROUP_NAME } from './api.js'

const PREFIX = 'websports-'
const claimsRef = ref => /^websports-\d{1,12}$/.test(String(ref || ''))
let defaultProvider = createProvider(), providers = new WeakMap()
function providerFor(ctx) {
  if (typeof ctx.fetchImpl !== 'function') return defaultProvider
  if (!providers.has(ctx.fetchImpl)) providers.set(ctx.fetchImpl, createProvider(ctx))
  return providers.get(ctx.fetchImpl)
}

export default {
  id: 'websports', name: 'WebSports', category: 'live',
  description: '来自第三方赛事网站的足球、篮球等比赛，每场一个频道，未开赛或已结束的场次播不了。入口页只放行大陆和香港网络，部署在其他地区的实例取不到地址。本机只中继清单，视频由播放器直连。',
  // 第三方网站、不是官方来源，不进默认内容，由用户自己打开
  defaultEnabled: false,
  capabilities: { cache: 'disk', resolve: true, epg: false, catchup: false },
  outputGroupName: GROUP_NAME, configSchema: [],
  // 三条线路的 CDN 都不看 Referer 和 UA（10-31 实测不带请求头、错误 Referer 都能取清单和分片）：
  // 本机只中继清单，视频由播放器直连，不占服务器带宽。
  relayProxyCompatible: true,
  // 第一次解析要代观众打四五个第三方页面，不能让播放器的批量探测把整张列表扫一遍
  resolveBurstGuard: true,
  defaultRefreshMinutes: 10, refreshConfigurable: false,
  refreshDescription: '自动同步赛事列表；播放时才解析线路，一条不通换下一条。',
  async fetch(_config, ctx = {}) {
    const matches = await providerFor(ctx).discover()
    return { groups: [{ name: GROUP_NAME, dataList: matches.map(match => ({
      name: `${match.time} ${match.league} ${match.home} vs ${match.away}`,
      deferredRef: `${PREFIX}${match.id}`, relayHls: true, catchup: 'none',
      // 比赛不是电视频道，按台标规则留空
      logo: '',
      opts: ['network-caching=3000'],
    })) }], meta: { skipped: [], warnings: [] } }
  },
  claimsRef,
  async resolve(ref, ctx = {}) {
    if (!claimsRef(ref)) return { url: '', desc: '未知的赛事引用' }
    try {
      const stream = await providerFor(ctx).resolve(ref.slice(PREFIX.length))
      return { url: stream.url, desc: stream.line, manifestText: stream.text, manifestUrl: stream.manifestUrl }
    } catch (error) { return { url: '', desc: error.message } }
  },
  clearResolveCache() { defaultProvider = createProvider(); providers = new WeakMap() },
}
