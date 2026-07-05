import { readFileSync, existsSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { writeJsonFileSync } from "./fileUtil.js"
import { dataPath } from "./paths.js"
import { enableBuiltInSubscriptions } from "../config.js"
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
 * 订阅源频道的最终分组：频道自带分组优先；为空、或仍是占位「未分组」时，
 * 回退到该源配置的「默认分组」(source.group)。issue #69 跟进——让订阅里没写
 * group-title 的频道整体归到用户指定的默认分组，而不是堆在「未分组」。
 * （m3u 解析对无 group-title 的频道填的就是字符串「未分组」，故与空值一并视作未分组。）
 */
export function resolveSubscriptionGroup(ch, source) {
  const own = ch && ch.group && ch.group !== '未分组' ? ch.group : ''
  return own || (source && source.group) || '未分组'
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
 * 解码并解析「本地导入」的播放列表字节（base64）。复用订阅的字节解码（BOM/charset/UTF-8 试解/GBK 回退）
 * 与 m3u/txt 解析，使本地上传的文件与在线订阅得到一致的编码处理与频道结构（issue #43）。
 * @param {string} base64 - 文件原始字节的 base64
 * @returns {{ text: string, channels: Array }}
 */
function decodeAndParseLocalContent(base64) {
  const buffer = Buffer.from(String(base64 || ''), 'base64')
  const text = decodeSubscriptionBody(buffer, null)
  const channels = parsePlaylistContent(text)
  return { text, channels }
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
 * 拆出 URL 内嵌的 user:pass@ 凭据，转成 HTTP Basic 认证头。
 * node-fetch 会直接拒绝带凭据的 URL（抛 "url with embedded credentials"），
 * 故订阅地址形如 http://user:pass@host/x.m3u 时，需把凭据从 URL 取出、改用 Authorization 头。
 * 返回去掉凭据后的 URL 与对应请求头（无凭据时 headers 为空，行为不变）。
 * @param {string} rawUrl
 * @returns {{ url: string, headers: Record<string,string> }}
 */
function splitCredentials(rawUrl) {
  let u
  try { u = new URL(rawUrl) } catch { return { url: rawUrl, headers: {} } }
  if (u.username === '' && u.password === '') return { url: rawUrl, headers: {} }
  // URL 里的 user/pass 是百分号编码，解码还原真实凭据再做 base64（解码失败则原样使用）
  const dec = (s) => { try { return decodeURIComponent(s) } catch { return s } }
  const token = Buffer.from(`${dec(u.username)}:${dec(u.password)}`).toString('base64')
  u.username = ''
  u.password = ''
  return { url: u.toString(), headers: { Authorization: `Basic ${token}` } }
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
    const transformedUrl = transformUrl(subscriptionUrl)
    // 拆出 URL 内嵌的 user:pass@ 凭据，转成 Basic 认证头（node-fetch 不接受带凭据的 URL）
    const { url: targetUrl, headers: authHeaders } = splitCredentials(transformedUrl)
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 15000)

    try {
      const response = await fetch(targetUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          ...authHeaders
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

      if (transformedUrl !== subscriptionUrl) {
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

  // 远程（raw + 所有镜像）都失败：内置订阅源回退读镜像里自带的本地快照，保证精选频道仍能加载（无外网/镜像也挂时）
  const localFile = BUILT_IN_SUBSCRIPTION_LOCAL_FALLBACK[subscriptionUrl]
  if (localFile) {
    try {
      const localPath = `${process.cwd()}/${localFile}`
      if (existsSync(localPath)) {
        const channels = parsePlaylistContent(decodeSubscriptionBody(readFileSync(localPath), ''))
        if (channels.length > 0) {
          printYellow(`远程订阅均失败，回退镜像内置 ${localFile}（${channels.length} 个频道，可能非最新）`)
          return channels
        }
      }
    } catch (e) {
      printYellow(`镜像内置 ${localFile} 兜底读取失败: ${e.message}`)
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
    name: '精选频道',
    group: '未分组',
    enabled: true,
    mode: 'subscription',
    m3u8Url: '',
    webUrl: '',
    subscriptionUrl: 'https://raw.githubusercontent.com/akiralereal/iptv/refs/heads/main/IPTV.m3u',
    parsedChannels: null,
    autoRefresh: true,
    refreshInterval: 360,
    updateOnStartup: true,
    lastUpdated: null
  }
]

// 内置订阅源「镜像内置本地文件」兜底：远程（raw + 所有 GitHub 镜像）都拉不到时，回退读镜像里自带的这份快照，
// 保证精选频道在「无外网、且第三方 GitHub 镜像也挂」的环境下仍能加载（issue：国内拉不到 raw.githubusercontent）。
// { 订阅 URL: 镜像内置文件名（位于 process.cwd()，由 Dockerfile `COPY . .` 打包） }
const BUILT_IN_SUBSCRIPTION_LOCAL_FALLBACK = {
  [BUILT_IN_SUBSCRIPTIONS[0].subscriptionUrl]: 'IPTV.m3u',
}

// 已退役的内置订阅源 URL（曾经内置、现已移除）。启动时一次性从老用户配置中清除，
// 避免「换掉常量 URL 后旧源仍残留、且因不在 BUILT_IN_SUBSCRIPTION_URLS 里而连开关都关不掉」的僵尸源问题。
const RETIRED_SUBSCRIPTION_URLS = [
  'https://raw.githubusercontent.com/YueChan/Live/refs/heads/main/GNTV.m3u',
  'https://raw.githubusercontent.com/YueChan/Live/refs/heads/main/Global.m3u'
]

function cloneBuiltInSubscription(entry) {
  return JSON.parse(JSON.stringify(entry))
}

// 内置订阅源 URL 集合与判断：禁用内置订阅时，抓取层(updateAllSources/updateSubscriptionSource)
// 与服务层(getValidChannels)都据此跳过，避免无谓联网下载，并保证输出一致。
const BUILT_IN_SUBSCRIPTION_URLS = new Set(BUILT_IN_SUBSCRIPTIONS.map(b => b.subscriptionUrl))
function isBuiltInSubscriptionSource(source) {
  return !!(source && source.subscriptionUrl && BUILT_IN_SUBSCRIPTION_URLS.has(source.subscriptionUrl))
}

// 播种内置订阅源（精选频道）。
// 关键改动：从「缺了就加回来」改为「只播种从未播种过的 URL」，用 config.seededBuiltInUrls 记录已播种集合。
// 这样用户删除内置订阅后不会在重启时复活（修复 issue：默认源删不掉）。
// enableBuiltInSubscriptions=false 时不再播种。
function ensureBuiltInSubscriptions(config) {
  if (!config || !Array.isArray(config.sources)) return false
  let mutated = false
  // 首次升级迁移：把「当前已存在的内置订阅 URL」视为已播种，避免老用户之后删除被重新加回。
  if (!Array.isArray(config.seededBuiltInUrls)) {
    config.seededBuiltInUrls = BUILT_IN_SUBSCRIPTIONS
      .map(b => b.subscriptionUrl)
      .filter(url => config.sources.some(s => s && s.subscriptionUrl === url))
    mutated = true
  }
  if (!enableBuiltInSubscriptions) return mutated  // 关闭：不再播种
  for (const builtIn of BUILT_IN_SUBSCRIPTIONS) {
    const url = builtIn.subscriptionUrl
    if (config.seededBuiltInUrls.includes(url)) continue  // 已播种（含被用户删除过）→ 不再加
    if (!config.sources.some(s => s && s.subscriptionUrl === url)) {
      config.sources.push(cloneBuiltInSubscription(builtIn))
      printBlue(`补齐内置订阅源: ${builtIn.name}`)
    }
    config.seededBuiltInUrls.push(url)
    mutated = true
  }
  return mutated
}

// 外部源稳定 id（issue #29/#68 按档过滤源）：随源一次生成、永不改变，供「配置档 ↔ 源」绑定引用
// （数组下标会因删源移位，不能当标识）。幂等：已有 id 原样保留；存量配置补齐后由调用方持久化。
function ensureSourceIds(config) {
  if (!config || !Array.isArray(config.sources)) return false
  let mutated = false
  const used = new Set(config.sources.map(s => (s && typeof s.id === 'string') ? s.id : '').filter(Boolean))
  for (const s of config.sources) {
    if (!s || (typeof s.id === 'string' && s.id)) continue
    let id
    do { id = randomBytes(4).toString('hex') } while (used.has(id))
    used.add(id)
    s.id = id
    mutated = true
  }
  return mutated
}

// 无 id 的进货源若与现有源「身份」匹配（订阅地址 / 网页地址 / 名称+直连地址），继承其已有 id——
// 前端整份保存可能带着「服务端已发过 id 但客户端未回读」的旧副本，若任由 ensureSourceIds 重新发号，
// 「配置档 ↔ 源」绑定（disabledSources 引用的 ext:<id>）会悄悄变孤儿（issue #29/#68）。
function inheritExistingSourceIds(incoming, current) {
  if (!incoming || !Array.isArray(incoming.sources) || !current || !Array.isArray(current.sources)) return
  const keyOf = s => s.subscriptionUrl ? `sub|${s.subscriptionUrl}`
    : s.webUrl ? `web|${s.webUrl}`
    : s.m3u8Url ? `m3u|${s.name || ''}|${s.m3u8Url}`
    : `name|${s.name || ''}`
  const byKey = new Map()
  for (const s of current.sources) {
    if (s && typeof s.id === 'string' && s.id) {
      const k = keyOf(s)
      if (!byKey.has(k)) byKey.set(k, s.id)
    }
  }
  const used = new Set(incoming.sources.map(s => (s && typeof s.id === 'string') ? s.id : '').filter(Boolean))
  for (const s of incoming.sources) {
    if (!s || (typeof s.id === 'string' && s.id)) continue
    const id = byKey.get(keyOf(s))
    if (id && !used.has(id)) { s.id = id; used.add(id) }
  }
}

// 一次性退役迁移：把已退役的内置订阅源从用户配置中移除（用 retiredBuiltInsV1 标记，只跑一次，
// 之后尊重用户的手动增删，与 seededBuiltInUrls 的「只播种一次」哲学一致）。
function retireBuiltInSubscriptions(config) {
  if (!config || !Array.isArray(config.sources)) return false
  if (config.retiredBuiltInsV1) return false  // 已迁移过 → 不再处理
  const before = config.sources.length
  config.sources = config.sources.filter(s => !(s && RETIRED_SUBSCRIPTION_URLS.includes(s.subscriptionUrl)))
  const removed = before - config.sources.length
  if (removed > 0) printBlue(`移除已退役的内置订阅源 ${removed} 个（旧 YueChan 港澳/全球）`)
  // 同步清理已播种账本里的退役 URL
  if (Array.isArray(config.seededBuiltInUrls)) {
    config.seededBuiltInUrls = config.seededBuiltInUrls.filter(u => !RETIRED_SUBSCRIPTION_URLS.includes(u))
  }
  config.retiredBuiltInsV1 = true
  return true
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
      const seedSubs = enableBuiltInSubscriptions
      const defaultConfig = {
        enabled: true,
        includeInPlaylists: true,
        updateOnStartup: true,
        sources: seedSubs ? BUILT_IN_SUBSCRIPTIONS.map(cloneBuiltInSubscription) : [],
        // 记录已播种的内置订阅 URL（开启时为全部；关闭时为空，之后开启会按需补齐一次）
        seededBuiltInUrls: seedSubs ? BUILT_IN_SUBSCRIPTIONS.map(b => b.subscriptionUrl) : [],
        retiredBuiltInsV1: true, // 新装无需退役迁移，直接标记已处理
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
        const config = {
          enabled: true,
          includeInPlaylists: true,
          updateOnStartup: true,
          sources,
          updateInterval: 60,
          lastGlobalUpdate: null
        }
        const retired = retireBuiltInSubscriptions(config)
        const mutated = ensureBuiltInSubscriptions(config)
        const idsAdded = ensureSourceIds(config)   // 存量源补稳定 id（issue #29/#68）
        if (retired || mutated || idsAdded) this.saveSources(config)
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
        // 播种内置订阅源（只播种从未播种过的；尊重用户删除）
        const retired = retireBuiltInSubscriptions(parsed)
        const mutated = ensureBuiltInSubscriptions(parsed)
        const idsAdded = ensureSourceIds(parsed)   // 存量源补稳定 id（issue #29/#68）
        if (retired || mutated || idsAdded) this.saveSources(parsed)
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
      // 兜底：任何写盘路径（含前端整份保存的新建源）都保证每个源有稳定 id（issue #29/#68）
      // 先按「身份」继承现有 id（防前端未回读的旧副本让 id 漂移），再给真正的新源发号
      if (sources !== this.sources) inheritExistingSourceIds(sources, this.sources)
      ensureSourceIds(sources)
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
    // 本地导入源：内容已内联在 subscriptionContent，直接本地解析、不发网络请求（issue #43）
    if (typeof source.subscriptionContent === 'string' && source.subscriptionContent.trim()) {
      const channels = parsePlaylistContent(source.subscriptionContent)
      this.sources.sources[index].parsedChannels = channels
      this.sources.sources[index].lastUpdated = new Date().toISOString()
      this.sources.sources[index]._failCount = 0
      this.saveSources()
      printGreen(`${source.name} 本地导入解析成功，共 ${channels.length} 个频道`)
      return { success: true, channelCount: channels.length }
    }
    if (!source.subscriptionUrl) {
      return { success: false, message: '未填写订阅地址' }
    }
    // 内置订阅源已禁用：不抓取（兜底覆盖 60s 重试 / 手动导入等所有调用方）
    if (!enableBuiltInSubscriptions && isBuiltInSubscriptionSource(source)) {
      return { success: true, skipped: true, message: '内置订阅源已禁用，跳过抓取' }
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

      // 内置订阅源已禁用：跳过抓取（避免无谓联网下载，与服务层一致）
      if (!enableBuiltInSubscriptions && isBuiltInSubscriptionSource(source)) {
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
      // 内置订阅源已禁用：跳过输出（数据仍保留在 external-sources.json，开启后即恢复，可逆）
      if (!enableBuiltInSubscriptions && isBuiltInSubscriptionSource(source)) return

      // 订阅模式：展开 parsedChannels
      if (source.mode === 'subscription' && Array.isArray(source.parsedChannels)) {
        source.parsedChannels.forEach(ch => {
          const group = resolveSubscriptionGroup(ch, source)
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
            groupTitle: group,
            sourceId: source.id ? `ext:${source.id}` : undefined   // 源归属（issue #29/#68）
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
          groupTitle: source.group,
          sourceId: source.id ? `ext:${source.id}` : undefined   // 源归属（issue #29/#68）
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
export { ExternalSourceManager, fetchAndParseM3u, parsePlaylistContent, decodeAndParseLocalContent, splitCredentials, isBuiltInSubscriptionSource, GITHUB_RAW_MIRRORS, BUILT_IN_SUBSCRIPTIONS, ensureSourceIds, inheritExistingSourceIds }