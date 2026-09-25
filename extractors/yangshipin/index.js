/** 央视频：63 个公开频道匿名取流，10 个会员频道由官网浏览器解扰。 */
import { buildChannels, claimsRef } from './channels.js'
import epg from './epg.js'
import { clearCache, resolveChannel } from './resolver.js'
import { browserLoginFlow, claimsLocalPath, handleLocalRequest, shutdown } from './runtime.js'

export default {
  id: 'yangshipin',
  name: '央视频',
  description: '63 个公开频道匿名取流，另含 10 个需登录/VIP 的频道；会员流由官网播放器自动解扰为 H.264。',
  category: 'account',
  // catchup: false —— 只做直播。官方接口虽有 playbacktime 时移，但按频道/时段受版权门控
  //（CCTV13 全时段拒、CCTV1 部分时段拒），回看需求交给同台的咪咕源承担（issue #119）。
  capabilities: { cache: 'disk', resolve: true, epg: true, catchup: false },
  // v2：在原有 63 个公开频道之外加入 10 个官网会员频道。递增后会让存量部署
  // 在启动生成播放列表前重建缓存，不必等待默认 24 小时刷新周期。
  // v3：频道表逐条标 catchup:'none'，收回订阅头全局回看声明对央视频的误导（issue #119）。
  // v4：频道带上官网电视页的官方台标（默认不再有台标库兜底）。
  catalogVersion: 4,
  outputGroupName: '央视频',
  // 公开频道分片必须由播放器直连 CDN，不能经本机转发：实测同一路频道，全代理下本机去拉分片被
  // 平台回 403，而清单直出（分片直连）与纯 302 两种方式都能稳定播放。差别只在「谁去拉分片」——
  // 播放器直连带着 TLS 会话复用与 keep-alive，本机代理则是每片一次裸请求，后者会被判成异常流量。
  // 用 relay 而非 302：清单仍由本机下发，不跟随跳转的播放器（issue #98 的极影视）照样能播。
  channelHlsMode: 'relay',
  // 播放器「刷新预览图 / 检测可用性 / 失败自动换台」会在几十秒内把 63 个公开频道逐一 GET 一遍，
  // 每台一张票加一两次清单，全从本机出口打官方，正好撞按 IP 的限频（共享实例两天 1487 次 403，
  // 一被限连正在看的人也一起 403）。HEAD 探活 app.js 已本地应答，GET 这一半交给客户端批量探测
  // 防护本地拒绝，见 utils/clientScanGuard.js。
  resolveBurstGuard: true,
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '自动管理：公开频道播放时刷新短效地址并让分片直连 CDN；VIP 频道由本机官网浏览器持续解扰并输出兼容 HLS。',
  helper: 'yangshipin-login',
  configSchema: [],
  // 官网节目单，按频道表里的 livePid 取；与取流链路互不依赖（见 epg.js）
  epg,

  async fetch() {
    return { groups: [{ name: '央视频', dataList: buildChannels() }], meta: { skipped: [], warnings: [] } }
  },

  claimsRef,
  resolve: resolveChannel,
  clearResolveCache: clearCache,
  browserLoginFlow,
  claimsLocalPath,
  handleLocalRequest,
  shutdown,
}
