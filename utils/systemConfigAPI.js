import { readFileSync, writeFileSync, existsSync } from "node:fs"
import path from "node:path"

const SYSTEM_CONFIG_PATH = path.join(process.cwd(), 'system-config.json')

/**
 * 获取系统配置
 */
export function getSystemConfigAPI() {
  try {
    if (!existsSync(SYSTEM_CONFIG_PATH)) {
      // 返回默认配置
      return {
        success: true,
        data: {
          userId: "",
          token: "",
          port: 1905,
          host: "",
          rateType: 3,
          pass: "",
          enableHDR: true,
          enableH265: true,
          programInfoUpdateInterval: "8"
        }
      }
    }
    
    const config = JSON.parse(readFileSync(SYSTEM_CONFIG_PATH, 'utf-8'))
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
 * 保存系统配置
 */
export function saveSystemConfigAPI(config) {
  try {
    // 验证配置
    const validated = {
      userId: config.userId || "",
      token: config.token || "",
      port: parseInt(config.port) || 1905,
      host: config.host || "",
      rateType: parseInt(config.rateType) || 3,
      pass: config.pass || "",
      enableHDR: config.enableHDR !== false,
      enableH265: config.enableH265 !== false,
      programInfoUpdateInterval: config.programInfoUpdateInterval || "8"
    }
    
    writeFileSync(SYSTEM_CONFIG_PATH, JSON.stringify(validated, null, 2), 'utf-8')
    return {
      success: true,
      message: '配置保存成功，重启服务后生效'
    }
  } catch (error) {
    return {
      success: false,
      message: error.message
    }
  }
}
