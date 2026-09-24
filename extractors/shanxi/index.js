/** 山西广电：官网直播页六套省级频道与十套地市频道，播放时动态取流并中继实时清单。 */
import { buildChannels, claimsRef, clearCache, resolveChannel } from './api.js'
import epg from './epg.js'

export default {
  id: 'shanxi',
  name: '山西',
  description: '山西广电官网 6 套省级频道，以及太原、晋中、运城等 10 个地市频道；无需登录，播放时动态取当前地址，本机只中继清单、分片由播放器直连官方 CDN。',
  capabilities: { cache: 'disk', resolve: true, epg: true, catchup: false },
  catalogVersion: 1,
  outputGroupName: '山西',
  channelHlsMode: 'relay',
  relayProxyCompatible: true,
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '自动管理：16 路固定频道表随模块版本更新；省级频道每次轮询按上海时区重算当日路径，地市频道 30 秒换一次官网签名，仅中继清单，媒体分片由播放器直连官方 CDN。',

  configSchema: [],
  // 官网节目单，按频道表里的 epgKey 取；与取流链路互不依赖（见 epg.js）
  epg,

  async fetch() {
    return {
      groups: [{ name: '山西', dataList: buildChannels() }],
      meta: { skipped: [], warnings: [] },
    }
  },

  claimsRef,
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
