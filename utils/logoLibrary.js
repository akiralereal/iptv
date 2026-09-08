// 公共台标库索引（issue #124）
//
// 背景：外部 / 内置 / 抓取模块的频道多数没有自带台标，此前的兜底是「按频道名盲拼一个
//   <库基址><频道名>.png」写进订阅。库里没有这张图时播放器拿到的是 404，屏幕上就是一个
//   裂图——比留空更难看（留空时播放器会画自己的占位图）。2026-09 实测：253 条兜底里
//   138 条 404。
//
// 做法：台标库自带一份「频道名 → 图片」索引（iconList_default.json，3266 条），
//   下载一次落盘缓存，之后纯本地比对：
//   - 命中 → 写库里真实存在的文件名，保证 200；
//   - 未命中 → 写空串，让播放器出占位图，不再有裂图；
//   - 索引拿不到（首次启动没网 / 库改版）→ 退回老的盲拼行为，至少不比以前差。
//
// 匹配顺序（越靠前越严格，先命中先用）：
//   1) 原名精确 —— 库里绝大多数就是频道原名
//   2) 台标匹配名 logoMatchName（去清晰度/运营商，issue #40）
//   3) 保守候选名：去 CCTV 前缀（CCTV怀旧剧场→怀旧剧场）、去「频道」尾巴（国学频道→国学）、
//      蒙古语→蒙语、补分组前缀（内蒙古组的「新闻综合」→内蒙古新闻综合）
//   4) 纯英文名去空格/连字符后大小写不敏感（Sky News→SKYNEWS）
// 宽松表只收「归一后唯一」的库名：logoMatchName 会把「广东移动」和「广东4K超高清」都
//   压成「广东」，这类多对一的 key 一律丢弃，宁可留空也不贴错台标。

import fetch from 'node-fetch'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { writeJsonFileSync } from './fileUtil.js'
import { dataPath } from './paths.js'
import { logoMatchName } from './channelNormalize.js'
import { externalLogoIndex } from '../config.js'
import { printGreen, printYellow, printBlue } from './colorOut.js'

const INDEX_PATH = dataPath('logo-index.json')
// 索引刷新间隔：台标库是慢变量（月级增删），7 天足够，且失败沿用旧缓存
const REFRESH_MS = 7 * 24 * 60 * 60 * 1000
const DOWNLOAD_TIMEOUT = 30000
// 索引正常 300KB 上下，给 20 倍余量；超了说明拿到的不是索引（劫持/改版），直接弃用
const MAX_INDEX_BYTES = 6 * 1024 * 1024

// { names: string[], exact: Map, loose: Map, ascii: Map }；null = 无索引（调用方退回盲拼）
let _index = null

function asciiKey(s) {
  // 只对纯 ASCII 名做大小写/空格不敏感匹配，中文名不参与（避免把不同台压成同一 key）
  if (!s || !/^[\x20-\x7E]+$/.test(s)) return ''
  return s.toUpperCase().replace(/[\s\-_.]/g, '')
}

// 由库文件名列表构建查找表；宽松表丢弃多对一的 key（见文件头说明）
function buildIndex(names) {
  const exact = new Map()
  const looseAll = new Map()
  const asciiAll = new Map()
  for (const name of names) {
    if (!name || typeof name !== 'string') continue
    if (!exact.has(name)) exact.set(name, name)
    const lk = logoMatchName(name)
    if (lk) {
      const bucket = looseAll.get(lk)
      if (bucket) bucket.push(name)
      else looseAll.set(lk, [name])
    }
    const ak = asciiKey(name)
    if (ak) {
      const bucket = asciiAll.get(ak)
      if (bucket) bucket.push(name)
      else asciiAll.set(ak, [name])
    }
  }
  const dropAmbiguous = (m) => {
    const out = new Map()
    for (const [k, v] of m) if (v.length === 1) out.set(k, v[0])
    return out
  }
  return { names, exact, loose: dropAmbiguous(looseAll), ascii: dropAmbiguous(asciiAll) }
}

function loadCachedIndex() {
  if (!existsSync(INDEX_PATH)) return null
  try {
    const parsed = JSON.parse(readFileSync(INDEX_PATH, 'utf-8'))
    const names = Array.isArray(parsed?.names) ? parsed.names : null
    if (!names || names.length === 0) return null
    return names
  } catch {
    return null   // 缓存损坏当作没有，下次更新会重新下载
  }
}

function cacheAgeMs() {
  try { return existsSync(INDEX_PATH) ? Date.now() - statSync(INDEX_PATH).mtimeMs : Infinity } catch { return Infinity }
}

// 下载索引并抽出库里的文件名（值形如 .../icon/<名>.png，只取 <名>）
async function downloadIndex(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_INDEX_BYTES) throw new Error(`索引体积异常(${Math.round(buf.length / 1024)}KB)`)
    const parsed = JSON.parse(buf.toString('utf-8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('格式非对象')
    const names = Object.keys(parsed).filter(n => n && typeof n === 'string')
    if (names.length === 0) throw new Error('索引为空')
    return names
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 准备台标库索引：到期则下载刷新，失败沿用上次缓存；两者都没有则本轮退回盲拼。
 * 每轮完整更新调一次，纯本地命中时零网络开销。
 */
export async function ensureLogoIndex() {
  if (!externalLogoIndex) { _index = null; return false }   // 用户显式关掉索引（或用了自定义台标库）
  const cached = loadCachedIndex()
  if (cached && cacheAgeMs() < REFRESH_MS) {
    _index = buildIndex(cached)
    return true
  }
  try {
    const names = await downloadIndex(externalLogoIndex)
    writeJsonFileSync(INDEX_PATH, { url: externalLogoIndex, updatedAt: new Date().toISOString(), names })
    _index = buildIndex(names)
    printGreen(`台标库索引已更新：${names.length} 个台标`)
    return true
  } catch (e) {
    if (cached) {
      _index = buildIndex(cached)
      printYellow(`台标库索引刷新失败，沿用上次缓存: ${e.message}`)
      return true
    }
    _index = null
    printYellow(`台标库索引获取失败，本轮按频道名直接兜底: ${e.message}`)
    return false
  }
}

// 测试用：直接注入一份索引（不联网）
export function setLogoIndexForTest(names) {
  _index = names ? buildIndex(names) : null
}

export function hasLogoIndex() {
  return _index !== null
}

// 保守候选名：只做「同一个台的另一种写法」，不做模糊猜测。
// 顺序即优先级，越具体越靠前：
//   原名 / 台标匹配名 → 补分组前缀（内蒙古组的「少儿频道」应命中 内蒙古少儿，而不是通用「少儿」）
//   → 去 CCTV 前缀 / 去「频道」尾巴 / 蒙古语→蒙语（这几种可叠加：内蒙古蒙古语文化频道 → 内蒙古蒙语文化）
function candidateNames(name, group) {
  const add = (arr, v) => { if (v && !arr.includes(v)) arr.push(v) }
  const seeds = []
  add(seeds, name)
  add(seeds, logoMatchName(name))

  const variants = [...seeds]
  let frontier = [...seeds]
  for (let depth = 0; depth < 2 && frontier.length; depth++) {
    const next = []
    for (const v of frontier) {
      // CCTV 数字频道由 logoMatchName 处理；这里只脱「CCTV+汉字」的付费/数字频道前缀
      if (/^CCTV[^\d]/.test(v)) add(next, v.slice(4))
      if (v.includes('蒙古语')) add(next, v.replace('蒙古语', '蒙语'))
      // 「频道 / 台」是通用后缀：库里多数收短名（翡翠台→翡翠、国学频道→国学）。
      // 只在剩下的名字仍有 2 个字以上时才脱，避免把「卫视台」这类脱成没信息量的短词。
      const noSuffix = v.replace(/(频道|台)$/, '')
      if (noSuffix !== v && noSuffix.length >= 2) add(next, noSuffix)
    }
    for (const v of next) add(variants, v)
    frontier = next
  }

  const out = []
  for (const v of seeds) add(out, v)
  // 地方台在分组里常是裸名（内蒙古组的「新闻综合」），库里则是「内蒙古新闻综合」
  if (group) for (const v of variants) if (!v.startsWith(group)) add(out, group + v)
  for (const v of variants) add(out, v)
  return out
}

/**
 * 在台标库里找这个频道的图片名。
 * @returns {string|null} 库里的文件名（不含扩展名）；'' = 索引里确实没有（应留空）；null = 无索引，调用方自行盲拼
 */
export function resolveLibraryLogo(name, group) {
  if (!_index) return null
  if (!name) return ''
  for (const cand of candidateNames(name, group)) {
    const hit = _index.exact.get(cand)
      || _index.loose.get(logoMatchName(cand) || cand)
      || _index.ascii.get(asciiKey(cand))
    if (hit) return hit
  }
  return ''
}

export function logoIndexSize() {
  return _index ? _index.names.length : 0
}

export { INDEX_PATH as LOGO_INDEX_PATH }
