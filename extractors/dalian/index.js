/** 大连云：大连市级正式电视直播，匿名媒体票据与播放地址均按当前客户端即时获取。 */
import { buildChannelGroups, clearCache, fetchChannelRows, resolveChannel } from './api.js'

export default {
  id: 'dalian',
  name: '大连',
  outputGroupName: '辽宁',
  description: '大连云官方正式电视直播；固定排除购物、测试、研发和回看内容，只追加真实在线的大连频道。',
  capabilities: { cache: 'memory', resolve: true, epg: false },
  defaultRefreshMinutes: 5,
  refreshConfigurable: false,
  refreshDescription: '自动管理：每 5 分钟刷新官方目录与媒体票据，并验证 HLS 正在产出；上游短暂失败时有限回退。',
  configSchema: [],

  async fetch(_config, ctx = {}) {
    const { rows, skipped, warnings } = await fetchChannelRows({
      timeoutMs: ctx.timeoutMs,
      fetchImpl: ctx.fetchImpl,
      now: ctx.now,
    })
    const groups = buildChannelGroups(rows)
    if (!groups.length) throw new Error('大连云接口成功，但没有找到真实在线的正式电视频道')
    return { groups, meta: { skipped, warnings } }
  },

  claimsRef: ref => /^dalian-(?:7|8|9)$/.test(String(ref || '')),
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
