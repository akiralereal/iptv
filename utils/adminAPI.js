import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { getAllChannels, externalSourceManager } from "./channelMerger.js"
import update from "./updateData.js"

const CONFIG_PATH = `${process.cwd()}/custom-channels.json`

/**
 * 获取所有频道数据（咪咕 + 外部源）
 */
export async function getChannelsAPI() {
  try {
    const channels = await getAllChannels()
    return {
      success: true,
      data: channels
    }
  } catch (error) {
    return {
      success: false,
      message: error.message
    }
  }
}

/**
 * 获取自定义配置
 */
export function getConfigAPI() {
  try {
    if (!existsSync(CONFIG_PATH)) {
      // 返回默认配置
      return {
        success: true,
        data: {
          enableCustomGroups: false,
          customGroups: [],
          excludeChannels: []
        }
      }
    }
    
    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
    return {
      success: true,
      data: config
    }
  } catch (error) {
    return {
      success: false,
      message: error.message
    }
  }
}

/**
 * 保存自定义配置
 */
export function saveConfigAPI(config) {
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')
    return {
      success: true,
      message: '配置保存成功'
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
      // 保存成功后自动触发更新，重新生成播放列表
      await update(0).catch(err => {
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
 * 重置分组为默认分组（将当前默认分组作为自定义分组的初始值）
 */
export async function resetGroupsToDefaultAPI() {
  try {
    // 获取当前的默认分组数据（未应用自定义分组时的原始数据）
    const channels = await getAllChannels()
    
    // 将分组数据转换为自定义分组格式
    const customGroups = channels.map(group => ({
      name: group.name,
      channels: group.dataList.map(channel => channel.name)
    }))
    
    // 保存为自定义分组配置
    const config = {
      enableCustomGroups: true,
      customGroups: customGroups,
      excludeChannels: []
    }
    
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')
    
    return {
      success: true,
      message: '已重置为默认分组，您现在可以在此基础上进行调整',
      data: config
    }
  } catch (error) {
    return {
      success: false,
      message: error.message
    }
  }
}
