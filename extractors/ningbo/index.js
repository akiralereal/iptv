/** 宁波广电集团四路电视频道；播放时按官网播放器的流程向官方签名接口取 HLS，本机中继实时清单。 */
import { buildChannels, claimsRef, clearResolveCache, resolveChannel } from './api.js'

export default {
  id: 'ningbo',
  name: '宁波',
  description: '宁波新闻综合、经济生活、都市文体、影视剧四路电视；播放时按宁波广电网播放器的流程向官方签名接口取 HLS，由本机中继实时清单。',
  capabilities: { cache: 'disk', resolve: true, epg: false, catchup: false },
  catalogVersion: 1,
  outputGroupName: '浙江',
  channelHlsMode: 'relay',
  relayProxyCompatible: true,
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '自动管理：固定频道表；播放时向官方签名接口取地址（缓存到过期前 15 分钟），本机刷新清单，分片由播放器直连官方 CDN。',
  configSchema: [],

  async fetch() {
    return {
      groups: [{ name: '浙江', dataList: buildChannels() }],
      meta: { skipped: [], warnings: [] },
    }
  },

  claimsRef,
  resolve: resolveChannel,
  clearResolveCache,
}
