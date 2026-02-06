import { readFileSync, writeFileSync, existsSync } from "node:fs"
import path from "node:path"
import { printBlue, printGreen, printRed } from "./colorOut.js"
import { extractM3u8FromWeb, validateM3u8 } from "./webSourceExtractor.js"

const EXTERNAL_SOURCES_PATH = path.join(process.cwd(), 'external-sources.json')

/**
 * 外部频道源管理类
 */
class ExternalSourceManager {
  
  constructor() {
    this.sources = this.loadSources()
  }

  /**
   * 加载外部源配置
   */
  loadSources() {
    if (!existsSync(EXTERNAL_SOURCES_PATH)) {
      const defaultConfig = {
        enabled: false,
        includeInPlaylists: true,
        sources: [],
        updateInterval: 60, // 更新间隔（分钟）
        lastGlobalUpdate: null
      }
      
      this.saveSources(defaultConfig)
      return defaultConfig
    }
    
    try {
      const content = readFileSync(EXTERNAL_SOURCES_PATH, 'utf-8')
      const parsed = JSON.parse(content)
      if (Array.isArray(parsed)) {
        return {
          enabled: true,
          includeInPlaylists: true,
          sources: parsed,
          updateInterval: 60,
          lastGlobalUpdate: null
        }
      }
      if (typeof parsed === 'object' && parsed !== null) {
        if (!Array.isArray(parsed.sources)) {
          parsed.sources = []
        }
        if (typeof parsed.includeInPlaylists !== 'boolean') {
          parsed.includeInPlaylists = true
        }
        return parsed
      }
      return { enabled: false, includeInPlaylists: true, sources: [] }
    } catch (error) {
      printRed(`加载外部源配置失败: ${error.message}`)
      return { enabled: false, includeInPlaylists: true, sources: [] }
    }
  }

  /**
   * 保存外部源配置
   */
  saveSources(sources = this.sources) {
    try {
      writeFileSync(EXTERNAL_SOURCES_PATH, JSON.stringify(sources, null, 2), 'utf-8')
      this.sources = sources
      return { success: true }
    } catch (error) {
      printRed(`保存外部源配置失败: ${error.message}`)
      return { success: false, message: error.message }
    }
  }

  /**
   * 添加新的外部源
   */
  addSource(sourceConfig) {
    const newSource = {
      name: sourceConfig.name,
      group: sourceConfig.group || "其他",
      webUrl: sourceConfig.webUrl,
      playButtonSelector: sourceConfig.playButtonSelector,
      m3u8Url: sourceConfig.m3u8Url || "",
      logo: sourceConfig.logo || "",
      enabled: sourceConfig.enabled !== false,
      lastUpdated: null,
      extractOptions: {
        waitTime: sourceConfig.waitTime || 5000,
        headless: sourceConfig.headless !== false,
        ...sourceConfig.extractOptions
      }
    }
    
    this.sources.sources.push(newSource)
    return this.saveSources()
  }

  /**
   * 删除外部源
   */
  removeSource(index) {
    if (index >= 0 && index < this.sources.sources.length) {
      this.sources.sources.splice(index, 1)
      return this.saveSources()
    }
    return { success: false, message: '索引无效' }
  }

  /**
   * 更新特定源的 m3u8 链接
   */
  async updateSource(index) {
    if (index < 0 || index >= this.sources.sources.length) {
      return { success: false, message: '索引无效' }
    }
    const source = this.sources.sources[index]
    if (!source.enabled) {
      return { success: false, message: '源已禁用' }
    }

    // 新增：如果 webUrl 为空且 m3u8Url 已填写，直接视为抓取成功
    if (!source.webUrl && source.m3u8Url) {
      this.sources.sources[index].lastUpdated = new Date().toISOString()
      this.saveSources()
      printGreen(`${source.name} 已手动填写m3u8，跳过网页抓取`)
      return { success: true, m3u8Url: source.m3u8Url, info: '已手动填写m3u8，跳过网页抓取' }
    }

    try {
      printBlue(`更新外部源: ${source.name}`)
      const extracted = await extractM3u8FromWeb(source.webUrl, {
        playButtonSelector: source.playButtonSelector,
        returnAll: true,
        ...source.extractOptions
      })
      const candidates = Array.isArray(extracted)
        ? extracted
        : extracted
          ? [extracted]
          : []
      if (candidates.length > 0) {
        // 验证链接有效性（逐个尝试）
        for (const candidate of candidates) {
          const isValid = await validateM3u8(candidate, { referer: source.webUrl })
          if (isValid) {
            this.sources.sources[index].m3u8Url = candidate
            this.sources.sources[index].lastUpdated = new Date().toISOString()
            this.saveSources()
            printGreen(`${source.name} 更新成功: ${candidate}`)
            return { success: true, m3u8Url: candidate }
          }
        }
        // 校验失败时仍保存首个链接，避免防盗链导致无法更新
        const fallback = candidates[0]
        this.sources.sources[index].m3u8Url = fallback
        this.sources.sources[index].lastUpdated = new Date().toISOString()
        this.saveSources()
        printRed(`${source.name} m3u8校验失败，已保存未验证链接`)
        return { success: true, m3u8Url: fallback, warning: 'm3u8校验失败，已保存未验证链接' }
      } else {
        printRed(`${source.name} 未能提取到m3u8链接`)
        return { success: false, message: '未能提取到m3u8链接' }
      }
    } catch (error) {
      printRed(`${source.name} 更新失败: ${error.message}`)
      return { success: false, message: error.message }
    }
  }

  /**
   * 更新所有启用的外部源
   */
  async updateAllSources() {
    printBlue(`开始更新所有外部源...`)
    const results = []
    
    for (let i = 0; i < this.sources.sources.length; i++) {
      const result = await this.updateSource(i)
      results.push({
        index: i,
        name: this.sources.sources[i].name,
        ...result
      })
      
      // 避免请求过快，添加延迟
      if (i < this.sources.sources.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }
    
    this.sources.lastGlobalUpdate = new Date().toISOString()
    this.saveSources()
    
    const successful = results.filter(r => r.success).length
    printGreen(`外部源更新完成: ${successful}/${results.length} 成功`)
    
    return results
  }

  /**
   * 获取有效的外部频道列表（转换为标准格式）
   */
  getValidChannels() {
    if (!this.sources.enabled) {
      return []
    }
    
    const channels = []
    const groupMap = new Map()
    
    this.sources.sources.forEach(source => {
      if (source.enabled && source.m3u8Url) {
        if (!groupMap.has(source.group)) {
          groupMap.set(source.group, {
            name: source.group,
            dataList: []
          })
        }
        
        groupMap.get(source.group).dataList.push({
          name: source.name,
          url: source.m3u8Url,
          logo: source.logo || "",
          groupTitle: source.group
        })
      }
    })
    
    return Array.from(groupMap.values())
  }

  /**
   * 手动设置 m3u8 链接（用于已知链接的情况）
   */
  setM3u8Url(index, m3u8Url) {
    if (index < 0 || index >= this.sources.sources.length) {
      return { success: false, message: '索引无效' }
    }
    
    this.sources.sources[index].m3u8Url = m3u8Url
    this.sources.sources[index].lastUpdated = new Date().toISOString()
    return this.saveSources()
  }

  /**
   * 启用/禁用外部源功能
   */
  toggleEnabled(enabled) {
    this.sources.enabled = enabled
    return this.saveSources()
  }

  /**
   * 获取配置信息
   */
  getConfig() {
    return {
      enabled: this.sources.enabled,
      includeInPlaylists: this.sources.includeInPlaylists !== false,
      sourcesCount: this.sources.sources.length,
      validSourcesCount: this.sources.sources.filter(s => s.enabled && s.m3u8Url).length,
      lastGlobalUpdate: this.sources.lastGlobalUpdate
    }
  }
}

// 导出单例实例
const externalSourceManager = new ExternalSourceManager()

export default externalSourceManager
export { ExternalSourceManager }