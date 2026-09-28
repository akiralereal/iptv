/** 天津广电：津云 App 的七路电视频道，播放时按 App 的 WiseTV 协议签发地址，清单与分片由本机全代理。 */
import { buildChannels, claimsRef, clearCache, resolveChannel } from './api.js'
import epg from './epg.js'

export default {
  id: 'tianjin',
  name: '天津',
  description: '津云 App 的天津卫视、新闻、文艺、影视、都市、体育、教育 7 路电视频道；无需登录，播放时按 App 协议签发短效地址，清单与分片由本机代理。',
  capabilities: { cache: 'disk', resolve: true, epg: true, catchup: false },
  catalogVersion: 1,
  outputGroupName: '天津',
  // 网宿 CDN（live2）的会话绑定取清单那一方的 UA，播放器直连分片会 403，只能全代理（见 api.js）
  channelHlsMode: 'proxy',
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '自动管理：7 路固定频道表随模块版本更新；开播时按频道签发地址（7 分钟内复用），播放中直接轮询官方媒体清单、不随轮询重签，清单与分片均经本机代理。',

  configSchema: [],
  // 津云官方节目单，与取流共用 auth.js 的应用参数（见 epg.js）
  epg,

  async fetch() {
    return {
      groups: [{ name: '天津', dataList: buildChannels() }],
      meta: { skipped: [], warnings: [] },
    }
  },

  claimsRef,
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
