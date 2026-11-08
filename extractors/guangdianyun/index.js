/**
 * 广电云市县台：全国 20 个省区市的市县级融媒体中心 / 电视台官方直播，按省拆成 20 个模块
 * （「市县台·山东」…），各自进后台源管理对应的省面板，各有开关、缓存、健康状态。
 *
 * 同一份实现：频道表、取流、节目单都按省过滤。播放会话（两条 WebSocket + 保活定时器）
 * 全部省份模块共用一个 resolver，不按省各开一套；claimsRef 按 ref 所属省份各认各的。
 * 慢直播跟着所属台的省份模块走，输出分组照旧「慢直播」。
 */
import { CHANNELS, GROUPS, PROVINCE_IDS } from './channels.js'
import { checkLive, createResolver } from './api.js'
import { epgFor } from './epg.js'
import { printGrey } from '../../utils/colorOut.js'

const resolver = createResolver({ log: printGrey })

export function buildGroups(results) {
  const live = results.filter(item => item.state === 'live' || item.state === 'unknown').map(item => item.channel)
  return GROUPS
    .map(group => ({
      name: group,
      dataList: live.filter(channel => channel.group === group).map(channel => ({
        name: channel.name,
        deferredRef: channel.ref,
        // 清单由模块每次播放请求取回（顺带给在线会话续期）并交给本机中继；分片带自己的签名，播放器直连
        relayHls: true,
        logo: channel.logo || '',
        catchup: 'none',
        opts: ['network-caching=3000'],
        // 地市分组里的市台（淄博新闻综合、菏泽一套二套）排到该组最前，区县台跟在后面
        ...(channel.city ? { leading: true } : {}),
      })),
    }))
    .filter(group => group.dataList.length)
}

export function createProvinceModule(province) {
  const channels = CHANNELS.filter(channel => channel.province === province)
  const refs = new Set(channels.map(channel => channel.ref))
  const tv = channels.filter(channel => channel.group !== '慢直播').length
  const slow = channels.length - tv
  const scope = slow ? `${tv} 路电视台和 ${slow} 路慢直播` : `${tv} 路电视台`
  return {
    id: `guangdianyun-${PROVINCE_IDS[province]}`,
    name: `市县台·${province}`,
    description: `广电云平台托管的${province}市县级电视台官方直播（目录 ${scope}）`
      + `${slow ? '，慢直播放在「慢直播」分组' : ''}；每轮只收正在推流的，停推的恢复后自动出现。默认关闭，需要时在本省面板里打开。`,
    region: province,
    // 频道量大、只有本地少数人看的市县台：默认关闭，由用户按省自己打开（作者拍板，同山东市县）
    defaultEnabled: false,
    // 后台「批量开关」里收进「市县台」一节（registry.js 的 county）
    county: true,
    capabilities: { cache: 'disk', resolve: true, epg: true, catchup: false },
    catalogVersion: 1,
    relayProxyCompatible: true,
    defaultRefreshMinutes: 60,
    refreshConfigurable: false,
    refreshDescription: '每小时查一次各台是否在推流，只收正在推流的。播放时在官方平台挂一个在线会话取地址，没人看一分半后自动断开；清单经本机中继，分片直连官方 CDN。',
    configSchema: [],
    epg: epgFor(province),

    async fetch(config, ctx = {}) {
      const results = await checkLive(channels, { timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl })
      const unknown = results.filter(item => item.state === 'unknown')
      if (unknown.length === results.length) throw new Error(unknown[0]?.error || '广电云频道状态查询失败')
      const offline = results.filter(item => item.state !== 'live' && item.state !== 'unknown')
      const skipped = offline.map(item => `${item.channel.name}：${item.state === 'gone' ? '直播间已不存在' : '台方当前没有推流'}`)
      const warnings = unknown.length
        ? [`${unknown.length} 台状态没查到，先照常保留：${unknown.slice(0, 5).map(item => item.channel.name).join('、')}`]
        : []
      return { groups: buildGroups(results), meta: { skipped, warnings } }
    },

    claimsRef: ref => refs.has(String(ref || '')),
    resolve: ref => resolver.resolve(ref),
    // 只断本省的在线会话：别的省份模块正在播的不受影响
    clearResolveCache: () => resolver.clear(ref => refs.has(ref)),
    async shutdown() { resolver.clear(ref => refs.has(ref)) },
  }
}

/** 按频道表里省份第一次出现的顺序；registry 原样展开进 MODULES。 */
export const MODULES = Object.keys(PROVINCE_IDS).map(createProvinceModule)

export default MODULES
