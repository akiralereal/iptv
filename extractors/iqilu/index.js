/** 山东网络台（齐鲁网）：从九个官方频道页取频道 ID，播放时换取短效 HLS。 */
import {
  buildChannels,
  clearCache,
  fetchChannelList,
  primeChannelCache,
  resolveChannel,
} from './api.js'
import epg from './epg.js'

export default {
  id: 'iqilu',
  name: '山东',
  description: '山东卫视及八个地面频道官方直播。播放时自动完成官网 AES 鉴权并获取最新地址。',
  capabilities: { cache: 'disk', resolve: true, epg: true },
  outputGroupName: '山东',
  defaultRefreshMinutes: 240,
  refreshConfigurable: false,
  refreshDescription: '自动管理：频道页每 240 分钟刷新；播放地址按频道缓存 30 分钟，失败后短暂重试。',

  configSchema: [],
  // 官网直播页用的闪电新闻节目单，按频道表里的 epgId 取今明两天；与取流链路互不依赖（见 epg.js）
  epg,

  async fetch(_config, ctx = {}) {
    const rows = await fetchChannelList({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl })
    primeChannelCache(rows, ctx.now ?? Date.now())
    const channels = buildChannels(rows)
    if (!channels.length) throw new Error('山东齐鲁网频道页可访问，但没有找到可用的正式频道（官网可能已改版）')
    return { groups: [{ name: '山东电视台', dataList: channels }], meta: { skipped: [], warnings: [] } }
  },

  claimsRef: ref => /^iqilu-[a-z0-9]{2,12}$/.test(String(ref || '')),
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
