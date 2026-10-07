/** 亚洲、公共直播实验台成果的生产接入：要动态解析当前 HLS 的频道，以及要把最高档挪到最前的频道。 */
import { clearCache, resolveChannel } from './api.js'
import { buildGroups, claimsRef, SOURCES } from './channels.js'
import epg from './epg.js'

export default {
  id: 'asian-live',
  name: '亚洲与国际直播',
  description: `来自独立实验台验证的 ${SOURCES.length} 个公开直播频道（YTN、NHK World、CNA、France 24 English / Français、World Poker Tour），播放时从最高画质起播；其余固定直连源由内置 IPTV.m3u 提供。`,
  capabilities: { cache: 'disk', resolve: true, epg: true, catchup: false },
  // v1：频道表补上官方台标。此前未声明，老缓存没有版本号，启动时会按新表重建一次
  // v2：加 CNA、France 24 English / Français、World Poker Tour；代理改按频道声明（YTN、NHK 全代理，其余只转发主清单）
  catalogVersion: 2,
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '频道表随模块版本维护；YTN、NHK World 播放时从官方接口获取当前 HLS，清单与媒体由本机代理；CNA、France 24 English / Français、World Poker Tour 只由本机转发一次主清单（最高档在前），视频由播放器直连官方 CDN。',
  configSchema: [],
  // YTN / NHK World 官方节目表（均为 UTC+9）；与取流链路互不依赖（见 epg.js）
  epg,

  async fetch() {
    return { groups: buildGroups(), meta: { skipped: [], warnings: [] } }
  },

  claimsRef,
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
