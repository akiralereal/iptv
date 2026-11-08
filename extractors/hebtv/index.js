/** 河北广播电视台「冀时」：六套电视频道，播放时生成两小时 HLS 签名。「美丽河北」景观在 scenic.js。 */
import { buildChannels, clearCache, fetchChannelList, primeChannelCache, resolveChannel } from './api.js'
import epg from './epg.js'

export default {
  id: 'hebtv',
  name: '河北',
  description: '河北广播电视台六套非购物电视频道，播放时自动续签。「美丽河北」城市慢直播在「河北景观」模块。',
  capabilities: { cache: 'disk', resolve: true, epg: true },
  outputGroupName: '河北',
  defaultRefreshMinutes: 240,
  refreshConfigurable: false,
  refreshDescription: '自动管理：电视频道列表每 240 分钟刷新；播放地址在请求时生成约两小时有效的官网签名。',

  configSchema: [],
  // 官网节目单，按节目源号取六套电视频道（见 epg.js）
  epg,

  async fetch(_config, ctx = {}) {
    const rows = await fetchChannelList({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl })
    primeChannelCache(rows, ctx.now ?? Date.now())
    const dataList = buildChannels(rows).map(channel => ({ ...channel, opts: ['network-caching=3000'] }))
    return { groups: [{ name: '河北电视台', dataList }], meta: { skipped: [], warnings: [] } }
  },

  // 「河北景观」的频道引用也是这个写法，注册在后面；两边共用 resolveChannel，归谁解析都一样
  claimsRef: ref => /^hebtv-\d{1,12}$/.test(String(ref || '')),
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
