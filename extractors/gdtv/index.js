/** 广东台荔枝网：固定本地频道引用，播放时由常驻浏览器自动续签短效地址。 */
import { buildChannels } from './channels.js'
import { clearCache, resolveChannel } from './resolver.js'
import epg from './epg.js'

export default {
  id: 'gdtv',
  name: '广东',
  description: '广东卫视及地面频道官方直播。自动排除购物频道，播放时无感续签官网短效地址。',
  capabilities: { cache: 'disk', resolve: true, epg: true },
  outputGroupName: '广东',
  // 频道表写在代码里、一天才刷新一次：改了频道或台标就递增，存量缓存在启动时重建
  // v1：经典剧、纪录片、健康三路补上广东台台标
  catalogVersion: 1,
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '自动管理：频道表随模块版本维护；播放地址在约 45 秒后后台换新，90 秒前强制续签，失败后 10 秒重试。纪录片的地址自带 30 分钟有效期，离过期 5 分钟再换。',

  configSchema: [],
  // 官网节目单，按频道 id 取；纯 HMAC 签名，不走取流那套浏览器会话（见 epg.js）
  epg,

  async fetch() {
    return {
      groups: [{ name: '广东电视台', dataList: buildChannels() }],
      meta: { skipped: [{ name: '南方购物', reason: '购物频道' }], warnings: [] },
    }
  },

  claimsRef: ref => /^gdtv-(?:15|16|43|44|45|46|47|48|51|53|54|66|74|94|99|100|102)$/.test(String(ref || '')),
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
