/** 嘉兴在线「看电视」的三套公开频道；播放时通过趣看接口获取动态签名。 */
import { buildChannels, claimsRef, resolveChannel } from './api.js'

export default {
  id: 'jiaxing',
  name: '嘉兴',
  description: '嘉兴在线三套电视直播；播放时从趣看公开接口获取签名 HLS，由本机中继实时清单。',
  capabilities: { cache: 'disk', resolve: true, epg: false, catchup: false },
  catalogVersion: 1,
  outputGroupName: '浙江',
  channelHlsMode: 'relay',
  relayProxyCompatible: true,
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '自动管理：固定频道表；每次播放获取新签名并检查实时清单，分片由播放器直连官方 CDN。',
  configSchema: [],

  async fetch() {
    return {
      groups: [{ name: '浙江', dataList: buildChannels() }],
      meta: { skipped: [], warnings: [] },
    }
  },

  claimsRef,
  resolve: resolveChannel,
}
