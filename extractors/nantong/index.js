import { CHANNELS, catalog } from './api.js'
import { proxyAwareFetch } from '../../utils/systemProxy.js'
import epg from './epg.js'
import { claimsRef, resolveChannel, claimsLocalPath, handleLocalRequest, clearResolveCache } from './runtime.js'

export default {
  id: 'nantong', name: '南通',
  description: '南通新闻综合、社教、公共三套官方电视；部分节目时段未开放网络直播。',
  capabilities: { cache: 'disk', resolve: true, epg: true, catchup: false },
  catalogVersion: 1, outputGroupName: '江苏', channelHlsMode: 'proxy',
  defaultRefreshMinutes: 1440, refreshConfigurable: false,
  refreshDescription: '自动同步官方目录与台标；播放时复核当前节目，限制时段保留频道并提示。',
  configSchema: [],
  async fetch(config, { fetchImpl = proxyAwareFetch } = {}) {
    const channels = await catalog({ fetchImpl })
    if (channels.length !== CHANNELS.length) throw new Error('南通官方电视目录不完整')
    return {
      groups: [{ name: '江苏', dataList: channels.map(c => ({
        name: c.name, logo: c.logo, deferredRef: c.ref,
        opts: ['network-caching=3000'], catchup: 'none',
      })) }],
      meta: { skipped: [], warnings: [] },
    }
  },
  epg, claimsRef, resolve: resolveChannel, claimsLocalPath, handleLocalRequest, clearResolveCache,
}
