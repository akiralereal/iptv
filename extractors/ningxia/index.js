/** 宁夏广电：黄河云公开的三套电视直播，直连不代理；节目单取黄河云官方接口。 */
import { buildChannels, pickMediaHost } from './api.js'
import epg from './epg.js'

// 上一轮选中的直播域名：探测说不准（超时 / 断网）时沿用，见 api.js pickMediaHost
let lastHost = ''

export default {
  id: 'ningxia',
  name: '宁夏',
  description: '宁夏广播电视台三套公开频道（宁夏卫视、公共、文旅）；无需登录，由播放器直连官方直播源；节目单取自黄河云官方接口。部分地区或网络可能无法播放，无法播放时可自行关闭本模块。',
  capabilities: { cache: 'disk', resolve: false, epg: true, catchup: false },
  catalogVersion: 2,
  outputGroupName: '宁夏',
  defaultRefreshMinutes: 360,
  refreshConfigurable: false,
  refreshDescription: '自动管理：每 6 小时从本机网络试一次官方的两个直播域名，三台统一用本机网络能打开的那个（都能打开或都打不开时用官方在用的域名）；地址不带签名也无需请求头，播放器直连官方 CDN，本机不转发媒体。',

  configSchema: [],

  async fetch(config, ctx = {}) {
    const { host } = await pickMediaHost({ fetchImpl: ctx.fetchImpl, timeoutMs: ctx.timeoutMs, previous: lastHost })
    lastHost = host
    return {
      groups: [{ name: '宁夏', dataList: buildChannels(host) }],
      meta: { skipped: [], warnings: [] },
    }
  },

  // 黄河云节目单，三套一次取回（见 epg.js）；与取流互不依赖
  epg,
}
