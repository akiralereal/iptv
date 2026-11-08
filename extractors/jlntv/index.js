/** 吉林广电：15 路电视，动态签名在播放时自动刷新。慢直播在「吉林风景」模块（scenic.js）。 */
import { claimsRef, clearCache, fetchGroups, resolveChannel } from './api.js'
import epg from './epg.js'

export default {
  id: 'jlntv',
  name: '吉林',
  description: '吉林广电官网 6 路省级频道和 9 路地方台；无需登录，动态签名自动刷新，清单和媒体全代理。慢直播在「吉林风景」模块。',
  capabilities: { cache: 'disk', resolve: true, epg: true, catchup: false },
  // 3：慢直播拆去「吉林风景」模块（2026-11-08）
  catalogVersion: 3,
  outputGroupName: '吉林',
  channelHlsMode: 'proxy',
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '自动管理：固定频道表随模块版本更新，电视频道台标每次刷新时从官网频道列表取；省级频道在播放时获取短效签名。',

  configSchema: [],

  async fetch(_config, ctx = {}) {
    const { groups, warnings } = await fetchGroups(ctx)
    return { groups, meta: { skipped: [], warnings } }
  },

  // 延边卫视的节目单取自央视网（见 epg.js）；其余电视频道官方没有
  epg,
  claimsRef,
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
