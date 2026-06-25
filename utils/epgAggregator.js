// 外部 EPG 聚合（issue #38）
//
// 目的：把多个第三方 XMLTV(EPG) 源里的节目单，归一到本项目「规范频道名」后，
//   合并进咪咕已生成的 playback.xml，做到「播放器只填本项目的 /playback.xml 就覆盖全部频道」。
//
// 设计要点（v1，尽量简单）：
//   - 默认开启、内置默认源、零配置自动跑；手动只是「可选」（改 data/epg-sources.json）。
//   - 只为「播放列表里实际存在、且咪咕没给到 EPG」的频道补节目单 —— 不整份塞进来，playback.xml 保持精简。
//   - 频道配对复用 issue #39 的归一逻辑（normalizeKey / normalizeTvgName），与播放列表 tvg-id 对齐。
//   - 多源冲突按 priority「每个频道选一个源」：先到先得，咪咕最高优先（它有的频道不会被外部覆盖）。
//   - 坏源/超时自动跳过并沿用上次缓存，绝不拖垮基础节目单。

import fetch from 'node-fetch'
import { gunzipSync } from 'node:zlib'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { appendFileSync, writeJsonFileSync } from './fileUtil.js'
import { dataPath } from './paths.js'
import { normalizeKey, normalizeTvgName } from './channelNormalize.js'
import { parseProgrammes, rewriteChannel, escapeXml } from './epgParse.js'
import { enableEpgAggregation, enableTvgNormalize } from '../config.js'
import { printGreen, printRed, printYellow, printBlue } from './colorOut.js'

const EPG_SOURCES_PATH = dataPath('epg-sources.json')
const EPG_CACHE_DIR = dataPath('epg-cache')

// 下载超时（毫秒）。EPG 文件通常几 MB，给足时间避免误判失败。
const DOWNLOAD_TIMEOUT = 60000
// 解压后体积上限，超过则跳过该源，避免超大 XMLTV 撑爆内存。
const MAX_XML_BYTES = 150 * 1024 * 1024

/**
 * 内置默认 EPG 源：新装时自动写入 data/epg-sources.json，开箱即用、无需任何手动配置。
 * 用户想增删改 / 调优先级，编辑该文件即可（手动可选）。
 */
const BUILT_IN_EPG_SOURCES = [
  {
    name: '默认EPG',
    url: 'http://epg.51zmt.top:8000/e.xml.gz',
    enabled: true,
    format: 'auto',        // auto | xml | gz
    refreshInterval: 720,  // 刷新间隔（分钟），默认 12 小时
    priority: 10,          // 数字小 = 优先级高，多源命中同一频道时高优先级胜
    lastUpdated: null,
    lastStatus: null,
    channelCount: 0,
    matchedCount: 0
  }
]

function defaultConfig() {
  return { enabled: true, sources: BUILT_IN_EPG_SOURCES.map(s => ({ ...s })) }
}

// 加载 EPG 源配置；缺失则写入内置默认（实现「默认全自动」）。
function loadEpgConfig() {
  if (!existsSync(EPG_SOURCES_PATH)) {
    const config = defaultConfig()
    saveEpgConfig(config)
    printBlue('已创建默认 EPG 源配置 epg-sources.json（默认开启，开箱即用）')
    return config
  }
  try {
    const parsed = JSON.parse(readFileSync(EPG_SOURCES_PATH, 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null) throw new Error('格式非对象')
    if (typeof parsed.enabled !== 'boolean') parsed.enabled = true
    if (!Array.isArray(parsed.sources)) parsed.sources = []
    return parsed
  } catch (e) {
    printRed(`加载 EPG 源配置失败，回退内置默认: ${e.message}`)
    return defaultConfig()
  }
}

function saveEpgConfig(config) {
  try {
    writeJsonFileSync(EPG_SOURCES_PATH, config)
  } catch (e) {
    printRed(`保存 EPG 源配置失败: ${e.message}`)
  }
}

function ensureCacheDir() {
  try { mkdirSync(EPG_CACHE_DIR, { recursive: true }) } catch { /* 已存在或不可创建，后续读写自然报错 */ }
}

function cacheFileFor(source, index) {
  const safe = String(source.name || `source${index}`).replace(/[^\w一-龥-]/g, '_').slice(0, 60)
  return dataPath(`epg-cache/${safe}_${index}.xml`)
}

// 是否到刷新时间：无缓存/无 lastUpdated → 需要；否则按 refreshInterval 判断
function isDue(source) {
  if (!source.lastUpdated) return true
  const last = new Date(source.lastUpdated).getTime()
  if (!last || Number.isNaN(last)) return true
  const intervalMs = (source.refreshInterval || 720) * 60 * 1000
  return Date.now() - last >= intervalMs
}

// 下载并按需 gunzip，返回 XML 文本
async function downloadXml(source) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT)
  try {
    const res = await fetch(source.url, { signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    // 以 gzip magic(1f 8b) 为准判断是否需解压：URL 后缀 / format 仅作提示。
    // 不少服务器会对 .gz 做传输层解压，此时 body 已是明文、无 magic，按 magic 判断可避免误解压。
    const isGz = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b
    const xmlBuf = isGz ? gunzipSync(buf) : buf
    if (xmlBuf.length > MAX_XML_BYTES) {
      throw new Error(`解压后体积过大(${Math.round(xmlBuf.length / 1048576)}MB)，已跳过`)
    }
    return xmlBuf.toString('utf-8')
  } finally {
    clearTimeout(timer)
  }
}

// 保证本地有可用的原始 XML 缓存：到期则下载刷新，失败则沿用上次缓存。返回是否有缓存可用。
async function ensureRawXml(source, cachePath) {
  const haveCache = existsSync(cachePath)
  if (haveCache && !isDue(source)) return true
  try {
    const xml = await downloadXml(source)
    writeFileSync(cachePath, xml, 'utf-8')
    source.lastUpdated = new Date().toISOString()
    source.lastStatus = 'ok'
    printGreen(`EPG 源「${source.name}」下载成功`)
    return true
  } catch (e) {
    source.lastStatus = `失败: ${e.message}`
    if (haveCache) {
      printYellow(`EPG 源「${source.name}」刷新失败，沿用上次缓存: ${e.message}`)
      return true
    }
    printRed(`EPG 源「${source.name}」下载失败且无缓存，跳过: ${e.message}`)
    return false
  }
}

/**
 * 把外部 EPG 源的节目单聚合追加进 playback（.bak）文件。
 * 仅在完整更新（非 regenerateOnly）里、写入 </tv> 之前调用。
 *
 * @param {string} playbackBakPath  - 正在写入的 playback.xml.bak 路径
 * @param {string[]} playlistChannelNames - 播放列表中实际写入的频道原始名（含咪咕/外部/内置）
 * @param {Set<string>} coveredKeys - 已由咪咕给到 EPG 的频道归一 key（这些频道不再被外部覆盖）
 * @returns {Promise<{appended:number, unmatched?:number, skipped?:string}>}
 */
async function aggregateExternalEpg(playbackBakPath, playlistChannelNames, coveredKeys) {
  if (!enableEpgAggregation) return { appended: 0, skipped: 'disabled-config' }

  const config = loadEpgConfig()
  if (config.enabled === false) return { appended: 0, skipped: 'disabled' }

  const sources = (config.sources || []).filter(s => s && s.enabled !== false && s.url)
  if (sources.length === 0) return { appended: 0 }

  // 待补频道：播放列表中尚无 EPG 的频道，归一 key → 输出用频道 id。
  // 输出 id 与播放列表 tvg-id 取同一变换（开启归一时取规范名，否则原名），保证播放器能对上。
  const pending = new Map()
  for (const name of playlistChannelNames) {
    const k = normalizeKey(name)
    if (!k || coveredKeys.has(k) || pending.has(k)) continue
    const outputId = enableTvgNormalize ? (normalizeTvgName(name) || name) : name
    pending.set(k, outputId)
  }
  if (pending.size === 0) {
    saveEpgConfig(config)
    return { appended: 0 }
  }

  ensureCacheDir()
  sources.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))

  let appended = 0
  for (let i = 0; i < sources.length; i++) {
    if (pending.size === 0) break
    const source = sources[i]
    const cachePath = cacheFileFor(source, i)

    const ok = await ensureRawXml(source, cachePath)
    if (!ok) { source.matchedCount = 0; continue }

    let xml
    try {
      xml = readFileSync(cachePath, 'utf-8')
    } catch (e) {
      source.lastStatus = `缓存读取失败: ${e.message}`
      continue
    }

    const byKey = parseProgrammes(xml, new Set(pending.keys()))
    source.channelCount = (xml.match(/<channel\b/g) || []).length

    let matched = 0
    for (const [k, outputId] of pending) {
      const blocks = byKey.get(k)
      if (!blocks || blocks.length === 0) continue
      let out = `    <channel id="${escapeXml(outputId)}">\n` +
        `        <display-name lang="zh">${escapeXml(outputId)}</display-name>\n` +
        `    </channel>\n`
      for (const b of blocks) out += rewriteChannel(b, outputId) + '\n'
      appendFileSync(playbackBakPath, out)
      pending.delete(k) // 该频道已补齐，后续低优先级源不再覆盖
      matched++
      appended++
    }
    source.matchedCount = matched
    if (matched > 0) printGreen(`EPG 源「${source.name}」补充 ${matched} 个频道节目单`)
  }

  saveEpgConfig(config)
  printGreen(`EPG 聚合完成：补充 ${appended} 个频道，仍有 ${pending.size} 个频道无外部 EPG`)
  return { appended, unmatched: pending.size }
}

export { aggregateExternalEpg, loadEpgConfig, saveEpgConfig, BUILT_IN_EPG_SOURCES }
