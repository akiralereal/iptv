import { CHANNELS, claimsRef, resolveChannel } from './api.js'
import epg from './epg.js'

export default {
  id: 'shaoxing', name: '绍兴',
  description: '绍兴网三套官方电视直播；自动发现官网当前地址，验证实时 HLS 和 TS 分片后播放。',
  capabilities: { cache: 'disk', resolve: true, epg: true, catchup: false },
  catalogVersion: 1, outputGroupName: '浙江',
  channelHlsMode: 'relay', relayProxyCompatible: true,
  defaultRefreshMinutes: 1440, refreshConfigurable: false,
  refreshDescription: '固定已验证频道；每次播放重新发现官方源，支持域名、路径与签名变更。',
  configSchema: [],
  async fetch() {
    return {
      groups: [{ name: '浙江', dataList: CHANNELS.map(channel => ({
        name: channel.name, logo: channel.logo, deferredRef: channel.ref,
        opts: ['network-caching=3000'], catchup: 'none',
      })) }],
      meta: { skipped: [], warnings: [] },
    }
  },
  claimsRef, resolve: resolveChannel, epg,
}
