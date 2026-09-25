/** 泉州广播电视台闽南语频道：官网公开接口签发短期 HLS，播放时取签名并全代理。 */
import { buildChannels, claimsRef, resolveChannel } from './api.js'

export default {
  id: 'quanzhou-minnan',
  name: '泉州',
  description: '从泉州广播电视台公开播放接口获取闽南语频道的短期签名 HLS。',
  capabilities: { cache: 'disk', resolve: true, epg: false, catchup: false },
  catalogVersion: 1,
  outputGroupName: '福建',
  channelHlsMode: 'proxy',
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '自动管理：固定频道表；播放时向官网取当前签名并验证实时清单。',
  configSchema: [],

  async fetch() {
    return {
      groups: [{ name: '福建', dataList: buildChannels() }],
      meta: { skipped: [], warnings: [] },
    }
  },

  claimsRef,
  resolve: resolveChannel,
}
