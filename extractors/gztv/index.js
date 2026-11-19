/** 广州广播电视台「花城+」：三路官方电视直播，播放时刷新短效签名。 */
import { buildChannels, clearCache, fetchChannelList, primeChannelCache, resolveChannel } from './api.js'

export default {
  id: 'gztv',
  name: '广州',
  description: '广州综合、新闻与南国都市三路官方直播；播放时自动换取官网最新签名地址。',
  // catchup: false —— 只做直播：官方直播地址不认回看时间参数（带上也照回直播），频道逐条标 catchup:'none'，不继承订阅头的回看声明
  capabilities: { cache: 'disk', resolve: true, epg: false, catchup: false },
  outputGroupName: '广东',
  defaultRefreshMinutes: 240,
  refreshConfigurable: false,
  refreshDescription: '自动管理：频道表每 240 分钟同步；播放地址按分钟短缓存并自动换新。',

  configSchema: [],

  async fetch(_config, ctx = {}) {
    const rows = await fetchChannelList({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl })
    primeChannelCache(rows, ctx.now ?? Date.now())
    const channels = buildChannels(rows)
    if (channels.length !== 3) throw new Error(`花城+只找到 ${channels.length}/3 个正式频道（接口可能已改版）`)
    return { groups: [{ name: '广东', dataList: channels }], meta: { skipped: [], warnings: [] } }
  },

  claimsRef: ref => /^gztv-300[1-3]$/.test(String(ref || '')),
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
