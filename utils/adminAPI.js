import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { getAllChannels, externalSourceManager, builtInSourceManager } from "./channelMerger.js"
import update from "./updateData.js"

/**
 * 从interface.txt解析体育赛事数据
 */
function parsePEChannels() {
  try {
    const interfacePath = `${process.cwd()}/interface.txt`
    if (!existsSync(interfacePath)) {
      return []
    }
    
    const content = readFileSync(interfacePath, 'utf-8')
    const lines = content.split('\n')
    const peGroups = {}
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (line.includes('group-title="体育-')) {
        const groupMatch = line.match(/group-title="(体育-[^"]+)"/)
        const nameMatch = line.match(/tvg-name="([^"]+)"/)
        const logoMatch = line.match(/tvg-logo="([^"]+)"/)
        
        if (groupMatch && nameMatch && i + 1 < lines.length) {
          const groupName = groupMatch[1]
          const channelName = nameMatch[1]
          const logo = logoMatch ? logoMatch[1] : ''
          const url = lines[i + 1].trim()
          
          if (!peGroups[groupName]) {
            peGroups[groupName] = []
          }
          
          peGroups[groupName].push({
            name: channelName,
            logo: logo,
            url: url,
            source: 'pe' // 标记为体育赛事
          })
        }
      }
    }
    
    // 转换为频道列表格式
    return Object.entries(peGroups).map(([name, dataList]) => ({
      name: name,
      source: 'pe',
      dataList: dataList
    }))
    
  } catch (error) {
    console.error('解析PE频道失败:', error)
    return []
  }
}

/**
 * 获取所有频道数据（咪咕 + 外部源 + 体育赛事）
 */
export async function getChannelsAPI() {
  try {
    const channels = await getAllChannels()
    const peChannels = parsePEChannels()
    
    // 合并PE频道（追加到末尾）
    const allChannels = [...channels, ...peChannels]
    
    return {
      success: true,
      data: allChannels
    }
  } catch (error) {
    return {
      success: false,
      message: error.message
    }
  }
}

/**
 * 获取外部源配置
 */
export function getExternalSourcesAPI() {
  try {
    return {
      success: true,
      data: externalSourceManager.sources
    }
  } catch (error) {
    return {
      success: false,
      message: error.message
    }
  }
}

/**
 * 保存外部源配置
 */
export async function saveExternalSourcesAPI(sources) {
  try {
    const result = externalSourceManager.saveSources(sources)
    if (result.success !== false) {
      // 保存成功后自动触发更新，仅重新生成播放列表（不重新抓取咪咕数据）
      await update(0, { regenerateOnly: true }).catch(err => {
        console.error('更新播放列表失败:', err)
      })
    }
    return result
  } catch (error) {
    return {
      success: false,
      message: error.message
    }
  }
}

/**
 * 添加外部源
 */
export function addExternalSourceAPI(sourceConfig) {
  try {
    return externalSourceManager.addSource(sourceConfig)
  } catch (error) {
    return {
      success: false,
      message: error.message
    }
  }
}

/**
 * 删除外部源
 */
export function removeExternalSourceAPI(index) {
  try {
    return externalSourceManager.removeSource(index)
  } catch (error) {
    return {
      success: false,
      message: error.message
    }
  }
}

/**
 * 更新外部源
 */
export async function updateExternalSourceAPI(index) {
  try {
    if (index === -1) {
      // 更新所有源
      return await externalSourceManager.updateAllSources()
    } else {
      // 更新单个源
      return await externalSourceManager.updateSource(index)
    }
  } catch (error) {
    return {
      success: false,
      message: error.message
    }
  }
}

/**
 * 手动设置外部源的 m3u8 链接
 */
export function setExternalSourceM3u8API(index, m3u8Url) {
  try {
    return externalSourceManager.setM3u8Url(index, m3u8Url)
  } catch (error) {
    return {
      success: false,
      message: error.message
    }
  }
}

/**
 * 获取内置源列表
 */
export function getBuiltInSourcesAPI() {
  try {
    const config = builtInSourceManager.getSourceList()
    return {
      success: true,
      data: config
    }
  } catch (error) {
    return {
      success: false,
      message: error.message,
      data: { enabled: true, sources: [] }
    }
  }
}
