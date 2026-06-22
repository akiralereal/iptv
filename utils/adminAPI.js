import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs"
import { getAllChannels, externalSourceManager, builtInSourceManager } from "./channelMerger.js"
import { BUILT_IN_SUBSCRIPTIONS, parsePlaylistContent, decodeAndParseLocalContent } from "./externalSources.js"
import { dataPath } from "./paths.js"
import update, { LOGO_EXTS } from "./updateData.js"

/**
 * 从interface.txt解析体育赛事数据
 */
function parsePEChannels() {
  try {
    const interfacePath = dataPath('interface.txt')
    if (!existsSync(interfacePath)) {
      return []
    }
    
    const content = readFileSync(interfacePath, 'utf-8')
    const lines = content.split('\n')
    const peGroups = {}
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (line.includes('group-title="体育-')) {
        const groupMatch = line.match(/group-title="(体育-[^"]+)"/)
        const nameMatch = line.match(/tvg-name="([^"]+)"/)
        const logoMatch = line.match(/tvg-logo="([^"]+)"/)
        
        if (groupMatch && nameMatch && i + 1 < lines.length) {
          const groupName = groupMatch[1]
          const channelName = nameMatch[1]
          const logo = logoMatch ? logoMatch[1] : ''
          const url = lines[i + 1].trim()
          
          if (!peGroups[groupName]) {
            peGroups[groupName] = []
          }
          
          peGroups[groupName].push({
            name: channelName,
            logo: logo,
            url: url,
            source: 'pe' // 标记为体育赛事
          })
        }
      }
    }
    
    // 转换为频道列表格式
    return Object.entries(peGroups).map(([name, dataList]) => ({
      name: name,
      source: 'pe',
      dataList: dataList
    }))
    
  } catch (error) {
    console.error('解析PE频道失败:', error)
    return []
  }
}

/**
 * 获取所有频道数据（咪咕 + 外部源 + 体育赛事）
 */
export async function getChannelsAPI() {
  try {
    const channels = await getAllChannels()
    const peChannels = parsePEChannels()
    
    // 合并PE频道（追加到末尾）
    const allChannels = [...channels, ...peChannels]
    
    return {
      success: true,
      data: allChannels
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
    // 本地导入源（内联 subscriptionContent）：保存前用内容重新解析出频道，保证 parsedChannels 与内容一致（issue #43）
    if (sources && Array.isArray(sources.sources)) {
      for (const s of sources.sources) {
        if (s && s.mode === 'subscription' && typeof s.subscriptionContent === 'string' && s.subscriptionContent.trim()) {
          s.parsedChannels = parsePlaylistContent(s.subscriptionContent)
        }
      }
    }
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

/**
 * 校验台标文件名（= 频道名）：不能含路径分隔符 / 控制字符，避免目录穿越
 */
function sanitizeLogoName(name) {
  const n = String(name || '').trim()
  if (!n || n.includes('/') || n.includes('\\') || n.includes('..')) return null
  for (let i = 0; i < n.length; i++) { if (n.charCodeAt(i) < 32) return null } // 拒绝控制字符
  return n
}

/**
 * 上传频道台标（issue #40）：把图片存为 data/logos/<频道名>.<ext>，最高优先级、即时生效。
 * 同一频道只保留一个台标（先删其它扩展名），保存后重新生成播放列表。
 */
export async function uploadLogoAPI(name, imageBase64, ext) {
  try {
    const safe = sanitizeLogoName(name)
    if (!safe) return { success: false, message: '频道名含非法字符，无法作为台标文件名' }
    let e = String(ext || 'png').toLowerCase().replace(/[^a-z0-9]/g, '')
    if (!LOGO_EXTS.includes(e)) e = 'png'
    const buffer = Buffer.from(String(imageBase64 || ''), 'base64')
    if (!buffer.length) return { success: false, message: '图片内容为空' }
    if (buffer.length > 3 * 1024 * 1024) return { success: false, message: '图片过大（请小于 3MB）' }
    const dir = dataPath('logos')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    // 一个频道只保留一个台标：先清掉同名其它扩展，避免 findLocalLogo 命中旧的
    for (const x of LOGO_EXTS) {
      const p = dataPath(`logos/${safe}.${x}`)
      if (existsSync(p)) { try { unlinkSync(p) } catch { /* ignore */ } }
    }
    writeFileSync(dataPath(`logos/${safe}.${e}`), buffer)
    await update(0, { regenerateOnly: true }).catch(err => console.error('上传台标后重新生成失败:', err))
    return { success: true, url: `/logos/${encodeURIComponent(safe)}.${e}` }
  } catch (error) {
    return { success: false, message: error.message }
  }
}

/**
 * 移除频道的本地上传台标（删 data/logos/<频道名>.* 后重新生成）
 */
export async function removeLogoAPI(name) {
  try {
    const safe = sanitizeLogoName(name)
    if (!safe) return { success: false, message: '非法名称' }
    let removed = 0
    for (const x of LOGO_EXTS) {
      const p = dataPath(`logos/${safe}.${x}`)
      if (existsSync(p)) { try { unlinkSync(p); removed++ } catch { /* ignore */ } }
    }
    if (removed > 0) await update(0, { regenerateOnly: true }).catch(err => console.error('移除台标后重新生成失败:', err))
    return { success: true, removed }
  } catch (error) {
    return { success: false, message: error.message }
  }
}

/**
 * 把一个频道（同名同地址）复制到一个或多个分组（issue #37）：每个目标分组建一条独立的「直连」副本。
 * 副本是固定地址的独立频道（独立隐藏/排序/删除）；咪咕频道地址为服务端跳转，暂不支持。
 */
export async function copyChannelToGroupsAPI({ name, url, logo, groups } = {}) {
  try {
    if (!name || !url) return { success: false, message: '缺少频道名或地址' }
    if (String(url).includes('${replace}')) return { success: false, message: '咪咕频道暂不支持复制（地址为服务端跳转）' }
    const targets = Array.isArray(groups) ? [...new Set(groups.map(g => String(g || '').trim()).filter(Boolean))] : []
    if (!targets.length) return { success: false, message: '未选择目标分组' }
    const safeLogo = (typeof logo === 'string' && /^https?:\/\//.test(logo)) ? logo : ''
    let added = 0
    for (const group of targets) {
      externalSourceManager.addSource({ name, group, m3u8Url: url, logo: safeLogo, enabled: true, autoRefresh: false })
      added++
    }
    await update(0, { regenerateOnly: true }).catch(err => console.error('复制频道后重新生成失败:', err))
    return { success: true, added }
  } catch (error) {
    return { success: false, message: error.message }
  }
}

/**
 * 解析本地导入的播放列表内容（base64 字节）：解码（GBK/UTF/BOM）+ 解析 m3u/txt，返回解码后文本与频道数（issue #43）
 */
export function parseLocalContentAPI(contentBase64) {
  try {
    const { text, channels } = decodeAndParseLocalContent(contentBase64)
    return { success: true, text, channelCount: channels.length }
  } catch (error) {
    return { success: false, message: error.message }
  }
}

/**
 * 导入订阅源（获取并解析m3u播放列表）
 */
export async function importSubscriptionAPI(index) {
  try {
    const result = await externalSourceManager.updateSubscriptionSource(index)
    if (result.success !== false) {
      // 导入成功后重新生成播放列表
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
 * 获取内置源列表
 */
export function getBuiltInSourcesAPI() {
  try {
    const config = builtInSourceManager.getSourceList()
    // 追加内置订阅源的 subscriptionUrl 列表，供前端识别"由内置订阅源展开出来的频道"
    const builtInSubscriptionUrls = BUILT_IN_SUBSCRIPTIONS.map(s => s.subscriptionUrl)
    return {
      success: true,
      data: {
        ...config,
        builtInSubscriptionUrls
      }
    }
  } catch (error) {
    return {
      success: false,
      message: error.message,
      data: { enabled: true, sources: [], builtInSubscriptionUrls: [] }
    }
  }
}
