/** 西藏广播电视台：「珠峰云」App 直播页三路频道，播放时取当前签名地址并中继实时清单。 */
import { buildChannels, claimsRef, clearCache, resolveChannel } from './api.js'

export default {
  id: 'xizang',
  name: '西藏',
  description: '西藏广播电视台「珠峰云」App 的西藏卫视、藏语卫视、影视文化 3 路频道；无需登录，播放时取当前签名地址，本机只中继清单、分片由播放器直连官方 CDN。',
  capabilities: { cache: 'disk', resolve: true, epg: false, catchup: false },
  catalogVersion: 1,
  outputGroupName: '西藏',
  channelHlsMode: 'relay',
  relayProxyCompatible: true,
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '自动管理：3 路固定频道表随模块版本更新；频道地址五分钟复用一次（签名一小时以上有效），清单被拒时立即重取，仅中继清单，媒体分片由播放器直连官方 CDN。',

  configSchema: [],

  async fetch() {
    return {
      groups: [{ name: '西藏', dataList: buildChannels() }],
      meta: { skipped: [], warnings: [] },
    }
  },

  claimsRef,
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
