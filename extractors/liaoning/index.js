/**
 * 辽宁：北斗融媒官方辽宁省台与沈阳台，播放时生成短效 HLS 并全代理防盗链。
 *
 * 2026-10-22 曾以 `beidou` 整体下线（官方入口 WAF 405）；11-04 作者要求加回来，先定默认关闭，
 * 看了实测（大陆都能播）当天改成默认开启。换了新 id：频道引用、缓存和告警状态不跟旧 `beidou` 混，
 * 旧的仍按退役模块清掉（utils/extractorManager.js 的 RETIRED_MODULE_IDS）。
 * 新版鉴权（version=6、RSA 2048）来自 vitter 的 PR #199。地域门槛和实测见 beidou-research.md。
 */
import { buildChannelGroups, claimsRef, clearCache, fetchChannelRows, resolveChannel, TENANTS } from './api.js'

const REGIONS = TENANTS.map(tenant => tenant.id)

export default {
  id: 'liaoning',
  name: '辽宁',
  description: '北斗融媒官方辽宁省台（卫视、都市、影视剧、体育休闲等）与沈阳新闻综合、经济、公共；官方当前只给回看的频道这一轮先不列。官方接口只放行部分网络（当前大陆可播，香港和海外不行）。',
  // 官方门槛变过几次：10-21 上海联通被拒、10-25 报告只放行辽宁本地、11-04 大陆都能播而港美日 405。
  // 跟其他「仅大陆」模块一样默认开（作者 11-04 拍板）；官方再收紧时先按 beidou-research.md 复测再定。
  // 关掉后再打开时弹 enableNotice
  enableNotice: '辽宁省台和沈阳台的官方接口曾经只放行辽宁本地网络（2026 年 11 月实测大陆其他地区也能播，香港和海外不行），官方随时可能再收紧。能不能播取决于部署这台服务器的网络，请自行辨别。',
  catalogVersion: 1,
  capabilities: { cache: 'disk', resolve: true, epg: false },
  outputGroupName: '辽宁',
  defaultRefreshMinutes: 10,
  refreshConfigurable: false,
  refreshDescription: '自动管理：每 10 分钟核对 live/replay 状态；播放时生成 30 分钟短签名，清单与分片经本机代理。',

  configSchema: [],

  async fetch(_config, ctx = {}) {
    const { rows, skipped, warnings } = await fetchChannelRows(REGIONS, {
      timeoutMs: ctx.timeoutMs,
      fetchImpl: ctx.fetchImpl,
      now: ctx.now,
    })
    const groups = buildChannelGroups(rows)
    const count = groups.reduce((sum, group) => sum + group.dataList.length, 0)
    if (!count) throw new Error('辽宁北斗融媒接口成功，但当前没有正在直播的电视频道')
    return { groups, meta: { skipped, warnings } }
  },

  claimsRef,
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
