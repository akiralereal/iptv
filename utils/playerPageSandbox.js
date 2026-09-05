/**
 * 播放器页沙箱解析：不起浏览器，把直播页（及其播放器 iframe）的脚本放进 node:vm 里按顺序跑一遍，
 * 收集脚本交给播放器 / 写进 DOM 的 m3u8 地址。
 *
 * 为什么要有这一层：纬来体育所在的 jrs 系入口页 → 跨域播放器 iframe（cloud.yumixiu768.com）→ 页内
 * jsjiami 混淆脚本把 URL 参数 `id` 解密成 m3u8 → 交给 xgplayer 播放。地址本身是静态的（expire / sign
 * 多日不变），解密只是几十毫秒的纯 JS，根本不需要一个真的浏览器；而 NAS 上的无头 Chromium 又慢又占
 * 内存，镜像里 Alpine 版 Chromium 还会被该脚本的 debugProtection（递归到栈溢出）直接崩掉渲染进程
 * （用户容器日志：frame 10 秒不响应脚本执行；根因与兜底见 browserLauncher.platformArgs）。这里几秒钟、
 * 几 MB 内存就把地址算出来；算不出来（页面结构不认识、脚本依赖联网）再退回 webSourceExtractor 起浏览器。
 *
 * 通用性：只认「脚本把地址交给了谁」这一类信号——new Player({url}) / hls.loadSource(url) / video.src =
 * / document.write(...) / innerHTML / 顶层 var 里的 m3u8 字符串，播放器桩见 playerPageSandboxWorker.js。
 * 跨域外链脚本（播放器库、统计）一律不下载：它们只负责播，不会产生地址。
 *
 * 安全：脚本在独立 worker 线程的 vm 里跑，拿不到宿主对象；同步死循环 3 秒截断，吃内存由 worker 的
 * resourceLimits 兜住，整页有总预算。详见 worker 文件头。
 */
import { Worker } from 'node:worker_threads'
import { printBlue, printYellow } from './colorOut.js'

export const SANDBOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const FETCH_TIMEOUT_MS = 10 * 1000
const MAX_HTML_BYTES = 2 * 1024 * 1024
const MAX_SCRIPT_BYTES = 1024 * 1024
const MAX_EXTERNAL_SCRIPTS = 8        // 每个页面最多下载的同源外链脚本数
const MAX_WRITE_ROUNDS = 2            // document.write 又写出 <script src> 时再跑的轮数
const MAX_IFRAMES = 3                 // 入口页里最多跟进的 iframe 数
const PAGE_BUDGET_MS = 25 * 1000      // 单个页面（下载 + 沙箱执行）的总预算
const WORKER_RESOURCE_LIMITS = { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 }

const RUNNABLE_SCRIPT_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript', 'module'])

/** 页面里的 <script>，按文档顺序：外链给 src，内联给 code；模板 / JSON 等非脚本类型跳过 */
export function extractScriptTags(html) {
  const out = []
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
  let m
  while ((m = re.exec(html))) {
    const attrs = m[1] || ''
    const type = (attrs.match(/\btype\s*=\s*["']?([^"'\s>]*)/i)?.[1] || '').trim().toLowerCase()
    if (!RUNNABLE_SCRIPT_TYPES.has(type)) continue
    const src = attrs.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
    const srcVal = src ? (src[1] ?? src[2] ?? src[3] ?? '').trim() : ''
    if (srcVal) out.push({ src: srcVal })
    else if (m[2].trim()) out.push({ code: m[2] })
  }
  return out
}

/** 页面里 <iframe src>（按出现顺序，去重、去空、去 about:blank / javascript:） */
export function extractIframeSrcs(html) {
  const out = []
  const re = /<iframe\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi
  let m
  while ((m = re.exec(html))) {
    const v = (m[1] ?? m[2] ?? m[3] ?? '').trim()
    if (!v || /^(about:|javascript:|data:)/i.test(v) || out.includes(v)) continue
    out.push(v)
  }
  return out
}

/** 给沙箱的 location 对象（纯数据，worker 里再补方法） */
export function pageLocation(url) {
  const u = new URL(url)
  return { href: u.href, protocol: u.protocol, host: u.host, hostname: u.hostname, port: u.port, pathname: u.pathname, search: u.search, hash: u.hash, origin: u.origin }
}

const hostOf = (url) => { try { return new URL(url).host } catch { return url } }

async function fetchText(url, { referer, maxBytes = MAX_HTML_BYTES, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const headers = { 'User-Agent': SANDBOX_UA, Accept: '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }
  if (referer) headers.Referer = referer
  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new Error(`HTTP ${res.status}`) }
  const len = Number(res.headers.get('content-length') || 0)
  if (len > maxBytes) { await res.body?.cancel().catch(() => {}); throw new Error(`响应过大 (${len} 字节)`) }
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > maxBytes) throw new Error(`响应过大 (${buf.length} 字节)`)
  return { text: buf.toString('utf8'), url: res.url || url }
}

/**
 * 一个 worker 一个页面。请求 / 应答串行；worker 出错（内存超限等）或退出时把挂着的请求全部拒绝。
 */
class SandboxSession {
  constructor(page, ua = SANDBOX_UA) {
    this.worker = new Worker(new URL('./playerPageSandboxWorker.js', import.meta.url), { resourceLimits: WORKER_RESOURCE_LIMITS })
    this.pending = null
    this.dead = null
    this.worker.on('message', msg => {
      const p = this.pending
      this.pending = null
      if (!p) return
      if (msg.type === 'error') p.reject(new Error(msg.error))
      else p.resolve(msg)
    })
    const die = (err) => {
      this.dead = this.dead || err
      const p = this.pending
      this.pending = null
      p?.reject(err)
    }
    this.worker.on('error', err => die(err?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? new Error('沙箱内存超限被终止（页面脚本疑似恶意占内存）') : (err instanceof Error ? err : new Error(String(err)))))
    this.worker.on('exit', code => die(new Error(`沙箱线程已退出 (${code})`)))
    this.readyP = this.request({ type: 'init', page, ua })
  }

  request(msg) {
    if (this.dead) return Promise.reject(this.dead)
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject }
      this.worker.postMessage(msg)
    })
  }

  ready() { return this.readyP }
  run(scripts) { return this.request({ type: 'run', scripts }) }
  finish() { return this.request({ type: 'finish' }) }
  close() { return this.worker.terminate().catch(() => {}) }
}

const dedupe = (arr) => [...new Set(arr)]

/**
 * 解析一个页面：下载 HTML 与同源脚本，在沙箱里跑，收集 m3u8。
 * @param {string} pageUrl
 * @param {object} [options]
 * @param {string} [options.referer]
 * @param {string} [options.html] 已经拿到的页面内容（省一次下载）
 * @returns {Promise<{links: string[], iframes: string[], ran: number, errors: number, skipped: number, ms: number, failed: {name: string, error: string}[], error?: string}>}
 */
export async function decodeM3u8FromPage(pageUrl, { referer, html } = {}) {
  const started = Date.now()
  const summary = { links: [], iframes: [], ran: 0, errors: 0, skipped: 0, ms: 0, failed: [] }
  const budgetLeft = () => PAGE_BUDGET_MS - (Date.now() - started)
  const withBudget = (p) => {
    const left = budgetLeft()
    if (left <= 0) return Promise.reject(new Error('超出页面预算'))
    let timer
    return Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('超出页面预算')), left) })]).finally(() => clearTimeout(timer))
  }

  let session = null
  try {
    if (html == null) ({ text: html, url: pageUrl } = await withBudget(fetchText(pageUrl, { referer })))
    summary.iframes = extractIframeSrcs(html)
    const origin = new URL(pageUrl).origin
    const fetched = new Set()
    let externalCount = 0

    // 按文档顺序把脚本拼成列表：同源外链下载（并发），跨域跳过
    const materialize = async (tags, labelPrefix) => {
      const slots = tags.map((t, i) => {
        if (t.code != null) return { name: `${labelPrefix}inline#${i + 1}`, code: t.code }
        let abs
        try { abs = new URL(t.src, pageUrl).href } catch { return null }
        if (new URL(abs).origin !== origin) { summary.skipped++; return null }
        if (fetched.has(abs) || externalCount >= MAX_EXTERNAL_SCRIPTS) return null
        fetched.add(abs)
        externalCount++
        return { name: abs, fetch: true }
      }).filter(Boolean)
      await Promise.all(slots.filter(s => s.fetch).map(async s => {
        try {
          s.code = (await withBudget(fetchText(s.name, { referer: pageUrl, maxBytes: MAX_SCRIPT_BYTES }))).text
        } catch (err) {
          s.code = null
          s.error = err.message
        }
      }))
      return slots
    }

    session = new SandboxSession(pageLocation(pageUrl))
    await withBudget(session.ready())

    const collect = (r) => {
      summary.links = dedupe([...summary.links, ...(r.found || [])])
      for (const x of (r.ran || [])) { summary.ran++; if (x.error) { summary.errors++; summary.failed.push({ name: x.name, error: x.error }) } }
      return r.written || []
    }

    let scripts = await materialize(extractScriptTags(html), '')
    let written = collect(await withBudget(session.run(scripts.filter(s => s.code != null).map(({ name, code }) => ({ name, code })))))
    // document.write / appendChild(script) 又写出同源脚本：再跑，最多 MAX_WRITE_ROUNDS 轮
    for (let round = 1; round <= MAX_WRITE_ROUNDS && written.length; round++) {
      const more = (await materialize(extractScriptTags(written.join('\n')).filter(t => t.src), `write#${round}-`)).filter(s => s.code != null)
      if (!more.length) break
      written = collect(await withBudget(session.run(more.map(({ name, code }) => ({ name, code })))))
    }
    collect(await withBudget(session.finish()))
  } catch (err) {
    summary.error = err.message
  } finally {
    await session?.close()
    summary.ms = Date.now() - started
  }
  return summary
}

/**
 * 从直播页拿 m3u8：先解析入口页本身，没有再跟进它嵌的 iframe（播放器常在跨域 iframe 里）。
 * 不抛错：任何环节失败都只返回空数组并打一行日志，由调用方决定是否退回浏览器嗅探。
 * @param {string} entryUrl
 * @returns {Promise<string[]>}
 */
export async function decodeM3u8FromWeb(entryUrl) {
  printBlue(`沙箱解析: ${entryUrl}`)
  const describe = (url, r) => {
    const parts = [`跑了 ${r.ran} 段脚本`]
    if (r.errors) parts.push(`${r.errors} 段报错（${r.failed.slice(0, 2).map(f => `${f.name.replace(/^https?:\/\/[^/]+/, '')}: ${f.error}`).join('；')}）`)
    if (r.skipped) parts.push(`跳过 ${r.skipped} 个跨域脚本`)
    parts.push(`${r.ms}ms`)
    const line = `  沙箱 ${hostOf(url)}: ${parts.join('，')}，找到 ${r.links.length} 条${r.error ? `；中止: ${r.error}` : ''}`
    if (r.links.length) printBlue(line); else printYellow(line)
  }
  let entry
  try {
    entry = await decodeM3u8FromPage(entryUrl)
  } catch (err) {
    printYellow(`  沙箱 ${hostOf(entryUrl)} 异常: ${err.message}`)
    return []
  }
  describe(entryUrl, entry)
  if (entry.links.length) return entry.links

  for (const src of entry.iframes.slice(0, MAX_IFRAMES)) {
    let iframeUrl
    try { iframeUrl = new URL(src, entryUrl).href } catch { continue }
    if (!/^https?:/i.test(iframeUrl)) continue
    const r = await decodeM3u8FromPage(iframeUrl, { referer: entryUrl })
    describe(iframeUrl, r)
    if (r.links.length) return r.links
  }
  return []
}
