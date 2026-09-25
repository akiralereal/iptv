/** GOOD TV：官网两路公开电视直播，归入台湾分组，两条官方线路择优，清单与分片全代理。 */
import { buildChannels, claimsRef, resolveChannel } from './api.js'
import epg from './epg.js'

export default {
  id: 'goodtv',
  name: 'GOOD TV',
  description: 'GOOD TV 好消息电视台官网公开的综合台、真理台（1080p），归入台湾分组；无需登录，官网的两条线路自动择优、出错即换线，清单和媒体全代理。',
  capabilities: { cache: 'disk', resolve: true, epg: true, catchup: false },
  // v2：两台补上官方频道卡台标
  catalogVersion: 2,
  outputGroupName: '台湾',
  channelHlsMode: 'proxy',
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '自动管理：两路固定频道表随模块版本更新；官方地址不带签名，播放时在官网的 CloudFront / Akamai 两条线路间择优，当前线路取不到清单会当场换线。其中一条线路只放行常见播放器标识，清单与分片一律经本机全代理回源。',

  configSchema: [],
  // 官网直播页的节目表；与取流链路互不依赖（见 epg.js）
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
