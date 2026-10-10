/** 青海：长云网的青海卫视、经济生活、都市，与青海藏语台官网的安多卫视；播放时动态取签名地址并中继实时清单。 */
import { buildChannels, claimsRef, clearCache, resolveChannel } from './api.js'
import epg from './epg.js'

export default {
  id: 'qinghai',
  name: '青海',
  description: '青海广电云直播平台的青海卫视、经济生活、都市（长云网）与安多卫视（青海藏语台官网）；无需登录，播放时动态取当前签名地址，本机只中继清单、分片由播放器直连官方 CDN。',
  capabilities: { cache: 'disk', resolve: true, epg: true, catchup: false },
  catalogVersion: 2,
  outputGroupName: '青海',
  channelHlsMode: 'relay',
  relayProxyCompatible: true,
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '自动管理：4 路固定频道表随模块版本更新；官网签名标称两小时，播放时取当前地址、30 分钟换一次，仅中继清单，媒体分片由播放器直连官方 CDN。',

  configSchema: [],

  async fetch() {
    return {
      groups: [{ name: '青海', dataList: buildChannels() }],
      meta: { skipped: [], warnings: [] },
    }
  },

  // 青海卫视的节目单取自央视网（见 epg.js）；平台节目单接口只有整点占位
  epg,
  claimsRef,
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
