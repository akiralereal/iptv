/** 福建官方直播：省级动态签名 + 海博地市频道 + 福州、厦门独立线路。 */
import {
  buildProvinceGroup,
  buildChannelGroups,
  clearProvinceCache,
  clearXiamenCache,
  EXPECTED_GROUPS,
  fetchChannelGroups,
  fetchFuzhouChannels,
  fetchXiamenChannels,
  resolveProvinceChannel,
  resolveXiamenChannel,
} from './api.js'
import epg from './epg.js'

const CITY_GROUP = '福建地市台'
const OLD_FUZHOU_NAMES = new Set(['福州新闻综合', '福州综合', '福州生活', '福州少儿'])
const OLD_XIAMEN_NAMES = new Set(['厦门卫视', '厦视一套', '厦视二套', '厦视三套'])

/** 排除海博的低清厦门卫视，插入厦门官网三个地面频道，不增加新的分组。 */
export function mergeXiamenChannels(groups, xiamenChannels) {
  const output = (Array.isArray(groups) ? groups : []).map(group => ({
    ...group,
    dataList: [...(group.dataList || [])],
  }))
  if (!xiamenChannels?.length) return output

  let city = output.find(group => group.name === CITY_GROUP)
  if (!city) {
    city = { name: CITY_GROUP, dataList: [] }
    output.push(city)
  }
  const original = city.dataList
  const replacementAt = original.findIndex(channel => OLD_XIAMEN_NAMES.has(channel.name))
  city.dataList = original.filter(channel => !OLD_XIAMEN_NAMES.has(channel.name))
  city.dataList.splice(replacementAt >= 0 ? replacementAt : 0, 0, ...xiamenChannels)
  return output
}

/** 用福州官网三路替换海博里的单路福州台，不增加新的分组。 */
export function mergeFuzhouChannels(groups, fuzhouChannels) {
  const output = (Array.isArray(groups) ? groups : []).map(group => ({
    ...group,
    dataList: [...(group.dataList || [])],
  }))
  if (!fuzhouChannels?.length) return output

  let city = output.find(group => group.name === CITY_GROUP)
  if (!city) {
    city = { name: CITY_GROUP, dataList: [] }
    output.push(city)
  }

  const original = city.dataList
  const replacementAt = original.findIndex(channel => OLD_FUZHOU_NAMES.has(channel.name))
  city.dataList = original.filter(channel => !OLD_FUZHOU_NAMES.has(channel.name))
  let lastXiamen = -1
  city.dataList.forEach((channel, index) => {
    if (OLD_XIAMEN_NAMES.has(channel.name)) lastXiamen = index
  })
  const insertAt = replacementAt >= 0 ? Math.min(replacementAt, city.dataList.length) : lastXiamen + 1
  city.dataList.splice(insertAt, 0, ...fuzhouChannels)
  return output
}

function validateHaiboGroups(rows, groups) {
  for (const groupRows of rows) {
    const expected = EXPECTED_GROUPS[groupRows.sortId]
    const definition = groups.find(group => group.name === expected?.name)
    const actual = definition?.dataList?.length || 0
    if (!expected || actual !== expected.channelCount) {
      throw new Error(`海博TV频道分类 ${groupRows.sortId} 只找到 ${actual}/${expected?.channelCount || 0} 个正式频道（官网可能已改版）`)
    }
  }
}

export default {
  id: 'fjtv',
  name: '福建',
  description: '福建省级频道播放时自动续签；地市、福州和厦门官方线路独立抓取并合入现有福建分组。',
  capabilities: { cache: 'disk', resolve: true, epg: true },
  outputGroupName: '福建',
  defaultRefreshMinutes: 360,
  refreshConfigurable: false,
  refreshDescription: '自动管理：省级六路在播放时刷新短效地址；每 360 分钟刷新地市频道表及福州、厦门官方 HLS。',

  configSchema: [],
  // 省级走云直播平台节目单、厦门走看厦门接口；与取流链路只共用频道表（见 epg.js）
  epg,

  async fetch(_config, ctx = {}) {
    const options = { timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl }
    const warnings = []
    let groups = [buildProvinceGroup()]
    let haiboError = null
    let fuzhouError = null
    let xiamenError = null

    try {
      const rows = await fetchChannelGroups(options)
      groups = buildChannelGroups(rows)
      validateHaiboGroups(rows, groups)
      groups.unshift(buildProvinceGroup())
    } catch (error) {
      haiboError = error
      warnings.push(`海博TV地市频道本轮不可用：${error?.message || error}`)
      groups = [buildProvinceGroup()]
    }

    try {
      const xiamen = await fetchXiamenChannels(options)
      groups = mergeXiamenChannels(groups, xiamen.channels)
      warnings.push(...xiamen.warnings)
    } catch (error) {
      xiamenError = error
      warnings.push(error?.message || String(error))
    }

    try {
      const fuzhou = await fetchFuzhouChannels(options)
      groups = mergeFuzhouChannels(groups, fuzhou.channels)
      warnings.push(...fuzhou.warnings)
    } catch (error) {
      fuzhouError = error
      warnings.push(error?.message || String(error))
    }

    const count = groups.reduce((sum, group) => sum + (group.dataList?.length || 0), 0)
    if (!count) {
      const reasons = [haiboError?.message, xiamenError?.message, fuzhouError?.message].filter(Boolean).join('；')
      throw new Error(`福建官方直播本轮全部抓取失败：${reasons || '没有可用频道'}`)
    }
    return { groups, meta: { skipped: [], warnings } }
  },

  claimsRef: ref => /^fjtv-(?:province-\d{18}|xiamen-(?:16|17|18))$/.test(String(ref || '')),
  resolve(ref, ctx) {
    return String(ref || '').startsWith('fjtv-province-')
      ? resolveProvinceChannel(ref, ctx)
      : resolveXiamenChannel(ref, ctx)
  },
  clearResolveCache() {
    clearProvinceCache()
    clearXiamenCache()
  },
}
