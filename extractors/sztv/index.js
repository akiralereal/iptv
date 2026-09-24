/** 深圳广电「第一现场」：官网匿名鉴权取频道，播放时换 Key 并逐路径签名。 */
import { buildChannels, clearCache, fetchChannelList, primeChannelCache, resolveChannel } from './api.js'
import epg from './epg.js'

export default {
  id: 'sztv',
  name: '深圳',
  description: '深圳卫视4K及六个地面频道官方直播。播放时自动完成官网鉴权、换取直播 Key 并续签分片。',
  capabilities: { cache: 'disk', resolve: true, epg: true },
  outputGroupName: '广东',
  defaultRefreshMinutes: 240,
  refreshConfigurable: false,
  refreshDescription: '自动管理：频道列表每 240 分钟刷新；播放 Key 与每条 HLS 路径由服务端自动续签。',

  configSchema: [],
  // 官网播放器的节目单，按频道 liveId 取；不签名，与取流链路不共享状态（见 epg.js）
  epg,

  async fetch(_config, ctx = {}) {
    const rows = await fetchChannelList({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl, now: ctx.now })
    primeChannelCache(rows, ctx.now ?? Date.now())
    const channels = buildChannels(rows).map(channel => ({
      ...channel,
      opts: ['network-caching=3000'],
    }))
    if (!channels.length) throw new Error('深圳广电接口成功，但没有找到可用频道（接口可能已改版）')
    return { groups: [{ name: '广东', dataList: channels }], meta: { skipped: [], warnings: [] } }
  },

  claimsRef: ref => /^sztv-\d{1,10}$/.test(String(ref || '')),
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
