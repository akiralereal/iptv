/** 看看新闻（SMG）：上海电视台官方频道，播放时解出与出口 IP / UA 绑定的地址。 */
import {
  buildChannels,
  buildScenicChannels,
  clearCache,
  fetchChannelList,
  fetchScenicList,
  resolveChannel,
} from './api.js'

export default {
  id: 'kankanews',
  name: '上海',
  description: '东方卫视、新闻综合等 SMG 官方电视直播，以及陆家嘴、外滩等上海景观慢直播。按官网当前节目验签取流并全代理防盗链请求；版权屏蔽时段以官网为准。',
  capabilities: { cache: 'disk', resolve: true, epg: false },
  outputGroupName: '上海',
  preserveGroupSuffixes: ['景观'],
  defaultRefreshMinutes: 240,
  refreshConfigurable: false,
  refreshDescription: '自动管理：频道列表每 240 分钟刷新；播放地址约每 150 秒重新获取，失败后 1 分钟重试。',

  configSchema: [],

  async fetch(_config, ctx = {}) {
    const options = { timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl }
    const [rows, scenicResult] = await Promise.all([
      fetchChannelList(options),
      fetchScenicList(options),
    ])
    const channels = buildChannels(rows).map(channel => ({
      ...channel,
      opts: ['network-caching=3000'],
    }))
    const scenicChannels = buildScenicChannels(scenicResult.play_info).map(channel => ({
      ...channel,
      opts: ['network-caching=3000'],
    }))
    if (!channels.length && !scenicChannels.length) {
      throw new Error('看看新闻接口成功，但没有找到可用上海频道（接口可能已改版）')
    }
    return {
      groups: [
        { name: '上海电视台', dataList: channels },
        { name: '上海景观', dataList: scenicChannels },
      ].filter(group => group.dataList.length),
      meta: { skipped: [], warnings: [] },
    }
  },

  claimsRef: ref => /^kankanews-(?:(?:1|2|4|5|9|10|11|12)|scenic-(?:12835|13755|13973|13974|15989))$/.test(String(ref || '')),
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
