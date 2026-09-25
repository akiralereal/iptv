/** 甘肃广电：官网六路公开频道，播放时刷新入口与实时 HLS 清单。 */
import {
  buildChannels,
  claimsRef,
  clearCache,
  resolveChannel,
} from './api.js'
import epg from './epg.js'

export default {
  id: 'gansu',
  name: '甘肃',
  description: '甘肃广电官网 6 路公开频道；无需登录，播放时动态获取当前 HLS，并由本机中继实时清单。',
  capabilities: { cache: 'disk', resolve: true, epg: true, catchup: false },
  catalogVersion: 1,
  outputGroupName: '甘肃',
  channelHlsMode: 'relay',
  relayProxyCompatible: true,
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '自动管理：固定频道表随模块版本更新；播放入口短期共享，滚动清单每次重新获取且仅中继清单，媒体分片由播放器直连官方 CDN。',

  configSchema: [],

  async fetch() {
    return {
      groups: [{ name: '甘肃', dataList: buildChannels() }],
      meta: { skipped: [], warnings: [] },
    }
  },

  // 甘肃卫视的节目单取自央视网（见 epg.js）；地面频道官方没有
  epg,
  claimsRef,
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
