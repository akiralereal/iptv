/** 浙江新蓝网：公开频道表，播放时按频道 ID 取流并生成短期 auth_key。 */
import { buildChannels, clearPlayInfoCache, fetchChannelList, resolveChannel } from './api.js'
import epg from './epg.js'

export default {
  id: 'cztv',
  name: '浙江',
  description: '浙江卫视及地面频道官方直播。播放时即时选择码率并生成有效地址。',
  capabilities: { cache: 'disk', resolve: true, epg: true },
  outputGroupName: '浙江',
  defaultRefreshMinutes: 240,
  refreshConfigurable: false,
  refreshDescription: '自动管理：频道列表每 240 分钟刷新；播放签名约 5 分钟更新，CDN 节点约 15 秒重新评估，失败后 1 分钟重试。',

  configSchema: [],
  // 官网节目单，按频道接口的 station_code 取；与取流链路互不依赖（见 epg.js）
  epg,

  async fetch(_config, ctx = {}) {
    const rows = await fetchChannelList({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl })
    const channels = buildChannels(rows).map(channel => ({
      ...channel,
      // 仅 VLC/libVLC 会读取这条提示；固定一个稳妥值，不向用户暴露技术参数。
      opts: ['network-caching=3000'],
    }))
    if (!channels.length) throw new Error('浙江新蓝网接口成功，但没有找到可用频道（接口可能已改版）')
    return {
      groups: [{ name: '浙江电视台', dataList: channels }],
      meta: { skipped: [], warnings: [] },
    }
  },

  claimsRef: ref => /^cztv-\d{1,8}$/.test(String(ref || '')),
  resolve: resolveChannel,
  clearResolveCache: clearPlayInfoCache,
}
