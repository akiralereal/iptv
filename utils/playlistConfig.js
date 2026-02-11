import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { printBlue, printGreen, printYellow, printRed } from "./colorOut.js"

const CONFIG_PATH = `${process.cwd()}/my-playlist-config.json`

/**
 * 默认配置
 */
const DEFAULT_CONFIG = {
  channelGroupMap: {},      // 频道ID → 自定义分组名
  hiddenChannels: [],       // 隐藏的频道ID列表
  customGroups: [],         // 自定义分组 [{name, order}]
  groupOrder: [],           // 分组显示顺序
  deletedGroups: []         // 删除的分组名列表
}

/**
 * 读取配置文件
 */
export function readConfig() {
  try {
    if (!existsSync(CONFIG_PATH)) {
      printYellow("播放列表配置文件不存在，使用默认配置")
      return { ...DEFAULT_CONFIG }
    }
    
    const content = readFileSync(CONFIG_PATH, 'utf-8')
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
 * 保存配置文件
 */
export function saveConfig(config) {
  try {
    const content = JSON.stringify(config, null, 2)
    writeFileSync(CONFIG_PATH, content, 'utf-8')
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
    const interfacePath = `${process.cwd()}/interface.txt`
    if (!existsSync(interfacePath)) {
      printYellow("interface.txt 不存在")
      return []
    }
    
    const content = readFileSync(interfacePath, 'utf-8')
    const lines = content.split('\n')
    const groups = {}
    
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
        const nameMatch = line.match(/,(.+)$/)
        
        if (groupMatch && nameMatch && i + 1 < lines.length) {
          const groupName = groupMatch[1]
          const channelName = nameMatch[1]
          const url = lines[i + 1].trim()
          
          // 提取频道ID (从URL中提取pID或使用完整URL)
          let channelId = url
          const pidMatch = url.match(/\/([^\/\?]+)(\?|$)/)
          if (pidMatch) {
            channelId = pidMatch[1]
          }
          
          if (!groups[groupName]) {
            groups[groupName] = []
          }
          
          groups[groupName].push({
            id: channelId,
            name: channelName,
            tvgId: tvgIdMatch ? tvgIdMatch[1] : '',
            tvgName: tvgNameMatch ? tvgNameMatch[1] : channelName,
            logo: tvgLogoMatch ? tvgLogoMatch[1] : '',
            url: url,
            originalGroup: groupName
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
 * 应用配置到频道列表
 */
export function applyConfig(groups, config) {
  try {
    printBlue("应用播放列表配置...")
    
    // 1. 构建频道映射
    const channelMap = new Map()
    groups.forEach(group => {
      group.channels.forEach(channel => {
        channelMap.set(channel.id, { ...channel, originalGroup: group.name })
      })
    })
    
    // 2. 应用配置
    const resultGroups = {}
    
    // 遍历所有频道
    channelMap.forEach((channel, channelId) => {
      // 跳过隐藏的频道
      if (config.hiddenChannels?.includes(channelId)) {
        return
      }
      
      // 跳过已删除分组的频道
      if (config.deletedGroups?.includes(channel.originalGroup)) {
        return
      }
      
      // 使用频道的原始分组
      const targetGroup = channel.originalGroup
      
      if (!resultGroups[targetGroup]) {
        resultGroups[targetGroup] = []
      }
      
      resultGroups[targetGroup].push(channel)
    })
    
    // 3. 转换为数组并排序
    let result = Object.entries(resultGroups)
      .filter(([_, channels]) => channels.length > 0) // 移除空分组
      .map(([name, channels]) => ({ name, channels }))
    
    // 4. 应用分组排序
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

export default {
  readConfig,
  saveConfig,
  parseInterfaceTxt,
  applyConfig,
  generateM3u8
}
