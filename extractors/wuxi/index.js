/** 无锡广电五路电视频道；播放时从无锡博报分享页取签名 HLS，本机中继实时清单。 */
import { buildChannels, claimsRef, clearResolveCache, resolveChannel } from './api.js'
import epg from './epg.js'

export default {
  id: 'wuxi',
  name: '无锡',
  description: '无锡博报 App 直播页的五路电视频道；播放时从官方分享页取签名 HLS，由本机中继实时清单。',
  capabilities: { cache: 'disk', resolve: true, epg: true, catchup: false },
  catalogVersion: 1,
  outputGroupName: '江苏',
  channelHlsMode: 'relay',
  relayProxyCompatible: true,
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '自动管理：固定频道表；播放时从分享页取签名地址（缓存到过期前半小时），本机刷新清单，分片由播放器直连官方 CDN。',
  configSchema: [],

  async fetch() {
    return {
      groups: [{ name: '江苏', dataList: buildChannels() }],
      meta: { skipped: [], warnings: [] },
    }
  },

  claimsRef,
  resolve: resolveChannel,
  clearResolveCache,
  epg,
}
