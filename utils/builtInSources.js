import { readFileSync, existsSync } from "node:fs"
import { writeJsonFileSync } from "./fileUtil.js"
import { dataPath } from "./paths.js"
import { enableBuiltInSources } from "../config.js"
import { printBlue, printGreen, printYellow, printRed } from "./colorOut.js"
import { extractM3u8FromWeb, validateM3u8 } from "./webSourceExtractor.js"
import { FailureBackoff } from "./refreshBackoff.js"
import fetch from "node-fetch"

// 内置源配置的远程地址：运行时优先从此拉取（含 GitHub 镜像回退），让 webUrl 等配置「push 即更新」、无需重建镜像。
// 设为空字符串(mbuiltInSourcesUrl=)可关闭远程拉取，只用镜像内置的本地 built-in-sources.json（便于本地开发调试）。
const BUILT_IN_SOURCES_URL = process.env.mbuiltInSourcesUrl !== undefined
  ? process.env.mbuiltInSourcesUrl
  : 'https://raw.githubusercontent.com/akiralereal/iptv/refs/heads/main/built-in-sources.json'

// GitHub raw 镜像（与 externalSources.js 保持一致；国内直连 raw 失败时回退，多为给国内访问 GitHub 用的代理/CDN）
function toJsdelivr(url, base) {
  let u = url.replace('https://raw.githubusercontent.com/', base)
  if (u.includes('/refs/heads/')) u = u.replace('/refs/heads/', '@')
  else u = u.replace(/(\/gh\/[^/]+\/[^/]+)\//, '$1@')
  return u
}
const GITHUB_RAW_MIRRORS = [
  (url) => url, // 原始地址优先
  (url) => url.replace('https://raw.githubusercontent.com/', 'https://ghfast.top/https://raw.githubusercontent.com/'),
  (url) => url.replace('https://raw.githubusercontent.com/', 'https://gh-proxy.com/https://raw.githubusercontent.com/'),
  (url) => toJsdelivr(url, 'https://gcore.jsdelivr.net/gh/'),
  (url) => toJsdelivr(url, 'https://cdn.jsdelivr.net/gh/'),
]

// 一轮刷新里最多尝试几个抓取网址。抓一个地址就要起一次 Chromium（页面超时 30s），
// 远程配置塞十几个备用域名时不加限制会让单轮跑掉十几分钟，低配 NAS 上尤其难受。
// 可按源用 maxAttemptsPerRun 覆盖。
const DEFAULT_MAX_FETCH_ATTEMPTS = 3

/**
 * 源的抓取网址候选清单：webUrl（主地址）+ webUrls（备用地址数组），去重保序。
 *
 * webUrl 必须一直保留、且是第一顺位：远程配置会被**线上跑着的旧版本**拉走，旧版只认
 * source.webUrl；只写 webUrls 会让老镜像抓 undefined。所以「换主站」= 改 webUrl，
 * 「加备胎」= 往 webUrls 里追加。
 */
export function getWebUrlCandidates(source) {
  const list = []
  const push = (value) => {
    if (typeof value !== 'string') return
    const url = value.trim()
    if (!/^https?:\/\//i.test(url)) return
    if (!list.includes(url)) list.push(url)
  }
  push(source?.webUrl)
  if (Array.isArray(source?.webUrls)) source.webUrls.forEach(push)
  return list
}

/**
 * 本轮的尝试顺序：上次抓成功的地址排最前（它多半还活着，省掉前面几个死站各一次
 * Chromium 启动），其余按配置顺序；再按 maxAttemptsPerRun 截断。
 * 上次成功的地址一旦整轮失败，缓存会被清掉，下轮自然回到配置顺序。
 */
export function orderWebUrlCandidates(candidates, lastUsedUrl, maxAttempts = DEFAULT_MAX_FETCH_ATTEMPTS) {
  const ordered = candidates.includes(lastUsedUrl)
    ? [lastUsedUrl, ...candidates.filter(u => u !== lastUsedUrl)]
    : [...candidates]
  const limit = Math.max(1, Number(maxAttempts) || DEFAULT_MAX_FETCH_ATTEMPTS)
  return ordered.slice(0, limit)
}

/**
 * 远程配置更新后，某个 fetch 源的抓取缓存还能不能继续用。
 * 判据是「缓存里那条链接是从哪个地址抓来的，那个地址还在不在新清单里」——
 * 只是给清单**追加备用地址**时不该白白重抓，而主地址被换掉/移除时必须重抓。
 * 老缓存没记 webUrl（升级前写的）时退回比对主地址。
 */
export function shouldInvalidateFetchCache(oldSource, newSource, cacheEntry) {
  if (!cacheEntry) return false
  const newList = getWebUrlCandidates(newSource)
  if (newList.length === 0) return true
  const usedUrl = cacheEntry.webUrl
  if (usedUrl) return !newList.includes(usedUrl)
  return getWebUrlCandidates(oldSource)[0] !== newList[0]
}

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
    this.configPath = `${process.cwd()}/built-in-sources.json`       // 随镜像分发的只读配置（兜底），留在代码目录
    this.remoteConfigPath = dataPath('built-in-sources-remote.json') // 上次成功拉取的远程配置缓存，持久化到数据目录
    this.cachePath = dataPath('built-in-sources-cache.json')         // 运行时抓取缓存（m3u8），持久化到数据目录
    this.sources = { enabled: true, sources: [] }
    this.cache = {} // { sourceId: { m3u8Url, lastUpdate } }
    // 抓取失败的退避（内存态）。失败会清缓存，而「没缓存 = 需要刷新」会让一个当前
    // 抓不到的源在每个 5 分钟 tick 都起一次 Chromium 重抓（用户日志里纬来体育即如此）
    this.backoff = new FailureBackoff()
    this.loadConfig()
    this.loadCache()
  }

  /**
   * 加载内置源配置
   * 远程开启时：优先用上次成功拉取的「远程缓存」(含最新 webUrl)，没有/损坏则回退镜像内置的本地配置。
   * 远程关闭(mbuiltInSourcesUrl=)时：只用镜像内置的本地配置（便于本地开发调试）。
   */
  loadConfig() {
    if (BUILT_IN_SOURCES_URL && this.applyConfigFromFile(this.remoteConfigPath, '远程缓存')) return
    this.applyConfigFromFile(this.configPath, '本地内置')
  }

  /**
   * 从指定文件读取并应用内置源配置，成功返回 true、失败返回 false（由调用方决定是否兜底）
   */
  applyConfigFromFile(path, label) {
    try {
      if (!existsSync(path)) return false
      const parsed = JSON.parse(readFileSync(path, 'utf-8'))
      if (!parsed || !Array.isArray(parsed.sources)) return false
      this.sources = parsed
      if (this.sources.enabled) {
        const enabledCount = this.sources.sources.filter(s => s.enabled).length
        const fetchCount = this.sources.sources.filter(s => s.mode === 'fetch').length
        printGreen(`加载内置源配置(${label}): ${enabledCount}/${this.sources.sources.length} 个启用 (${fetchCount} 个需要抓取)`)
      } else {
        printYellow(`内置源功能已禁用(${label})`)
      }
      return true
    } catch (error) {
      printYellow(`读取内置源配置失败(${label}): ${error.message}`)
      return false
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
      writeJsonFileSync(this.cachePath, this.cache)
    } catch (error) {
      printRed(`保存内置源缓存失败: ${error.message}`)
    }
  }

  /**
   * 从远程拉取内置源配置（raw → GitHub 镜像回退）。
   * 成功且合法：更新内存配置 + 写入数据卷缓存（含 webUrl 变更则清抓取缓存重抓）。
   * 失败/非法：保持当前配置（本地内置或上次远程缓存兜底），绝不让 app 出错。
   * 这样 webUrl 等「push 即更新」、无需重建镜像；国内拉不到时退回本地配置，和纯本地一样稳。
   */
  async refreshRemoteConfig() {
    if (!BUILT_IN_SOURCES_URL) return
    const text = await this.fetchRemoteText(BUILT_IN_SOURCES_URL)
    if (!text) {
      printYellow("内置源远程配置拉取失败，沿用当前配置（本地/缓存兜底）")
      return
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      printYellow("内置源远程配置非法 JSON，忽略本次")
      return
    }
    if (!parsed || !Array.isArray(parsed.sources)) {
      printYellow("内置源远程配置结构异常（缺少 sources 数组），忽略本次")
      return
    }
    this.invalidateChangedFetchCaches(parsed) // webUrl 变了就清旧抓取缓存、强制重抓
    this.sources = parsed
    try {
      writeJsonFileSync(this.remoteConfigPath, parsed)
    } catch (e) {
      printYellow(`内置源远程配置缓存写入失败: ${e.message}`)
    }
    const fetchCount = parsed.sources.filter(s => s.mode === 'fetch').length
    printGreen(`内置源远程配置已更新: ${parsed.sources.length} 个源（${fetchCount} 个需抓取）`)
  }

  /**
   * 拉取远程文本：raw 地址走镜像回退（直连失败依次尝试镜像），任一通即返回；全失败返回 null
   */
  async fetchRemoteText(url) {
    const isRaw = url.includes('raw.githubusercontent.com')
    const candidates = isRaw ? GITHUB_RAW_MIRRORS.map(t => t(url)) : [url]
    for (const target of candidates) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 8000)
      try {
        const res = await fetch(target, { signal: ctrl.signal, headers: { 'User-Agent': 'iptv-builtin' } })
        if (res.ok) return await res.text()
      } catch {
        // 当前线路失败，尝试下一个镜像
      } finally {
        clearTimeout(timer)
      }
    }
    return null
  }

  /**
   * 远程配置里 fetch 源的抓取网址若已换掉，清其旧抓取缓存以便用新地址重抓。
   * 判据见 shouldInvalidateFetchCache：只往清单里追加备用地址不算变更、不重抓。
   */
  invalidateChangedFetchCaches(newConfig) {
    const oldById = {}
    for (const s of (this.sources.sources || [])) oldById[s.id] = s
    let changed = false
    for (const s of newConfig.sources) {
      if (s.mode !== 'fetch') continue
      const old = oldById[s.id]
      if (!old) continue
      if (shouldInvalidateFetchCache(old, s, this.cache[s.id])) {
        delete this.cache[s.id]
        changed = true
        printYellow(`内置源 ${s.name} 的抓取网址已变更，清除旧抓取缓存以重新抓取`)
      }
    }
    if (changed) this.saveCache()
  }

  /**
   * 依次尝试源的多个抓取网址，取第一个能抓到可用直播地址的结果。
   *
   * 单个站点被墙 / 换域名 / 挂掉是常态（纬来体育所在的 jrs 系尤其能换），所以这里
   * 允许配多个入口：顺序见 orderWebUrlCandidates（上次成功的优先），一个抓不到就换下一个。
   * 「抓到了」不等于「能播」——站还在但流停了也会抓出链接，故逐个 validateM3u8；
   * 某个地址抓到了但都没过校验，先留作兜底、继续试下一个，全都没过再用兜底
   * （与改造前「抓到什么用什么」保持一致，不会因为校验误判而倒退成没有频道）。
   *
   * @returns {Promise<{m3u8Url: string|null, webUrl: string|null, error?: string}>}
   */
  async extractWithFallback(source) {
    const candidates = getWebUrlCandidates(source)
    if (candidates.length === 0) {
      return { m3u8Url: null, webUrl: null, error: '未配置抓取网址（webUrl / webUrls）' }
    }
    const order = orderWebUrlCandidates(candidates, this.cache[source.id]?.webUrl, source.maxAttemptsPerRun)
    const multi = order.length > 1
    let fallback = null      // 抓到了但没过校验的兜底结果
    let lastError = ''

    for (let i = 0; i < order.length; i++) {
      const webUrl = order[i]
      if (multi) printBlue(`  [${i + 1}/${order.length}] 尝试抓取网址: ${webUrl}`)
      let links = []
      try {
        const extracted = await extractM3u8FromWeb(webUrl, { ...(source.extractOptions || {}), returnAll: true })
        links = Array.isArray(extracted) ? extracted : extracted ? [extracted] : []
      } catch (error) {
        lastError = error.message
        printYellow(`  ${webUrl} 抓取异常: ${error.message}`)
        continue
      }

      if (links.length === 0) {
        lastError = '未找到m3u8链接'
        if (multi) printYellow(`  ${webUrl} 未找到 m3u8，换下一个地址`)
        continue
      }

      for (const link of links) {
        if (await validateM3u8(link, { referer: webUrl })) {
          return { m3u8Url: link, webUrl }
        }
      }

      // 校验全没过：留最长的那条（通常参数最全）作兜底，继续试下一个地址
      if (!fallback) fallback = { m3u8Url: [...links].sort((a, b) => b.length - a.length)[0], webUrl }
      lastError = 'm3u8校验未通过'
      if (multi) printYellow(`  ${webUrl} 抓到 ${links.length} 个链接但校验未通过，换下一个地址`)
    }

    if (fallback) {
      printYellow(`${source.name} 所有地址均未通过 m3u8 校验，沿用 ${fallback.webUrl} 抓到的链接`)
      return fallback
    }
    return { m3u8Url: null, webUrl: null, error: lastError || '未找到m3u8链接' }
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

    // 连续失败：退避窗口内不重抓
    if (this.backoff.isCooling(source.id)) {
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

    // 全局关闭内置源时直接跳过（连远程配置也不拉）
    if (!enableBuiltInSources) {
      return { success: true, message: "内置源已禁用" }
    }

    // 先刷新远程内置源配置（webUrl / 源列表等可能已 push 更新），再据此抓取
    await this.refreshRemoteConfig()

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
      return { success: true, message: "无需更新" }
    }

    const results = []
    let skipped = 0
    let hasWork = false

    for (const source of fetchSources) {
      // autoOnly 模式下检查是否需要刷新
      if (autoOnly && !forceAll && !startupMode) {
        if (!this.needsRefresh(source)) {
          skipped++
          continue
        }
      }
      
      // 首次有实际工作时才打印日志
      if (!hasWork) {
        printBlue(`开始更新内置源${startupMode ? '（启动模式）' : ''}...`)
        hasWork = true
      }
      
      try {
        printBlue(`更新内置源: ${source.name}`)

        // 多个抓取网址依次重试，见 extractWithFallback
        const { m3u8Url, webUrl, error: extractError } = await this.extractWithFallback(source)

        if (m3u8Url) {
          this.cache[source.id] = {
            m3u8Url,
            webUrl,                       // 本次成功的抓取网址：下轮优先重试它，也方便排查是哪个站在供源
            lastUpdate: Date.now(),
            updateTime: new Date().toISOString()
          }
          this.saveCache()
          this.backoff.clear(source.id)
          
          printGreen(`✓ ${source.name} 更新成功`)
          
          results.push({ 
            id: source.id, 
            name: source.name, 
            success: true,
            m3u8Url,
            webUrl
          })
        } else {
          const reason = extractError || '未找到m3u8链接'
          printRed(`✗ ${source.name} 更新失败: ${reason}`)
          // 清除旧缓存，避免继续使用已过期的链接
          if (this.cache[source.id]) {
            delete this.cache[source.id]
            this.saveCache()
            printYellow(`✗ ${source.name} 已清除过期缓存`)
          }
          this.noteFailure(source, reason)
          results.push({ 
            id: source.id, 
            name: source.name, 
            success: false,
            error: reason
          })
        }
      } catch (error) {
        printRed(`✗ ${source.name} 更新失败: ${error.message}`)
        // 清除旧缓存，避免继续使用已过期的链接
        if (this.cache[source.id]) {
          delete this.cache[source.id]
          this.saveCache()
          printYellow(`✗ ${source.name} 已清除过期缓存`)
        }
        this.noteFailure(source, error.message)
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
      // 全部跳过，不打印日志
    } else if (successful === results.length) {
      printGreen(`内置源更新完成: 全部成功 (${successful}/${results.length})${skipped > 0 ? `, ${skipped} 个跳过` : ''}`)
    } else if (successful > 0) {
      printYellow(`内置源更新完成: 部分成功 (${successful}/${results.length})${skipped > 0 ? `, ${skipped} 个跳过` : ''}`)
    } else {
      printRed(`内置源更新完成: 全部失败 (0/${results.length})${skipped > 0 ? `, ${skipped} 个跳过` : ''}`)
    }

    return { success: true, results }
  }

  /** 记一次抓取失败并打印下次重试时间（退避规则见 refreshBackoff.js） */
  noteFailure(source, error) {
    const entry = this.backoff.record(source.id, source.refreshInterval || 240, { error })
    printYellow(`${source.name} 已连续失败 ${entry.count} 次，${entry.waitMinutes} 分钟后再试`)
  }

  /**
   * 获取所有有效的内置源频道（按分组）
   */
  getValidChannels() {
    if (!this.sources.enabled || !enableBuiltInSources) {
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
          description: source.description || '',
          // 源归属（issue #29/#68）。id 来自远程下发的 built-in-sources.json → 白名单消毒，
          // 防含引号等字符破坏 interface.txt 的 EXTINF 属性或后台 HTML
          sourceId: source.id ? `bi:${String(source.id).replace(/[^\w.-]/g, '')}` : undefined
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
          webUrls: getWebUrlCandidates(source),        // 完整候选清单（含主地址），排查用
          cachedM3u8Url: cachedUrl || null,
          cachedWebUrl: this.cache[source.id]?.webUrl || null, // 当前这条链接是从哪个地址抓来的
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
