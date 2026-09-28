/** 青海：青海藏语网络广播电视台官网的安多卫视，播放时动态取签名地址并中继实时清单。 */
import { buildChannels, claimsRef, clearCache, resolveChannel } from './api.js'

export default {
  id: 'qinghai',
  name: '青海',
  description: '青海藏语网络广播电视台官网的安多卫视；无需登录，播放时动态取当前签名地址，本机只中继清单、分片由播放器直连官方 CDN。',
  // 官网节目单接口对任何日期都只回 24 条整点「精彩节目」占位，没有可用的官方节目单（见 EPG.md）
  capabilities: { cache: 'disk', resolve: true, epg: false, catchup: false },
  catalogVersion: 1,
  outputGroupName: '青海',
  channelHlsMode: 'relay',
  relayProxyCompatible: true,
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '自动管理：1 路固定频道表随模块版本更新；官网签名标称两小时，播放时取当前地址、30 分钟换一次，仅中继清单，媒体分片由播放器直连官方 CDN。',

  configSchema: [],

  async fetch() {
    return {
      groups: [{ name: '青海', dataList: buildChannels() }],
      meta: { skipped: [], warnings: [] },
    }
  },

  claimsRef,
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
