import { buildChannels, claimsRef, resolveChannel } from './api.js'
import epg from './epg.js'

export default {
  id: 'sichuan-cities', name: '四川市州',
  description: '四川 18 个市州共 25 路官方电视直播，免登录，归入四川；凉山两套及攀枝花带官方节目单。',
  capabilities: { cache: 'disk', resolve: true, epg: true, catchup: false },
  catalogVersion: 3, outputGroupName: '四川', relayProxyCompatible: true,
  defaultRefreshMinutes: 1440, refreshConfigurable: false,
  refreshDescription: '目录短缓存 30 秒；绵阳、阿坝、乐山、眉山复用官方 CDN 会话，拒绝后重新取址。遂宁、达州、凉山、资阳七路全代理，其余中继清单、分片直连。',
  configSchema: [],
  epg,
  async fetch() {
    return { groups: [{ name: '四川', dataList: buildChannels() }], meta: { skipped: [], warnings: [] } }
  },
  claimsRef, resolve: resolveChannel,
}
