/** 陕西广电：陕西网络广播电视台看电视页的八套频道，播放时现解官网频道目录并中继实时清单。 */
import { buildChannels, claimsRef, clearCache, resolveChannel } from './api.js'
import epg from './epg.js'

export default {
  id: 'shaanxi',
  name: '陕西',
  description: '陕西广电官网 8 套频道（陕西卫视、农林卫视与新闻资讯、都市青春、银龄、秦腔、体育休闲、移动电视）；无需登录，播放时动态取当前地址，本机只中继清单、分片由播放器直连官方 CDN。',
  capabilities: { cache: 'disk', resolve: true, epg: true, catchup: false },
  catalogVersion: 1,
  outputGroupName: '陕西',
  channelHlsMode: 'relay',
  relayProxyCompatible: true,
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '自动管理：8 路固定频道表随模块版本更新；官网播放地址会不定期换名，播放时现解官网频道目录（5 分钟复用，失效即重读），仅中继清单，媒体分片由播放器直连官方 CDN。',

  configSchema: [],
  // 官网节目单，只有当天；与取流链路互不依赖（见 epg.js）
  epg,

  async fetch() {
    return {
      groups: [{ name: '陕西', dataList: buildChannels() }],
      meta: { skipped: [], warnings: [] },
    }
  },

  claimsRef,
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
