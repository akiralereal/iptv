/** 海南网络广播电视台：定时同步七套频道，播放时换取短效签名 HLS。 */
import { buildChannels, clearCache, fetchChannelList, primeChannelCache, resolveChannel } from './api.js'
import epg from './epg.js'

export default {
  id: 'hnntv',
  name: '海南',
  description: '海南卫视、三沙卫视及五个地面频道官方直播。播放时自动换取短效签名地址。',
  capabilities: { cache: 'disk', resolve: true, epg: true },
  outputGroupName: '海南',
  defaultRefreshMinutes: 240,
  refreshConfigurable: false,
  refreshDescription: '自动管理：频道列表每 240 分钟刷新；播放时按频道换取签名地址，最多复用 90 分钟。',

  configSchema: [],
  // 官网节目单，按频道表里的 id 取今天；与取流链路互不依赖（见 epg.js）
  epg,

  async fetch(_config, ctx = {}) {
    const rows = await fetchChannelList({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl })
    primeChannelCache(rows, ctx.now ?? Date.now())
    const channels = buildChannels(rows)
    if (!channels.length) throw new Error('海南网台接口成功，但没有找到七套正式电视频道（官网可能已改版）')
    return { groups: [{ name: '海南电视台', dataList: channels }], meta: { skipped: [], warnings: [] } }
  },

  claimsRef: ref => /^hnntv-\d{1,3}$/.test(String(ref || '')),
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
