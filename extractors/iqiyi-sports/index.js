import { GROUP_NAME, eventName, claimsRef } from './api.js'
import { runtime } from './runtime.js'

export default {
  id: 'iqiyi-sports', name: '爱奇艺体育', category: 'account',
  description: '官方在播体育赛事动态目录；免费赛事或本人账号有权观看的赛事，播放时由官方网页取票。支持网页登录与 Cookie 导入，优先 H.264 1080P 50帧档（以赛事实际提供为准）。',
  capabilities: { cache: 'disk', resolve: true, epg: false, catchup: false },
  outputGroupName: GROUP_NAME, channelHlsMode: 'proxy', resolveBurstGuard: true,
  defaultRefreshMinutes: 5, refreshConfigurable: false,
  refreshDescription: '每五分钟同步官方在播赛事；播放时一分钟缓存复核赛事状态，地址四分钟复用，到期或 CDN 拒绝时重新校验授权。',
  helper: 'iqiyi-sports-login', configSchema: [],
  credentialCheck: { refresh: false, playback: true, degrade: '免费完整直播可匿名播放；会员赛事保留入口，缺少完整权益时提示登录，不续接匿名试看。' },
  async fetch(_config, ctx = {}) {
    // Test injection keeps offline fixtures independent of the production browser/profile.
    const catalog = ctx.catalog || runtime.catalog
    const { events, warnings, coverage } = await catalog.discover()
    return { groups: [{ name: GROUP_NAME, dataList: events.map(event => ({
      name: eventName(event), deferredRef: `iqiyi-sports-${event.id}`, proxyHls: true, catchup: 'none',
      // Sports rooms are dynamic events, not television channels. Do not use match posters as logos.
      logo: '', opts: ['network-caching=3000'],
    })) }], meta: { skipped: [], warnings, coverage } }
  },
  claimsRef,
  resolve: ref => runtime.resolve(ref),
  credentialRejected: () => runtime.credentialRejected(),
  clearResolveCache: () => runtime.clear(),
  browserLoginFlow: runtime.browserLoginFlow,
  shutdown: () => runtime.shutdown(),
}
