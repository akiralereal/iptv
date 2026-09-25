/** 宁夏广电：黄河云公开的三套电视直播，直连不代理；节目单取黄河云官方接口。 */
import { buildChannels } from './api.js'
import epg from './epg.js'

export default {
  id: 'ningxia',
  name: '宁夏',
  description: '宁夏广播电视台三套公开频道（宁夏卫视、公共、文旅）；无需登录，地址固定且上游不设防盗链，由播放器直连官方 CDN；节目单取自黄河云官方接口。',
  capabilities: { cache: 'disk', resolve: false, epg: true, catchup: false },
  catalogVersion: 1,
  outputGroupName: '宁夏',
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '自动管理：三套固定频道表随模块版本更新；地址不带签名也无需请求头，播放器直连官方 CDN，本机不转发媒体。',

  configSchema: [],

  async fetch() {
    return {
      groups: [{ name: '宁夏', dataList: buildChannels() }],
      meta: { skipped: [], warnings: [] },
    }
  },

  // 黄河云节目单，三套一次取回（见 epg.js）；与取流互不依赖
  epg,
}
