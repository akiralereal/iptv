/** 央视频：官方匿名直播接口，播放时获取短效 H.264 地址。 */
import { buildChannels, CHANNEL_BY_REF } from './channels.js'
import { clearCache, resolveChannel } from './resolver.js'

export default {
  id: 'yangshipin',
  name: '央视频',
  description: '央视、CGTN、卫视等 63 个官方直播频道；固定 H.264 兼容模式，自动切换可用 CDN。',
  capabilities: { cache: 'disk', resolve: true, epg: false },
  outputGroupName: '央视频',
  // 分片必须由播放器直连 CDN，不能经本机转发：实测同一路频道，全代理下本机去拉分片被
  // 平台回 403，而清单直出（分片直连）与纯 302 两种方式都能稳定播放。差别只在「谁去拉分片」——
  // 播放器直连带着 TLS 会话复用与 keep-alive，本机代理则是每片一次裸请求，后者会被判成异常流量。
  // 用 relay 而非 302：清单仍由本机下发，不跟随跳转的播放器（issue #98 的极影视）照样能播。
  channelHlsMode: 'relay',
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '自动管理：频道表随模块维护；播放时刷新短效地址并选出可用 CDN，清单由本机下发、分片由播放器直连。',
  configSchema: [],

  async fetch() {
    return { groups: [{ name: '央视频', dataList: buildChannels() }], meta: { skipped: [], warnings: [] } }
  },

  claimsRef: ref => CHANNEL_BY_REF.has(String(ref || '')),
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}

