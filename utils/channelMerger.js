import { dataList as getMiguChannels } from "./fetchList.js"
import externalSourceManager from "./externalSources.js"
import { printBlue, printGreen, printYellow, printRed } from "./colorOut.js"

// 缓存最近一次获取的咪咕频道数据
let cachedMiguChannels = []

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
    if (skipMigu) {
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
    printBlue("获取外部源频道数据...")
    const externalChannels = externalSourceManager.getValidChannels()
    
    // 合并数据
    const allChannels = [...miguChannels]
    
    // 将外部源按分组插入或合并
    externalChannels.forEach(externalGroup => {
      // 查找是否有同名分组
      const existingGroup = allChannels.find(group => group.name === externalGroup.name)
      
      if (existingGroup) {
        // 合并到现有分组
        existingGroup.dataList.push(...externalGroup.dataList.map(channel => ({
          ...channel,
          source: 'external' // 标记为外部源
        })))
        printGreen(`外部源 "${externalGroup.name}" 合并到现有分组，添加 ${externalGroup.dataList.length} 个频道`)
      } else {
        // 创建新分组
        allChannels.push({
          ...externalGroup,
          source: 'external',
          dataList: externalGroup.dataList.map(channel => ({
            ...channel,
            source: 'external'
          }))
        })
        printGreen(`创建外部源分组 "${externalGroup.name}"，包含 ${externalGroup.dataList.length} 个频道`)
      }
    })
    
    const externalCount = externalChannels.reduce((sum, group) => sum + group.dataList.length, 0)
    const miguCount = miguChannels.reduce((sum, group) => sum + group.dataList.length, 0)
    
    printGreen(`频道数据获取完成: 咪咕 ${miguCount} 个，外部源 ${externalCount} 个`)
    
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
    printYellow("外部源功能已禁用，跳过更新")
    return { success: true, message: "外部源已禁用" }
  }

  if (!externalSourceManager.sources.sources || externalSourceManager.sources.sources.length === 0) {
    printYellow("未配置外部源，跳过更新")
    return { success: true, message: "未配置外部源" }
  }
  
  printBlue("开始更新外部源...")
  const results = await externalSourceManager.updateAllSources({ autoOnly, forceAll, startupMode })
  
  const successful = results.filter(r => r.success).length
  const total = results.length
  
  if (results.length === 0) {
    printYellow("所有外部源均无需更新")
    return { success: true, message: "无需更新" }
  }
  
  if (successful === total) {
    printGreen(`所有外部源更新成功 (${successful}/${total})`)
    return { success: true, results }
  } else if (successful > 0) {
    printYellow(`部分外部源更新成功 (${successful}/${total})`)
    return { success: true, results, partial: true }
  } else {
    printRed(`所有外部源更新失败 (0/${total})`)
    return { success: false, results }
  }
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
  getExternalSourceStats,
  externalSourceManager
}