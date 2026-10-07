/** 杭州文广集团五路电视频道；播放时向葫芦网频道接口取签名 HLS，清单与分片带官方来源头全代理。 */
import { buildChannels, claimsRef, clearResolveCache, resolveChannel } from './api.js'

export default {
  id: 'hangzhou',
  name: '杭州',
  description: '杭州综合、西湖明珠、杭州生活、杭州影视、杭州青少体育五路电视；播放时从葫芦网官方频道接口取签名 HLS，官方 CDN 只认自家来源，清单与分片由本机全代理。',
  capabilities: { cache: 'disk', resolve: true, epg: false, catchup: false },
  catalogVersion: 1,
  outputGroupName: '浙江',
  channelHlsMode: 'proxy',
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '自动管理：固定频道表；播放时从官方接口取签名地址（缓存到过期前半小时），清单和分片都带官方来源头经本机转发。',
  configSchema: [],

  async fetch() {
    return {
      groups: [{ name: '浙江', dataList: buildChannels() }],
      meta: { skipped: [], warnings: [] },
    }
  },

  claimsRef,
  resolve: resolveChannel,
  clearResolveCache,
}
