/** 河北广播电视台「冀时」：电视与「美丽河北」城市慢直播，播放时生成两小时 HLS 签名。 */
import { buildChannels, clearCache, fetchAllRows, primeChannelCache, resolveChannel } from './api.js'
import epg from './epg.js'

export default {
  id: 'hebtv',
  name: '河北',
  description: '河北广播电视台六套非购物电视频道与「美丽河北」城市景观慢直播，播放时自动续签。',
  capabilities: { cache: 'disk', resolve: true, epg: true },
  outputGroupName: '河北',
  preserveGroupSuffixes: ['景观'],
  defaultRefreshMinutes: 240,
  refreshConfigurable: false,
  refreshDescription: '自动管理：电视与景观列表每 240 分钟刷新；播放地址在请求时生成约两小时有效的官网签名。',

  configSchema: [],
  // 官网节目单，按节目源号取六套电视频道；景观慢直播不出（见 epg.js）
  epg,

  async fetch(_config, ctx = {}) {
    const result = await fetchAllRows({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl })
    primeChannelCache(result.rows, ctx.now ?? Date.now())
    const decorate = rows => buildChannels(rows).map(channel => ({
      ...channel,
      opts: ['network-caching=3000'],
    }))
    const groups = []
    if (result.tvRows.length) groups.push({ name: '河北电视台', dataList: decorate(result.tvRows) })
    if (result.scenicRows.length) groups.push({ name: '河北景观', dataList: decorate(result.scenicRows) })
    return { groups, meta: { skipped: [], warnings: result.warnings } }
  },

  claimsRef: ref => /^hebtv-\d{1,12}$/.test(String(ref || '')),
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
