import { createHash } from "node:crypto"
import { readFileSync, existsSync, unlinkSync } from "node:fs"
import { writeJsonFileSync } from "./fileUtil.js"
import { dataPath } from "./paths.js"
import { printBlue, printGreen, printYellow, printRed } from "./colorOut.js"
import { enableTvgNormalize, enableDisplayNameUnify, externalLogoBase } from "../config.js"
import { getCanonicalMap, normalizeKey, normalizeTvgName, getPlaybackChannelIds } from "./channelNormalize.js"
import { matchKeywordGroup } from "./groupRulesAPI.js"

// 台标来源分类（供后台展示）：本地上传 / 源自带 / 公共库兜底 / 无。
// 依据 interface 里写出的 tvg-logo 形态判定，不联网、零额外成本。issue #38 / #40
function classifyLogo(logo) {
  if (!logo) return 'none'
  if (logo.includes('/logos/')) return 'local'                                  // ${replace}/logos/<名>.<ext>（本地上传/手放，最高优先级）
  if (externalLogoBase && logo.startsWith(externalLogoBase)) return 'auto'       // fanmingming 等公共库按名兜底
  return 'source'                                                               // 咪咕 pics / m3u 源自带
}

// 多套配置档（大分组）：每台电视一套个性化定制。
// - default 档沿用原 my-playlist-config.json（零迁移、向后兼容老部署）
// - 其余档为 my-playlist-config.<slug>.json（slug 限 [a-z0-9_-]，直接进文件名，必须白名单防路径穿越）
// - 档清单存在 my-playlist-profiles.json（仅存非默认档的 {id,name}；default 恒存在、隐式置顶）
// 底层 interface.txt / playback.xml / 回看 全部多档共享，多档只是「同一全集的不同视图」。
const PROFILES_PATH = dataPath('my-playlist-profiles.json')
const PROFILE_ID_RE = /^[a-z0-9_-]{1,64}$/
const DEFAULT_PROFILE = { id: 'default', name: '默认' }

// 归一化档名：空 / 'default' / 非法 → 默认档（杜绝任意 profile 名经文件名注入）
function normalizeProfile(profile) {
  if (!profile || profile === 'default' || !PROFILE_ID_RE.test(profile)) return 'default'
  return profile
}

function configPath(profile) {
  const p = normalizeProfile(profile)
  return p === 'default' ? dataPath('my-playlist-config.json') : dataPath(`my-playlist-config.${p}.json`)
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG = {
  channelGroupMap: {},      // 单频道归类： "原始分组::频道ID" → 目标分组名
  channelRenameMap: {},     // 单频道重命名： "原始分组::频道ID" → 新显示名
  channelOrder: {},         // 组内频道顺序： 显示分组名 → ["原始分组::频道ID", ...]
  hiddenChannels: [],       // 隐藏的频道ID列表
  customGroups: [],         // 自定义分组 [{name, order}]
  groupOrder: [],           // 分组显示顺序
  deletedGroups: [],        // 删除的分组名列表
  groupRenameMap: {},       // 分组重命名映射 { 原始名: 新名 }
  groupSortMode: {},        // 组内排序模式 { 显示分组名: 'name' }；'name'=按名称自动排序，缺省=手动(channelOrder)
  disabledSources: []       // 本档禁用的源（issue #29/#68）：['migu' | 'bi:<id>' | 'ext:<id>']，黑名单——新源默认全档可见
}

function buildChannelId({ groupName, channelName, tvgName, url }) {
  if (!url) {
    return createHash('sha1')
      .update(`${groupName}\n${channelName}\n${tvgName || ''}`)
      .digest('hex')
      .slice(0, 16)
  }

  const miguRelayMatch = url.match(/^\$\{replace\}\/([^/?#]+)(?:\?[^#]*)?$/)
  if (miguRelayMatch) {
    return miguRelayMatch[1]
  }

  return `ext-${createHash('sha1')
    .update(`${groupName}\n${channelName}\n${tvgName || ''}\n${url}`)
    .digest('hex')
    .slice(0, 16)}`
}

/**
 * 读取配置文件（profile 缺省/非法=默认档）
 */
export function readConfig(profile) {
  const filePath = configPath(profile)
  try {
    if (!existsSync(filePath)) {
      // 默认档缺失沿用旧提示；新建的空档（文件未生成）静默返回默认配置（空档=全集）
      if (normalizeProfile(profile) === 'default') printYellow("播放列表配置文件不存在，使用默认配置")
      return { ...DEFAULT_CONFIG }
    }

    const content = readFileSync(filePath, 'utf-8')
    const config = JSON.parse(content)

    // 合并默认配置（防止配置文件缺少字段）
    return {
      ...DEFAULT_CONFIG,
      ...config
    }
  } catch (error) {
    printRed(`读取播放列表配置失败: ${error.message}`)
    return { ...DEFAULT_CONFIG }
  }
}

/**
 * 保存配置文件（profile 缺省/非法=默认档）
 */
export function saveConfig(profile, config) {
  try {
    writeJsonFileSync(configPath(profile), config)
    printGreen("播放列表配置已保存")
    return { success: true }
  } catch (error) {
    printRed(`保存播放列表配置失败: ${error.message}`)
    return { success: false, message: error.message }
  }
}

/**
 * 解析 interface.txt 文件
 */
export function parseInterfaceTxt() {
  try {
    const interfacePath = dataPath('interface.txt')
    if (!existsSync(interfacePath)) {
      printYellow("interface.txt 不存在")
      return []
    }
    
    const content = readFileSync(interfacePath, 'utf-8')
    const lines = content.split('\n')
    const groups = {}
    const playbackIds = getPlaybackChannelIds()   // 解析一次：用于逐频道判定有无节目单（issue #38）

    let currentGroup = null
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      
      // 跳过空行和文件头
      if (!line || line.startsWith('#EXTM3U')) {
        continue
      }
      
      // 解析频道信息
      if (line.startsWith('#EXTINF:')) {
        const tvgIdMatch = line.match(/tvg-id="([^"]*)"/)
        const tvgNameMatch = line.match(/tvg-name="([^"]*)"/)
        const tvgLogoMatch = line.match(/tvg-logo="([^"]*)"/)
        const groupMatch = line.match(/group-title="([^"]*)"/)
        const sourceIdsMatch = line.match(/source-ids="([^"]*)"/)   // 源归属（issue #29/#68），内部属性
        const nameMatch = line.match(/,(.+)$/)
        
        if (groupMatch && nameMatch && i + 1 < lines.length) {
          const groupName = groupMatch[1]
          const channelName = nameMatch[1]
          const url = lines[i + 1].trim()
          
          const tvgName = tvgNameMatch ? tvgNameMatch[1] : channelName
          const channelId = buildChannelId({
            groupName,
            channelName,
            tvgName,
            url
          })
          
          if (!groups[groupName]) {
            groups[groupName] = []
          }

          const logo = tvgLogoMatch ? tvgLogoMatch[1] : ''
          // 配对状态（issue #38）：让后台「我的频道」每个频道直接看到节目单 / 台标是否命中，不用逐个点开。
          // 节目单：按订阅实际写出的 tvg-id（开启归一时取规范名）对 playback.xml 的 channel id 判定。
          const canonical = enableTvgNormalize ? normalizeTvgName(tvgName) : null
          const epgId = canonical || tvgName
          const epgMatched = playbackIds.has(epgId) || playbackIds.has(channelName)

          groups[groupName].push({
            id: channelId,
            name: channelName,
            tvgId: tvgIdMatch ? tvgIdMatch[1] : '',
            tvgName: tvgName,
            logo,
            logoStatus: classifyLogo(logo),       // local | source | auto | none
            epgMatched,                            // 该频道是否有节目单
            epgName: epgMatched ? epgId : '',      // 命中的规范名（详情里展示，解释「显示名虽特殊但已归一匹配」）
            url: url,
            originalGroup: groupName,
            // 源归属（issue #29/#68 按档过滤）：来自哪些源（migu / bi:<id> / ext:<id>，去重并集）。
            // 分号分隔（属性值不能含逗号——频道名按第一个逗号解析）；旧数据无该属性 → 空数组=不过滤。
            sourceIds: sourceIdsMatch ? sourceIdsMatch[1].split(';').filter(Boolean) : []
          })

          i++ // 跳过URL行
        }
      }
    }
    
    // 转换为数组格式
    return Object.entries(groups).map(([name, channels]) => ({
      name,
      channels
    }))
    
  } catch (error) {
    printRed(`解析 interface.txt 失败: ${error.message}`)
    return []
  }
}

/**
 * 检查分组是否被删除（支持通配符前缀匹配）
 * deletedGroups 中以 * 结尾的条目会作为前缀匹配，例如 "体育-*" 匹配 "体育-昨天"、"体育-今天"、"体育-明天"
 */
function isGroupDeleted(groupName, deletedGroups) {
  if (!deletedGroups || deletedGroups.length === 0) return false
  return deletedGroups.some(pattern => {
    if (pattern.endsWith('*')) {
      return groupName.startsWith(pattern.slice(0, -1))
    }
    return pattern === groupName
  })
}

/**
 * 获取自定义分组名称
 */
function getCustomGroupNames(config) {
  if (!Array.isArray(config?.customGroups)) {
    return []
  }

  return config.customGroups
    .map(group => typeof group === 'string' ? group : group?.name)
    .map(name => typeof name === 'string' ? name.trim() : '')
    .filter(Boolean)
}

/**
 * 校验分组配置是否会与现有分组重名
 */
export function validateGroupConfig(groups, config) {
  const renameMap = config?.groupRenameMap || {}
  const occupiedNames = new Map([['未分组', '__reserved_ungrouped__']])

  if (renameMap['未分组'] && renameMap['未分组'] !== '未分组') {
    return {
      valid: false,
      message: '未分组不支持重命名'
    }
  }

  for (const group of groups) {
    // 该源分组在「应用隐藏 / 移动 / 删除后」是否还有属于自己的可见频道。
    // 频道被全部移走、隐藏或整组删除后，该分组在「我的频道」里已看不到，就不应再占用其分组名，
    // 否则把别的分组改名成它、或新建同名分组时会误报「分组已存在」却在列表里找不到它（issue #35）。
    const stillVisible = group.channels.some(channel => {
      const channelKey = `${group.name}::${channel.id}`
      if (config?.hiddenChannels?.includes(channelKey)) return false      // 被隐藏
      if (config?.channelGroupMap?.[channelKey]) return false             // 被移动到别的分组
      if (isGroupDeleted(group.name, config?.deletedGroups)) return false // 整组被删除
      // 全部来源被本档禁用（issue #29/#68）——与 applyConfig 的过滤语义一致
      if (Array.isArray(config?.disabledSources) && config.disabledSources.length > 0
          && Array.isArray(channel.sourceIds) && channel.sourceIds.length > 0
          && channel.sourceIds.every(id => config.disabledSources.includes(id))) return false
      return true
    })
    if (!stillVisible) continue

    const targetName = renameMap[group.name] || group.name
    const existingGroup = occupiedNames.get(targetName)

    if (existingGroup && existingGroup !== group.name) {
      if (!(targetName === '未分组' && group.name === '未分组')) {
        return {
          valid: false,
          message: `分组 "${targetName}" 已存在`
        }
      }
    }

    if (group.name !== '未分组' && targetName === '未分组') {
      return {
        valid: false,
        message: `分组 "${targetName}" 已存在`
      }
    }

    occupiedNames.set(targetName, group.name)
  }

  for (const customGroupName of getCustomGroupNames(config)) {
    if (occupiedNames.has(customGroupName)) {
      return {
        valid: false,
        message: `分组 "${customGroupName}" 已存在`
      }
    }

    occupiedNames.set(customGroupName, `custom:${customGroupName}`)
  }

  return { valid: true }
}

/**
 * 应用配置到频道列表
 */
export function applyConfig(groups, config) {
  try {
    printBlue("应用播放列表配置...")
    
    // 1. 构建频道映射（使用 分组名+频道ID 作为key，允许同一频道出现在不同分组中）
    const channelMap = new Map()
    groups.forEach(group => {
      group.channels.forEach(channel => {
        const key = `${group.name}::${channel.id}`
        channelMap.set(key, { ...channel, originalGroup: group.name })
      })
    })
    
    // 2. 应用配置
    const resultGroups = {}
    const channelGroupMap = config.channelGroupMap || {}

    // EPG 名称规整（#39）/ 统一显示名（#56）共用「归一 key → 规范名」映射；构建一次循环内复用，getCanonicalMap 内部按文件 mtime 缓存
    const canonicalMap = (enableTvgNormalize || enableDisplayNameUnify) ? getCanonicalMap() : null

    // 遍历所有频道
    channelMap.forEach((channel, key) => {
      // 频道标识：原始分组名::频道ID（与 hiddenChannels / channelGroupMap 同源，避免重命名/同名错乱）
      const channelKey = `${channel.originalGroup}::${channel.id}`

      // 单频道重命名：覆盖显示名（只改 name，不动 tvgName，保 EPG 匹配）；channel 已是副本，可安全修改
      const renamedName = config.channelRenameMap?.[channelKey]
      if (renamedName) {
        channel.name = renamedName
      }

      // 跳过隐藏的频道（按分组独立隐藏）
      if (config.hiddenChannels?.includes(channelKey)) {
        return
      }

      // 按档禁用源（issue #29/#68）：该频道的**所有**来源都被本档禁用才隐藏——
      // 多源提供的同一频道只要有一个来源未禁用就保留；旧 interface.txt 无源标记（sourceIds 空）→ 不过滤。
      if (Array.isArray(config.disabledSources) && config.disabledSources.length > 0
          && Array.isArray(channel.sourceIds) && channel.sourceIds.length > 0
          && channel.sourceIds.every(id => config.disabledSources.includes(id))) {
        return
      }

      // 单频道归类：被移动到其它分组的频道，目标分组优先级最高
      const movedTo = channelGroupMap[channelKey]

      // 跳过已删除分组的频道（支持通配符前缀匹配）；已被移动到别处的频道予以保留
      if (!movedTo && isGroupDeleted(channel.originalGroup, config.deletedGroups)) {
        return
      }

      // 目标分组优先级：单频道移动 > 关键字自动分组(仅未分组) > 分组重命名 > 原始分组
      let targetGroup
      if (movedTo) {
        targetGroup = movedTo
      } else {
        targetGroup = channel.originalGroup
        if (targetGroup === '未分组') {
          // 关键字自动分组（issue #69）：只对「未分组」频道按名字子串匹配规则（首条命中胜），
          // 让自定义源里没写分组、每次刷新又回到未分组的新频道自动归位；不动源已分好的组。
          const kw = matchKeywordGroup(channel.name)
          if (kw) targetGroup = kw
        } else if (config.groupRenameMap && config.groupRenameMap[targetGroup]) {
          targetGroup = config.groupRenameMap[targetGroup]
        }
      }

      if (!resultGroups[targetGroup]) {
        resultGroups[targetGroup] = []
      }

      // EPG 名称规整（issue #39）：把 tvg-id / tvg-name 归一到规范名（= EPG/playback.xml 里的频道名），
      // 让异构外部源频道也能匹配上节目单。
      // 统一显示名（issue #56）：开关开启且未手动重命名时，把显示名也归一到规范名，
      // 让不同源「CCTV1 / CCTV-1 / CCTV1综合」按规则批量统一成同一个名字。
      if (canonicalMap) {
        const canonical = canonicalMap.get(normalizeKey(channel.tvgName || channel.name))
        if (canonical) {
          if (enableTvgNormalize) {
            channel.tvgId = canonical
            channel.tvgName = canonical
          }
          if (enableDisplayNameUnify && !renamedName) {
            channel.name = canonical
          }
        }
      }

      resultGroups[targetGroup].push(channel)
    })
    
    // 3. 补齐自定义空分组
    getCustomGroupNames(config).forEach(groupName => {
      if (!resultGroups[groupName]) {
        resultGroups[groupName] = []
      }
    })

    // 4. 转换为数组并排序
    let result = Object.entries(resultGroups)
      .map(([name, channels]) => ({ name, channels }))
    
    // 5. 应用分组排序
    if (config.groupOrder && config.groupOrder.length > 0) {
      result.sort((a, b) => {
        const indexA = config.groupOrder.indexOf(a.name)
        const indexB = config.groupOrder.indexOf(b.name)
        
        // 如果都在排序列表中，按列表顺序
        if (indexA !== -1 && indexB !== -1) {
          return indexA - indexB
        }
        
        // 如果只有A在列表中，A在前
        if (indexA !== -1) return -1
        
        // 如果只有B在列表中，B在前
        if (indexB !== -1) return 1
        
        // 都不在列表中，保持原顺序
        return 0
      })
    }

    // 6. 应用组内频道排序：groupSortMode='name' 的组按名称自动排序（中文按拼音、含数字按数值，
    //    依赖 Node full-ICU），否则按手动拖拽顺序 channelOrder（显示分组名 → ["原始分组::频道ID"]）。
    const channelOrder = config.channelOrder || {}
    const groupSortMode = config.groupSortMode || {}
    result.forEach(group => {
      if (groupSortMode[group.name] === 'name') {
        group.channels.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh', { numeric: true }))
        return
      }
      const order = channelOrder[group.name]
      if (Array.isArray(order) && order.length > 0) {
        group.channels.sort((a, b) => {
          const ia = order.indexOf(`${a.originalGroup}::${a.id}`)
          const ib = order.indexOf(`${b.originalGroup}::${b.id}`)
          if (ia !== -1 && ib !== -1) return ia - ib
          if (ia !== -1) return -1   // 已排序的在前
          if (ib !== -1) return 1
          return 0                   // 都不在列表中：保持相对顺序（V8 稳定排序）
        })
      }
    })

    const totalChannels = result.reduce((sum, g) => sum + g.channels.length, 0)
    printGreen(`配置应用完成: ${result.length} 个分组, ${totalChannels} 个频道`)
    
    return result
    
  } catch (error) {
    printRed(`应用配置失败: ${error.message}`)
    return groups // 返回原始数据
  }
}

/**
 * 生成 M3U8 格式内容
 */
export function generateM3u8(groups) {
  let content = '#EXTM3U x-tvg-url="${replace}/playback.xml" catchup="append" catchup-source="?playbackbegin=${(b)yyyyMMddHHmmss}&playbackend=${(e)yyyyMMddHHmmss}"\n'
  
  groups.forEach(group => {
    group.channels.forEach(channel => {
      content += `#EXTINF:-1 tvg-id="${channel.tvgId}" tvg-name="${channel.tvgName}" tvg-logo="${channel.logo}" group-title="${group.name}",${channel.name}\n`
      content += `${channel.url}\n`
    })
  })
  
  return content
}

/**
 * 生成 TXT 格式内容
 */
export function generateTxt(groups) {
  let content = ''
  
  groups.forEach(group => {
    content += `${group.name},#genre#\n`
    group.channels.forEach(channel => {
      content += `${channel.name},${channel.url}\n`
    })
  })
  
  return content
}

// ---- 配置档（profile）管理 ----
// 注册表只存非默认档的 {id, name}；default 档恒存在、隐式置顶。

function readProfilesRegistry() {
  try {
    if (!existsSync(PROFILES_PATH)) return []
    const data = JSON.parse(readFileSync(PROFILES_PATH, 'utf-8'))
    const list = Array.isArray(data?.profiles) ? data.profiles : []
    return list
      .filter(p => p && PROFILE_ID_RE.test(p.id) && p.id !== 'default')
      .map(p => ({ id: p.id, name: (typeof p.name === 'string' && p.name.trim()) ? p.name.trim() : p.id }))
  } catch (error) {
    printRed(`读取配置档列表失败: ${error.message}`)
    return []
  }
}

function writeProfilesRegistry(profiles) {
  const extra = profiles
    .filter(p => p.id !== 'default')
    .map(p => ({ id: p.id, name: p.name }))
  writeJsonFileSync(PROFILES_PATH, { profiles: extra })
}

/** 列出所有配置档（default 恒在首位） */
export function listProfiles() {
  return [DEFAULT_PROFILE, ...readProfilesRegistry()]
}

/** 新建配置档：fromProfile 指定时复制其配置（含 default），否则空配置（=全集） */
export function createProfile({ id, name, fromProfile } = {}) {
  if (!PROFILE_ID_RE.test(id || '')) {
    return { success: false, message: '档名只能用小写字母、数字、_ 或 -，长度 1-64' }
  }
  if (id === 'default') {
    return { success: false, message: 'default 为系统保留档名' }
  }
  const displayName = (typeof name === 'string' && name.trim()) ? name.trim() : id
  if (displayName.length > 20) {
    return { success: false, message: '档名不能超过 20 个字符' }
  }
  const existing = readProfilesRegistry()
  if (existing.some(p => p.id === id)) {
    return { success: false, message: `配置档 "${id}" 已存在` }
  }
  const baseConfig = (fromProfile !== undefined && fromProfile !== null && fromProfile !== '')
    ? readConfig(fromProfile)
    : { ...DEFAULT_CONFIG }
  const saveRes = saveConfig(id, baseConfig)
  if (!saveRes.success) return saveRes
  writeProfilesRegistry([...existing, { id, name: displayName }])
  return { success: true, profile: { id, name: displayName } }
}

/** 重命名配置档（仅改显示名，id/文件名不变） */
export function renameProfile({ id, name } = {}) {
  if (id === 'default') return { success: false, message: '默认档不可改名' }
  const existing = readProfilesRegistry()
  const idx = existing.findIndex(p => p.id === id)
  if (idx === -1) return { success: false, message: `配置档 "${id}" 不存在` }
  const displayName = (typeof name === 'string' && name.trim()) ? name.trim() : id
  if (displayName.length > 20) return { success: false, message: '档名不能超过 20 个字符' }
  existing[idx] = { id, name: displayName }
  writeProfilesRegistry(existing)
  return { success: true, profile: { id, name: displayName } }
}

/** 删除配置档（连同其配置文件） */
export function deleteProfile(id) {
  if (id === 'default') return { success: false, message: '默认档不可删除' }
  const existing = readProfilesRegistry()
  if (!existing.some(p => p.id === id)) {
    return { success: false, message: `配置档 "${id}" 不存在` }
  }
  writeProfilesRegistry(existing.filter(p => p.id !== id))
  try {
    const filePath = configPath(id)
    if (existsSync(filePath)) unlinkSync(filePath)
  } catch (error) {
    printYellow(`配置档已从列表移除，但删除其文件失败: ${error.message}`)
  }
  return { success: true }
}

// 导出 isGroupDeleted 供管理后台API使用
export { isGroupDeleted }

export default {
  readConfig,
  saveConfig,
  parseInterfaceTxt,
  validateGroupConfig,
  applyConfig,
  generateM3u8,
  generateTxt,
  isGroupDeleted,
  listProfiles,
  createProfile,
  renameProfile,
  deleteProfile
}
