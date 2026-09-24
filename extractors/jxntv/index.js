/** 江西广电：官网公开八路频道，播放时匿名换票并全代理实时 HLS。 */
import {
  buildChannels,
  claimsRef,
  clearCache,
  resolveChannel,
} from './api.js'

export default {
  id: 'jxntv',
  name: '江西',
  description: '江西广电官网 8 路公开频道；无需登录，播放时自动换取匿名短效凭证并持续刷新清单。',
  capabilities: { cache: 'disk', resolve: true, epg: false, catchup: false },
  // v2：八路频道带上官方台标
  catalogVersion: 2,
  outputGroupName: '江西',
  channelHlsMode: 'proxy',
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '自动管理：固定频道表随模块版本更新；短效 token 自动续取，每次播放轮询刷新实时清单，清单和分片全代理。',

  configSchema: [],

  async fetch() {
    return {
      groups: [{ name: '江西', dataList: buildChannels() }],
      meta: { skipped: [], warnings: [] },
    }
  },

  claimsRef,
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
