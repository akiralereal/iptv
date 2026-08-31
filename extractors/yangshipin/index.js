/** 央视频：官方匿名直播接口，播放时获取短效 H.264 地址。 */
import { buildChannels, CHANNEL_BY_REF } from './channels.js'
import { clearCache, resolveChannel } from './resolver.js'

export default {
  id: 'yangshipin',
  name: '央视频',
  description: '央视、CGTN、卫视等 63 个官方直播频道；固定 H.264 兼容模式，自动切换可用 CDN。',
  capabilities: { cache: 'disk', resolve: true, epg: false },
  outputGroupName: '央视频',
  channelHlsMode: 'proxy',
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '自动管理：频道表随模块维护；播放时刷新短效地址并检测主、备用 CDN，清单与分片全代理。',
  configSchema: [],

  async fetch() {
    return { groups: [{ name: '央视频', dataList: buildChannels() }], meta: { skipped: [], warnings: [] } }
  },

  claimsRef: ref => CHANNEL_BY_REF.has(String(ref || '')),
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}

