/** 芒果 TV 官方电视直播：播放时取最高画质，并全代理防盗链请求头。 */
import { buildChannels, clearCache, fetchChannelList, resolveChannel } from './api.js'

export default {
  id: 'mgtv',
  name: '湖南',
  description: '湖南广电及长沙频道官方直播。自动排除购物频道并选择官网当前最高画质。',
  // catchup: false —— 只做直播：官方直播地址不认回看时间参数（地址不带查询串，拼上去上游直接 403/404），频道逐条标 catchup:'none'，不继承订阅头的回看声明
  capabilities: { cache: 'disk', resolve: true, epg: false, catchup: false },
  outputGroupName: '湖南',
  defaultRefreshMinutes: 240,
  refreshConfigurable: false,
  refreshDescription: '自动管理：频道列表每 240 分钟刷新；播放地址每 60 分钟提前换新，失败后 1 分钟重试并沿用未过期地址。',

  configSchema: [],

  async fetch(_config, ctx = {}) {
    const rows = await fetchChannelList({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl })
    const channels = buildChannels(rows)
    if (!channels.length) throw new Error('芒果 TV 接口成功，但没有找到可用的固定电视直播频道（接口可能已改版）')
    return { groups: [{ name: '湖南电视台', dataList: channels }], meta: { skipped: [], warnings: [] } }
  },

  claimsRef: ref => /^mgtv-\d{1,8}$/.test(String(ref || '')),
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
