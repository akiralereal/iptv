/** 大爱电视：官网两路公开电视直播，归入台湾分组，清单与分片全代理。 */
import { buildChannels, claimsRef, resolveChannel } from './api.js'
import epg from './epg.js'

export default {
  id: 'daai',
  name: '大爱电视',
  description: '大爱电视官网公开的大爱一台、二台，归入台湾分组；无需登录，官方地址无签名但按 Referer 防盗链，清单和媒体全代理。',
  capabilities: { cache: 'disk', resolve: true, epg: true, catchup: false },
  // v2：两台补上官方频道卡台标
  catalogVersion: 2,
  outputGroupName: '台湾',
  channelHlsMode: 'proxy',
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '自动管理：两路固定频道表随模块版本更新；官方地址不带签名，播放时由本机补齐官网防盗链请求头并全代理清单与分片。',

  configSchema: [],
  // 官网逐日节目表；与取流链路互不依赖（见 epg.js）
  epg,

  async fetch() {
    return {
      groups: [{ name: '台湾', dataList: buildChannels() }],
      meta: { skipped: [], warnings: [] },
    }
  },

  claimsRef,
  resolve: resolveChannel,
}
