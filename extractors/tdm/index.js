/** 澳广视（TDM）自办六套电视：官网公开直播，播放时按官方路由接口取当前网络可用的 CDN。 */
import { buildChannels, claimsRef, clearResolveCache, resolveChannel } from './api.js'
import epg from './epg.js'
import { outboundFetch, outboundProxyUrl } from '../../utils/outboundProxy.js'
import { fetchUpstreamResponse } from '../../utils/hlsProxy.js'

export default {
  id: 'tdm',
  name: '澳门',
  category: 'overseas',
  outbound: 'proxy',
  proxyProbe: { name: '澳门（澳广视）', url: 'https://www.tdm.com.mo/api/v1/common/get-domain' },
  // 官网、路由接口与各路 CDN（live3 / live5 / globallive…）都在这个域下（api.js 的 OFFICIAL_HOST_RE 只放行它）
  proxyHosts: ['tdm.com.mo'],
  description: '澳广视（TDM）自办的六套电视：澳视澳门、澳视葡文、澳门体育、澳门资讯、澳门综艺、澳门-Macau。可在「设置 → 网络代理」配置代理：官网取址、节目单和视频均经服务器代理，播放设备无需设置代理。未配置代理时，部署机器和播放器都需要能访问官网及官方 CDN。默认关闭，需要时手动打开。',
  // 默认关闭；用户确认直连网络或代理可用后自行打开
  defaultEnabled: false,
  capabilities: { cache: 'disk', resolve: true, epg: true, catchup: false },
  catalogVersion: 1,
  epgFetch: outboundFetch,
  channelHlsModeForConfig: () => outboundProxyUrl() ? 'proxy' : undefined,
  fetchProxyMedia: (_ref, _config, url, options) => fetchUpstreamResponse(url, { ...options, fetchImpl: outboundFetch }),
  outputGroupName: '澳门',
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '固定频道表；播放时向官方路由接口取当前网络可用的 CDN（缓存 5 分钟），有生效代理时清单和视频经服务器转发，否则由播放器直连官方 CDN。',
  configSchema: [],

  async fetch() {
    return {
      groups: [{ name: '澳门', dataList: buildChannels() }],
      meta: { skipped: [], warnings: [] },
    }
  },

  // 官网直播页自用的节目单接口（见 epg.js）；与取流链路互不依赖
  epg,
  claimsRef,
  resolve: resolveChannel,
  clearResolveCache,
}
