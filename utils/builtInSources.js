import { readFileSync, existsSync, writeFileSync } from "node:fs"
import { printBlue, printGreen, printYellow, printRed } from "./colorOut.js"
import { extractM3u8FromWeb } from "./webSourceExtractor.js"

/**
 * 内置源管理器
 * 内置源特点：
 * 1. 打包在项目中，不可删除
 * 2. 用户只能启用/禁用，不能编辑
 * 3. 版本更新时可以添加新的内置源
 * 4. 支持直连和抓取两种模式
 */
class BuiltInSourceManager {
  constructor() {
    this.configPath = `${process.cwd()}/built-in-sources.json`
    this.cachePath = `${process.cwd()}/built-in-sources-cache.json`
    this.sources = { enabled: true, sources: [] }
    this.cache = {} // { sourceId: { m3u8Url, lastUpdate } }
    this.loadConfig()
    this.loadCache()
  }

  /**
   * 加载内置源配置
   */
  loadConfig() {
    try {
      if (!existsSync(this.configPath)) {
        printYellow("内置源配置文件不存在，使用空配置")
        return
      }

      const content = readFileSync(this.configPath, 'utf-8')
      this.sources = JSON.parse(content)
      
      if (!this.sources.enabled) {
        printYellow("内置源功能已禁用")
        return
      }

      const enabledCount = this.sources.sources.filter(s => s.enabled).length
      const fetchCount = this.sources.sources.filter(s => s.mode === 'fetch').length
      printGreen(`加载内置源配置: ${enabledCount}/${this.sources.sources.length} 个启用 (${fetchCount} 个需要抓取)`)
    } catch (error) {
      printRed(`加载内置源配置失败: ${error.message}`)
      this.sources = { enabled: true, sources: [] }
    }
  }

  /**
   * 加载缓存
   */
  loadCache() {
    try {
      if (existsSync(this.cachePath)) {
        const content = readFileSync(this.cachePath, 'utf-8')
        this.cache = JSON.parse(content)
      }
    } catch (error) {
      printYellow(`加载内置源缓存失败: ${error.message}`)
      this.cache = {}
    }
  }

  /**
   * 保存缓存
   */
  saveCache() {
    try {
      writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 2), 'utf-8')
    } catch (error) {
      printRed(`保存内置源缓存失败: ${error.message}`)
    }
  }

  /**
   * 获取源的m3u8地址（优先使用缓存）
   */
  getM3u8Url(source) {
    // 直连模式直接返回配置的URL
    if (source.mode === 'direct' || !source.mode) {
      return source.m3u8Url
    }

    // 抓取模式：优先使用缓存
    if (this.cache[source.id]) {
      return this.cache[source.id].m3u8Url
    }

    return null
  }

  /**
   * 检查内置源是否需要刷新
   */
  needsRefresh(source) {
    // 未设置自动刷新
    if (source.autoRefresh === false) {
      return false
    }
    
    // 直连模式不需要刷新
    if (source.mode === 'direct') {
      return false
    }
    
    // 没有缓存，需要刷新
    if (!this.cache[source.id]) {
      return true
    }
    
    // 检查时间间隔
    const lastUpdateTime = this.cache[source.id].lastUpdate
    const now = Date.now()
    const intervalMs = (source.refreshInterval || 240) * 60 * 1000 // 转换为毫秒
    
    return (now - lastUpdateTime) >= intervalMs
  }

  /**
   * 更新需要抓取的内置源
   * @param {Object} options - 更新选项
   * @param {boolean} options.startupMode - 启动模式，只更新updateOnStartup=true的源
   * @param {boolean} options.autoOnly - 仅更新需要自动刷新的源（检查时间间隔）
   * @param {boolean} options.forceAll - 强制更新所有抓取源
   */
  async updateFetchSources(options = {}) {
    const { startupMode = false, autoOnly = false, forceAll = false } = options
    
    if (!this.sources.enabled) {
      return { success: true, message: "内置源已禁用" }
    }

    const fetchSources = this.sources.sources.filter(source => {
      if (!source.enabled) return false
      if (source.mode !== 'fetch') return false
      if (startupMode && !source.updateOnStartup) return false
      return true
    })

    if (fetchSources.length === 0) {
      printYellow("没有需要更新的内置源")
      return { success: true, message: "无需更新" }
    }

    printBlue(`开始更新内置源 (${fetchSources.length} 个)${autoOnly ? '（仅自动刷新）' : ''}${startupMode ? '（启动模式）' : ''}...`)
    const results = []
    let skipped = 0

    for (const source of fetchSources) {
      // autoOnly 模式下检查是否需要刷新
      if (autoOnly && !forceAll && !startupMode) {
        if (!this.needsRefresh(source)) {
          const cacheInfo = this.cache[source.id]
          const lastUpdate = cacheInfo ? new Date(cacheInfo.updateTime).toLocaleString('zh-CN') : '从未'
          printYellow(`${source.name} 无需刷新（上次更新: ${lastUpdate}, 间隔: ${source.refreshInterval || 240}分钟）`)
          skipped++
          continue
        }
      }
      
      try {
        printBlue(`更新内置源: ${source.name}`)
        printBlue(`开始提取: ${source.webUrl}`)
        
        const m3u8Url = await extractM3u8FromWeb(
          source.webUrl,
          source.extractOptions || {}
        )

        if (m3u8Url) {
          this.cache[source.id] = {
            m3u8Url,
            lastUpdate: Date.now(),
            updateTime: new Date().toISOString()
          }
          this.saveCache()
          
          printGreen(`✓ ${source.name} 更新成功`)
          
          results.push({ 
            id: source.id, 
            name: source.name, 
            success: true,
            m3u8Url
          })
        } else {
          printRed(`✗ ${source.name} 更新失败: 未找到m3u8链接`)
          results.push({ 
            id: source.id, 
            name: source.name, 
            success: false,
            error: '未找到m3u8链接'
          })
        }
      } catch (error) {
        printRed(`✗ ${source.name} 更新失败: ${error.message}`)
        results.push({ 
          id: source.id, 
          name: source.name, 
          success: false,
          error: error.message
        })
      }
    }

    const successful = results.filter(r => r.success).length
    if (results.length === 0 && skipped > 0) {
      printYellow(`所有内置源均无需更新 (${skipped} 个跳过)`)
    } else if (successful === results.length) {
      printGreen(`内置源更新完成: 全部成功 (${successful}/${results.length})${skipped > 0 ? `, ${skipped} 个跳过` : ''}`)
    } else if (successful > 0) {
      printYellow(`内置源更新完成: 部分成功 (${successful}/${results.length})${skipped > 0 ? `, ${skipped} 个跳过` : ''}`)
    } else {
      printRed(`内置源更新完成: 全部失败 (0/${results.length})${skipped > 0 ? `, ${skipped} 个跳过` : ''}`)
    }

    return { success: true, results }
  }

  /**
   * 获取所有有效的内置源频道（按分组）
   */
  getValidChannels() {
    if (!this.sources.enabled) {
      return []
    }

    const groups = {}
    
    this.sources.sources
      .filter(source => source.enabled)
      .forEach(source => {
        const m3u8Url = this.getM3u8Url(source)
        
        // 如果是抓取模式但没有缓存URL，跳过
        if (!m3u8Url) {
          printYellow(`内置源 ${source.name} 尚未抓取，跳过`)
          return
        }
        
        const groupName = source.group || '未分组'
        
        if (!groups[groupName]) {
          groups[groupName] = {
            name: groupName,
            dataList: []
          }
        }

        groups[groupName].dataList.push({
          id: source.id,
          name: source.name,
          playURL: m3u8Url,
          builtIn: true,
          mode: source.mode || 'direct',
          description: source.description || ''
        })
      })

    return Object.values(groups)
  }

  /**
   * 获取内置源列表（用于管理后台）
   */
  getSourceList() {
    return {
      enabled: this.sources.enabled,
      sources: this.sources.sources.map(source => {
        const cachedUrl = this.cache[source.id]?.m3u8Url
        return {
          ...source,
          builtIn: true,
          cachedM3u8Url: cachedUrl || null,
          lastUpdate: this.cache[source.id]?.updateTime || null
        }
      })
    }
  }

  /**
   * 获取配置
   */
  getConfig() {
    const fetchCount = this.sources.sources.filter(s => s.mode === 'fetch').length
    const cachedCount = Object.keys(this.cache).length
    
    return {
      enabled: this.sources.enabled,
      totalCount: this.sources.sources.length,
      enabledCount: this.sources.sources.filter(s => s.enabled).length,
      fetchCount,
      cachedCount
    }
  }
}

// 创建单例
const builtInSourceManager = new BuiltInSourceManager()

export default builtInSourceManager
