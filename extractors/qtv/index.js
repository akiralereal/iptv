/** 青岛网络广播电视台：用户选定的五路城市景观直播。 */
import { fetchChannels, QTV_CHANNELS } from './api.js'

export default {
  id: 'qtv',
  // 电视频道在「青岛」模块（extractors/qingdao），这张卡只管城市景观机位
  name: '青岛景观',
  description: '五四广场、奥帆中心及三路主干道官方城市直播；QTV-1 到 QTV-5 电视频道在「青岛」模块。',
  capabilities: { cache: 'disk', resolve: false, epg: false },
  outputGroupName: '山东',
  preserveGroupSuffixes: ['景观'],
  defaultRefreshMinutes: 360,
  refreshConfigurable: false,
  refreshDescription: '自动管理：每 360 分钟刷新五个城市直播页面；单页异常时沿用该路已核验地址。',

  configSchema: [],

  async fetch(_config, ctx = {}) {
    const result = await fetchChannels({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl })
    if (result.channels.length !== QTV_CHANNELS.length || result.channels.some(channel => !channel.url)) {
      throw new Error(`青岛城市直播只找到 ${result.channels.filter(channel => channel.url).length}/${QTV_CHANNELS.length} 路`)
    }
    return { groups: [{ name: '青岛景观', dataList: result.channels }], meta: { skipped: [], warnings: result.warnings } }
  },
}
