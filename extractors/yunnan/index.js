/** 云南广电：云视网四套省级频道与七彩云端三套地方频道，播放时动态取流并全代理。 */
import { buildChannels, claimsRef, clearCache, resolveChannel } from './api.js'
import epg from './epg.js'

export default {
  id: 'yunnan',
  name: '云南',
  description: '云视网云南卫视、都市、康旅、澜湄国际，以及七彩云端临沧、怒江、昭通共 7 路公开频道；无需登录，播放时动态取当前地址，清单和媒体全代理。',
  capabilities: { cache: 'disk', resolve: true, epg: true, catchup: false },
  catalogVersion: 2,
  outputGroupName: '云南',
  channelHlsMode: 'proxy',
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '自动管理：7 路固定频道表随模块版本更新；省级频道按官网接口逐档节目换取签名地址，地方频道按七彩云端目录取当前机位，清单与分片均由本机全代理。',

  configSchema: [],

  async fetch() {
    return {
      groups: [{ name: '云南', dataList: buildChannels() }],
      meta: { skipped: [], warnings: [] },
    }
  },

  claimsRef,
  resolve: resolveChannel,
  clearResolveCache: clearCache,
  // 云视网四套省级频道的官网节目单，按频道表里的 webName 取；与取流链路互不依赖（见 epg.js）
  epg,
}
