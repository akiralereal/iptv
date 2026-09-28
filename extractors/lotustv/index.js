/** 澳门莲花卫视：官网单路公开直播，播放时解析签名 HLS。 */
import { buildChannels, claimsRef, clearResolveCache, resolveChannel } from './api.js'
import epg from './epg.js'

export default {
  id: 'lotustv',
  name: '澳门莲花卫视',
  description: '从莲花卫视官网播放器动态获取带签名的直播入口，实时转发清单，媒体分片由播放器直连官方 CDN。',
  capabilities: { cache: 'disk', resolve: true, epg: true, catchup: false },
  catalogVersion: 1,
  outputGroupName: '澳门',
  channelHlsMode: 'relay',
  relayProxyCompatible: true,
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '自动管理：固定频道表；播放时检查实时清单，官网签名入口短期缓存，失效后重新获取。',
  configSchema: [],

  async fetch() {
    return {
      groups: [{ name: '澳门', dataList: buildChannels() }],
      meta: { skipped: [], warnings: [] },
    }
  },

  // 官网「節目單」页，一页一周（见 epg.js）；与取流链路互不依赖
  epg,
  claimsRef,
  resolve: resolveChannel,
  clearResolveCache,
}
