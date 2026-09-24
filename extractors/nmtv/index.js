/** 内蒙古广电：奔腾融媒官网 20 路公开频道，动态取流并全代理。 */
import { claimsRef, clearCache, fetchChannels, resolveChannel } from './api.js'

export default {
  id: 'nmtv',
  name: '内蒙古',
  description: '内蒙古广电官网 20 路公开频道；无需登录，播放时从加密接口动态取流，清单和媒体全代理。',
  capabilities: { cache: 'disk', resolve: true, epg: false, catchup: false },
  catalogVersion: 2,
  outputGroupName: '内蒙古',
  channelHlsMode: 'proxy',
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '自动管理：20 路固定频道表随模块版本更新，台标每次刷新时从官网频道列表取；播放时获取官网动态地址并补齐防盗链请求头。',

  configSchema: [],

  async fetch(_config, ctx = {}) {
    const { channels, warnings } = await fetchChannels(ctx)
    return {
      groups: [{ name: '内蒙古', dataList: channels }],
      meta: { skipped: [], warnings },
    }
  },

  claimsRef,
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
