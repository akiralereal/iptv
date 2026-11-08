/** 南京景观：Live 南京 13 路城市景观官方直播，从「南京」模块拆出单独开关（2026-11-08）。 */
import { fetchScenicGroup, SCENIC_CHANNELS } from './api.js'

export default {
  id: 'njtv-scenic',
  name: '南京景观',
  description: 'Live 南京长江大桥、紫金山、南京眼等 13 路城市景观官方直播，自动排除与电视频道重复的流。电视频道在「南京」模块。',
  capabilities: { cache: 'disk', resolve: false, epg: false },
  outputGroupName: '江苏',
  preserveGroupSuffixes: ['景观'],
  splitFrom: { id: 'njtv', groups: ['南京景观'] },
  defaultRefreshMinutes: 360,
  refreshConfigurable: false,
  refreshDescription: '自动管理：每 360 分钟同步 Live 南京页面；单路缺失或页面异常时沿用已核验地址。',

  configSchema: [],

  async fetch(_config, ctx = {}) {
    const { group, warnings } = await fetchScenicGroup({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl })
    if (group.dataList.length !== SCENIC_CHANNELS.length) {
      throw new Error(`南京景观频道不完整：${group.dataList.length}/${SCENIC_CHANNELS.length}`)
    }
    return { groups: [group], meta: { skipped: [{ name: '5G Live', reason: '与南京文旅纪录同一直播地址' }], warnings } }
  },
}
