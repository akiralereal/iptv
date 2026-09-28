/** 南京广电：四路电视直播与 Live 南京景观慢直播。 */
import { fetchChannelGroups, SCENIC_CHANNELS, TV_CHANNELS } from './api.js'
import epg from './epg.js'

export default {
  id: 'njtv',
  name: '南京',
  description: '南京四个电视频道与 Live 南京城市景观官方直播，自动去除重复电视流。',
  capabilities: { cache: 'disk', resolve: false, epg: true },
  outputGroupName: '南京',
  preserveGroupSuffixes: ['景观'],
  defaultRefreshMinutes: 360,
  refreshConfigurable: false,
  refreshDescription: '自动管理：每 360 分钟同步南京电视与城市景观页面；单页异常时沿用已核验地址。',

  configSchema: [],
  // 牛咔视频的官方节目单，只有四套电视频道有；与取流链路互不依赖（见 epg.js）
  epg,

  async fetch(_config, ctx = {}) {
    const result = await fetchChannelGroups({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl })
    const tvCount = result.groups[0]?.dataList?.length || 0
    const scenicCount = result.groups[1]?.dataList?.length || 0
    if (tvCount !== TV_CHANNELS.length || scenicCount !== SCENIC_CHANNELS.length) {
      throw new Error(`南京广电频道不完整：电视 ${tvCount}/${TV_CHANNELS.length}，景观 ${scenicCount}/${SCENIC_CHANNELS.length}`)
    }
    return { groups: result.groups, meta: { skipped: [{ name: '5G Live', reason: '与南京文旅纪录同一直播地址' }], warnings: result.warnings } }
  },
}
