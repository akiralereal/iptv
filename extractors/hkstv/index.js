/** 香港卫视：官网单路公开电视直播，播放时刷新入口与实时 HLS 清单。 */
import {
  buildChannels,
  claimsRef,
  clearCache,
  resolveChannel,
} from './api.js'
import epg from './epg.js'

export default {
  id: 'hkstv',
  name: '香港卫视',
  description: '香港卫视官网公开的一路电视直播，归入香港分组；无需登录，播放时动态获取当前入口，清单与视频分片由服务器转发。',
  capabilities: { cache: 'disk', resolve: true, epg: true, catchup: false },
  catalogVersion: 1,
  outputGroupName: '香港',
  channelHlsMode: 'proxy',
  relayProxyCompatible: true,
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '自动管理：频道固定为官网这一路直播；入口短期缓存，滚动清单每次播放请求重新获取。官方 CDN 限制播放器标识，清单与视频分片统一以兼容标识由服务器转发，会占用服务器带宽。',

  configSchema: [],
  // 官网直播页的節目單；与取流链路互不依赖（见 epg.js）
  epg,

  async fetch() {
    return {
      groups: [{ name: '香港', dataList: buildChannels() }],
      meta: { skipped: [], warnings: [] },
    }
  },

  claimsRef,
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
