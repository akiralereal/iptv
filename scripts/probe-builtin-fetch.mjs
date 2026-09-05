#!/usr/bin/env node
/**
 * 内置抓取源（纬来体育等）单独排查脚本：不启动整个项目，只对一个源、一个入口跑一遍完整链路，
 * 每一步都给出可读的诊断，方便在「内网直连」和「科学上网」两种网络下对比。
 *
 *   node scripts/probe-builtin-fetch.mjs                      # 默认源 vl-sports，只试主地址
 *   node scripts/probe-builtin-fetch.mjs --url https://www.jrs33.com/wlty.html   # 指定入口
 *   node scripts/probe-builtin-fetch.mjs --all                # 所有入口都做 HTTP 探测，浏览器只抓第一个能打开的
 *   node scripts/probe-builtin-fetch.mjs --no-browser         # 只做 DNS/HTTP 探测 + 沙箱解析，不起 Chromium
 *   node scripts/probe-builtin-fetch.mjs --no-sandbox         # 跳过沙箱解析阶段
 *   node scripts/probe-builtin-fetch.mjs --module             # 浏览器阶段改用项目的 extractM3u8FromWeb 原样跑
 *   node scripts/probe-builtin-fetch.mjs --config /path/built-in-sources.json
 *
 * 做的事（按顺序，每步只发最少的请求，避免触发站点风控）：
 *   A. 环境：Node / 代理环境变量 / 将要使用的浏览器
 *   B. 入口页：DNS（系统解析 vs 阿里 DNS，对比是否被污染）→ GET 页面 → 解析出播放器 iframe 与
 *      外链脚本的域名 → 逐个 DNS + GET 探测（这一步不开浏览器就能定位是哪一环不通）
 *   B2. 沙箱解析：与项目相同的 decodeM3u8FromWeb——把入口页 / 播放器 iframe 的脚本放进 node:vm 跑，
 *      不起浏览器就把页内解密出来的 m3u8 拿到手（项目里这一步成功就不会再起 Chromium）
 *   C. 浏览器：与项目相同的启动器 / 拦截规则 / UA，导航用与项目相同的 networkidle2 + 15s；
 *      导航超时时**不丢弃**已嗅探到的 m3u8，并列出超时那一刻还挂着的请求（内网常见的卡点）
 *   D. m3u8：解析域名（系统 vs 阿里 DNS）、带 Referer 校验（与项目 validateM3u8 相同）
 *
 * 不会碰真实数据目录：mdataDir 指向临时目录，远程配置拉取关闭。
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import dns from 'node:dns'
import { performance } from 'node:perf_hooks'

process.env.mdataDir = mkdtempSync(join(tmpdir(), 'iptv-probe-'))
process.env.mbuiltInSourcesUrl = ''

const { launchBrowser, closeBrowser, findSystemChrome } = await import('../utils/browserLauncher.js')
const { extractM3u8FromWeb, validateM3u8, shouldBlockRequest, restoreLegacyEntities } = await import('../utils/webSourceExtractor.js')
const { decodeM3u8FromWeb } = await import('../utils/playerPageSandbox.js')
const { getWebUrlCandidates } = await import('../utils/builtInSources.js')

// ---------- 参数 ----------
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const VALUE_FLAGS = new Set(['--url', '--config'])
let sourceId = 'vl-sports'
for (let i = 0; i < argv.length; i++) {
  if (VALUE_FLAGS.has(argv[i])) { i++; continue }
  if (!argv[i].startsWith('--')) { sourceId = argv[i]; break }
}
const configPath = opt('--config') || `${process.cwd()}/built-in-sources.json`
const onlyUrl = opt('--url')
const probeAll = flag('--all')
const noBrowser = flag('--no-browser')
const noSandbox = flag('--no-sandbox')
const useModule = flag('--module')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const HTTP_TIMEOUT_MS = 10000
const NAV_TIMEOUT_MS = 15000   // 与 webSourceExtractor.js 的 timeout 默认值一致

// ---------- 小工具 ----------
const ms = (t) => `${Math.round(t)}ms`
const hostOf = (u) => { try { return new URL(u).host } catch { return u } }
const line = (s = '') => console.log(s)
const ok = (s) => line(`  ✅ ${s}`)
const bad = (s) => line(`  ❌ ${s}`)
const warn = (s) => line(`  ⚠️  ${s}`)
const info = (s) => line(`  ·  ${s}`)

const aliResolver = new dns.promises.Resolver({ timeout: 3000, tries: 1 })
aliResolver.setServers(['223.5.5.5'])

/** 系统解析 + 阿里 DNS 各解一次；两边不一致（尤其解到 Facebook/Twitter 段）多半是被污染 */
async function probeDns(host) {
  const sys = await dns.promises.lookup(host, { all: true }).then(r => r.map(x => x.address)).catch(e => [`ERR ${e.code || e.message}`])
  const ali = await aliResolver.resolve4(host).catch(e => [`ERR ${e.code || e.message}`])
  const fakeIp = sys.some(ip => ip.startsWith('198.18.'))
  const mismatch = !fakeIp && !sys[0]?.startsWith('ERR') && !ali[0]?.startsWith('ERR') && !sys.some(ip => ali.includes(ip))
  return { host, sys, ali, fakeIp, mismatch }
}

function printDns({ host, sys, ali, fakeIp, mismatch }) {
  const tag = fakeIp ? '（198.18.x 是本机代理的 fake-ip，说明这台机器在走代理，不代表内网结果）' : mismatch ? '（系统解析与阿里 DNS 不一致，疑似污染/分流）' : ''
  const fn = sys[0]?.startsWith('ERR') ? bad : mismatch ? warn : ok
  fn(`DNS ${host} → 系统: ${sys.join(',')} | 阿里: ${ali.join(',')} ${tag}`)
}

/** 直连 GET（Node 原生 fetch 不读代理环境变量，跑在哪台机器就是哪台机器的真实网络） */
async function probeHttp(url, { referer, range } = {}) {
  const headers = { 'User-Agent': UA, 'Accept': '*/*' }
  if (referer) { headers.Referer = referer; try { headers.Origin = new URL(referer).origin } catch {} }
  if (range) headers.Range = range
  const t0 = performance.now()
  try {
    const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
    const text = await res.text()
    // CDN 的拒绝原因头：如 jrs 系用的字节 CDN 对海外 IP 会回 "deny by area access rule"
    const why = ['x-exception-info', 'cf-mitigated', 'x-cache'].map(k => res.headers.get(k)).filter(Boolean).join('; ')
    return { ok: res.ok, status: res.status, elapsed: performance.now() - t0, contentType: res.headers.get('content-type') || '', text, finalUrl: res.url, server: res.headers.get('server') || '', why }
  } catch (e) {
    const error = e.name === 'TimeoutError' ? 'TIMEOUT' : (e.cause?.code || e.cause?.message || e.message)
    return { ok: false, status: 0, elapsed: performance.now() - t0, error, text: '' }
  }
}

function printHttp(label, r) {
  if (r.ok) ok(`${label} HTTP ${r.status} ${ms(r.elapsed)} ${r.text.length}B${r.finalUrl && r.finalUrl !== label ? ` → ${r.finalUrl}` : ''}`)
  else bad(`${label} ${r.status ? `HTTP ${r.status}` : r.error} ${ms(r.elapsed)}${r.server ? ` server=${r.server}` : ''}${r.why ? ` (${r.why})` : ''}`)
}

/** 从 HTML 里抠出 iframe 地址与外链资源（脚本/样式），只取绝对地址或 // 开头的 */
function parseAssets(html, baseUrl) {
  const abs = (u) => { try { return new URL(u, baseUrl).href } catch { return null } }
  const iframes = [...html.matchAll(/<iframe[^>]*\ssrc=["']([^"']+)["']/gi)].map(m => abs(m[1])).filter(Boolean)
  const assets = [...html.matchAll(/<(?:script|link)[^>]*\s(?:src|href)=["']([^"']+)["']/gi)]
    .map(m => abs(m[1])).filter(u => u && /^https?:/.test(u))
  return { iframes: [...new Set(iframes)], assets: [...new Set(assets)] }
}

// ---------- A. 环境 ----------
line(`\n=== A. 环境 ===`)
info(`Node ${process.version} / ${process.platform} ${process.arch}`)
const proxyEnv = Object.entries(process.env).filter(([k]) => /^(https?_proxy|all_proxy|no_proxy)$/i.test(k))
if (proxyEnv.length) warn(`代理环境变量: ${proxyEnv.map(([k, v]) => `${k}=${v}`).join(' ')}（Chromium 在 Linux 上会读 http_proxy；内网排查请确认这台机器没设代理）`)
else info(`未设置代理环境变量`)
const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.mchromePath || findSystemChrome() || '(puppeteer 自带)'
info(`浏览器: ${chromePath}`)

// ---------- 读源配置 ----------
const config = JSON.parse(readFileSync(configPath, 'utf-8'))
const source = (config.sources || []).find(s => s.id === sourceId)
if (!source) { bad(`配置 ${configPath} 里没有 id=${sourceId} 的源`); process.exit(2) }
const candidates = onlyUrl ? [onlyUrl] : getWebUrlCandidates(source)
line(`\n源: ${source.name} (${source.id})  入口 ${candidates.length} 个${probeAll || onlyUrl ? '' : '，默认只试第一个（--all 试全部）'}`)
const entries = probeAll || onlyUrl ? candidates : candidates.slice(0, 1)

// ---------- B. 入口页 + 依赖域名 ----------
line(`\n=== B. 入口页与依赖（不开浏览器）===`)
let chosen = null            // 第一个能打开的入口
const seenAssetHosts = new Set()
const entrySummary = []
for (const entry of entries) {
  line(`\n[入口] ${entry}`)
  const d = await probeDns(hostOf(entry))
  printDns(d)
  const page = await probeHttp(entry)
  printHttp(entry, page)
  entrySummary.push(`${page.ok ? '✅' : '❌'} ${hostOf(entry)}  ${page.ok ? `HTTP ${page.status}` : (page.status ? `HTTP ${page.status}${page.why ? ` ${page.why}` : ''}` : page.error)} ${ms(page.elapsed)}${d.mismatch ? '  DNS 疑似污染' : ''}`)
  if (!page.ok) continue
  if (!chosen) chosen = entry

  const { iframes, assets } = parseAssets(page.text, entry)
  const deps = [...iframes, ...assets].filter(u => hostOf(u) !== hostOf(entry))
  if (deps.length === 0) { info(`页面没有外链依赖（或播放器在同域）`) }
  for (const dep of deps) {
    const h = hostOf(dep)
    const isIframe = iframes.includes(dep)
    if (!isIframe && seenAssetHosts.has(h)) continue   // 同域脚本探一个就够
    seenAssetHosts.add(h)
    printDns(await probeDns(h))
    const r = await probeHttp(dep, { referer: entry, range: isIframe ? undefined : 'bytes=0-0' })
    printHttp(`${isIframe ? '播放器 iframe' : '外链'} ${dep.slice(0, 120)}`, r)
    if (isIframe && r.ok) {
      // 播放器页自己还会拉播放器脚本（如 xgplayer），再探一层
      const inner = parseAssets(r.text, dep)
      for (const a of inner.assets.filter(u => hostOf(u) !== h)) {
        const ah = hostOf(a)
        if (seenAssetHosts.has(ah)) continue
        seenAssetHosts.add(ah)
        printDns(await probeDns(ah))
        printHttp(`播放器依赖 ${a}`, await probeHttp(a, { referer: dep, range: 'bytes=0-0' }))
      }
      const hinted = r.text.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/g)
      if (hinted) info(`播放器页明文里出现 m3u8: ${[...new Set(hinted)].join(' ')}`)
      else info(`播放器页里没有明文 m3u8（地址在页内 JS 解密后才请求，必须靠浏览器嗅探）`)
    }
  }
}

if (entrySummary.length > 1) {
  line(`\n入口汇总（这台机器的网络视角）:`)
  entrySummary.forEach(s => line(`  ${s}`))
}
if (!chosen) {
  line(`\n结论：所有入口页都打不开，问题在入口站本身（DNS / 网络不通 / 被墙），换入口或走代理。`)
  process.exit(1)
}

// ---------- B2. 沙箱解析（项目里每个入口都先走这一步，成功就不起浏览器） ----------
let links = []
if (noSandbox) {
  line(`\n=== B2. 已跳过沙箱解析（--no-sandbox）===`)
} else {
  line(`\n=== B2. 沙箱解析（项目 decodeM3u8FromWeb 原样，不起浏览器）: ${chosen} ===`)
  const t0 = performance.now()
  const sandboxLinks = await decodeM3u8FromWeb(chosen)
  info(`耗时 ${ms(performance.now() - t0)}，返回 ${sandboxLinks.length} 条`)
  for (const u of sandboxLinks) {
    const valid = await validateM3u8(u, { referer: chosen })
    ;(valid ? ok : warn)(`${valid ? '校验通过' : '校验未通过'}: ${u}`)
  }
  if (sandboxLinks.length) {
    info(`项目里到这一步（校验通过）就直接用了；下面的浏览器阶段只是对照`)
    links = sandboxLinks
  } else {
    warn(`沙箱没解出地址：页面结构不认识或脚本依赖联网，项目里会退回浏览器嗅探`)
  }
}

// ---------- C. 浏览器嗅探 ----------
if (noBrowser) {
  line(`\n=== C. 已跳过浏览器（--no-browser）===`)
} else if (useModule) {
  line(`\n=== C. 浏览器嗅探（项目 extractM3u8FromWeb 原样）: ${chosen} ===`)
  const t0 = performance.now()
  const r = await extractM3u8FromWeb(chosen, { ...(source.extractOptions || {}), returnAll: true })
  links = Array.isArray(r) ? r : r ? [r] : []
  info(`耗时 ${ms(performance.now() - t0)}，返回 ${links.length} 条`)
} else {
  line(`\n=== C. 浏览器嗅探（诊断模式，与项目同启动器/同拦截/同 UA）: ${chosen} ===`)
  const waitTime = source.extractOptions?.waitTime ?? 5000
  const headless = source.extractOptions?.headless ?? true
  let browser = null
  const sniffed = []
  const pending = new Map()   // url → { start, type }
  const hostFirstByte = new Map()
  const t0 = performance.now()
  let tNav = t0
  try {
    browser = await launchBrowser({ headless, label: '探测', waitMs: 60 * 1000 })
    info(`浏览器启动 ${ms(performance.now() - t0)}`)
    const page = await browser.newPage()
    const seen = []             // 所有放行的请求：{ url, type, status | failure }
    await page.setRequestInterception(true)
    page.on('request', req => {
      if (shouldBlockRequest(req)) { req.abort().catch(() => {}); return }
      const rec = { url: req.url(), type: req.resourceType(), status: null }
      seen.push(rec)
      pending.set(req.url(), { start: performance.now(), type: req.resourceType(), rec })
      req.continue().catch(() => {})
    })
    const done = req => pending.delete(req.url())
    page.on('requestfinished', done)
    page.on('requestfailed', req => {
      const p = pending.get(req.url())
      if (p) {
        p.rec.status = req.failure()?.errorText || 'FAILED'
        info(`请求失败 [${p.type}] ${req.failure()?.errorText || ''} ${ms(performance.now() - p.start)} ${req.url().slice(0, 140)}`)
      }
      done(req)
    })
    page.on('response', res => {
      const u = res.url()
      const h = hostOf(u)
      const p = pending.get(u)
      if (p) p.rec.status = res.status()
      if (!hostFirstByte.has(h)) hostFirstByte.set(h, performance.now() - tNav)
      if (u.includes('.m3u8')) { sniffed.push(u); ok(`嗅探到 m3u8 (${ms(performance.now() - tNav)}) HTTP ${res.status()} ${u}`) }
    })
    // 页面里的报错最能说明「播放器为什么没起来」（解密失败 / MSE 不支持 / 脚本被拦）
    page.on('pageerror', e => warn(`页面异常: ${String(e.message || e).split('\n')[0].slice(0, 200)}`))
    page.on('console', m => { if (['error', 'warning'].includes(m.type())) info(`console.${m.type()}: ${m.text().slice(0, 200)}`) })
    await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }) })
    await page.setUserAgent(UA)

    tNav = performance.now()
    let navTimedOut = false
    try {
      await page.goto(chosen, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS })
      ok(`导航完成(networkidle2) ${ms(performance.now() - tNav)}`)
    } catch (e) {
      navTimedOut = /timeout/i.test(e.message)
      bad(`导航 ${navTimedOut ? '超时' : '失败'}: ${e.message.split('\n')[0]}`)
      if (navTimedOut) {
        warn(`旧版抓取器在这一步会直接返回 null，丢掉已嗅探到的 ${sniffed.length} 条 m3u8；当前版本嗅到即走、超时也继续用它们`)
        const still = [...pending.entries()].sort((a, b) => a[1].start - b[1].start)
        info(`超时时仍挂着 ${still.length} 个请求：`)
        for (const [u, p] of still.slice(0, 15)) info(`    ${hostOf(u)} [${p.type}] 已等 ${ms(performance.now() - p.start)}  ${u.slice(0, 100)}`)
      }
    }
    if (hostFirstByte.size) info(`各域名首个响应时刻: ${[...hostFirstByte.entries()].map(([h, t]) => `${h}=${ms(t)}`).join('  ')}`)

    await new Promise(r => setTimeout(r, 2000 + waitTime))
    if (sniffed.length === 0) {
      const triggered = await page.evaluate(() => {
        const selectors = ['.vjs-big-play-button', '.jw-display-icon-display', '.dplayer-play-icon', '[class*="btn-play"]', '[class*="play-btn"]', '[class*="play_btn"]']
        for (const s of selectors) { const el = document.querySelector(s); if (el) { el.click(); return s } }
        const v = document.querySelector('video')
        if (v) { v.muted = true; const p = v.play(); if (p && p.catch) p.catch(() => {}); return 'video.play()' }
        return null
      }).catch(() => null)
      if (triggered) { info(`尝试触发播放: ${triggered}`); await new Promise(r => setTimeout(r, 4000)) }
    }
    const inPage = await page.evaluate(() => {
      const v = []
      document.querySelectorAll('video').forEach(x => { if (x.src && x.src.includes('.m3u8')) v.push(x.src) })
      return { v, t: document.body.innerText.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/g) || [] }
    }).catch(() => ({ v: [], t: [] }))
    // 每个 frame（含跨域播放器 iframe）里的播放器状态：video 有没有、src 是什么、播放器全局对象在不在
    for (const f of page.frames()) {
      if (!f.url() || f.url() === 'about:blank') continue
      const st = await f.evaluate(() => {
        const videos = [...document.querySelectorAll('video')].map(v => ({
          src: (v.currentSrc || v.src || '').slice(0, 120), readyState: v.readyState, paused: v.paused, err: v.error?.code ?? null
        }))
        const globals = ['Player', 'HlsPlayer', 'Hls', 'videojs', 'DPlayer', 'jwplayer', 'originalUrl', 'm3u8Url']
          .filter(k => { try { return typeof window[k] !== 'undefined' } catch { return false } })
        let hint = ''
        try { if (typeof originalUrl !== 'undefined') hint = String(originalUrl).slice(0, 160) } catch {}
        return { videos, globals, hint, scripts: document.scripts.length }
      }).catch(e => ({ error: e.message.split('\n')[0] }))
      info(`frame ${hostOf(f.url())}: ${st.error ? `evaluate 失败 ${st.error}` : `video×${st.videos.length} ${JSON.stringify(st.videos)} 全局:[${st.globals.join(',')}] scripts:${st.scripts}${st.hint ? ` 解密出的地址: ${st.hint}` : ''}`}`)
    }
    // 放行过的请求清单（按域名汇总），看播放器到底有没有去拉流
    const byHost = {}
    for (const r of seen) { (byHost[hostOf(r.url)] ||= []).push(r) }
    info(`请求汇总（放行 ${seen.length} 个）:`)
    for (const [h, rs] of Object.entries(byHost)) {
      const failed = rs.filter(r => typeof r.status === 'string').length
      info(`    ${h}: ${rs.length} 个${failed ? `（失败 ${failed}）` : ''}  ${[...new Set(rs.map(r => r.type))].join('/')}`)
    }
    const streamy = seen.filter(r => /m3u8|hls|live|stream|\.ts\b|flv/i.test(r.url) && !/jrs\d*\.com\/wlty|\.js\b|\.css\b/i.test(r.url))
    if (streamy.length) { info(`疑似拉流请求:`); for (const r of streamy.slice(0, 10)) info(`    [${r.type}] ${r.status ?? '?'} ${r.url.slice(0, 140)}`) }
    links = [...new Set([...sniffed, ...inPage.v, ...inPage.t.map(restoreLegacyEntities)])]
    info(`总耗时 ${ms(performance.now() - t0)}，得到 ${links.length} 条 m3u8`)
  } catch (e) {
    bad(`浏览器阶段异常: ${e.message}`)
  } finally {
    await closeBrowser(browser, { label: '探测浏览器', timeoutMs: 10000 })
  }
}

// ---------- D. m3u8 校验 ----------
if (!noBrowser) {
  line(`\n=== D. m3u8 校验 ===`)
  if (links.length === 0) {
    bad(`没有拿到任何 m3u8。若 B 阶段全绿、C 阶段导航超时且超时前也没嗅到，问题在播放器那一跳（看上面挂着的请求是哪个域名）；B 阶段就红则是入口站不通`)
  }
  for (const l of links) {
    line(`\n[m3u8] ${l}`)
    printDns(await probeDns(hostOf(l)))
    const r = await probeHttp(l, { referer: chosen, range: 'bytes=0-2048' })
    printHttp('GET', r)
    if (r.text) info(`Content-Type: ${r.contentType || '(无)'}  首行: ${r.text.split('\n')[0].slice(0, 80)}`)
    const valid = await validateM3u8(l, { referer: chosen })
    ;(valid ? ok : bad)(`validateM3u8(带 Referer) → ${valid}`)
    const noRef = await validateM3u8(l)
    info(`validateM3u8(不带 Referer) → ${noRef}${valid && !noRef ? '（播放器不带 Referer 会被拒，需走项目的代理层）' : ''}`)
  }
}
line('')
