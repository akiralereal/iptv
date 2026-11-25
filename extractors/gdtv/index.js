/** 广东台荔枝网：固定本地频道引用，播放时通过官方接口自动续签短效地址。 */
import { buildChannels } from './channels.js'
import { clearCache, resolveChannel } from './resolver.js'
import epg from './epg.js'

export default {
  id: 'gdtv',
  name: '广东',
  description: '广东卫视及地面频道官方直播。自动排除购物频道，播放时无感续签官网短效地址，清单与视频分片由服务器转发。',
  // catchup: false —— 只做直播：官方直播地址不认回看时间参数（带上也照回直播），频道逐条标 catchup:'none'，不继承订阅头的回看声明
  capabilities: { cache: 'disk', resolve: true, epg: true, catchup: false },
  outputGroupName: '广东',
  // 整个模块全代理（2026-11-25）：广东卫视、珠江、大湾区卫视两路、少儿、嘉佳卡通的分片主机
  // （tx-*lizhi.gdtv.cn，Server: MC_VCLOUD_LIVE）对 UA 含「Lavf」（FFmpeg 默认，区分大小写）
  // 的请求回 403 空正文，浏览器、VLC、ExoPlayer、AVPlayer 的 UA 都放行，不看 Referer。
  // 规则按主机配：同一 CDN 的另外五个 tx-*lizhi 当天还不拦，szlizhi / lbplay（Tengine）也不拦，
  // 但随时可能扩到别的主机，所以不按主机挑，整个模块由服务器用 hlsProxy 的浏览器 UA 回源。
  // 代价：视频经服务器转发，每路约 1.3～2.3 Mbps。输出时覆盖旧频道缓存，不用递增 catalogVersion。
  channelHlsMode: 'proxy',
  // 频道表写在代码里、一天才刷新一次：改了频道或台标就递增，存量缓存在启动时重建
  // v1：经典剧、纪录片、健康三路补上广东台台标
  // v2：频道逐条标 catchup:'none'
  catalogVersion: 2,
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '自动管理：频道表随模块版本维护；播放地址在约 45 秒后后台换新，90 秒前强制续签，失败后 10 秒重试。纪录片的地址自带 30 分钟有效期，离过期 5 分钟再换。官方 CDN 拒绝部分播放器标识，清单与视频分片统一由服务器转发，会占用服务器带宽。',

  configSchema: [],
  // 官网节目单，按频道 id 取；与取流共用 HMAC 签名，不需要播放会话（见 epg.js）
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
