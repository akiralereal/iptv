/** 北京景观：北京时间官网免登录的活动 / 慢直播，从「北京广播电视台」模块拆出单独开关（2026-11-08）。 */
import { buildPublicGroups, claimsPublicRef, clearCache, fetchPublicCatalog, resolveChannel } from './api.js'

export default {
  id: 'beijing-scenic',
  name: '北京景观',
  description: '北京时间官网当前公开的活动 / 慢直播，免登录；失效的活动流自动排除。电视频道在「北京广播电视台」模块（要 Cookie）。',
  capabilities: { cache: 'disk', resolve: true, epg: false, catchup: false },
  outputGroupName: '北京',
  preserveGroupSuffixes: ['景观'],
  splitFrom: { id: 'beijing', groups: ['北京景观'] },
  channelHlsMode: 'proxy',
  defaultRefreshMinutes: 60,
  refreshConfigurable: false,
  refreshDescription: '自动管理：每 60 分钟读取官网直播目录，逐个确认能取流后才收录；播放地址按需获取并短期复用。',

  configSchema: [],

  async fetch(_config, ctx = {}) {
    const catalog = await fetchPublicCatalog({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl })
    return { groups: buildPublicGroups(catalog), meta: { skipped: [], warnings: catalog.warnings } }
  },

  claimsRef: claimsPublicRef,
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
