/** 吉林风景：吉林广电官网慢直播，从「吉林」模块拆出单独开关（2026-11-08）。 */
import { claimsScenicRef, clearCache, fetchScenicGroups, resolveChannel } from './api.js'

export default {
  id: 'jlntv-scenic',
  name: '吉林风景',
  description: '吉林广电官网当前在播的城市与景区慢直播（看敦化、浑江、白山松岭、长白山滑雪场等）；官网按季节换机位，刷新时自动收新机位、撤下和停播的不显示。无需登录，动态机位在播放时获取短效签名，清单和媒体全代理。电视频道在「吉林」模块。',
  capabilities: { cache: 'disk', resolve: true, epg: false, catchup: false },
  outputGroupName: '吉林',
  preserveGroupSuffixes: ['风景'],
  splitFrom: { id: 'jlntv', groups: ['吉林风景'] },
  channelHlsMode: 'proxy',
  defaultRefreshMinutes: 240,
  refreshConfigurable: false,
  refreshDescription: '自动管理：每 240 分钟读官网直播目录里在播的慢直播专题，收进全部机位并逐路确认清单在播；新换上的自动加入，撤下或停播的不显示，恢复后自动回来；播放时获取短效签名。',

  configSchema: [],

  async fetch(_config, ctx = {}) {
    const { groups, skipped, warnings } = await fetchScenicGroups(ctx)
    return { groups, meta: { skipped, warnings } }
  },

  claimsRef: claimsScenicRef,
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
