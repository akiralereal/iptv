import { readFileSync, existsSync } from "node:fs"
import { writeJsonFileSync } from "./fileUtil.js"
import { dataPath } from "./paths.js"
import { printBlue, printGreen, printGrey, printRed, printYellow } from "./colorOut.js"
import { extractM3u8FromWeb, validateM3u8 } from "./webSourceExtractor.js"
import fetch from 'node-fetch'

/**
 * 解析 m3u/m3u8 播放列表内容，提取频道列表
 */
function parseM3uContent(content) {
  const lines = content.split('\n').map(l => l.trim()).filter(l => l)
  const channels = []
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.startsWith('#EXTINF:')) continue
    
    // 解析 #EXTINF 行
    const groupMatch = line.match(/group-title="([^"]*)"/) 
    const logoMatch = line.match(/tvg-logo="([^"]*)"/)  
    // 频道名在逗号后面
    const nameMatch = line.match(/,(.+)$/)
    
    // 下一个非注释行是 URL
    let url = ''
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].startsWith('#')) {
        url = lines[j]
        break
      }
    }
    
    if (url && nameMatch) {
      channels.push({
        name: nameMatch[1].trim(),
        group: groupMatch ? groupMatch[1] : '未分组',
        logo: logoMatch ? logoMatch[1] : '',
        url: url
      })
    }
  }

  return channels
}

/**
 * 解析 TXT（diyp / TVBox）格式播放列表，提取频道列表。
 * 格式约定：
 *   分组名,#genre#          → 分组头，后续频道归入该分组
 *   频道名,播放地址          → 一个频道
 *   频道名,地址1#地址2#地址3  → 同一频道的多个备用源，取第一个
 * 分组为空的频道交由 getValidChannels 回退到 source.group。
 */
function parseTxtContent(content) {
  const lines = content.split('\n').map(l => l.trim()).filter(l => l)
  const channels = []
  let currentGroup = ''

  for (const line of lines) {
    // 跳过注释行（m3u 残留指令、自定义注释等）
    if (line.startsWith('#')) continue

    const commaIndex = line.indexOf(',')
    if (commaIndex === -1) continue

    const name = line.slice(0, commaIndex).trim()
    const rest = line.slice(commaIndex + 1).trim()
    if (!name || !rest) continue

    // 分组头：xxx,#genre#
    if (rest.toLowerCase() === '#genre#') {
      currentGroup = name
      continue
    }

    // 频道行：部分 txt 用 # 连接多个备用源，取第一个
    const url = rest.split('#')[0].trim()
    if (!url || !url.includes('://')) continue

    channels.push({
      name,
      group: currentGroup,
      logo: '',
      url
    })
  }

  return channels
}

/**
 * 解析订阅内容，自动识别 M3U/M3U8 或 TXT（diyp/TVBox）格式。
 * 含 #EXTM3U 头或 #EXTINF 行视为 M3U，否则按 TXT 解析。
 */
function parsePlaylistContent(content) {
  if (/^﻿?#EXTM3U/i.test(content) || /#EXTINF:/i.test(content)) {
    return parseM3uContent(content)
  }
  return parseTxtContent(content)
}

/**
 * 用 GBK 解码字节，环境无 GBK 解码器时回退宽松 UTF-8
 */
function decodeGbk(buffer) {
  try {
    return new TextDecoder('gbk').decode(buffer)
  } catch {
    return buffer.toString('utf-8')
  }
}

/**
 * 解码订阅内容字节，处理非 UTF-8 编码。
 * node-fetch 的 response.text() 始终按 UTF-8 解码，部分中文 IPTV 订阅是 GBK/GB2312，
 * 直接 .text() 会导致分组名/频道名乱码。这里按优先级判定编码：
 * 1) BOM 嗅探（UTF-8 / UTF-16）；2) Content-Type 的 charset；3) 严格 UTF-8 试解，失败回退 GBK。
 * @param {Buffer} buffer - 响应原始字节
 * @param {string|null} contentType - 响应 Content-Type 头
 * @returns {string}
 */
function decodeSubscriptionBody(buffer, contentType) {
  if (!buffer || buffer.length === 0) return ''

  // 1. BOM 嗅探
  if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    return buffer.toString('utf-8', 3) // 去掉 UTF-8 BOM
  }
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
    return new TextDecoder('utf-16le').decode(buffer)
  }
  if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
    return new TextDecoder('utf-16be').decode(buffer)
  }

  // 2. Content-Type 声明的 charset
  const charset = (contentType || '').toLowerCase().match(/charset=\s*"?([\w-]+)"?/)?.[1]
  if (charset) {
    if (/^(gb2312|gb18030|gbk)$/.test(charset)) return decodeGbk(buffer)
    if (/^utf-?8$/.test(charset)) return buffer.toString('utf-8')
  }

  // 3. 启发式：先按严格 UTF-8 试解，遇到非法字节说明不是 UTF-8，回退 GBK
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return decodeGbk(buffer)
  }
}

/**
 * 将 raw.githubusercontent.com 地址转换为 jsdelivr 格式 /gh/owner/repo@branch/path
 */
function toJsdelivr(url, base) {
  let u = url.replace('https://raw.githubusercontent.com/', base)
  if (u.includes('/refs/heads/')) {
    u = u.replace('/refs/heads/', '@')
  } else {
    // owner/repo/branch/path → owner/repo@branch/path
    u = u.replace(/(\/gh\/[^/]+\/[^/]+)\//, '$1@')
  }
  return u
}

/**
 * GitHub raw 镜像列表（当直连 raw.githubusercontent.com 失败时回退）
 */
const GITHUB_RAW_MIRRORS = [
  (url) => url, // 原始地址优先
  (url) => url.replace('https://raw.githubusercontent.com/', 'https://ghfast.top/https://raw.githubusercontent.com/'),
  (url) => url.replace('https://raw.githubusercontent.com/', 'https://gh-proxy.com/https://raw.githubusercontent.com/'),
  (url) => toJsdelivr(url, 'https://gcore.jsdelivr.net/gh/'),
  (url) => toJsdelivr(url, 'https://cdn.jsdelivr.net/gh/'), // 备用 jsdelivr 边缘节点
]

/**
 * 从 URL 中取出主机名（用于日志/错误信息）
 */
function hostOf(url) {
  try { return new URL(url).host } catch { return url }
}

/**
 * 把 fetch 失败原因提炼成可读信息（node-fetch 的 reason 经常为空）
 */
function describeFetchError(error) {
  if (error?.name === 'AbortError' || error?.type === 'aborted') return '请求超时'
  return error?.code || error?.cause?.code || error?.cause?.message || error?.message || '未知错误'
}

/**
 * 从远程 URL 获取并解析 m3u 播放列表（支持 GitHub 镜像回退）
 */
async function fetchAndParseM3u(subscriptionUrl) {
  const isGithubRaw = subscriptionUrl.includes('raw.githubusercontent.com')
  const mirrors = isGithubRaw ? GITHUB_RAW_MIRRORS : [(url) => url]

  const failures = []

  for (const transformUrl of mirrors) {
    const targetUrl = transformUrl(subscriptionUrl)
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 15000)

    try {
      const response = await fetch(targetUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      })
      clearTimeout(timeoutId)

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}${response.statusText ? ' ' + response.statusText : ''}`)
      }

      // 读原始字节并按编码解码（兼容 GBK/GB2312 订阅，避免分组/频道名乱码）
      const buffer = Buffer.from(await response.arrayBuffer())
      const content = decodeSubscriptionBody(buffer, response.headers.get('content-type'))
      const channels = parsePlaylistContent(content)

      if (channels.length === 0) {
        throw new Error('未能从播放列表中解析出任何频道')
      }

      if (targetUrl !== subscriptionUrl) {
        printGreen(`通过镜像获取成功: ${hostOf(targetUrl)}`)
      }

      return channels
    } catch (error) {
      clearTimeout(timeoutId)
      const reason = describeFetchError(error)
      failures.push(`${hostOf(targetUrl)}(${reason})`)
      printYellow(`订阅获取失败 (${hostOf(targetUrl)}): ${reason}`)
      continue
    }
  }

  // 所有线路都失败：给出可操作的提示，而不是单条被截断的 node-fetch 报错
  throw new Error(`所有线路均无法获取订阅，请检查服务器能否访问 GitHub/CDN（必要时配置代理或更换可访问的订阅地址）。已尝试: ${failures.join('，')}`)
}

const EXTERNAL_SOURCES_PATH = dataPath('external-sources.json')

/**
 * 内置订阅源列表：新安装会自动写入，已有配置会在启动时补齐缺失项（按 subscriptionUrl 去重）
 */
const BUILT_IN_SUBSCRIPTIONS = [
  {
    name: '港澳地方频道',
    group: '未分组',
    enabled: true,
    mode: 'subscription',
    m3u8Url: '',
    webUrl: '',
    subscriptionUrl: 'https://raw.githubusercontent.com/YueChan/Live/refs/heads/main/GNTV.m3u',
    parsedChannels: null,
    autoRefresh: true,
    refreshInterval: 1440,
    updateOnStartup: true,
    lastUpdated: null
  },
  {
    name: '全球频道',
    group: '未分组',
    enabled: true,
    mode: 'subscription',
    m3u8Url: '',
    webUrl: '',
    subscriptionUrl: 'https://raw.githubusercontent.com/YueChan/Live/refs/heads/main/Global.m3u',
    parsedChannels: null,
    autoRefresh: true,
    refreshInterval: 1440,
    updateOnStartup: true,
    lastUpdated: null
  }
]

function cloneBuiltInSubscription(entry) {
  return JSON.parse(JSON.stringify(entry))
}

function ensureBuiltInSubscriptions(sources) {
  if (!Array.isArray(sources)) return false
  let mutated = false
  for (const builtIn of BUILT_IN_SUBSCRIPTIONS) {
    const exists = sources.some(s => s && s.subscriptionUrl === builtIn.subscriptionUrl)
    if (!exists) {
      sources.push(cloneBuiltInSubscription(builtIn))
      mutated = true
      printBlue(`补齐内置订阅源: ${builtIn.name}`)
    }
  }
  return mutated
}

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
        enabled: true,
        includeInPlaylists: true,
        updateOnStartup: true,
        sources: BUILT_IN_SUBSCRIPTIONS.map(cloneBuiltInSubscription),
        updateInterval: 60,
        lastGlobalUpdate: null
      }

      this.saveSources(defaultConfig)
      return defaultConfig
    }

    try {
      const content = readFileSync(EXTERNAL_SOURCES_PATH, 'utf-8')
      const parsed = JSON.parse(content)
      if (Array.isArray(parsed)) {
        const sources = parsed.map(s => ({ ...s, updateOnStartup: s.updateOnStartup !== false }))
        const mutated = ensureBuiltInSubscriptions(sources)
        const config = {
          enabled: true,
          includeInPlaylists: true,
          updateOnStartup: true,
          sources,
          updateInterval: 60,
          lastGlobalUpdate: null
        }
        if (mutated) this.saveSources(config)
        return config
      }
      if (typeof parsed === 'object' && parsed !== null) {
        if (!Array.isArray(parsed.sources)) {
          parsed.sources = []
        }
        if (typeof parsed.includeInPlaylists !== 'boolean') {
          parsed.includeInPlaylists = true
        }
        if (typeof parsed.updateOnStartup !== 'boolean') {
          parsed.updateOnStartup = true // 默认开启
        }
        // 为每个源添加默认的 updateOnStartup
        parsed.sources = parsed.sources.map(s => ({
          ...s,
          updateOnStartup: s.updateOnStartup !== false
        }))
        // 补齐缺失的内置订阅源
        const mutated = ensureBuiltInSubscriptions(parsed.sources)
        if (mutated) this.saveSources(parsed)
        return parsed
      }
      return { enabled: false, includeInPlaylists: true, updateOnStartup: true, sources: [] }
    } catch (error) {
      printRed(`加载外部源配置失败: ${error.message}`)
      return { enabled: false, includeInPlaylists: true, updateOnStartup: true, sources: [] }
    }
  }

  /**
   * 保存外部源配置
   */
  saveSources(sources = this.sources) {
    try {
      writeJsonFileSync(EXTERNAL_SOURCES_PATH, sources)
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
      autoRefresh: sourceConfig.autoRefresh !== false, // 是否自动刷新，默认开启
      refreshInterval: sourceConfig.refreshInterval || 240, // 刷新间隔（分钟），默认240分钟（4小时）
      updateOnStartup: sourceConfig.updateOnStartup !== false, // 重启时是否更新，默认开启
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

    // 订阅模式：获取并解析 m3u 播放列表
    if (source.mode === 'subscription') {
      return await this.updateSubscriptionSource(index)
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
        // 校验失败时选择最有可能正确的链接（优先选择链接最长的，通常包含完整参数）
        const fallback = candidates.sort((a, b) => b.length - a.length)[0]
        this.sources.sources[index].m3u8Url = fallback
        this.sources.sources[index].lastUpdated = new Date().toISOString()
        this.saveSources()
        printYellow(`${source.name} m3u8校验失败，已保存最长链接（共${candidates.length}个候选）`)
        printGrey(`  选中: ${fallback.substring(0, 100)}...`)
        return { success: true, m3u8Url: fallback, warning: `m3u8校验失败，已保存最长链接（共${candidates.length}个候选）` }
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
   * 更新订阅源：获取远程 m3u 播放列表并解析频道
   */
  async updateSubscriptionSource(index) {
    const source = this.sources.sources[index]
    if (!source.subscriptionUrl) {
      return { success: false, message: '未填写订阅地址' }
    }

    try {
      printBlue(`更新订阅源: ${source.name} (${source.subscriptionUrl})`)
      const channels = await fetchAndParseM3u(source.subscriptionUrl)
      
      this.sources.sources[index].parsedChannels = channels
      this.sources.sources[index].lastUpdated = new Date().toISOString()
      this.sources.sources[index]._failCount = 0
      this.saveSources()
      
      printGreen(`${source.name} 订阅更新成功，共 ${channels.length} 个频道`)
      return { success: true, channelCount: channels.length }
    } catch (error) {
      printRed(`${source.name} 订阅更新失败: ${error.message}`)
      
      // 如果已有缓存的频道数据，保留旧数据并设置短延迟避免每小时重试
      const hasCache = Array.isArray(source.parsedChannels) && source.parsedChannels.length > 0
      if (hasCache) {
        printYellow(`${source.name} 保留上次缓存的 ${source.parsedChannels.length} 个频道`)
        // 设置 lastUpdated 为当前时间减去 refreshInterval 的一半，避免立即重试
        const halfInterval = ((source.refreshInterval || 1440) / 2) * 60 * 1000
        this.sources.sources[index].lastUpdated = new Date(Date.now() - halfInterval).toISOString()
        this.saveSources()
      } else {
        // 没有缓存：递增失败计数，用于退避重试
        const failCount = (source._failCount || 0) + 1
        this.sources.sources[index]._failCount = failCount
        // 失败超过3次后，设置短 lastUpdated 避免每小时都发起请求
        if (failCount > 3) {
          const backoffMinutes = Math.min(failCount * 30, 360) // 最长6小时退避
          this.sources.sources[index].lastUpdated = new Date(Date.now() - ((source.refreshInterval || 1440) - backoffMinutes) * 60 * 1000).toISOString()
          this.saveSources()
          printYellow(`${source.name} 已连续失败 ${failCount} 次，${backoffMinutes} 分钟后重试`)
        }
      }
      
      return { success: false, message: error.message }
    }
  }

  /**
   * 检查源是否需要刷新
   */
  needsRefresh(source) {
    // 未设置自动刷新
    if (source.autoRefresh === false) {
      return false
    }
    
    // 从未更新过，需要刷新
    if (!source.lastUpdated) {
      return true
    }
    
    // 检查时间间隔
    const lastUpdateTime = new Date(source.lastUpdated).getTime()
    const now = Date.now()
    const intervalMs = (source.refreshInterval || 240) * 60 * 1000 // 转换为毫秒
    
    return (now - lastUpdateTime) >= intervalMs
  }

  /**
   * 更新所有启用的外部源
   * @param {Object} options - 选项
   * @param {boolean} options.autoOnly - 仅更新设置了自动刷新的源
   * @param {boolean} options.forceAll - 强制更新所有源（忽略时间间隔）
   * @param {boolean} options.startupMode - 启动模式，仅更新设置了updateOnStartup的源
   */
  async updateAllSources(options = {}) {
    const { autoOnly = false, forceAll = false, startupMode = false } = options
    
    const results = []
    let skipped = 0
    let hasWork = false
    
    for (let i = 0; i < this.sources.sources.length; i++) {
      const source = this.sources.sources[i]
      
      // 跳过禁用的源
      if (!source.enabled) {
        skipped++
        continue
      }
      
      // 启动模式：只更新设置了updateOnStartup的源
      if (startupMode && source.updateOnStartup === false) {
        skipped++
        continue
      }
      
      // 如果是仅自动模式，检查是否需要刷新
      // 注意：启动模式下不检查刷新间隔，强制更新所有启用的源
      if (autoOnly && !forceAll && !startupMode) {
        if (!this.needsRefresh(source)) {
          skipped++
          continue
        }
      }
      
      // 首次有实际工作时才打印日志
      if (!hasWork) {
        printBlue(`开始更新外部源${startupMode ? '（启动模式）' : ''}...`)
        hasWork = true
      }
      
      const result = await this.updateSource(i)
      results.push({
        index: i,
        name: source.name,
        ...result
      })
      
      // 避免请求过快，添加延迟
      if (i < this.sources.sources.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }
    
    // 仅在有源被实际处理时才保存配置，避免每小时无效写入
    if (results.length > 0) {
      this.sources.lastGlobalUpdate = new Date().toISOString()
      this.saveSources()
    }
    
    const successful = results.filter(r => r.success).length
    if (results.length > 0) {
      printGreen(`外部源更新完成: ${successful}/${results.length} 成功${skipped > 0 ? `, ${skipped} 个跳过` : ''}`)
    }
    
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
      if (!source.enabled) return
      
      // 订阅模式：展开 parsedChannels
      if (source.mode === 'subscription' && Array.isArray(source.parsedChannels)) {
        source.parsedChannels.forEach(ch => {
          const group = ch.group || source.group || '未分组'
          if (!groupMap.has(group)) {
            groupMap.set(group, {
              name: group,
              dataList: []
            })
          }
          groupMap.get(group).dataList.push({
            name: ch.name,
            url: ch.url,
            logo: ch.logo || "",
            groupTitle: group
          })
        })
        return
      }
      
      // 直连/抓取模式：单频道
      if (source.m3u8Url) {
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
   * 设置重启时是否更新（全局-咪咕源）
   */
  setUpdateOnStartup(enabled) {
    this.sources.updateOnStartup = enabled
    return this.saveSources()
  }

  /**
   * 获取配置信息
   */
  getConfig() {
    return {
      enabled: this.sources.enabled,
      includeInPlaylists: this.sources.includeInPlaylists !== false,
      updateOnStartup: this.sources.updateOnStartup !== false,
      sourcesCount: this.sources.sources.length,
      validSourcesCount: this.sources.sources.filter(s => s.enabled && s.m3u8Url).length,
      lastGlobalUpdate: this.sources.lastGlobalUpdate
    }
  }
}

// 导出单例实例
const externalSourceManager = new ExternalSourceManager()

export default externalSourceManager
export { ExternalSourceManager, fetchAndParseM3u, parsePlaylistContent, GITHUB_RAW_MIRRORS, BUILT_IN_SUBSCRIPTIONS }