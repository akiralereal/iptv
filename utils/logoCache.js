// 台标本机托管：把播放列表要用的台标下载到数据目录 logo-cache/，校验确是图片后由本机 /logo-cache/ 提供。
//
// 为什么：公共台标库走 gcore.jsdelivr，大陆 12 个探针只有 5 个取得到；模块给的官方图也会失效
// （河南 13 张全 404），而源自带台标的优先级高于台标库，坏图反倒挡住了库里的好图。托管后播放器只找本机，
// 下载由服务端在更新时做：可以重试、走系统代理，取不到或不是图片就换下一个候选。
//
// 优先级：本地上传 > 源自带（模块官方 / 咪咕 / m3u）> 内置台标（logo-pack）> 台标库（默认不配，用户自己设）。本文件只管后几级「能不能用」：
// 候选按顺序取第一个已托管的；还没下载过或网络出错的沿用原地址（与托管前一样）；确认坏掉的跳过，
// 全都坏了就留空让播放器出占位图。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'
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

// 不声明 webp/avif：带了的话，按 Accept 转码的图床（内蒙古的腾讯云 CDN 就是）会把 PNG 转成 WebP 给，
// 而不少老电视盒子的播放器显示不了 WebP。不声明就拿原图。
const ACCEPT = 'image/png,image/jpeg,image/gif,image/*;q=0.8,*/*;q=0.5'

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
  if (svgRootAfterProlog(buf.subarray(0, 4096).toString('utf8'))) return 'svg'
  return null
}

// 跳过 XML 声明、注释和一个 DOCTYPE 后，根元素是不是 <svg>。Illustrator 导出的 SVG 常带 DOCTYPE 和一段
// [内部声明]；内嵌 SVG 图标的网页不算。逐段 indexOf 往前走，不用带嵌套量词的正则：那种写法遇到几十段
// 注释后面不跟 <svg> 的内容会指数级回溯，一张第三方「台标」就能把整个进程卡死。
function svgRootAfterProlog(text) {
  let rest = text.replace(/^﻿/, '').trimStart()
  if (rest.startsWith('<?xml')) {
    const end = rest.indexOf('?>')
    if (end === -1) return false
    rest = rest.slice(end + 2).trimStart()
  }
  let doctypeSeen = false
  for (;;) {
    if (rest.startsWith('<!--')) {
      const end = rest.indexOf('-->', 4)
      if (end === -1) return false
      rest = rest.slice(end + 3).trimStart()
    } else if (!doctypeSeen && /^<!DOCTYPE/i.test(rest)) {
      const gt = rest.indexOf('>')
      const bracket = rest.indexOf('[')
      let end = gt
      if (bracket !== -1 && (gt === -1 || bracket < gt)) {
        const close = rest.slice(bracket).search(/\]\s*>/)
        end = close === -1 ? -1 : rest.indexOf('>', bracket + close)
      }
      if (end === -1) return false
      rest = rest.slice(end + 1).trimStart()
      doctypeSeen = true
    } else {
      return /^<svg[\s>]/i.test(rest)
    }
  }
}

// 私网 / 本机 / 保留地址。198.18.0.0/15 不算：OpenClash 等 fake-ip 模式的 DNS 把所有域名都解析到这段，
// 挡了的话这类部署一张台标都托管不了。
function isPrivateIPv4(host) {
  const [a, b] = host.split('.').map(Number)
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}

// IPv6 展开成 8 个 16 位整数（支持 :: 缩写与末尾点分 IPv4），解析不了返回 null
function ipv6Words(host) {
  let text = String(host).toLowerCase().replace(/%.*$/, '')
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (dotted) {
    if (isIP(dotted[2]) !== 4) return null
    const [a, b, c, d] = dotted[2].split('.').map(Number)
    text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const parse = part => (part ? part.split(':') : []).map(word => (/^[0-9a-f]{1,4}$/.test(word) ? parseInt(word, 16) : NaN))
  const head = parse(halves[0])
  const tail = halves.length === 2 ? parse(halves[1]) : []
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (fill < 0) return null
  const words = [...head, ...new Array(fill).fill(0), ...tail]
  return words.length === 8 && words.every(Number.isInteger) ? words : null
}

function isPrivateIPv6(host) {
  const w = ipv6Words(host)
  if (!w) return true
  const embedded = `${w[6] >> 8}.${w[6] & 255}.${w[7] >> 8}.${w[7] & 255}`
  if (w.slice(0, 5).every(x => x === 0)) {
    // ::、::1，以及 IPv4 映射（::ffff:a.b.c.d）/ 兼容（::a.b.c.d）地址按里面那个 IPv4 判
    if (w[5] === 0xffff) return isPrivateIPv4(embedded)
    if (w[5] === 0) return (w[6] === 0 && w[7] <= 1) || isPrivateIPv4(embedded)
  }
  if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every(x => x === 0)) return isPrivateIPv4(embedded) // NAT64
  return (w[0] & 0xfe00) === 0xfc00 || (w[0] & 0xffc0) === 0xfe80 || (w[0] & 0xff00) === 0xff00
}

/** 字面 IP 是否落在私网 / 本机 / 保留段；不是 IP 的也按不可托管算。 */
export function isPrivateAddress(address) {
  const family = isIP(String(address || ''))
  if (family === 4) return isPrivateIPv4(address)
  if (family === 6) return isPrivateIPv6(address)
  return true
}

function hostOf(url) {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
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
  const host = hostOf(url)
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false
  if (isIP(host) && isPrivateAddress(host)) return false
  return true
}

const MAX_REDIRECTS = 3

/**
 * 下载台标用的 fetch：只看地址字面不够——域名可以解析到局域网，公网地址也可以 302 到本机。
 * 所以每一跳（含跳转）都先解析域名，任一地址落在私网 / 本机就不取；跳转改为手动跟，逐跳重查。
 * 解析失败按网络问题处理（下一轮再试，先用原地址），和托管前一样由播放器自己去取。
 */
export function createGuardedFetch({
  fetchImpl = proxyAwareFetch,
  lookupImpl = host => dnsLookup(host, { all: true, verbatim: true }),
} = {}) {
  async function assertPublic(raw, signal) {
    if (!hostableUrl(raw)) throw new Error('不是公网地址，不代取')
    const host = hostOf(new URL(raw))
    if (isIP(host)) return
    // 解析本身不吃 fetch 的超时；跟着同一个 signal 放弃，免得一个卡住的 DNS 占着下载协程
    const result = await new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'))
      const onAbort = () => reject(signal.reason ?? new Error('aborted'))
      signal?.addEventListener?.('abort', onAbort, { once: true })
      Promise.resolve(lookupImpl(host)).then(resolve, reject)
        .finally(() => signal?.removeEventListener?.('abort', onAbort))
    })
    const addresses = (Array.isArray(result) ? result : [result]).map(item => item?.address ?? item).filter(Boolean)
    if (!addresses.length || addresses.some(address => isPrivateAddress(String(address)))) {
      throw new Error('域名解析到局域网 / 本机地址，不代取')
    }
  }
  return async function guardedFetch(url, options = {}) {
    let current = String(url)
    for (let hop = 0; ; hop++) {
      await assertPublic(current, options.signal)
      const response = await fetchImpl(current, { ...options, redirect: 'manual' })
      const location = response.status >= 300 && response.status < 400 ? response.headers?.get?.('location') : null
      if (!location) return response
      await response.body?.cancel?.().catch(() => {})
      if (hop >= MAX_REDIRECTS) throw new Error(`跳转超过 ${MAX_REDIRECTS} 次`)
      current = new URL(location, current).href
    }
  }
}

const guardedFetch = createGuardedFetch()

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
      headers: { 'User-Agent': UA, Accept: ACCEPT },
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
  fetchImpl = guardedFetch,
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

