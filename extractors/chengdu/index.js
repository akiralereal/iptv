import { buildChannels, claimsRef, resolveChannel } from './api.js'
import epg from './epg.js'

export default {
  id: 'chengdu',
  name: '成都',
  description: '成都六套电视、蓉城先锋及 20 路区县频道，共 27 路；免登录，播放时获取官方签名地址，默认 302 跳转、播放器直连。',
  capabilities: { cache: 'disk', resolve: true, epg: true, catchup: false },
  catalogVersion: 1,
  outputGroupName: '四川',
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '自动管理：固定频道表；每次播放从看度官方接口获取当前签名，成都主频道优先高清，不转码、不常驻浏览器。',
  configSchema: [],
  epg,

  async fetch() {
    return {
      groups: [{ name: '四川', dataList: buildChannels() }],
      meta: { skipped: [], warnings: [] },
    }
  },
  claimsRef,
  resolve: resolveChannel,
}
