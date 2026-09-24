/** 湖北长江云：六套公开省台，匿名浏览器会话自动补齐短签名与防盗链。 */
import { fetchChannelPage, primePageCache } from './api.js'
import { buildChannels } from './channels.js'
import epg from './epg.js'
import { clearCache, resolveChannel } from './resolver.js'

export default {
  id: 'hbtv',
  name: '湖北',
  description: '湖北卫视、经视、综合、影视、教育、垄上六套官网公开直播；自动处理短效签名与防盗链。',
  capabilities: { cache: 'disk', resolve: true, epg: true },
  outputGroupName: '湖北',
  defaultRefreshMinutes: 240,
  refreshConfigurable: false,
  refreshDescription: '自动管理：频道表每 240 分钟核对；播放时用匿名浏览器会话刷新短效 HLS，清单与分片全代理。',

  configSchema: [],
  // 长江云 TV（湖北 IPTV）的官方节目单，按频道码取；与取流链路互不依赖（见 epg.js）
  epg,

  async fetch(_config, ctx = {}) {
    const rows = await fetchChannelPage({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl, now: ctx.now })
    primePageCache(rows, ctx.now ?? Date.now())
    return { groups: [{ name: '湖北电视台', dataList: buildChannels() }], meta: { skipped: [], warnings: [] } }
  },

  claimsRef: ref => /^hbtv-(?:431|432|433|435|437|438)$/.test(String(ref || '')),
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
