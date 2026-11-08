/** 看看新闻（SMG）：上海电视台官方频道，播放时解出与出口 IP / UA 绑定的地址。上海景观慢直播在 scenic.js。 */
import {
  buildChannels,
  clearCache,
  fetchChannelList,
  resolveChannel,
} from './api.js'
import epg from './epg.js'

export default {
  id: 'kankanews',
  name: '上海',
  description: '东方卫视、新闻综合等 SMG 官方电视直播。按官网当前节目验签取流并全代理防盗链请求；版权屏蔽时段以官网为准。陆家嘴、外滩等慢直播在「上海景观」模块。',
  capabilities: { cache: 'disk', resolve: true, epg: true },
  outputGroupName: '上海',
  defaultRefreshMinutes: 240,
  refreshConfigurable: false,
  refreshDescription: '自动管理：频道列表每 240 分钟刷新；播放地址约每 150 秒重新获取，失败后 1 分钟重试。',

  configSchema: [],
  // 官网节目单，按 channel_id 验签取；与取流链路互不依赖（见 epg.js）
  epg,

  async fetch(_config, ctx = {}) {
    const rows = await fetchChannelList({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl })
    const channels = buildChannels(rows).map(channel => ({
      ...channel,
      opts: ['network-caching=3000'],
    }))
    if (!channels.length) {
      throw new Error('看看新闻接口成功，但没有找到可用上海频道（接口可能已改版）')
    }
    return {
      groups: [{ name: '上海电视台', dataList: channels }],
      meta: { skipped: [], warnings: [] },
    }
  },

  claimsRef: ref => /^kankanews-(?:1|2|4|5|9|10|11|12)$/.test(String(ref || '')),
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
