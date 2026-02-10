import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { getAllChannels, externalSourceManager } from "./channelMerger.js"
import update from "./updateData.js"

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


