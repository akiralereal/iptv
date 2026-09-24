/** 江苏网络台（荔枝网）：播放时生成 3 分钟签名，并全代理必须的防盗链请求头。 */
import { buildChannels, clearCache, fetchChannelList, primeChannelCache, resolveChannel } from './api.js'
import epg from './epg.js'

export default {
  id: 'jstv',
  name: '江苏',
  description: '江苏卫视及地面频道官方直播。播放时自动生成短效签名并代理官网防盗链请求头。',
  capabilities: { cache: 'disk', resolve: true, epg: true },
  outputGroupName: '江苏',
  defaultRefreshMinutes: 240,
  refreshConfigurable: false,
  refreshDescription: '自动管理：频道列表每 240 分钟刷新；每次播放及清单更新都会重新生成约 3 分钟有效的地址。',

  configSchema: [],
  // 官网节目单，按频道 extraId 取；与取流链路只共用纯签名计算（见 epg.js）
  epg,

  async fetch(_config, ctx = {}) {
    const rows = await fetchChannelList({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl })
    primeChannelCache(rows)
    const channels = buildChannels(rows).map(channel => ({
      ...channel,
      // 仅 VLC/libVLC 会读取这条提示；固定一个稳妥值，不向用户暴露技术参数。
      opts: ['network-caching=3000'],
    }))
    if (!channels.length) throw new Error('江苏网络台接口成功，但没有找到可用频道（接口可能已改版）')
    return { groups: [{ name: '江苏电视台', dataList: channels }], meta: { skipped: [], warnings: [] } }
  },

  claimsRef: ref => /^jstv-\d{1,8}$/.test(String(ref || '')),
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
