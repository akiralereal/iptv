import { clearResolveCache, fetchProxyMedia, records, refOf, resolve } from './api.js'

// 用户订阅在配置里已有完整目录，修改后（包括模块停用期间）即可重建。
function groupsFromConfig(config) {
  const dataList = records(config).map(item => ({
    name: item.name, deferredRef: refOf(item), logo: '', catchup: 'none', proxyHls: true,
  }))
  return dataList.length ? [{ name: 'YouTube 直播', dataList }] : []
}

export default {
  id: 'youtube-live',
  name: 'YouTube 直播',
  category: 'live',
  defaultEnabled: false,
  catalogVersion: 2,
  description: '添加官方频道或固定直播场次。部署机器需能访问 YouTube 和 Google Video；输出当前最高画质，保留配套音轨和字幕。',
  capabilities: { cache:'disk', resolve:true, epg:false, catchup:false },
  channelHlsMode: 'proxy',
  resolveBurstGuard: true,
  playbackRequiresEnabled: true,
  helper: 'youtube-subscriptions',
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '添加或移除订阅后更新列表。未开播的频道保留，播放时重新查找直播。',
  configSchema: [{ key:'subscriptions', type:'text', label:'YouTube 订阅', default:'[]', hidden:true }],
  groupsFromConfig,
  async fetch(config) {
    return { groups: groupsFromConfig(config) }
  },
  claimsRef: ref => /^yt-[a-f0-9]{24}$/.test(ref),
  resolve,
  fetchProxyMedia,
  clearResolveCache,
}
