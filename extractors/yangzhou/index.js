/** 扬州市新闻传媒中心「扬州发布」App 的四路电视直播：扬州新闻、扬州民生与江都、邗江两个区台。 */
import { CHANNELS } from './channels.js'
import epg from './epg.js'

export default {
  id: 'yangzhou',
  name: '扬州',
  description: '扬州发布 App 直播的扬州新闻、民生与江都、邗江四路电视频道，固定官方 HLS 地址。',
  capabilities: { cache: 'disk', resolve: false, epg: true, catchup: false },
  catalogVersion: 1,
  outputGroupName: '江苏',
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '固定频道表；HLS 地址不校验时效参数，由播放器访问上游 CDN。',
  configSchema: [],

  async fetch() {
    return {
      groups: [{
        name: '江苏',
        dataList: CHANNELS.map(channel => ({
          name: channel.name,
          url: channel.url,
          opts: ['network-caching=3000'],
          catchup: 'none',
        })),
      }],
      meta: { skipped: [], warnings: [] },
    }
  },

  epg,
}
