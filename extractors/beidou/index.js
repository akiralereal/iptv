/** 辽宁北斗融媒：辽宁省台与沈阳台，播放时生成短效 HLS 并全代理防盗链。 */
import { buildChannelGroups, clearCache, fetchChannelRows, resolveChannel, TENANTS } from './api.js'

const REGIONS = TENANTS.map(tenant => tenant.id)

export default {
  id: 'beidou',
  name: '辽宁',
  description: '北斗融媒官方辽宁省台与沈阳台直播；固定排除购物频道，只收录当前确认为 live 的频道。',
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
    if (!count) throw new Error('辽宁北斗融媒接口成功，但没有找到可用电视频道')
    return { groups, meta: { skipped, warnings } }
  },

  claimsRef: ref => /^beidou-(?:liaoning|shenyang)-[a-f0-9]{32}$/.test(String(ref || '')),
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
