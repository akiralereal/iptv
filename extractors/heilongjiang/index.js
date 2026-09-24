/** 黑龙江广电：极光新闻 App 在用的七套官方直播，直连不代理。 */
import { buildChannels } from './api.js'

export default {
  id: 'heilongjiang',
  name: '黑龙江',
  description: '黑龙江广播电视台七套公开频道（极光新闻 App 在用的官方入口）；无需登录，地址固定且上游不设防盗链，由播放器直连官方 CDN。',
  capabilities: { cache: 'disk', resolve: false, epg: false, catchup: false },
  // v2：七套频道带上官方台标
  catalogVersion: 2,
  outputGroupName: '黑龙江',
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '自动管理：七套固定频道表随模块版本更新；地址不带签名也无需请求头，播放器直连官方 CDN，本机不转发媒体。',

  configSchema: [],

  async fetch() {
    return {
      groups: [{ name: '黑龙江', dataList: buildChannels() }],
      meta: { skipped: [], warnings: [] },
    }
  },
}
