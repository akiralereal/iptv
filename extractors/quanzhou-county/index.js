/** 泉州下辖县级市台：晋江电视台、石狮新闻综合的官方公开直播。 */
import { CHANNELS } from './channels.js'
import epg from './epg.js'

export default {
  id: 'quanzhou-county',
  name: '晋江、石狮',
  description: '晋江市、石狮市融媒体中心官网直播的两路电视频道，固定官方 HLS 地址。',
  capabilities: { cache: 'disk', resolve: false, epg: true, catchup: false },
  catalogVersion: 1,
  outputGroupName: '福建',
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '固定频道表；HLS 地址无时效参数，由播放器访问上游 CDN。',
  configSchema: [],

  async fetch() {
    return {
      groups: [{
        name: '福建',
        dataList: CHANNELS.map(channel => ({
          name: channel.name,
          url: channel.url,
          ...(channel.logo ? { logo: channel.logo } : {}),
          opts: ['network-caching=3000'],
          catchup: 'none',
        })),
      }],
      meta: { skipped: [], warnings: [] },
    }
  },

  // 石狮官网节目单是真编排；晋江目前只有「精彩节目」占位，按官方没发处理（见 epg.js）
  epg,
}
