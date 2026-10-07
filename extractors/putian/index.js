/** 莆田广播电视台三路电视频道；播放时从莆田TV频道接口取签名 HLS，本机中继实时清单。 */
import { buildChannels, claimsRef, clearResolveCache, resolveChannel } from './api.js'
import epg from './epg.js'

export default {
  id: 'putian',
  name: '莆田',
  description: '莆田TV 官方直播的新闻综合、文旅生活与仙游电视台三路电视频道；播放时取官方签名 HLS，由本机中继实时清单。',
  capabilities: { cache: 'disk', resolve: true, epg: true, catchup: false },
  catalogVersion: 1,
  outputGroupName: '福建',
  channelHlsMode: 'relay',
  relayProxyCompatible: true,
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '自动管理：固定频道表；播放时从频道接口取签名地址（缓存到过期前半小时），本机刷新清单，分片由播放器直连官方 CDN。',
  configSchema: [],

  async fetch() {
    return {
      groups: [{ name: '福建', dataList: buildChannels() }],
      meta: { skipped: [], warnings: [] },
    }
  },

  claimsRef,
  resolve: resolveChannel,
  clearResolveCache,
  // 一套、二套是真编排；仙游天天占位，照样去取（见 epg.js）
  epg,
}
