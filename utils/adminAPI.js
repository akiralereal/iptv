import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { getAllChannels, externalSourceManager } from "./channelMerger.js"

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
export function saveExternalSourcesAPI(sources) {
  try {
    const result = externalSourceManager.saveSources(sources)
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
