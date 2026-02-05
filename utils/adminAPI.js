import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { dataList } from "./fetchList.js"

const CONFIG_PATH = `${process.cwd()}/custom-channels.json`

/**
 * 获取所有频道数据
 */
export async function getChannelsAPI() {
  try {
    const channels = await dataList()
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
