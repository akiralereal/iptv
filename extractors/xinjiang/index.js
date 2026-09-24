/** 新疆广播电视台：丝路视听网五路公开频道，播放时动态签发 HLS。 */
import {
  buildChannels,
  claimsRef,
  clearCache,
  resolveChannel,
} from './api.js'
import epg from './epg.js'

export default {
  id: 'xinjiang',
  name: '新疆',
  description: '新疆广播电视台官网 5 路公开频道；无需登录，播放时解析当天签名配置并获取短效 HLS。',
  capabilities: { cache: 'disk', resolve: true, epg: true, catchup: false },
  catalogVersion: 1,
  outputGroupName: '新疆',
  channelHlsMode: 'relay',
  relayProxyCompatible: true,
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '自动管理：固定频道表随模块版本更新；播放时从官网签发约一小时有效的入口并实时刷新清单。',

  configSchema: [],
  // 官网节目单，按频道接口 Id 取；与取流链路互不依赖（见 epg.js）
  epg,

  async fetch() {
    return {
      groups: [{ name: '新疆', dataList: buildChannels() }],
      meta: { skipped: [], warnings: [] },
    }
  },

  claimsRef,
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
