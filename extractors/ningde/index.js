/** 宁德市广播电视台两路电视频道：每轮刷新从官方直播详情接口取 HLS，播放器直连。 */
import { fetchChannels } from './api.js'

export default {
  id: 'ningde',
  name: '宁德',
  description: '宁德台官方直播的新闻综合、文化旅游两路电视频道，每轮刷新从官方接口取 HLS 地址。',
  capabilities: { cache: 'disk', resolve: false, epg: false, catchup: false },
  catalogVersion: 1,
  outputGroupName: '福建',
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '固定频道表；每天向官方接口取一次 HLS 地址（地址无时效参数），由播放器访问上游 CDN。',
  configSchema: [],

  async fetch(_config, ctx = {}) {
    const { channels, warnings } = await fetchChannels({
      ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
      ...(ctx.timeoutMs ? { timeoutMs: ctx.timeoutMs } : {}),
    })
    return {
      groups: [{ name: '福建', dataList: channels }],
      meta: { skipped: [], warnings },
    }
  },
}
