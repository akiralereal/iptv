import { CHANNEL, infoUrl, readOfficial, selectChannel } from './protocol.js'
import { claimsRef, loadCatalog, resolveChannel } from './api.js'
import epg from './epg.js'

export default {
  id: 'jiangmen', name: '江门',
  description: '江门广播电视台官方综合频道；官方台标、今明两天节目单，免登录。',
  capabilities: { cache: 'disk', resolve: true, epg: true, catchup: false },
  catalogVersion: 1, outputGroupName: '广东', channelHlsMode: 'proxy',
  defaultRefreshMinutes: 1440, refreshConfigurable: false,
  refreshDescription: '固定正式电视频道；播放时自动核对官方目录并按上海日期更新入口。',
  configSchema: [],
  async fetch(config, { fetchImpl } = {}) {
    if (fetchImpl) selectChannel(JSON.parse((await readOfficial(infoUrl(), { fetchImpl })).toString('utf8')))
    else await loadCatalog()
    return {
      groups: [{ name: '广东', dataList: [{ name: CHANNEL.name, logo: CHANNEL.logo,
        deferredRef: CHANNEL.ref, opts: ['network-caching=3000'], catchup: 'none' }] }],
      meta: { skipped: [], warnings: [] },
    }
  },
  claimsRef, resolve: resolveChannel, epg,
}
