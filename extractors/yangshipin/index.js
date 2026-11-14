/** 央视频：63 个公开频道匿名取流，10 个会员频道由官网浏览器解扰。 */
import { buildChannels, claimsRef } from './channels.js'
import epg from './epg.js'
import { clearCache, resolveChannel } from './resolver.js'
import { browserLoginFlow, claimsLocalPath as claimsVipPath, credentialRejected, handleLocalRequest as handleVipRequest, shutdown as shutdownVip } from './runtime.js'
import { createCastGateway } from './cast/gateway.js'

const castGateway = createCastGateway({ resolveMain: resolveChannel })

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
  // 原方案的公开频道分片由播放器直连 CDN：实测同一路频道，全代理下本机去拉分片被
  // 平台回 403，而清单直出（分片直连）与纯 302 两种方式都能稳定播放。差别只在「谁去拉分片」——
  // 播放器直连带着 TLS 会话复用与 keep-alive，本机代理则是每片一次裸请求，后者会被判成异常流量。
  // 用 relay 而非 302：清单仍由本机下发，不跟随跳转的播放器（issue #98 的极影视）照样能播。
  channelHlsMode: 'relay',
  // 播放器「刷新预览图 / 检测可用性 / 失败自动换台」会在几十秒内把 63 个公开频道逐一 GET 一遍，
  // 每台一张票加一两次清单，全从本机出口打官方，正好撞按 IP 的限频（共享实例两天 1487 次 403，
  // 一被限连正在看的人也一起 403）。HEAD 探活 app.js 已本地应答，GET 这一半交给客户端批量探测
  // 防护本地拒绝，见 utils/clientScanGuard.js。这只管公开频道（走 resolve）；10 个会员频道走本地
  // 媒体路由，由 runtime.js 的 vipBurstRefusal 接上同一本账。
  // 按客户端的账拦不住多设备各扫几个、两秒一台的慢扫，出口一旦被限连换新票都 403（issue #162）：
  // resolver.js 另有实例级取票预算（TICKET_BUDGET）兜底，只拦冷启动，正在播的不受影响。
  resolveBurstGuard: true,
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '自动管理：三台超高清按所选来源播放，其他公开台刷新短效地址并让分片直连 CDN；VIP 保持官网播放桥。',
  helper: 'yangshipin-login',
  // 刷新（每天一次）不查；登录态由 6 小时保活、会员台播放、后台检查读账号时发现，经 credentialRejected 上报
  credentialCheck: { refresh: false, playback: true, degrade: '10 个会员频道照留但播不了（没有游客版），63 个公开频道不受影响' },
  configSchema: [{ key: 'uhdSource', label: '超高清频道播放来源', type: 'select', default: 'cast',
    options: [{ value: 'cast', label: '投屏方案（默认）' }, { value: 'main', label: '原方案' }],
    hint: '仅影响 CCTV4K、CCTV16 4K、CCTV8K；其他频道和会员登录保持原方案。投屏流经服务器转发，会占用媒体带宽，首次启播可能稍慢。CCTV8K 当前实测为 4K。保存后停止播放、重新打开频道生效。' }],
  configSavedNotice: '超高清来源已保存，重新打开频道后生效；当前播放不自动切源。',
  // 官网节目单，按频道表里的 livePid 取；与取流链路互不依赖（见 epg.js）
  epg,

  async fetch() {
    return { groups: [{ name: '央视频', dataList: buildChannels() }], meta: { skipped: [], warnings: [] } }
  },

  claimsRef,
  // 登录态失效由保活 / 会员台播放 / 后台检查读账号时发现（runtime.js 的失效记录），这里交给提醒中心
  credentialRejected,
  resolve: resolveChannel,
  // This setting only selects the next master. Keep active original-source history,
  // tickets and refreshers intact when saving it; manual cache clears still work.
  clearResolveCache(context) { if (context?.reason !== 'config') clearCache() },
  browserLoginFlow,
  claimsLocalPath: path => castGateway.claims(path) || claimsVipPath(path),
  handleLocalRequest: ctx => castGateway.claims(ctx.path) ? castGateway.handle(ctx) : handleVipRequest(ctx),
  async shutdown() { await Promise.allSettled([castGateway.close(), shutdownVip()]) },
}
