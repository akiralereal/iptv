/** 贵州广电：官网八路公开频道，播放时刷新短效签名并全代理。 */
import { buildChannels, claimsRef, clearCache, resolveChannel } from './api.js'

export default {
  id: 'gzstv',
  name: '贵州',
  description: '贵州广电官网 8 路公开频道；无需登录，播放时获取短效签名，清单和媒体全代理。',
  capabilities: { cache: 'disk', resolve: true, epg: false, catchup: false },
  // v2：八路频道带上官方台标
  catalogVersion: 2,
  outputGroupName: '贵州',
  channelHlsMode: 'proxy',
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '自动管理：8 路固定频道表随模块版本更新；播放时刷新官方短效地址，每次轮询重新获取滚动清单。',

  configSchema: [],

  async fetch() {
    return {
      groups: [{ name: '贵州', dataList: buildChannels() }],
      meta: { skipped: [], warnings: [] },
    }
  },

  claimsRef,
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
