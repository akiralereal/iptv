// 台标本机托管：把播放列表要用的台标下载到数据目录 logo-cache/，校验确是图片后由本机 /logo-cache/ 提供。
//
// 为什么：公共台标库走 gcore.jsdelivr，大陆 12 个探针只有 5 个取得到；模块给的官方图也会失效
// （河南 13 张全 404），而源自带台标的优先级高于台标库，坏图反倒挡住了库里的好图。托管后播放器只找本机，
// 下载由服务端在更新时做：可以重试、走系统代理，取不到或不是图片就换下一个候选。
//
// 优先级不变：本地上传 > 源自带（模块官方 / 咪咕 / m3u）> 台标库（默认不配，用户自己设）。本文件只管后两级「能不能用」：
// 候选按顺序取第一个已托管的；还没下载过或网络出错的沿用原地址（与托管前一样）；确认坏掉的跳过，
// 全都坏了就留空让播放器出占位图。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { dataPath } from './paths.js'
import { writeJsonFileSync } from './fileUtil.js'
import { proxyAwareFetch } from './systemProxy.js'
import { printGreen, printYellow } from './colorOut.js'

const CACHE_DIR = dataPath('logo-cache')
const INDEX_PATH = dataPath('logo-cache/index.json')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
// 已托管的一周重取一次，换了图能跟上；重取失败继续用旧图
const REFRESH_MS = 7 * DAY
// 确认坏掉（404、不是图片）的一天后再试，免得每轮都去敲一遍
const RETRY_DEAD_MS = DAY
// 连续一个月没被播放列表用到的删掉
const PRUNE_MS = 30 * DAY
const MAX_BYTES = 2 * 1024 * 1024
const MIN_BYTES = 64
const CONCURRENCY = 8
const TIMEOUT_MS = 8000
// 一轮更新里下载台标最多花这么久，剩下的下一轮接着下；首次部署约 700 张，通常一两分钟内下完
const BUDGET_MS = 90 * 1000
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' }

let index = null

function loadIndex() {
  if (index) return index
  try {
    const parsed = JSON.parse(readFileSync(INDEX_PATH, 'utf-8'))
    index = parsed && typeof parsed.entries === 'object' && parsed.entries ? parsed : { entries: {} }
  } catch {
    index = { entries: {} }
  }
  return index
}

function saveIndex() {
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    writeJsonFileSync(INDEX_PATH, loadIndex())
  } catch (e) {
    printYellow(`台标托管索引保存失败: ${e.message}`)
  }
}

/** 按文件头认图片格式，认不出返回 null。只收播放器普遍认的几种。 */
export function detectImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < MIN_BYTES) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg'
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif'
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  const head = buf.subarray(0, 512).toString('utf8').trimStart()
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) return 'svg'
  return null
}

/** 只托管公网上的 http(s) 图片：局域网、本机地址一律不代取（订阅里的台标地址是第三方写的）。 */
export function hostableUrl(raw) {
  let url
  try {
    url = new URL(String(raw || ''))
  } catch {
    return false
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number)
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return false
  }
  if (isIP(host) === 6 && (host === '::1' || /^f[cd]/.test(host) || host.startsWith('fe80'))) return false
  return true
}

// 有的官方图床（腾讯云 CDN 的 TypeA 鉴权，内蒙古、吉林就是）每次下发的地址都带新签的
// sign=<10 位时间戳>-<随机串>-<uid>-<32 位 md5>，图还是那张。按去掉签名的地址记账：不然模块每刷新
// 一次就当新图重下一遍、旧图要堆一个月才清；重取时用这一轮拿到的新签名地址去取。
const TYPE_A_SIGN = /^\d{10}-[0-9a-z]+-\d+-[0-9a-f]{32}$/i

/** 索引里记账用的地址：去掉 CDN 每次重签的鉴权参数，其它原样。 */
export function logoCacheKey(raw) {
  const value = String(raw || '')
  if (!value.includes('sign=')) return value
  try {
    const url = new URL(value)
    if (!TYPE_A_SIGN.test(url.searchParams.get('sign') || '')) return value
    url.searchParams.delete('sign')
    return url.href
  } catch {
    return value
  }
}

const fileNameFor = (key, ext) => `${createHash('sha1').update(key).digest('hex').slice(0, 20)}.${ext}`

/** 这一轮需要下载的：没下过、已托管但该重取了、坏掉的到了重试时间、上次网络出错。 */
function needsFetch(entry, now) {
  if (!entry) return true
  if (entry.status === 'ok') return now - (entry.fetchedAt || 0) >= REFRESH_MS || !existsSync(dataPath(`logo-cache/${entry.file}`))
  if (entry.status === 'dead') return now - (entry.checkedAt || 0) >= RETRY_DEAD_MS
  return true
}

async function download(url, { fetchImpl, timeoutMs }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/png,image/*,*/*;q=0.8' },
    })
    // 4xx 是地址坏了；5xx 当网络问题，下一轮再试
    if (response.status >= 400 && response.status < 500) {
      await response.body?.cancel?.().catch(() => {})
      return { status: 'dead', reason: `HTTP ${response.status}` }
    }
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {})
      return { status: 'error', reason: `HTTP ${response.status}` }
    }
    if (Number(response.headers?.get?.('content-length') || 0) > MAX_BYTES) {
      await response.body?.cancel?.().catch(() => {})
      return { status: 'dead', reason: '图片过大' }
    }
    const buf = Buffer.from(await response.arrayBuffer())
    if (buf.length > MAX_BYTES) return { status: 'dead', reason: '图片过大' }
    const ext = detectImage(buf)
    if (!ext) return { status: 'dead', reason: '不是图片' }
    return { status: 'ok', buf, ext }
  } catch (error) {
    return { status: 'error', reason: error?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : (error?.message || String(error)) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 更新前把要用到的台标下载好。并发下载、有总时长上限，超时没轮到的下一轮接着下。
 * 已托管的重取失败时保留旧图。
 */
export async function prefetchLogos(urls, {
  now = Date.now(),
  fetchImpl = proxyAwareFetch,
  timeoutMs = TIMEOUT_MS,
  budgetMs = BUDGET_MS,
} = {}) {
  const entries = loadIndex().entries
  // 记账地址相同的（同一张图、签名不同）一轮只取一次，用先出现的地址
  const byKey = new Map()
  for (const url of urls) {
    if (!hostableUrl(url)) continue
    const key = logoCacheKey(url)
    if (!byKey.has(key) && needsFetch(entries[key], now)) byKey.set(key, url)
  }
  const queue = [...byKey]
  if (!queue.length) return { fetched: 0, dead: 0, errors: 0, pending: 0 }
  mkdirSync(CACHE_DIR, { recursive: true })

  const deadline = Date.now() + budgetMs
  let next = 0
  const stats = { fetched: 0, dead: 0, errors: 0 }
  async function worker() {
    while (next < queue.length && Date.now() < deadline) {
      const [key, url] = queue[next++]
      const previous = entries[key]
      const result = await download(url, { fetchImpl, timeoutMs })
      if (result.status === 'ok') {
        const file = fileNameFor(key, result.ext)
        writeFileSync(dataPath(`logo-cache/${file}`), result.buf)
        if (previous?.file && previous.file !== file) {
          try { unlinkSync(dataPath(`logo-cache/${previous.file}`)) } catch { /* 已不在 */ }
        }
        entries[key] = { ...previous, status: 'ok', file, fetchedAt: now, checkedAt: now, reason: undefined }
        stats.fetched++
      } else if (previous?.status === 'ok' && existsSync(dataPath(`logo-cache/${previous.file}`))) {
        // 重取失败：旧图还能用，先不动，下一轮再试
        entries[key] = { ...previous, checkedAt: now, lastError: result.reason }
        stats.errors++
      } else {
        entries[key] = { ...previous, status: result.status, checkedAt: now, reason: result.reason }
        if (result.status === 'dead') stats.dead++
        else stats.errors++
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker))
  const pending = queue.length - next
  saveIndex()
  const parts = [`新取 ${stats.fetched} 张`]
  if (stats.dead) parts.push(`${stats.dead} 张地址已失效或不是图片（会换用下一个来源）`)
  if (stats.errors) parts.push(`${stats.errors} 张这轮没取到（下一轮再试，先用原地址）`)
  if (pending) parts.push(`${pending} 张没来得及，下一轮接着下`)
  ;(stats.dead || stats.errors || pending ? printYellow : printGreen)(`台标托管：${parts.join('，')}`)
  return { ...stats, pending }
}

/**
 * 从候选里挑这个频道写进订阅的台标地址。
 *
 * @param {{url: string, from: 'source'|'auto'}[]} candidates 按优先级排好的候选
 * @returns {string} 已托管的写本机地址；都没托管上时沿用第一个不确定坏掉的原地址；全坏了返回空串
 */
export function hostedLogoUrl(candidates, { now = Date.now() } = {}) {
  const entries = loadIndex().entries
  let fallback = ''
  for (const { url, from } of candidates) {
    if (!url) continue
    // 不归托管管的地址（相对地址、局域网地址）照原样用
    if (!hostableUrl(url)) return url
    const entry = entries[logoCacheKey(url)]
    if (entry?.status === 'ok' && existsSync(dataPath(`logo-cache/${entry.file}`))) {
      entry.usedAt = now
      return `\${replace}/logo-cache/${entry.file}?v=${Math.floor(entry.fetchedAt || 0)}&from=${from}`
    }
    if (entry?.status !== 'dead' && !fallback) fallback = url
  }
  return fallback
}

/** 一轮更新收尾：记下用过的，清掉一个月没用到的图，保存索引。 */
export function finishLogoCache({ now = Date.now() } = {}) {
  const entries = loadIndex().entries
  const keep = new Set()
  for (const [url, entry] of Object.entries(entries)) {
    const lastSeen = Math.max(entry.usedAt || 0, entry.checkedAt || 0, entry.fetchedAt || 0)
    if (now - lastSeen >= PRUNE_MS) {
      delete entries[url]
      continue
    }
    if (entry.file) keep.add(entry.file)
  }
  try {
    for (const name of readdirSync(CACHE_DIR)) {
      if (name === 'index.json' || keep.has(name)) continue
      unlinkSync(dataPath(`logo-cache/${name}`))
    }
  } catch { /* 目录还没建 */ }
  saveIndex()
}

/** /logo-cache/ 路由用：文件名合法才给路径与 MIME，否则 null。 */
export function cachedLogoFile(name) {
  const match = /^([0-9a-f]{20})\.(png|jpg|gif|webp|svg)$/.exec(String(name || ''))
  if (!match) return null
  return { path: dataPath(`logo-cache/${name}`), mime: MIME[match[2]] }
}

/** 测试用：丢掉内存里的索引，下次从磁盘重读。 */
export function resetLogoCacheForTest() {
  index = null
}

