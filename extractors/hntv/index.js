/** 河南广播电视台（大象新闻）：官方频道接口返回约四小时有效的签名 HLS。 */
import { buildChannels, clearCache, fetchChannelList, primeChannelCache, resolveChannel } from './api.js'
import epg from './epg.js'

export default {
  id: 'hntv',
  name: '河南',
  description: '河南卫视及十二个地面、专业频道官方直播。自动排除购物频道并刷新短效地址。',
  // catchup: false —— 只做直播：官方直播地址不认回看时间参数。官方的回看是节目单接口里按节目给的录像文件（programs[].playUrl），
  // 与直播取流是两套，没接；频道逐条标 catchup:'none'，不继承订阅头的回看声明
  capabilities: { cache: 'disk', resolve: true, epg: true, catchup: false },
  outputGroupName: '河南',
  defaultRefreshMinutes: 120,
  refreshConfigurable: false,
  refreshDescription: '自动管理：频道与约 4 小时有效的播放地址每 120 分钟刷新；失败后 1 分钟重试。',

  configSchema: [],
  // 官网节目单，按频道表里的 cid 取当天；与取流链路互不依赖（见 epg.js）
  epg,

  async fetch(_config, ctx = {}) {
    const rows = await fetchChannelList({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl, now: ctx.now })
    primeChannelCache(rows, ctx.now ?? Date.now())
    const channels = buildChannels(rows)
    if (!channels.length) throw new Error('大象新闻接口成功，但没有找到可用的河南正式频道（官网可能已改版）')
    return { groups: [{ name: '河南电视台', dataList: channels }], meta: { skipped: [], warnings: [] } }
  },

  claimsRef: ref => /^hntv-\d{1,4}$/.test(String(ref || '')),
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
