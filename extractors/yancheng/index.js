import { proxyAwareFetch } from '../../utils/systemProxy.js'
import { catalog } from './protocol.js'
import { claimsRef, resolveChannel } from './api.js'
import epg from './epg.js'

export default {
  id: 'yancheng', name: '盐城',
  description: '盐城电视一套、二套官方直播，免登录，带官方台标和今明两天节目单。',
  capabilities: { cache: 'disk', resolve: true, epg: true, catchup: false },
  catalogVersion: 1, outputGroupName: '江苏', channelHlsMode: 'proxy',
  defaultRefreshMinutes: 1440, refreshConfigurable: false,
  refreshDescription: '自动同步官网电视目录；播放时获取当前节目与短期直播地址。',
  configSchema: [],
  async fetch(config, { fetchImpl = proxyAwareFetch } = {}) {
    const channels = await catalog({ fetchImpl })
    return {
      groups: [{ name: '江苏', dataList: channels.map(c => ({ name: c.name, logo: c.logo,
        deferredRef: c.ref, opts: ['network-caching=3000'], catchup: 'none' })) }],
      meta: { skipped: [], warnings: [] },
    }
  },
  claimsRef, resolve: resolveChannel, epg,
}
