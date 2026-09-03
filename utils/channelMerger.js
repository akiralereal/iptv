import externalSourceManager from "./externalSources.js"
import builtInSourceManager from "./builtInSources.js"
import { getExtractorManager } from "./extractorManager.js"
import { printBlue, printGreen, printYellow, printRed } from "./colorOut.js"
import { isLocalGroup } from "./playlistConfig.js"

// 频道的「主来源」标识（issue #29/#68 按档过滤源）：
// 外部/内置/抓取模块的频道在 getValidChannels 里带上 sourceId（ext:<id> / bi:<id> / xt:<id>），
// 咪咕频道无 sourceId、以 pID 隐式识别。
function primarySourceId(ch) {
  return ch.sourceId || (ch.pID != null ? 'migu' : '')
}

// 分组内去重（纯函数，供测试）：name + 播放地址 完全相同只留第一个；
// 命中重复时把归属并入保留者的 sourceIds 并集——同一频道多个源提供时，按档禁用其一不误删（issue #29/#68）。
function dedupeAllChannels(allChannels) {
  let removed = 0
  for (const group of allChannels) {
    const seen = new Map()
    const kept = []
    for (const ch of group.dataList) {
      const urlKey = ch.url || ch.playURL || (ch.pID != null ? `migu:${ch.pID}` : '')
      const key = `${(ch.name || '').trim().toLowerCase()} ${urlKey}`
      const prev = seen.get(key)
      if (prev) {
        removed++
        const sid = primarySourceId(ch)
        if (sid) {
          if (!Array.isArray(prev.sourceIds)) {
            const own = primarySourceId(prev)
            prev.sourceIds = own ? [own] : []
          }
          if (!prev.sourceIds.includes(sid)) prev.sourceIds.push(sid)
          for (const extra of (ch.sourceIds || [])) {
            if (!prev.sourceIds.includes(extra)) prev.sourceIds.push(extra)
          }
        }
        continue
      }
      seen.set(key, ch)
      kept.push(ch)
    }
    group.dataList = kept
  }
  return removed
}

/** 「纪实」改名为「文旅」，并合并已经使用新名的其它来源。 */
function normalizeContentGroupNames(groups) {
  const output = []
  const byName = new Map()
  for (const group of Array.isArray(groups) ? groups : []) {
    const name = group?.name === '纪实' ? '文旅' : group?.name
    const channels = Array.isArray(group?.dataList) ? group.dataList : []
    const existing = byName.get(name)
    if (existing) {
      existing.dataList.push(...channels)
      continue
    }
    const normalized = { ...group, name, dataList: [...channels] }
    byName.set(name, normalized)
    output.push(normalized)
  }
  return output
}

// 地方官方模块的少儿频道在保留省份归属的同时，也收到「少儿」组。部分频道
// 名字不带「少儿 / 卡通 / 动漫」，需要明确补入，避免漏分。
const LOCAL_KIDS_EXACT_NAMES = new Set(['哈哈炫动'])

function isKidsChannel(channel) {
  const name = String(channel?.name || '').trim()
  return LOCAL_KIDS_EXACT_NAMES.has(name) || /(少儿|卡通|动漫)/.test(name)
}

// 只用于少儿组的重复判定：「优漫卡通频道」与「优漫卡通」、
// 「海南广播电视总台少儿频道」与「海南少儿」应视为同一频道。
function kidsChannelKey(channel) {
  return String(channel?.name || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/广播电视总台/g, '')
    .replace(/频道$/, '')
}

/**
 * 把符合条件的地方频道复制到内容分组，地方组仍保留完整频道；
 * 如果其它内容分组已有同台条目，用地方官方源替换并去掉重复。
 * 返回新分组，不修改输入。
 *
 * prepend=true 时官方源按自身顺序插到目标组最前，目标组原有的同台条目一律让位。
 * 默认（false）是原地替换：官方源顶掉同台条目、位置沿用目标组既有排序——内容组
 * （体育/少儿/教育）的顺序由平台分类决定，不该被地方组的收录顺序打乱。
 */
function consolidateLocalChannels(groups, { targetGroup, matches, keyOf, prepend = false }) {
  const output = (Array.isArray(groups) ? groups : []).map(group => ({
    ...group,
    dataList: [...(Array.isArray(group?.dataList) ? group.dataList : [])],
  }))
  const localChannels = []

  for (const group of output) {
    if (!isLocalGroup(group.name)) continue
    for (const channel of group.dataList) {
      if (matches(channel)) localChannels.push(channel)
    }
  }
  if (!localChannels.length) return output

  const preferred = new Map()
  for (const channel of localChannels) {
    const key = keyOf(channel)
    if (key && !preferred.has(key)) preferred.set(key, channel)
  }

  // 同台可能被平台放在其它分类（如「南京教科频道」在纪实），
  // 不能只查目标组，否则重复源会换个分组继续存在；
  // 地方组是用户需要的完整省份入口，不参与此处删重。
  for (const group of output) {
    if (group.name === targetGroup || isLocalGroup(group.name)) continue
    group.dataList = group.dataList.filter(channel => !preferred.has(keyOf(channel)))
  }

  let contentGroup = output.find(group => group.name === targetGroup)
  if (!contentGroup) {
    contentGroup = { name: targetGroup, dataList: [] }
    const firstLocal = output.findIndex(group => isLocalGroup(group.name))
    output.splice(firstLocal >= 0 ? firstLocal : output.length, 0, contentGroup)
  }

  const placedPreferred = new Set()
  const merged = []
  if (prepend) {
    for (const channel of localChannels) {
      const key = keyOf(channel)
      if (!key || placedPreferred.has(key)) continue
      merged.push(preferred.get(key) || channel)
      placedPreferred.add(key)
    }
  }
  for (const channel of contentGroup.dataList) {
    const key = keyOf(channel)
    const local = preferred.get(key)
    if (!local) {
      merged.push(channel)
      continue
    }
    if (!placedPreferred.has(key)) {
      merged.push(local)
      placedPreferred.add(key)
    }
  }
  for (const channel of localChannels) {
    const key = keyOf(channel)
    if (placedPreferred.has(key)) continue
    merged.push(preferred.get(key) || channel)
    placedPreferred.add(key)
  }
  contentGroup.dataList = merged

  return output.filter(group => group.dataList.length > 0)
}

function consolidateLocalKidsChannels(groups) {
  return consolidateLocalChannels(groups, {
    targetGroup: '少儿',
    matches: isKidsChannel,
    keyOf: kidsChannelKey,
  })
}

function isEducationChannel(channel) {
  const name = String(channel?.name || '').trim()
  // 「河北少儿科教」以少儿属性为主，应由上面的少儿规则处理。
  return !isKidsChannel(channel) && /(教育|科教|教科)/.test(name)
}

function educationChannelKey(channel) {
  return String(channel?.name || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/教育科技/g, '教科')
    .replace(/频道$/, '')
}

function consolidateLocalEducationChannels(groups) {
  return consolidateLocalChannels(groups, {
    targetGroup: '教育',
    matches: isEducationChannel,
    keyOf: educationChannelKey,
  })
}

// 地方体育频道多数直接带「体育」，「武术世界」是河南官方体育频道的例外名称。
const LOCAL_SPORTS_EXACT_NAMES = new Set(['武术世界'])

function isSportsChannel(channel) {
  const name = String(channel?.name || '').trim()
  return LOCAL_SPORTS_EXACT_NAMES.has(name) || /体育/.test(name)
}

function sportsChannelKey(channel) {
  return String(channel?.name || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/频道$/, '')
}

function consolidateLocalSportsChannels(groups) {
  return consolidateLocalChannels(groups, {
    targetGroup: '体育',
    matches: isSportsChannel,
    keyOf: sportsChannelKey,
  })
}

// 凤凰卫视三台的官方源是凤凰秀模块（归入「香港」）。「亚太」是外部订阅整理出的
// 港澳台入口，用户找凤凰先看那里，所以官方三台再置顶复制一份进去，「香港」照旧保留。
// 第三方源的同台条目一律让位——那些转流地址画质不明、随时失效，留在同名多源里
// 只会让播放器在「源1/源2」之间挑到坏的那条。命名变体（凤凰卫视中文台）一并覆盖。
const FENGSHOWS_SOURCE_ID = 'xt:fengshows'

function isFengshowsChannel(channel) {
  return primarySourceId(channel) === FENGSHOWS_SOURCE_ID
    || (Array.isArray(channel?.sourceIds) && channel.sourceIds.includes(FENGSHOWS_SOURCE_ID))
}

// 只认「凤凰」开头的台名，并抹平各源命名差异：凤凰卫视中文台 / 凤凰中文台 → 凤凰中文。
// 其它频道返回空串——consolidateLocalChannels 对空键不做任何删改，不会误伤。
function phoenixChannelKey(channel) {
  const name = String(channel?.name || '').trim().replace(/\s+/g, '')
  if (!name.startsWith('凤凰')) return ''
  return name.replace(/卫视/g, '').replace(/(?:台|频道)$/, '')
}

function consolidatePhoenixChannels(groups) {
  return consolidateLocalChannels(groups, {
    targetGroup: '亚太',
    matches: channel => isFengshowsChannel(channel) && Boolean(phoenixChannelKey(channel)),
    keyOf: phoenixChannelKey,
    prepend: true,
  })
}

/**
 * 获取所有频道数据（咪咕 + 外部源）
 * @param {Object} options - 选项
 * @param {boolean} options.skipMigu - 跳过咪咕数据获取
 * @param {boolean} options.useCachedMigu - 使用缓存的咪咕数据（用于仅更新外部源时）
 */
async function getAllChannels() {
  try {
    // 抓取模块（咪咕也在其中）。读的是模块缓存而非现抓——抓取失败时沿用上一轮
    // 结果，否则频道会静默从播放列表消失（全局的 0 频道守卫只看总数，护不住
    // 单个模块）。缓存冷时 ensureWarm 现抓一次：cache:'memory' 的模块重启后
    // 缓存是空的，而 regenerateOnly 那轮不触发抓取。
    const extractorManager = getExtractorManager()
    await extractorManager.ensureWarm()
    const extractorChannels = extractorManager.getValidChannels()

    // 获取外部源频道
    const externalChannels = externalSourceManager.getValidChannels()
    
    // 获取内置源频道
    const builtInChannels = builtInSourceManager.getValidChannels()

    // 合并数据：抓取模块（咪咕居首）+ 内置源 + 外部源
    // 组内去重保留先入者，所以打底的顺序即优先级——咪咕在注册表 MODULES 里
    // 排第一，其频道的优先级与收编前一致。
    let allChannels = extractorChannels.map(group => ({
      ...group,
      dataList: [...group.dataList]
    }))
    
    // 先合并内置源
    // 注意：内置源频道用 playURL 字段，不能在此补 url —
    // 下游 updateData.js 用 `!!channelItem.url` 判定外部源，补 url 会让内置源被误判为外部源。
    const tagBuiltIn = channel => ({
      ...channel,
      source: 'built-in'
    })
    builtInChannels.forEach(builtInGroup => {
      const existingGroup = allChannels.find(group => group.name === builtInGroup.name)

      if (existingGroup) {
        existingGroup.dataList.push(...builtInGroup.dataList.map(tagBuiltIn))
      } else {
        allChannels.push({
          ...builtInGroup,
          source: 'built-in',
          dataList: builtInGroup.dataList.map(tagBuiltIn)
        })
      }
    })
    
    // 再合并外部源
    externalChannels.forEach(externalGroup => {
      const existingGroup = allChannels.find(group => group.name === externalGroup.name)
      
      if (existingGroup) {
        existingGroup.dataList.push(...externalGroup.dataList.map(channel => ({
          ...channel,
          source: 'external'
        })))
      } else {
        allChannels.push({
          ...externalGroup,
          source: 'external',
          dataList: externalGroup.dataList.map(channel => ({
            ...channel,
            source: 'external'
          }))
        })
      }
    })

    // 平台历史名「纪实」统一显示为「文旅」，外部精选频道
    // 也合并到同一组，避免新旧名并存。
    allChannels = normalizeContentGroupNames(allChannels)

    // 内容型分组按频道性质统一：地方体育 / 少儿 / 教育频道分别复制到
    // 对应内容组，地方组仍保持完整；同台多源时优先地方官方线路。
    allChannels = consolidateLocalSportsChannels(allChannels)
    allChannels = consolidateLocalKidsChannels(allChannels)
    allChannels = consolidateLocalEducationChannels(allChannels)
    // 凤凰三台置顶进「亚太」，并顶掉第三方源的同台条目
    allChannels = consolidatePhoenixChannels(allChannels)
    
    // 频道级去重：同一分组内，name + 播放地址 完全相同的频道只保留第一个
    // （合并顺序为 咪咕 > 内置 > 外部 > 抓取模块，因此优先保留更高优先级的来源）
    // 只移除完全重复的条目，名称相同但地址不同的频道予以保留
    const dedupRemoved = dedupeAllChannels(allChannels)
    if (dedupRemoved > 0) {
      printYellow(`频道去重：移除 ${dedupRemoved} 个分组内完全重复的频道`)
    }

    const externalCount = externalChannels.reduce((sum, group) => sum + group.dataList.length, 0)
    const builtInCount = builtInChannels.reduce((sum, group) => sum + group.dataList.length, 0)
    // 咪咕现在是抓取模块之一，按归属拆开统计，日志格式与收编前保持一致
    let miguCount = 0
    let extractorCount = 0
    for (const group of extractorChannels) {
      for (const channel of group.dataList) {
        if (channel.sourceId === 'migu') miguCount++
        else extractorCount++
      }
    }

    printGreen(`频道数据获取完成: 咪咕 ${miguCount} 个，内置源 ${builtInCount} 个，外部源 ${externalCount} 个，抓取模块 ${extractorCount} 个`)

    return allChannels
    
  } catch (error) {
    printRed(`获取频道数据失败: ${error.message}`)
    // 合并环节出错时至少返回抓取模块的缓存（咪咕在其中）。
    // 注意不能直接返回 fetchList 的裸数据——那份没有 deferredRef，写盘会变成
    // ${replace}/undefined，比少几个频道糟糕得多。
    try {
      return getExtractorManager().getValidChannels()
    } catch (fallbackError) {
      printRed(`抓取模块缓存也不可用: ${fallbackError.message}`)
      return []
    }
  }
}

/**
 * 更新外部源
 * @param {Object} options - 更新选项
 * @param {boolean} options.autoOnly - 仅更新设置了自动刷新的源（默认true）
 * @param {boolean} options.forceAll - 强制更新所有源
 * @param {boolean} options.startupMode - 启动模式，仅更新设置了updateOnStartup的源
 */
async function updateExternalSources(options = {}) {
  const { autoOnly = true, forceAll = false, startupMode = false } = options
  
  if (!externalSourceManager.sources.enabled) {
    return { success: true, message: "外部源已禁用" }
  }

  if (!externalSourceManager.sources.sources || externalSourceManager.sources.sources.length === 0) {
    return { success: true, message: "未配置外部源" }
  }
  
  const results = await externalSourceManager.updateAllSources({ autoOnly, forceAll, startupMode })
  
  const successful = results.filter(r => r.success).length
  const total = results.length
  
  if (results.length === 0) {
    return { success: true, message: "无需更新" }
  }
  
  if (successful === total) {
    return { success: true, results }
  } else if (successful > 0) {
    return { success: true, results, partial: true }
  } else {
    return { success: false, results }
  }
}

/**
 * 更新内置源（需要抓取的）
 * @param {Object} options - 更新选项
 * @param {boolean} options.startupMode - 启动模式，仅更新updateOnStartup=true的源
 * @param {boolean} options.forceAll - 强制更新所有抓取源
 */
async function updateBuiltInSources(options = {}) {
  return await builtInSourceManager.updateFetchSources(options)
}

/**
 * 更新抓取模块
 *
 * 返回值形状与 updateExternalSources 一致（success / results / partial），
 * 好让 app.js 的定时器和后台按钮用同一套归类逻辑。
 * @param {Object} options - { autoOnly, forceAll, onlyId }
 */
async function updateExtractors(options = {}) {
  // 这里刻意不判模块是否启用：判定在 extractorManager.isModuleEnabled 里，
  // 因为代理开关的模块（咪咕听 enableMigu）要绕过子系统总开关。
  const { updated, results, message } = await getExtractorManager().updateAll(options)
  if (message) return { success: true, message }
  if (!results.length) return { success: true, message: "无需更新" }

  const successful = results.filter(r => r.success).length
  if (successful === results.length) return { success: true, results, updated }
  if (successful > 0) return { success: true, results, partial: true, updated }
  return { success: false, results, updated }
}

/**
 * 获取外部源统计信息
 */
function getExternalSourceStats() {
  return externalSourceManager.getConfig()
}

export {
  getAllChannels,
  updateExternalSources,
  updateBuiltInSources,
  updateExtractors,
  getExternalSourceStats,
  externalSourceManager,
  builtInSourceManager,
  dedupeAllChannels,
  primarySourceId,
  normalizeContentGroupNames,
  consolidateLocalSportsChannels,
  consolidateLocalKidsChannels,
  consolidateLocalEducationChannels,
  consolidatePhoenixChannels
}
