/** 河北景观：冀时「美丽河北」城市慢直播，从「河北」模块拆出单独开关（2026-11-08）。 */
import { buildChannels, clearCache, fetchScenicRows, primeScenicCache, resolveChannel } from './api.js'

export default {
  id: 'hebtv-scenic',
  name: '河北景观',
  description: '冀时「美丽河北」石家庄、承德、张家口、雄安新区等城市慢直播，播放时自动续签。电视频道在「河北」模块。',
  capabilities: { cache: 'disk', resolve: true, epg: false },
  outputGroupName: '河北',
  preserveGroupSuffixes: ['景观'],
  splitFrom: { id: 'hebtv', groups: ['河北景观'] },
  defaultRefreshMinutes: 240,
  refreshConfigurable: false,
  refreshDescription: '自动管理：景观列表每 240 分钟刷新；播放地址在请求时生成约两小时有效的官网签名。',

  configSchema: [],

  async fetch(_config, ctx = {}) {
    const { rows, warnings } = await fetchScenicRows({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl })
    primeScenicCache(rows, ctx.now ?? Date.now())
    const dataList = buildChannels(rows).map(channel => ({ ...channel, opts: ['network-caching=3000'] }))
    return { groups: [{ name: '河北景观', dataList }], meta: { skipped: [], warnings } }
  },

  // 与「河北」同一种引用写法（稿件号），播放请求先落到注册在前的「河北」，两边共用 resolveChannel
  claimsRef: ref => /^hebtv-\d{1,12}$/.test(String(ref || '')),
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
