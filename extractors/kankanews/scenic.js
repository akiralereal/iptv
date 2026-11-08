/** 上海景观：看看新闻陆家嘴、外滩等慢直播，从「上海」模块拆出单独开关（2026-11-08）。 */
import { buildScenicChannels, clearCache, fetchScenicList, resolveChannel } from './api.js'

export default {
  id: 'kankanews-scenic',
  name: '上海景观',
  description: '看看新闻陆家嘴、外滩观光平台、魔都眼、北外滩、外白渡桥五路慢直播，播放时验签取流并全代理。电视频道在「上海」模块；松江慢直播是单独的「上海松江」模块。',
  capabilities: { cache: 'disk', resolve: true, epg: false },
  outputGroupName: '上海',
  preserveGroupSuffixes: ['景观'],
  splitFrom: { id: 'kankanews', groups: ['上海景观'] },
  defaultRefreshMinutes: 240,
  refreshConfigurable: false,
  refreshDescription: '自动管理：景观列表每 240 分钟刷新；播放地址按官网给的有效期重新获取，失败后 1 分钟重试。',

  configSchema: [],

  async fetch(_config, ctx = {}) {
    const result = await fetchScenicList({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl })
    const channels = buildScenicChannels(result.play_info).map(channel => ({
      ...channel,
      opts: ['network-caching=3000'],
    }))
    if (!channels.length) {
      throw new Error('看看新闻景观接口成功，但没有找到可用慢直播（接口可能已改版）')
    }
    return {
      groups: [{ name: '上海景观', dataList: channels }],
      meta: { skipped: [], warnings: [] },
    }
  },

  claimsRef: ref => /^kankanews-scenic-(?:12835|13755|13973|13974|15989)$/.test(String(ref || '')),
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
