/** 南京广电：四路电视直播。Live 南京景观慢直播在「南京景观」模块（scenic.js）。 */
import { fetchTvGroup, TV_CHANNELS } from './api.js'
import epg from './epg.js'

export default {
  id: 'njtv',
  name: '南京',
  description: '南京新闻综合、教育科技、十八·生活、文旅纪录四个电视频道官方直播。Live 南京城市景观在「南京景观」模块。',
  capabilities: { cache: 'disk', resolve: false, epg: true },
  outputGroupName: '江苏',
  defaultRefreshMinutes: 360,
  refreshConfigurable: false,
  refreshDescription: '自动管理：每 360 分钟同步南京电视页面；页面异常时沿用已核验地址。',

  configSchema: [],
  // 牛咔视频的官方节目单，只有四套电视频道有；与取流链路互不依赖（见 epg.js）
  epg,

  async fetch(_config, ctx = {}) {
    const { group, warnings } = await fetchTvGroup({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl })
    if (group.dataList.length !== TV_CHANNELS.length) {
      throw new Error(`南京电视频道不完整：${group.dataList.length}/${TV_CHANNELS.length}`)
    }
    return { groups: [group], meta: { skipped: [], warnings } }
  },
}
