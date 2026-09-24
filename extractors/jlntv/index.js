/** 吉林广电：15 路电视与 13 路慢直播，动态签名在播放时自动刷新。 */
import { claimsRef, clearCache, fetchGroups, resolveChannel } from './api.js'

export default {
  id: 'jlntv',
  name: '吉林',
  description: '吉林广电官网 15 路电视和 13 路慢直播；无需登录，动态签名自动刷新，清单和媒体全代理。',
  capabilities: { cache: 'disk', resolve: true, epg: false, catchup: false },
  catalogVersion: 2,
  outputGroupName: '吉林',
  preserveGroupSuffixes: ['风景'],
  channelHlsMode: 'proxy',
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '自动管理：固定频道表随模块版本更新，电视频道台标每次刷新时从官网频道列表取；省级频道和季节性慢直播在播放时获取短效签名。',

  configSchema: [],

  async fetch(_config, ctx = {}) {
    const { groups, warnings } = await fetchGroups(ctx)
    return { groups, meta: { skipped: [], warnings } }
  },

  claimsRef,
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
