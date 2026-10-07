import { createProvider, GROUP_NAME, eventChannelName, HEADERS, validateSegmentUrl, verifySegment } from './api.js'
const claimsRef = ref => /^gdsport-event-[1-9]\d{0,9}$/.test(String(ref || ''))
let defaultProvider = createProvider(), providers = new WeakMap()
function providerFor(ctx) {
  if (typeof ctx.fetchImpl !== 'function') return defaultProvider
  if (!providers.has(ctx.fetchImpl)) providers.set(ctx.fetchImpl, createProvider(ctx))
  return providers.get(ctx.fetchImpl)
}

export default {
  id: 'gdsport-events', name: '广东体育赛事',
  description: '从广东体育官方 H5 获取公开赛事直播，归入广东分组并同时出现在体育分组；开播加入、结束移除。本机只中继清单，视频由播放器直连官方 CDN。',
  capabilities: { cache: 'disk', resolve: true, epg: false, catchup: false },
  catalogVersion: 1, outputGroupName: GROUP_NAME, configSchema: [],
  // 官方 CDN 不看来源头和 UA、分片地址不带签名也不绑 IP（10-06 实测：本机不带请求头、Globalping
  // 大陆家宽与机房、香港都能直接取分片）：本机只中继清单，视频由播放器直连，不占服务器带宽。
  // 全代理版订阅（?relay=2）可升级为清单和分片都经本机，resolve 里的分片校验就是给那条路用的。
  relayProxyCompatible: true,
  defaultRefreshMinutes: 1, refreshConfigurable: false,
  refreshDescription: '自动同步在播赛事，结束后移除；播放时复核官方状态并获取当前 HLS。',
  async fetch(_config, ctx = {}) {
    const events = await providerFor(ctx).discover()
    return { groups: [{ name: GROUP_NAME, dataList: events.map(event => ({
      name: eventChannelName(event), deferredRef: `gdsport-event-${event.id}`, relayHls: true, catchup: 'none',
      // 官方赛事直播间按台标规则留空，不使用比赛海报冒充电视频道台标。
      logo: '',
      opts: ['network-caching=3000'],
    })) }], meta: { skipped: [], warnings: [] } }
  },
  claimsRef,
  async resolve(ref, ctx = {}) {
    if (!claimsRef(ref)) return { url: '', desc: '未知的广东体育赛事引用' }
    try {
      const result = await providerFor(ctx).resolve(ref.slice('gdsport-event-'.length))
      return {
        url: result.url, desc: result.event.name,
        upstreamHeaders: url => {
          if (url !== result.url) validateSegmentUrl(url, result.url)
          return HEADERS
        },
        manifestText: result.text, manifestUrl: result.url,
        upstreamUrlTransform: url => validateSegmentUrl(url, result.url), segmentTransform: verifySegment,
      }
    } catch (error) { return { url: '', desc: error.message } }
  },
  clearResolveCache() { defaultProvider = createProvider(); providers = new WeakMap() },
}
