/** 亚洲直播实验台成果的生产接入：固定频道表，播放时解析并校验当前 HLS。 */
import { clearCache, resolveChannel } from './api.js'
import { buildGroups, claimsRef, SOURCES } from './channels.js'

export default {
  id: 'asian-live',
  name: '亚洲与国际直播',
  description: `来自独立实验台验证的 ${SOURCES.length} 个公开直播频道，覆盖港台、日韩、国际资讯、体育、文旅与娱乐。`,
  capabilities: { cache: 'disk', resolve: true, epg: false, catchup: false },
  channelHlsMode: 'relay',
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '频道表随模块版本维护；每次播放都会重新获取并校验当前 HLS 清单，媒体默认直连 CDN。',
  configSchema: [],

  async fetch() {
    return { groups: buildGroups(), meta: { skipped: [], warnings: [] } }
  },

  claimsRef,
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
