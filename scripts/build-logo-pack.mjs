#!/usr/bin/env node
/**
 * 维护仓库内置台标（logo-pack/）。规则见 LOGO.md。
 *
 * 用法：
 *   node scripts/build-logo-pack.mjs [--data <数据目录>] [--update]
 *       用一轮完整更新的结果刷新：各模块频道的官方台标（extractor-cache.json）与咪咕频道台标
 *       （interface.txt）。图优先取本机托管已下载校验过的（logo-cache/），没有再现下。
 *       数据目录默认 mdataDir，没设就是当前目录。
 *       默认只补内置库里还没有的、以及用官方图替换手工图；已有的官方图不动——同一张图重新下载、
 *       重新转码后字节会有细微差别，全量覆盖只会让仓库白白长大。官方真换了台标时加 --update。
 *   node scripts/build-logo-pack.mjs --add <台标名> <图片文件或地址> --source <出处> [--kind official|platform|library] [--trim]
 *       手工收一张：官方没有、模块取不到的频道（精选频道这类 m3u、官方确实没图的台）。
 *       --trim 裁掉四周与角落同色（透明或纯色底）的空白，图里留白太多时用。
 *       --bg <#颜色> 铺一层底色：官方只有纯白字台标时用，否则浅色界面上整个看不见。
 *   node scripts/build-logo-pack.mjs --import <目录>
 *       批量手工收：目录里 <台标名>.<扩展名> 加一份 sources.json
 *       （{ "<台标名>": { "url": "...", "page": "...", "kind": "official|platform|library", "note": "...",
 *          "file": "可选，文件名与台标名不同时写", "trim": 可选 true, "bg": "可选，#颜色" } }）。
 *   node scripts/build-logo-pack.mjs --remove <台标名>
 *
 * 所有图统一缩到长边不超过 256px 的 PNG（不放大位图），用本机 Chrome 的画布转码，不引入图片库依赖。
 * 模块 / 咪咕的图会覆盖同名的手工图（官方优先）；手工图不会覆盖官方图。模块里已经不在的频道不删，
 * 内置台标本来就是兜底备份。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const PACK_DIR = process.env.mlogoPackDir || path.join(ROOT, 'logo-pack')
const INDEX_PATH = path.join(PACK_DIR, 'index.json')
const MAX_SIDE = 256
const MAX_SOURCE_BYTES = 8 * 1024 * 1024
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// 这些不是电视台：直播平台的主播间、景观 / 熊猫 / 慢直播机位的封面、活动直播间，不进内置台标
const SKIP_MODULES = new Set(['livechina', 'ipanda', 'songjiang'])
const SKIP_GROUP = /景观|风景/
const SKIP_REF = /^sichuan-live-/

// 通用频道名：全由这些词拼成（去掉「频道 / 台」尾巴后）的，存成带地名的名字（内蒙古新闻综合），
// 免得外部 m3u 里裸的「新闻综合」按名匹配贴上别家的图。
const GENERIC_WORDS = [
  '电视剧', '新闻', '综合', '公共', '都市', '生活', '经济', '影视', '文体', '娱乐', '少儿', '教育', '科教',
  '农牧', '农业', '乡村', '文艺', '体育', '法治', '民生', '文旅', '戏曲', '国际', '电影', '科技', '社会',
  '健康', '纪实', '旅游', '移动', '购物', '资讯', '文化', '休闲', '时尚', '卡通', '动画', '音乐', '财经',
  '交通', '城市', '导视', '电视', '汉语', '综艺', '家庭', '房产', '青少', '数字', '高清', '妇女', '儿童',
].sort((a, b) => b.length - a.length)

export function isGenericName(name) {
  let rest = String(name || '').replace(/(频道|台)$/, '').replace(/[\s·・-]/g, '')
  if (!rest) return false
  while (rest) {
    const word = GENERIC_WORDS.find(w => rest.startsWith(w))
    if (!word) return false
    rest = rest.slice(word.length)
  }
  return true
}

export function packNameFor(name, group) {
  return isGenericName(name) && group && !name.startsWith(group) ? `${group}${name}` : name
}

function fileNameFor(name, taken) {
  let base = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '') || 'logo'
  // macOS / Windows 文件名不分大小写
  let candidate = base
  for (let i = 2; taken.has(candidate.toLowerCase()); i++) candidate = `${base}_${i}`
  return `${candidate}.png`
}

function loadIndex() {
  if (!existsSync(INDEX_PATH)) return { version: 1, logos: {}, refs: {} }
  const parsed = JSON.parse(readFileSync(INDEX_PATH, 'utf-8'))
  return { version: 1, logos: parsed.logos || {}, refs: parsed.refs || {} }
}

function saveIndex(index) {
  const sorted = obj => Object.fromEntries(Object.keys(obj).sort((a, b) => a.localeCompare(b, 'zh-CN')).map(k => [k, obj[k]]))
  const logos = Object.fromEntries(Object.entries(sorted(index.logos)).map(([name, e]) => [name, sorted(e)]))
  writeFileSync(INDEX_PATH, JSON.stringify({ version: 1, logos, refs: sorted(index.refs) }, null, 1) + '\n')
}

function detectMime(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif'
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  if (/^\uFEFF?\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^[>]*(\[[\s\S]*?\])?\s*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(buf.subarray(0, 4096).toString('utf8'))) return 'image/svg+xml'
  return null
}

async function download(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'image/png,image/jpeg,image/gif,image/svg+xml,image/*;q=0.8,*/*;q=0.5' },
    signal: AbortSignal.timeout(20000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const buf = Buffer.from(await response.arrayBuffer())
  if (buf.length > MAX_SOURCE_BYTES) throw new Error('图片过大')
  return buf
}

function readSource(src) {
  return /^https?:\/\//i.test(src) ? download(src) : Promise.resolve(readFileSync(src))
}

/**
 * 把 SVG 的显示尺寸定成长边 MAX_SIDE：有的只写 viewBox、有的只写宽高，浏览器给的天然尺寸不可靠
 * （没 viewBox 时放大不会按比例缩放内容）。缺 viewBox 就按宽高补一个。
 */
export function sizeSvg(text) {
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0]
  if (!tag) return text
  const attr = name => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1]
  const length = value => (value && !/%\s*$/.test(value) ? parseFloat(value) : 0) || 0
  let box = (attr('viewBox') || '').trim().split(/[\s,]+/).map(Number)
  if (box.length !== 4 || !(box[2] > 0 && box[3] > 0)) {
    const [width, height] = [length(attr('width')), length(attr('height'))]
    if (!(width > 0 && height > 0)) return text
    box = [0, 0, width, height]
  }
  const scale = MAX_SIDE / Math.max(box[2], box[3])
  const sized = tag
    .replace(/\s(width|height|viewBox)\s*=\s*["'][^"']*["']/gi, '')
    .replace(/^<svg\b/i, `<svg width="${+(box[2] * scale).toFixed(2)}" height="${+(box[3] * scale).toFixed(2)}" viewBox="${box.join(' ')}"`)
  return text.replace(tag, sized)
}

let browser = null
let page = null
async function toPng(buf, { trim = false, bg = '' } = {}) {
  let mime = detectMime(buf)
  if (!mime) throw new Error('不是图片')
  if (mime === 'image/svg+xml') buf = Buffer.from(sizeSvg(buf.toString('utf8')))
  if (!page) {
    const { launchWithFallback } = await import('../utils/browserLauncher.js')
    browser = await launchWithFallback({})
    page = await browser.newPage()
  }
  const out = await page.evaluate(async (src, max, vector, trim, bg) => {
    const img = new Image()
    img.src = src
    await img.decode()
    const w = img.naturalWidth || max
    const h = img.naturalHeight || max
    // 先按原尺寸铺开，要裁边就找出和左上角颜色不同的内容范围，四周留 2% 余量
    const full = document.createElement('canvas')
    full.width = w
    full.height = h
    full.getContext('2d').drawImage(img, 0, 0, w, h)
    let [x0, y0, x1, y1] = [0, 0, w, h]
    if (trim) {
      const data = full.getContext('2d').getImageData(0, 0, w, h).data
      const corner = [data[0], data[1], data[2], data[3]]
      const differs = i => (corner[3] < 16 && data[i + 3] < 16)
        ? false
        : Math.abs(data[i] - corner[0]) + Math.abs(data[i + 1] - corner[1]) + Math.abs(data[i + 2] - corner[2]) + Math.abs(data[i + 3] - corner[3]) > 48
      let [minX, minY, maxX, maxY] = [w, h, -1, -1]
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!differs((y * w + x) * 4)) continue
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
      if (maxX >= minX && maxY >= minY) {
        const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.02)
        ;[x0, y0, x1, y1] = [Math.max(0, minX - pad), Math.max(0, minY - pad), Math.min(w, maxX + 1 + pad), Math.min(h, maxY + 1 + pad)]
      }
    }
    const [cropW, cropH] = [x1 - x0, y1 - y0]
    // 位图不放大；矢量图按长边铺满
    const scale = vector && !trim ? max / Math.max(cropW, cropH) : Math.min(1, max / Math.max(cropW, cropH))
    const cw = Math.max(1, Math.round(cropW * scale))
    const ch = Math.max(1, Math.round(cropH * scale))
    const canvas = document.createElement('canvas')
    canvas.width = cw
    canvas.height = ch
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingQuality = 'high'
    if (bg) {
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, cw, ch)
    }
    ctx.drawImage(full, x0, y0, cropW, cropH, 0, 0, cw, ch)
    return { data: canvas.toDataURL('image/png'), width: cw, height: ch }
  }, `data:${mime};base64,${buf.toString('base64')}`, MAX_SIDE, mime === 'image/svg+xml', trim, /^#[0-9a-f]{3,8}$/i.test(bg) ? bg : '')
  return { png: Buffer.from(out.data.split(',')[1], 'base64'), width: out.width, height: out.height }
}

const today = () => new Date().toISOString().slice(0, 10)

/** 写入一张台标；图没变只更新出处，返回 'added' | 'updated' | 'same' */
async function putLogo(index, name, buf, meta, { trim = false, bg = '' } = {}) {
  const { png, width, height } = await toPng(buf, { trim, bg })
  const hash = createHash('sha1').update(png).digest('hex').slice(0, 10)
  const existing = index.logos[name]
  const taken = new Set(Object.values(index.logos).filter(e => e !== existing).map(e => e.file.toLowerCase().replace(/\.png$/, '')))
  const file = existing?.file || fileNameFor(name, taken)
  if (existing?.hash === hash) {
    index.logos[name] = { ...existing, ...meta }
    return 'same'
  }
  writeFileSync(path.join(PACK_DIR, file), png)
  index.logos[name] = { ...meta, file, hash, width, height, updated: today() }
  return existing ? 'updated' : 'added'
}

/** 一轮完整更新留下的模块频道与咪咕频道 */
async function collectFromData(dataDir) {
  const { getModule } = await import('../extractors/registry.js')
  const { logoCacheKey } = await import('../utils/logoCache.js')
  const cacheIndex = existsSync(path.join(dataDir, 'logo-cache/index.json'))
    ? JSON.parse(readFileSync(path.join(dataDir, 'logo-cache/index.json'), 'utf-8')).entries || {}
    : {}
  const cachedFile = url => {
    const entry = cacheIndex[logoCacheKey(url)]
    const file = entry?.status === 'ok' && entry.file && path.join(dataDir, 'logo-cache', entry.file)
    return file && existsSync(file) ? file : ''
  }
  const items = []
  const modules = JSON.parse(readFileSync(path.join(dataDir, 'extractor-cache.json'), 'utf-8')).modules || {}
  for (const [id, entry] of Object.entries(modules)) {
    const mod = getModule(id)
    if (!mod || id === 'migu' || mod.category === 'live' || SKIP_MODULES.has(id)) continue
    for (const group of entry.groups || []) {
      if (SKIP_GROUP.test(group.name)) continue
      const groupName = mod.outputGroupName || group.name
      for (const item of group.dataList || []) {
        const ref = item.deferredRef ?? `#${item.name}`
        if (!item.name || SKIP_REF.test(ref)) continue
        items.push({ origin: id, ref: `${id}/${ref}`, name: packNameFor(item.name, groupName), url: item.logo || '', file: item.logo ? cachedFile(item.logo) : '' })
      }
    }
  }
  // 咪咕频道不落模块缓存，从生成的播放列表里取（体育赛事的场次海报不收）
  const fileToUrl = new Map(Object.entries(cacheIndex).map(([url, e]) => [e.file, url]))
  const playlist = existsSync(path.join(dataDir, 'interface.txt')) ? readFileSync(path.join(dataDir, 'interface.txt'), 'utf-8') : ''
  for (const line of playlist.split('\n')) {
    if (!line.startsWith('#EXTINF') || !/source-ids="migu[";]/.test(line)) continue
    const group = /group-title="([^"]*)"/.exec(line)?.[1] || ''
    const file = /tvg-logo="\$\{replace\}\/logo-cache\/([^"?]+)/.exec(line)?.[1]
    if (/^体育-/.test(group) || !file) continue
    const name = line.slice(line.lastIndexOf(',') + 1).trim()
    items.push({ origin: 'migu', name, url: fileToUrl.get(file) || '', file: path.join(dataDir, 'logo-cache', file) })
  }
  return items
}

async function refresh(dataDir, { update = false } = {}) {
  const index = loadIndex()
  const items = await collectFromData(dataDir)
  if (!items.length) throw new Error(`${dataDir} 里没有一轮完整更新的结果（extractor-cache.json / interface.txt）`)
  const stats = { added: 0, updated: 0, same: 0, failed: [], noLogo: 0, replacedManual: [] }
  const seen = new Map()
  for (const item of items) {
    if (item.ref) index.refs[item.ref] = item.name
    if (!item.url && !item.file) { stats.noLogo++; continue }
    // 同名的已经由另一个来源收过（咪咕和央视频的 CCTV1综合）：一个名字一张图，先到先得
    const first = seen.get(item.name)
    if (first) continue
    const existing = index.logos[item.name]
    if (!update && existing && existing.origin !== 'manual') {
      seen.set(item.name, item.origin)
      stats.same++
      continue
    }
    try {
      const buf = item.file ? readFileSync(item.file) : await download(item.url)
      const before = index.logos[item.name]
      if (before?.origin === 'manual') stats.replacedManual.push(item.name)
      const result = await putLogo(index, item.name, buf, { origin: item.origin, source: item.url || '' })
      stats[result]++
      seen.set(item.name, item.origin)
    } catch (e) {
      stats.failed.push(`${item.name}（${item.origin}）：${e.message}`)
    }
  }
  saveIndex(index)
  console.log(`内置台标：新增 ${stats.added}，更新 ${stats.updated}，未变 ${stats.same}；模块里没给台标的频道 ${stats.noLogo} 个`)
  if (stats.replacedManual.length) console.log(`官方图替换了手工图：${stats.replacedManual.join('、')}`)
  if (stats.failed.length) console.log(`取不到的：\n  ${stats.failed.join('\n  ')}`)
}

async function addManual(index, name, src, { source, kind, note, trim, bg }) {
  if (index.logos[name] && index.logos[name].origin !== 'manual') {
    return `跳过 ${name}：已有官方来源（${index.logos[name].origin}）的图`
  }
  const buf = await readSource(src)
  const result = await putLogo(index, name, buf, { origin: 'manual', source, kind: kind || 'official', ...(note ? { note } : {}) }, { trim, bg })
  return `${result === 'same' ? '未变' : result === 'added' ? '新增' : '更新'} ${name}`
}

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) { args[key] = next; i++ } else args[key] = true
    } else args._.push(a)
  }
  return args
}

async function main() {
  mkdirSync(PACK_DIR, { recursive: true })
  const args = parseArgs(process.argv.slice(2))
  try {
    if (args.add) {
      const index = loadIndex()
      if (!args._[0] || !args.source) throw new Error('用法：--add <台标名> <图片文件或地址> --source <出处> [--kind official|platform|library]')
      console.log(await addManual(index, args.add, args._[0], { source: args.source, kind: args.kind, trim: args.trim === true, bg: args.bg }))
      saveIndex(index)
    } else if (args.import) {
      const index = loadIndex()
      const sources = JSON.parse(readFileSync(path.join(args.import, 'sources.json'), 'utf-8'))
      const files = readdirSync(args.import)
      for (const [name, info] of Object.entries(sources)) {
        if (!info?.url) continue
        const file = info.file || files.find(f => f.slice(0, f.lastIndexOf('.')) === name && f !== 'sources.json')
        if (!file) { console.log(`缺文件：${name}`); continue }
        try {
          console.log(await addManual(index, name, path.join(args.import, file), {
            source: info.page || info.url, kind: info.kind, note: info.note, trim: info.trim === true, bg: info.bg,
          }))
        } catch (e) {
          console.log(`失败 ${name}：${e.message}`)
        }
      }
      saveIndex(index)
    } else if (args.remove) {
      const index = loadIndex()
      const entry = index.logos[args.remove]
      if (!entry) throw new Error(`没有 ${args.remove}`)
      unlinkSync(path.join(PACK_DIR, entry.file))
      delete index.logos[args.remove]
      saveIndex(index)
      console.log(`已删除 ${args.remove}`)
    } else {
      const dataDir = args.data || process.env.mdataDir || process.cwd()
      await refresh(path.resolve(dataDir), { update: args.update === true })
    }
  } finally {
    await browser?.close()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => {
    console.error(e.message)
    process.exit(1)
  })
}
