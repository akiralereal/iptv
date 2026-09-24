// 外部 EPG 聚合（issue #38）
//
// 目的：把多个第三方 XMLTV(EPG) 源里的节目单，归一到本项目「规范频道名」后，
//   合并进咪咕已生成的 playback.xml，做到「播放器只填本项目的 /playback.xml 就覆盖全部频道」。
//
// 设计要点（v1，尽量简单）：
//   - 默认开启、不带内置外部源：节目单默认由咪咕与各模块的官方接口提供（moduleEpg.js），
//     这里只处理用户自己在后台（或 data/epg-sources.json）加的 XMLTV 源。
//   - 只为「播放列表里实际存在、且咪咕没给到 EPG」的频道补节目单 —— 不整份塞进来，playback.xml 保持精简。
//   - 频道配对复用 issue #39 的归一逻辑（normalizeKey / normalizeTvgName），与播放列表 tvg-id 对齐。
//   - 多源冲突按 priority「每个频道选一个源」：先到先得，咪咕与模块官方节目单最先（它们有的频道不会被外部覆盖）。
//   - 坏源/超时自动跳过并沿用上次缓存，绝不拖垮基础节目单。

import fetch from 'node-fetch'
import { gunzipSync, gzipSync } from 'node:zlib'
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { appendFileSync, writeJsonFileSync } from './fileUtil.js'
import { dataPath } from './paths.js'
import { normalizeKey, normalizeTvgName } from './channelNormalize.js'
import { parseProgrammes, rewriteChannel, stripNoticeDesc, escapeXml } from './epgParse.js'
import { enableEpgAggregation, enableTvgNormalize } from '../config.js'
import { printGreen, printRed, printYellow, printBlue } from './colorOut.js'

const EPG_SOURCES_PATH = dataPath('epg-sources.json')
const EPG_CACHE_DIR = dataPath('epg-cache')

// 下载超时（毫秒）。EPG 文件通常几 MB，给足时间避免误判失败。
const DOWNLOAD_TIMEOUT = 60000
// 解压后体积上限，超过则跳过该源，避免超大 XMLTV 撑爆内存。
const MAX_XML_BYTES = 150 * 1024 * 1024

/**
 * 内置默认外部 EPG 源：现在一个都没有。
 * 先后用过的两家都是个人维护的站点，一家退化、一家转收费，默认源的可用性就这样系在别人身上。
 * 节目单改由咪咕与各模块从官方接口取（moduleEpg.js）；想要更广覆盖的用户在后台「EPG 聚合」自己加源。
 */
const BUILT_IN_EPG_SOURCES = []

// 节目单里的频道 id 与播放列表 tvg-id 取同一变换（开启归一时取规范名，否则原名），
// 播放器才对得上。外部聚合与模块节目单（moduleEpg.js）共用。
export function epgChannelId(name) {
  return enableTvgNormalize ? (normalizeTvgName(name) || name) : name
}

// 用过、已经停用的内置默认源：
// - epg.51zmt.top：退化到只剩 101 个央视卫视、2 天节目（咪咕本来就有），issue #124 换掉；
// - e.erw.cc：站长 2026-10-01 起关掉免费下载，XML 只给赞助用户。
const LEGACY_EPG_SOURCE_URLS = ['http://epg.51zmt.top:8000/e.xml.gz', 'https://e.erw.cc/all.xml.gz']

// 老部署的 data/epg-sources.json 里还写着这些地址。下载失败后聚合会一直沿用最后一份缓存、
// 配对又不看日期，留着它只会给一批频道挂上过期节目单，还把用户自己加的源挡在后面。
// 所以「一字未改的内置默认源」（名字仍是「默认EPG」、地址还是上面之一）直接删掉；
// 用户改过名 / 改过地址 / 自己加的源一律不碰，后台会在停用地址那条上提示。
function migrateLegacySources(config) {
  const sources = config.sources || []
  const retired = s => s && s.name === '默认EPG' && LEGACY_EPG_SOURCE_URLS.includes(s.url)
  if (!sources.some(retired)) return false
  // 缓存按「名字_序号」落盘：删掉一条后，后面的源会挪到它的序号上，同名的就会读到它的旧缓存
  sources.forEach((s, index) => {
    if (!retired(s)) return
    try { unlinkSync(cacheFileFor(s, index)) } catch { /* 没下过或已删 */ }
  })
  config.sources = sources.filter(s => !retired(s))
  return true
}

function defaultConfig() {
  return { enabled: true, sources: BUILT_IN_EPG_SOURCES.map(s => ({ ...s })) }
}

// 加载 EPG 源配置；缺失则写入内置默认（实现「默认全自动」）。
function loadEpgConfig() {
  if (!existsSync(EPG_SOURCES_PATH)) {
    const config = defaultConfig()
    saveEpgConfig(config)
    printBlue('已创建 EPG 源配置 epg-sources.json（聚合已开启，暂无外部源；节目单默认由咪咕与各模块官方接口提供）')
    return config
  }
  try {
    const parsed = JSON.parse(readFileSync(EPG_SOURCES_PATH, 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null) throw new Error('格式非对象')
    if (typeof parsed.enabled !== 'boolean') parsed.enabled = true
    if (!Array.isArray(parsed.sources)) parsed.sources = []
    if (migrateLegacySources(parsed)) {
      saveEpgConfig(parsed)
      printBlue('已移除停用的内置默认 EPG 源（erw 10 月 1 日起停止免费下载）：节目单改由咪咕与各模块官方接口提供，需要更多覆盖可在后台「EPG 聚合」自己加源')
    }
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

// 缓存按 gzip 落盘：一份覆盖全国地方台的 XMLTV 解压后有十几 MB，原样堆在数据目录里
// 对 NAS 用户是白占的空间（压缩后约 1/13），而每轮只在真正解析时才解压一次，代价可忽略。
// 老部署里已有的明文缓存不作废：读取时按 gzip magic 判定，明文照样能用。issue #124
function writeCachedXml(cachePath, xml) {
  writeFileSync(cachePath, gzipSync(Buffer.from(xml, 'utf-8')))
}

function readCachedXml(cachePath) {
  const buf = readFileSync(cachePath)
  const isGz = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b
  return (isGz ? gunzipSync(buf) : buf).toString('utf-8')
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
    writeCachedXml(cachePath, xml)
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
  const pending = new Map()
  for (const name of playlistChannelNames) {
    const k = normalizeKey(name)
    if (!k || coveredKeys.has(k) || pending.has(k)) continue
    const outputId = epgChannelId(name)
    pending.set(k, outputId)
  }
  if (pending.size === 0) {
    saveRunStates(config)
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
      xml = readCachedXml(cachePath)
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
      for (const b of blocks) out += rewriteChannel(stripNoticeDesc(b), outputId) + '\n'
      appendFileSync(playbackBakPath, out)
      pending.delete(k) // 该频道已补齐，后续低优先级源不再覆盖
      matched++
      appended++
    }
    source.matchedCount = matched
    if (matched > 0) printGreen(`EPG 源「${source.name}」补充 ${matched} 个频道节目单`)
  }

  saveRunStates(config)
  printGreen(`EPG 聚合完成：补充 ${appended} 个频道，仍有 ${pending.size} 个频道无外部 EPG`)
  return { appended, unmatched: pending.size }
}

// 聚合收尾保存：不整份写回进入时的旧配置——聚合窗口长达分钟级（逐源下载，单源超时 60s），
// 期间配置可能已被后台「EPG 源管理」编辑或配置导入（issue #99）改写，整份写回会把新配置
// 静默还原。改为重读磁盘最新配置，按源 url 对齐、只合并本轮产生的运行状态字段再保存；
// url 已不在新配置里的源（本轮跑动期间被删除）直接丢弃其状态。
function saveRunStates(runConfig) {
  const fresh = loadEpgConfig()
  const byUrl = new Map((runConfig.sources || []).filter(s => s && s.url).map(s => [s.url, s]))
  for (const s of (fresh.sources || [])) {
    const run = s && s.url ? byUrl.get(s.url) : null
    if (!run) continue
    for (const k of ['lastUpdated', 'lastStatus', 'channelCount', 'matchedCount']) {
      if (run[k] !== undefined) s[k] = run[k]
    }
  }
  saveEpgConfig(fresh)
}

export { aggregateExternalEpg, loadEpgConfig, saveEpgConfig, BUILT_IN_EPG_SOURCES, LEGACY_EPG_SOURCE_URLS }
