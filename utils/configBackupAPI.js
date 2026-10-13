// 配置导出 / 导入（issue #99）
//
// 面向 NAS 图形界面用户（拿不到数据卷目录）的换机迁移 / 重装 / 备份口子。
// 形态：单 JSON 打包 { format, version, exportedAt, files: { 文件名: 内容 } }——
//   零新依赖、人类可读、逐文件可校验，天然没有压缩包路径穿越问题。
//
// 只打包「配置」，不打包可再生的缓存（interface*.txt / playback.xml / pe-cache /
// built-in-sources-cache / epg-cache）与二进制 logos/（体积大，提示用户单独拷）。
//
// 导入安全线：文件名白名单（含配置档动态名模式）+ 内容必须是 JSON 对象/数组 +
// 覆盖前自动把当前配置快照写入 config-pre-import-backup.json（写坏可回退）。

import { existsSync, readFileSync, unlinkSync } from "node:fs"
import { writeJsonFileSync } from "./fileUtil.js"
import { dataPath } from "./paths.js"
import { reloadConfig, pass, adminPath } from "../config.js"
import { clearUrlCache } from "./appUtils.js"
import { getExtractorManager } from "./extractorManager.js"
import { externalSourceManager } from "./channelMerger.js"
import { userManager } from "./userManager.js"
import update from "./updateData.js"
import { printGreen, printRed, printYellow } from "./colorOut.js"

export const BACKUP_FORMAT = 'iptv-config-backup'
export const BACKUP_VERSION = 1

// 固定名配置文件白名单（存在才导出；导入只认这些名字）
const FIXED_FILES = [
  'system-config.json',        // 含咪咕账号 token 与访问密码（敏感，前端导出时需提示）
  'external-sources.json',
  'my-playlist-profiles.json',
  'my-playlist-config.json',
  'epg-sources.json',
  'channel-aliases.json',
  'group-keyword-rules.json',
  'users.json',
  'extractors.json',          // 抓取模块的开关与配置（抓取结果在 extractor-cache.json，不进备份）
  'notify-channels.json',     // 消息推送渠道（含机器人地址 / Token，敏感；推送记录在 notify-state.json，不进备份）
]

// 配置档独立配置的动态文件名：my-playlist-config.<档id>.json。
// 档 id 全链路只认小写（playlistConfig 的 PROFILE_ID_RE），这里保持同一字符集，
// 避免导入落盘出「任何档都读不到」的死文件
const PROFILE_FILE_RE = /^my-playlist-config\.[a-z0-9_-]{1,64}\.json$/

function isAllowedFileName(name) {
  return FIXED_FILES.includes(name) || PROFILE_FILE_RE.test(name)
}

// 收集当前数据目录里全部可导出的配置文件（解析失败的损坏文件跳过并记录，不让一个坏文件卡死导出）。
// 配置档文件按 my-playlist-profiles.json 注册表收集，而非目录扫描——
// 用户手拷在数据目录的 my-playlist-config.old.json 等杂散副本不进备份
function collectConfigFiles() {
  const files = {}
  const skipped = []
  const candidates = new Set(FIXED_FILES)
  try {
    const registry = JSON.parse(readFileSync(dataPath('my-playlist-profiles.json'), 'utf-8'))
    for (const p of (registry.profiles || [])) {
      if (p && typeof p.id === 'string' && /^[a-z0-9_-]{1,64}$/.test(p.id)) {
        candidates.add(`my-playlist-config.${p.id}.json`)
      }
    }
  } catch { /* 注册表不存在/损坏：没有额外配置档，默认档已在固定名单里 */ }
  for (const name of candidates) {
    const p = dataPath(name)
    if (!existsSync(p)) continue
    try {
      files[name] = JSON.parse(readFileSync(p, 'utf-8'))
    } catch {
      skipped.push(name)
    }
  }
  return { files, skipped }
}

// 导入的 system-config.json 绕过了 saveSystemConfigAPI 的字段级校验，这里对
// 启动关键项做同口径清洗：非法值删除该字段（回落到环境变量/默认值），而不是写坏配置。
// port 尤其关键：非法端口会让下次重启 listen 崩溃（999999）或静默绑 unix socket（"abc"）
function sanitizeSystemConfig(content) {
  if (content.port !== undefined) {
    const p = parseInt(content.port)
    if (Number.isInteger(p) && p >= 1 && p <= 65535) content.port = p
    else delete content.port
  }
  if (content.rateType !== undefined) {
    const rt = parseInt(content.rateType)
    if (Number.isInteger(rt) && rt > 0) content.rateType = rt
    else delete content.rateType
  }
  return content
}

// 导入后的内存态刷新：磁盘是唯一事实来源，持有内存副本的管理器必须重载。
// 写盘部分成功/失败后也要执行，保证运行态与磁盘对齐
function refreshRuntime() {
  reloadConfig()
  externalSourceManager.sources = externalSourceManager.loadSources()
  userManager.load()
  getExtractorManager().reload()
  clearUrlCache()
}

/** 导出：聚合全部配置为单 JSON（前端负责触发下载） */
export function exportConfigAPI() {
  try {
    const { files, skipped } = collectConfigFiles()
    return {
      success: true,
      data: {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        files,
      },
      skipped,   // 损坏未纳入的文件名（正常为空）
    }
  } catch (error) {
    return { success: false, message: error.message }
  }
}

/**
 * 导入：白名单校验 → 自动快照当前配置 → 覆盖写入 → 刷新各内存态并后台重建播放列表。
 * 返回 { success, imported, skipped, message }
 */
export function importConfigAPI(payload) {
  try {
    if (!payload || payload.format !== BACKUP_FORMAT || typeof payload.files !== 'object' || payload.files === null) {
      return { success: false, message: '不是有效的配置备份文件（缺少 iptv-config-backup 标记）' }
    }
    if (Number(payload.version) > BACKUP_VERSION) {
      return { success: false, message: `备份文件版本（${payload.version}）高于当前程序支持的版本（${BACKUP_VERSION}），请先升级程序再导入` }
    }

    const accepted = []
    const skipped = []
    for (const [name, content] of Object.entries(payload.files)) {
      // 文件名白名单挡路径穿越与未知文件；内容必须是对象/数组（配置文件均为 JSON 结构）
      if (!isAllowedFileName(name) || typeof content !== 'object' || content === null) {
        skipped.push(name)
        continue
      }
      accepted.push([name, name === 'system-config.json' ? sanitizeSystemConfig(content) : content])
    }
    if (accepted.length === 0) {
      return { success: false, message: '备份文件里没有可导入的配置（文件名均不在白名单内）', skipped }
    }

    // 覆盖前快照当前全部配置（同导出格式），写坏可从数据目录的该文件手动恢复；只保留最近一次
    const snapshot = collectConfigFiles()
    writeJsonFileSync(dataPath('config-pre-import-backup.json'), {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      note: '导入前自动备份（每次导入覆盖）',
      files: snapshot.files,
    })

    // 逐文件原子写；中途失败（磁盘满/权限/只读挂载）时用快照回滚已写文件，
    // 避免磁盘半新半旧；无论成败都刷新内存态，保证运行态与磁盘对齐
    const written = []
    try {
      for (const [name, content] of accepted) {
        writeJsonFileSync(dataPath(name), content)
        written.push(name)
      }
    } catch (error) {
      let rollbackFailed = false
      for (const name of written) {
        try {
          if (snapshot.files[name] !== undefined) {
            writeJsonFileSync(dataPath(name), snapshot.files[name])
          } else {
            unlinkSync(dataPath(name))   // 导入前不存在的文件：回滚 = 删除
          }
        } catch { rollbackFailed = true }
      }
      refreshRuntime()
      printRed(`配置导入写盘失败: ${error.message}`)
      return {
        success: false,
        message: `导入在写入第 ${written.length + 1}/${accepted.length} 个文件时失败：${error.message}。`
          + (rollbackFailed
            ? '部分文件回滚失败，请用数据目录 config-pre-import-backup.json 手动恢复'
            : '已自动回滚到导入前状态'),
      }
    }

    // 刷新各内存态：其余（my-playlist / epg 源 / 分组规则 / 别名表）按请求读盘或按 mtime 缓存，写盘即生效
    refreshRuntime()
    // 后台重建播放列表（fire-and-forget，update 内部串行化）
    update(0, { regenerateOnly: true }).catch(err => printRed(`导入后重建播放列表失败: ${err.message}`))

    printGreen(`配置导入完成：${accepted.length} 个文件`)
    if (skipped.length > 0) printYellow(`已跳过 ${skipped.length} 个白名单外的文件: ${skipped.join(', ')}`)
    return {
      success: true,
      imported: accepted.map(([name]) => name),
      skipped,
      // 新入口按导入后的**生效配置**算（refreshRuntime 刚 reloadConfig 过，config.js
      // 已把文件 + 环境变量合并）。密码只配在 compose（mpass）的部署，备份文件里
      // pass 为空——前端按备份文件自拼入口会误判「已变更」，把正常后台踢到 403。
      // 口径与 systemConfigAPI 保存响应的 entry/apiPrefix 完全一致。
      entry: '/' + [pass, adminPath].filter(Boolean).join('/'),
      apiPrefix: pass ? '/' + pass : '',
      message: `已导入 ${accepted.length} 个配置文件，播放列表正在后台重建（多数配置即时生效；端口修改需重启）。导入前的配置已自动备份到数据目录 config-pre-import-backup.json`,
    }
  } catch (error) {
    return { success: false, message: error.message }
  }
}
