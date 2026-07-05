import { dataList as getMiguChannels } from "./fetchList.js"
import externalSourceManager from "./externalSources.js"
import builtInSourceManager from "./builtInSources.js"
import { enableMigu } from "../config.js"
import { printBlue, printGreen, printYellow, printRed } from "./colorOut.js"

// 缓存最近一次获取的咪咕频道数据
let cachedMiguChannels = []

// 频道的「主来源」标识（issue #29/#68 按档过滤源）：
// 外部/内置源频道在 getValidChannels 里带上 sourceId（ext:<id> / bi:<id>），咪咕频道以 pID 隐式识别。
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

/**
 * 获取所有频道数据（咪咕 + 外部源）
 * @param {Object} options - 选项
 * @param {boolean} options.skipMigu - 跳过咪咕数据获取
 * @param {boolean} options.useCachedMigu - 使用缓存的咪咕数据（用于仅更新外部源时）
 */
async function getAllChannels(options = {}) {
  const { skipMigu = false, useCachedMigu = false } = options
  try {
    // 获取咪咕频道
    let miguChannels = []
    if (!enableMigu) {
      printYellow("咪咕已禁用（enableMigu=false），仅使用内置/外部源")
    } else if (skipMigu) {
      printYellow("跳过咪咕频道获取（启动时更新已关闭）")
    } else if (useCachedMigu && cachedMiguChannels.length > 0) {
      // 使用缓存数据（快速模式）
      const channelCount = cachedMiguChannels.reduce((sum, g) => sum + g.dataList.length, 0)
      printGreen(`使用缓存的咪咕频道数据 (${channelCount} 个频道) - 快速模式`)
      miguChannels = cachedMiguChannels
    } else if (useCachedMigu && cachedMiguChannels.length === 0) {
      // 缓存为空，降级为完整更新（仅第一次操作时发生）
      printYellow("缓存未初始化，执行完整更新（首次操作需要较长时间）")
      miguChannels = await getMiguChannels()
      cachedMiguChannels = miguChannels
      const channelCount = miguChannels.reduce((sum, g) => sum + g.dataList.length, 0)
      printGreen(`咪咕频道数据已缓存 (${channelCount} 个频道) - 后续操作将使用快速模式`)
    } else {
      printBlue("获取咪咕频道数据...")
      miguChannels = await getMiguChannels()
      cachedMiguChannels = miguChannels
      const channelCount = miguChannels.reduce((sum, g) => sum + g.dataList.length, 0)
      printGreen(`咪咕频道数据已缓存 (${channelCount} 个频道)`)
    }
    
    // 获取外部源频道
    const externalChannels = externalSourceManager.getValidChannels()
    
    // 获取内置源频道
    const builtInChannels = builtInSourceManager.getValidChannels()
    
    // 合并数据：咪咕源 + 内置源 + 外部源
    // 深拷贝分组及 dataList，避免 merge 操作污染 cachedMiguChannels
    const allChannels = miguChannels.map(group => ({
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
    
    // 频道级去重：同一分组内，name + 播放地址 完全相同的频道只保留第一个
    // （合并顺序为 咪咕 > 内置 > 外部，因此优先保留更高优先级的来源）
    // 只移除完全重复的条目，名称相同但地址不同的频道予以保留
    const dedupRemoved = dedupeAllChannels(allChannels)
    if (dedupRemoved > 0) {
      printYellow(`频道去重：移除 ${dedupRemoved} 个分组内完全重复的频道`)
    }

    const externalCount = externalChannels.reduce((sum, group) => sum + group.dataList.length, 0)
    const builtInCount = builtInChannels.reduce((sum, group) => sum + group.dataList.length, 0)
    const miguCount = miguChannels.reduce((sum, group) => sum + group.dataList.length, 0)

    printGreen(`频道数据获取完成: 咪咕 ${miguCount} 个，内置源 ${builtInCount} 个，外部源 ${externalCount} 个`)

    return allChannels
    
  } catch (error) {
    printRed(`获取频道数据失败: ${error.message}`)
    // 如果外部源失败，至少返回咪咕数据
    try {
      return await getMiguChannels()
    } catch (miguError) {
      printRed(`咪咕数据也获取失败: ${miguError.message}`)
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
 * 获取外部源统计信息
 */
function getExternalSourceStats() {
  return externalSourceManager.getConfig()
}

export {
  getAllChannels,
  updateExternalSources,
  updateBuiltInSources,
  getExternalSourceStats,
  externalSourceManager,
  builtInSourceManager,
  dedupeAllChannels,
  primarySourceId
}