import { GROUP_NAME, eventName, eventRef, claimsRef } from './api.js'
import { runtime } from './runtime.js'

export default {
  id: 'iqiyi-sports', name: '爱奇艺体育', category: 'live',
  description: '官方体育直播、赛事回放及集锦动态目录；免费赛事或本人账号有权观看的赛事，播放时由官方网页取票。支持网页登录与 Cookie 导入，优先 H.264 1080P 50帧档（以赛事实际提供为准）。',
  capabilities: { cache: 'disk', resolve: true, epg: false, catchup: false },
  catalogVersion: 2,
  outputGroupName: GROUP_NAME, channelHlsMode: 'proxy', resolveBurstGuard: true,
  defaultRefreshMinutes: 5, refreshConfigurable: false,
  refreshDescription: '每五分钟同步官方直播、回放和集锦；播放时用缓存目录、过期在后台重扫；授权约两分半在后台复核，四分钟硬过期或 CDN 拒绝时当场重新校验。',
  helper: 'iqiyi-sports-login', configSchema: [],
  credentialCheck: { refresh: false, playback: true, degrade: '免费完整直播可匿名播放；只有已确认完整播放权限的内容才显示；缺少权益、试看或核验未完成的内容隐藏，账号变更后重新核验。' },
  async fetch(_config, ctx = {}) {
    // Test injection keeps offline fixtures independent of the production browser/profile.
    const catalog = ctx.catalog || runtime.catalog
    let data
    try { data = await catalog.discover() }
    catch { return { groups: [{ name: GROUP_NAME, dataList: [] }], meta: { warnings: ['爱奇艺官方目录暂时无法读取，未核验的旧条目暂不显示'], skipped: [] } } }
    const { events, vods = [], warnings = [], coverage } = data
    const filtered = await (ctx.filterPlayable || runtime.filterPlayable)([...events, ...vods])
    return { groups: [{ name: GROUP_NAME, dataList: filtered.items.map(event => ({
      name: eventName(event), deferredRef: eventRef(event), proxyHls: true, catchup: 'none',
      // Sports rooms are dynamic events, not television channels. Do not use match posters as logos.
      logo: '', opts: ['network-caching=3000'],
    })) }], meta: { skipped: filtered.skipped, warnings: [...filtered.warnings, ...warnings], coverage } }
  },
  claimsRef,
  resolve: ref => runtime.resolve(ref),
  credentialRejected: () => runtime.credentialRejected(),
  clearResolveCache: () => runtime.clear(),
  browserLoginFlow: runtime.browserLoginFlow,
  shutdown: () => runtime.shutdown(),
}
