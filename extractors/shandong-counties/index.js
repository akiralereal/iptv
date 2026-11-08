/**
 * 山东市县台：闪电新闻融媒平台上 16 个地市的区县融媒体中心、市台官方直播，按地市分组
 * （「山东-济南」…「山东-菏泽」）。两百来路区县台并进「山东」会把省台淹掉，而看的人大多
 * 只关心自己县的一两个台，所以模块默认关闭、按地市拆开，想看的自己打开、不要的地市整组隐藏。
 */
import { CHANNELS, CHANNEL_BY_REF, CITY_NAMES } from './channels.js'
import { checkChannels, createResolver } from './api.js'
import epg from './epg.js'

const resolver = createResolver()

export function groupName(city) {
  return `山东-${city}`
}

export function buildGroups(results) {
  const live = results.filter(item => item.state === 'live')
  return CITY_NAMES
    .map(city => ({
      name: groupName(city),
      dataList: live.filter(item => item.channel.city === city).map(item => ({
        name: item.channel.name,
        // 地址的 k / t 每次都换，写进播放列表会让频道主键跟着变（见 api.js 顶部）；播放时 302 到当前地址
        deferredRef: item.channel.ref,
        logo: item.logo || '',
        catchup: 'none',
        opts: ['network-caching=3000'],
      })),
    }))
    .filter(group => group.dataList.length)
}

export default {
  id: 'shandong-counties',
  name: '山东市县',
  description: '闪电新闻融媒平台上山东 16 个地市的区县融媒体中心与部分市台官方直播，按地市分组（山东-济南、山东-潍坊…），默认关闭；每轮只收正在推流的台。',
  defaultEnabled: false,
  // 后台「批量开关」里收进「市县台」一节（registry.js 的 county）
  county: true,
  region: '山东',
  capabilities: { cache: 'disk', resolve: true, epg: true, catchup: false },
  catalogVersion: 2,
  defaultRefreshMinutes: 120,
  refreshConfigurable: false,
  refreshDescription: '每两小时向官方接口取一次各台状态，并逐台确认主清单在推流，只收取得到的。播放时跳转到官方当前地址（接口结果缓存 20 分钟），播放器直连官方 CDN，本机不转发清单和分片。',
  configSchema: [],
  epg,

  async fetch(config, ctx = {}) {
    const results = await checkChannels(CHANNELS, {
      timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl, onOrg: resolver.remember,
    })
    const unknown = results.filter(item => item.state === 'unknown')
    if (unknown.length === results.length) throw new Error(unknown[0]?.error || '闪电新闻接口请求失败')
    const reasons = { offline: '台方当前没有推流', gone: '官方已不再列出这台' }
    const skipped = results.filter(item => reasons[item.state]).map(item => `${item.channel.name}：${reasons[item.state]}`)
    const warnings = unknown.length
      ? [`${unknown.length} 台所在机构的接口没取到，本轮暂缺：${unknown.slice(0, 5).map(item => item.channel.name).join('、')}`]
      : []
    return { groups: buildGroups(results), meta: { skipped, warnings } }
  },

  claimsRef: ref => CHANNEL_BY_REF.has(String(ref || '')),
  resolve: ref => resolver.resolve(ref),
  clearResolveCache: () => resolver.clear(),
}
