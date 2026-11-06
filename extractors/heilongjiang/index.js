/** 黑龙江广电：极光新闻 App 七套官方直播。 */
import { buildChannels, channelForRef, resolveChannel, fetchProxyMedia, clearResolveCache, shutdown } from './api.js'

export default {
  id: 'heilongjiang',
  name: '黑龙江',
  description: '黑龙江广播电视台七套公开频道；无需登录。默认由服务器直连官方直播并转发给播放器，修复部分代理网络无法访问官方端口的问题；也可选择播放器直连。',
  capabilities: { cache: 'disk', resolve: true, epg: false, catchup: false },
  // v3：旧直链目录迁移到本机代理入口。
  catalogVersion: 3,
  outputGroupName: '黑龙江',
  channelHlsModeForConfig: (config = {}) => config.networkMode === 'direct' ? undefined : 'proxy',
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '七套固定频道表随模块版本更新；服务器转发模式每次播放读取实时清单，域名解析异常时自动查询公共 DNS。',

  configSchema: [{ key: 'networkMode', label: '播放方式', type: 'select', default: 'proxy',
    options: [{ value: 'proxy', label: '服务器转发（推荐）' }, { value: 'direct', label: '播放器直连' }],
    hint: '服务器转发会直连官方 4430 端口，占用服务器媒体带宽；服务器需能访问官方源。播放器直连沿用原方式，适合服务器无法访问、但播放设备可以访问的网络。保存后刷新频道和播放器订阅。' }],

  async fetch(config) {
    return {
      groups: [{ name: '黑龙江', dataList: buildChannels(config) }],
      meta: { skipped: [], warnings: [] },
    }
  },
  claimsRef: ref => !!channelForRef(ref),
  resolve: resolveChannel,
  fetchProxyMedia,
  clearResolveCache,
  shutdown,
}
