import { readFileSync, existsSync } from "node:fs"

/**
 * 加载自定义频道配置
 */
export function loadCustomChannels() {
  const configPath = `${process.cwd()}/custom-channels.json`
  
  if (!existsSync(configPath)) {
    return null
  }
  
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    return config
  } catch (error) {
    console.error('自定义频道配置加载失败:', error)
    return null
  }
}

/**
 * 应用自定义分组
 * @param {Array} originalData - 原始频道数据
 * @param {Object} customConfig - 自定义配置
 */
export function applyCustomGroups(originalData, customConfig) {
  if (!customConfig || !customConfig.enableCustomGroups) {
    return originalData
  }

  // 创建频道名称到频道数据的映射
  const channelMap = new Map()
  originalData.forEach(category => {
    category.dataList.forEach(channel => {
      channelMap.set(channel.name, channel)
    })
  })

  // 根据自定义分组重新组织
  const customGroups = customConfig.customGroups.map(group => {
    const dataList = []
    
    group.channels.forEach(channelName => {
      const channel = channelMap.get(channelName)
      if (channel) {
        dataList.push(channel)
      }
    })

    return {
      name: group.name,
      dataList: dataList
    }
  })

  return customGroups.filter(g => g.dataList.length > 0)
}

/**
 * 过滤排除的频道
 * @param {Array} data - 频道数据
 * @param {Array} excludeList - 排除列表
 */
export function filterExcludedChannels(data, excludeList) {
  if (!excludeList || excludeList.length === 0) {
    return data
  }

  return data.map(category => {
    const filteredDataList = category.dataList.filter(channel => {
      return !excludeList.some(excluded => channel.name.includes(excluded))
    })

    return {
      ...category,
      dataList: filteredDataList
    }
  }).filter(category => category.dataList.length > 0)
}
