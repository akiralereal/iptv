/** 仅收录已验证的台州地区官方电视直播。 */
import { buildChannels, claimsRef, resolveChannel } from './api.js'

export default {
  id: 'taizhou',
  name: '台州',
  description: '天台县和合频道官方直播；免登录，归入浙江分组。',
  capabilities: { cache: 'disk', resolve: true, epg: false, catchup: false },
  catalogVersion: 1,
  outputGroupName: '浙江',
  channelHlsMode: 'relay',
  relayProxyCompatible: true,
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '自动管理：固定频道表；每次播放获取新签名并检查实时清单，分片直连官方 CDN。',
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
