/** 青岛广播电视台：官网 QTV-1 到 QTV-5 五路电视直播，分片带官网播放器的封装加密，固定经本机全代理解密播放。 */
import { buildChannelGroups, fetchChannels, resolveChannel } from './api.js'
import { CHANNELS } from './channels.js'
import epg from './epg.js'

const REF_RE = /^qingdao-[1-5]$/

export default {
  id: 'qingdao',
  name: '青岛',
  description: '青岛新闻综合、生活服务、影视、都市、教育五路官网直播（QTV-1 到 QTV-5）。官网分片带播放器自用的封装加密，由本机代理边下边解；五四广场等城市景观在「青岛景观」模块。',
  capabilities: { cache: 'disk', resolve: true, epg: true, catchup: false },
  catalogVersion: 1,
  outputGroupName: '青岛',
  defaultRefreshMinutes: 360,
  refreshConfigurable: false,
  refreshDescription: '自动管理：地址固定，每 360 分钟探一次官网清单确认在播；单路取不到只记警告，频道照留。',

  configSchema: [],
  // 官网播放页的节目单接口，按频道表里的 channel 号取；与取流链路互不依赖（见 epg.js）
  epg,

  async fetch(_config, ctx = {}) {
    const result = await fetchChannels({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl })
    const count = result.groups.reduce((sum, group) => sum + group.dataList.length, 0)
    if (count !== CHANNELS.length) throw new Error(`青岛广电频道表异常：${count}/${CHANNELS.length}`)
    return { groups: result.groups, meta: { skipped: [], warnings: result.warnings } }
  },

  claimsRef: ref => REF_RE.test(String(ref || '')),
  resolve: resolveChannel,
}

export { buildChannelGroups }
