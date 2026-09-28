/** 广西网络台：官方 HLS 的 PES 负载需平台密钥解码，因此固定经本机全代理播放。 */
import {
  buildChannelGroups,
  clearStreamCache,
  fetchChannelRows,
  primeStreamCache,
  resolveChannel,
} from './api.js'
import epg from './epg.js'

export default {
  id: 'gxtv',
  name: '广西',
  description: '广西卫视及地面频道官方直播。只收录官网正式频道，自动排除测试流和矩阵号。',
  capabilities: { cache: 'disk', resolve: true, epg: true },
  outputGroupName: '广西',
  defaultRefreshMinutes: 30,
  refreshConfigurable: false,
  refreshDescription: '自动管理：频道与播放参数每 30 分钟刷新；失败后 1 分钟重试，并沿用上次可用数据。',

  configSchema: [],
  // 官网节目单，按频道表里的官网频道名取；与取流链路互不依赖（见 epg.js）
  epg,

  async fetch(config, ctx = {}) {
    const rows = await fetchChannelRows({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl })
    primeStreamCache(rows)
    const groups = buildChannelGroups(rows)
    const count = groups.reduce((sum, group) => sum + group.dataList.length, 0)
    if (!count) throw new Error('广西网络台接口成功，但没有找到正式频道的可播 HLS（接口可能已改版）')
    return { groups, meta: { skipped: [], warnings: [] } }
  },

  claimsRef: ref => /^gxtv-[a-z0-9]{1,16}$/.test(String(ref || '')),
  resolve: resolveChannel,
  clearResolveCache: clearStreamCache,
}
