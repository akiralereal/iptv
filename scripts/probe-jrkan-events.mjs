#!/usr/bin/env node
/**
 * jrkan / jrs 系赛事列表探测：看首页上「每场比赛 × 直播①②③」能不能用项目现有的网页抓取链路
 * （utils/playerPageSandbox.js 沙箱解密 → utils/webSourceExtractor.js 校验 / 浏览器兜底）解出可播的 m3u8。
 * 用来判断值不值得做成「赛事直播」模块，以及模块该怎么解析列表；只读，不改配置、不碰数据目录。
 *
 *   node scripts/probe-jrkan-events.mjs                               # 默认 https://www.jrkan.com/，解前 6 个直播入口
 *   node scripts/probe-jrkan-events.mjs --url https://www.jrs03.com/   # 国内镜像（jrkan.com 在国内 DNS 被污染）
 *   node scripts/probe-jrkan-events.mjs --match CBA --limit 9         # 只看行文字含 CBA 的比赛
 *   node scripts/probe-jrkan-events.mjs --entry <某个直播①的地址>       # 跳过首页，直接探一个直播入口
 *   node scripts/probe-jrkan-events.mjs --browser                     # 首页静态 HTML 没列表 / 沙箱解不出时用 Chromium 兜底
 *   node scripts/probe-jrkan-events.mjs --external                    # 站外链接（如绿色「🔗直播①」）也一起探
 *   node scripts/probe-jrkan-events.mjs --dump ./jrkan-dump           # 首页、各入口页、iframe 的 HTML 和汇总 JSON 存盘
 *
 * 步骤：
 *   A. 首页：GET → 还原 index.js 里 document.write 的列表 → 找文字形如「直播①」「信号2」「线路3」的链接，按「两条链接之间有没有别的文字」切成比赛行
 *      （同一场的 直播①②③ 之间只有图标和空白；行文字即 联赛 / 时间 / 状态 / 主队 / 比分 / 客队）
 *   B. 每个直播入口：沙箱跑入口页（不起浏览器）→ 没地址就跟进它嵌的 iframe → 仍没有且带 --browser 时起 Chromium 嗅探
 *   C. 解出的 m3u8 带 Referer 校验（与内置抓取源相同），不过再试不带 Referer；顺带报签名参数里的过期时间
 *   D. 汇总：每场每路的结果、用到的播放器 iframe 与 m3u8 域名
 *
 * 入口之间串行、默认只探 6 个，避免给站点压力。Node 原生 fetch 不读代理环境变量：跑在哪台机器就是哪台机器的真实网络。
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

process.env.mdataDir = mkdtempSync(join(tmpdir(), 'iptv-probe-'))
process.env.mbuiltInSourcesUrl = ''

const { decodeM3u8FromPage, extractIframeSrcs, SANDBOX_UA } = await import('../utils/playerPageSandbox.js')
const { validateM3u8, extractM3u8FromWeb } = await import('../utils/webSourceExtractor.js')

// ---------- 参数 ----------
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const homeUrl = opt('--url') || 'https://www.jrkan.com/'
const entryOnly = opt('--entry')
const matchKw = opt('--match')
const limit = Math.max(1, Number(opt('--limit')) || 6)
const useBrowser = flag('--browser')
const includeExternal = flag('--external')
const dumpDir = opt('--dump') ? resolve(opt('--dump')) : null

const HTTP_TIMEOUT_MS = 15000
const MAX_IFRAMES = 3
const PAUSE_BETWEEN_ENTRIES_MS = 500
// 编号的直播入口：直播① / 直播2 / 信号③ / 线路1 / 高清2 / 源3。导航里的「球界直播」「JRKAN直播」不带编号，不会命中
const LIVE_LINK_RE = /(?:直播|信号|线路|高清|超清|蓝光|源)\s*[①-⑳\d]/

// ---------- 小工具 ----------
const line = (s = '') => console.log(s)
const ok = (s) => line(`  ✅ ${s}`)
const bad = (s) => line(`  ❌ ${s}`)
const warn = (s) => line(`  ⚠️  ${s}`)
const info = (s) => line(`  ·  ${s}`)
const ms = (t) => `${Math.round(t)}ms`
const sleep = (t) => new Promise(r => setTimeout(r, t))
// validateM3u8 自身不设超时，探测脚本里给它兜一个上限，免得某个 CDN 不回包把整轮挂住
const validate = (url, opts) => {
  let timer
  return Promise.race([validateM3u8(url, opts), new Promise(r => { timer = setTimeout(r, HTTP_TIMEOUT_MS, false) })]).finally(() => clearTimeout(timer))
}
const hostOf = (u) => { try { return new URL(u).host } catch { return u } }
const shortUrl = (u, n = 110) => (u.length > n ? `${u.slice(0, n)}…` : u)
const decodeEntities = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')

/** 去标签后的纯文本（脚本 / 样式整段去掉），空白折叠成一个空格 */
function stripTags(html) {
  return decodeEntities(html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

function attrVal(attrs, name) {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
  return m ? decodeEntities((m[1] ?? m[2] ?? m[3] ?? '').trim()) : ''
}

/** 两个主机是否同站（比后两段域名，www.jrkan.com 与 m.jrkan.com 算同站） */
function sameSite(a, b) {
  const tail = (h) => h.replace(/:\d+$/, '').split('.').slice(-2).join('.')
  return tail(a) === tail(b)
}

// 首页 PLAY_HOSTS 里的播放域名：和首页不同站，但它们才是真正的直播入口
const playHosts = new Set()

/**
 * 列表在外链脚本里：首页的 PLAY_HOSTS / getPlayUrl 给出播放域名，index.js 用 document.write 一行行写比赛。
 * 不起浏览器，把这些 document.write 还原成 HTML 拼回去；首页不是这种结构时原样返回。
 */
async function expandListScripts(html, baseUrl) {
  const hosts = {}
  for (const m of html.matchAll(/(\w+)\s*:\s*atob\(\s*["']([A-Za-z0-9+/=]+)["']\s*\)/g)) {
    hosts[m[1]] = Buffer.from(m[2], 'base64').toString().replace(/\/+$/, '')
  }
  const playPath = html.match(/host\s*\+\s*["']([^"']*)["']\s*\+\s*id\s*\+\s*["']([^"']*)["']/)
  if (!Object.keys(hosts).length || !playPath) return html
  Object.values(hosts).forEach(h => playHosts.add(hostOf(h)))
  info(`播放域名: ${Object.entries(hosts).map(([k, v]) => `${k}=${v}`).join('  ')}`)

  const out = []
  for (const m of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']*\/index\.js[^"']*)["']/gi)) {
    const src = new URL(decodeEntities(m[1]), baseUrl).href
    const r = await getPage(src, baseUrl)
    printPage(src, r, src)
    dump('list.js', r.text)
    if (!r.ok) continue
    const written = [...r.text.matchAll(/document\.write\('((?:[^'\\]|\\.)*(?:'\s*\+\s*getPlayUrl\("\w+",\s*"\w+"\)\s*\+\s*'(?:[^'\\]|\\.)*)*)'\);/g)]
      .map(w => w[1]
        .replace(/'\s*\+\s*getPlayUrl\("(\w+)",\s*"(\w+)"\)\s*\+\s*'/g, (_, line, id) => `${hosts[line] || ''}${playPath[1]}${id}${playPath[2]}`)
        .replace(/\\(.)/g, '$1'))
    out.push(...written)
  }
  return out.length ? out.join('\n') : html
}

/**
 * 首页 → 比赛行。不认具体标签 / class（不知道、也不该绑死站点的模板）：按文档顺序找编号直播链接，
 * 和上一条直播链接之间夹着别的文字（队名、时间）就是新的一场，否则是同一场的下一路。
 */
function parseLiveRows(rawHtml, baseUrl) {
  // 脚本 / 样式 / 注释先剔掉：脚本里拼 HTML 的字符串（'<a href="/play/' + id + '">直播①</a>'）不是真链接
  const html = rawHtml.replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ').replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi
  const base = hostOf(baseUrl)
  const rows = []
  let cur = null
  let lastEnd = 0
  let m
  while ((m = re.exec(html))) {
    const text = stripTags(m[2])
    if (!LIVE_LINK_RE.test(text)) continue
    const between = stripTags(html.slice(lastEnd, m.index))
    lastEnd = re.lastIndex
    if (!cur || /[\p{L}\p{N}]{2,}/u.test(between)) {
      cur = { label: between.slice(-120), links: [] }
      rows.push(cur)
    }
    const raw = attrVal(m[1], 'href')
    let href = ''
    try { if (raw && !/^(javascript:|#)/i.test(raw)) href = new URL(raw, baseUrl).href } catch {}
    const onclick = attrVal(m[1], 'onclick')
    const dataAttrs = [...m[1].matchAll(/\b(data-[\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map(d => `${d[1]}=${d[2] ?? d[3]}`)
    cur.links.push({ text, href, raw, external: href ? !sameSite(hostOf(href), base) && !playHosts.has(hostOf(href)) : false, onclick, dataAttrs })
  }
  return rows
}

/** 入口页的线路切换：data-play 里是同站的播放器路径（「=&id2=」这种空线路跳过） */
function dataPlayPaths(html) {
  return [...html.replace(/<!--[\s\S]*?-->/g, ' ').matchAll(/\bdata-play="(\/[^"]+)"/g)].map(m => decodeEntities(m[1]))
}

/** 播放器页把真正的地址拆开放：playerUrlBase64 是前缀，encodedStr 是加密参数，pjs.js 拼成 iframe */
function wrappedPlayerUrl(html) {
  const base = html.match(/playerUrlBase64\s*:\s*"([A-Za-z0-9+/=]+)"/)?.[1]
  const param = html.match(/encodedStr\s*=\s*"([^"]+)"/)?.[1]
  return base && param ? `${Buffer.from(base, 'base64').toString().trim()}${param}` : ''
}

/** 签名参数里的过期时间（expire / expires / wsTime / txTime / e / t 之类的 10 位 Unix 秒） */
function expiryOf(url) {
  try {
    const u = new URL(url)
    for (const [k, v] of u.searchParams) {
      if (!/^(expires?|e|t|wstime|txtime|deadline|auth_expire)$/i.test(k)) continue
      const n = /^\d{10}$/.test(v) ? Number(v) : /^[0-9a-f]{8}$/i.test(v) && /txtime/i.test(k) ? parseInt(v, 16) : NaN
      if (!Number.isFinite(n)) continue
      const hours = (n * 1000 - Date.now()) / 3600e3
      return `${k}=${new Date(n * 1000).toLocaleString('zh-CN', { hour12: false })}（${hours >= 0 ? `${hours.toFixed(1)} 小时后` : `已过期 ${(-hours).toFixed(1)} 小时`}）`
    }
  } catch {}
  return ''
}

async function getPage(url, referer) {
  const headers = { 'User-Agent': SANDBOX_UA, Accept: 'text/html,*/*', 'Accept-Language': 'zh-CN,zh;q=0.9' }
  if (referer) headers.Referer = referer
  const t0 = performance.now()
  try {
    const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
    const text = await res.text()
    const cf = res.headers.get('cf-mitigated') || (/cloudflare/i.test(res.headers.get('server') || '') && /Just a moment|cf-chl|challenge-platform/i.test(text) ? 'challenge' : '')
    return { ok: res.ok, status: res.status, url: res.url || url, text, elapsed: performance.now() - t0, server: res.headers.get('server') || '', cf }
  } catch (e) {
    return { ok: false, status: 0, url, text: '', elapsed: performance.now() - t0, error: e.name === 'TimeoutError' ? 'TIMEOUT' : (e.cause?.code || e.message) }
  }
}

function printPage(label, r, requested = label) {
  const title = r.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || ''
  const tail = `${ms(r.elapsed)} ${r.text.length}B${title ? ` 《${shortUrl(title, 40)}》` : ''}${r.url !== requested ? ` → ${shortUrl(r.url, 90)}` : ''}`
  if (r.cf) bad(`${label} Cloudflare 质询页（${r.cf}）：普通 HTTP 请求被拦，只能起浏览器 ${tail}`)
  else if (r.ok) ok(`${label} HTTP ${r.status} ${tail}`)
  else bad(`${label} ${r.status ? `HTTP ${r.status}` : r.error} ${ms(r.elapsed)}${r.server ? ` server=${r.server}` : ''}`)
}

let dumpSeq = 0
function dump(name, text) {
  if (!dumpDir) return
  mkdirSync(dumpDir, { recursive: true })
  writeFileSync(join(dumpDir, `${String(++dumpSeq).padStart(2, '0')}-${name}`), text)
}

/** 首页渲染（--browser）：静态 HTML 里没列表时，看看是不是 JS 拉数据画出来的，顺便列出 XHR / fetch 请求 */
async function renderHome(url) {
  const { launchBrowser, closeBrowser } = await import('../utils/browserLauncher.js')
  const browser = await launchBrowser({ headless: true, label: '赛事探测', waitMs: 60 * 1000 })
  const xhr = []
  try {
    const page = await browser.newPage()
    await page.setUserAgent(SANDBOX_UA)
    page.on('response', r => {
      const t = r.request().resourceType()
      if (t === 'xhr' || t === 'fetch') xhr.push(`${r.status()} ${r.url()}`)
    })
    page.on('dialog', d => d.dismiss().catch(() => {}))
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 }).catch(e => warn(`首页渲染: ${e.message}（继续用已渲染的内容）`))
    // 页面脚本卡住时 page.content() 不会自己返回，给个上限
    let timer
    const html = await Promise.race([page.content(), new Promise(r => { timer = setTimeout(r, HTTP_TIMEOUT_MS, '') })]).finally(() => clearTimeout(timer))
    if (!html) warn('首页渲染: 读取页面内容超时')
    return { html, xhr }
  } finally {
    await closeBrowser(browser, { label: '赛事探测浏览器', timeoutMs: 10000 })
  }
}

/** 一个直播入口：入口页沙箱 → iframe 沙箱 → （--browser）浏览器嗅探 → 校验 */
async function probeEntry(entryUrl, referer, tag) {
  const result = { entryUrl, iframes: [], links: [], via: '', playable: [], ms: 0 }
  const t0 = performance.now()
  const page = await getPage(entryUrl, referer)
  printPage(entryUrl, page)
  dump(`${tag}-entry.html`, page.text)
  if (!page.ok) { result.ms = performance.now() - t0; result.error = page.cf ? 'cloudflare' : (page.status ? `HTTP ${page.status}` : page.error); return result }

  const r0 = await decodeM3u8FromPage(page.url, { referer, html: page.text })
  info(`入口页沙箱：跑了 ${r0.ran} 段脚本、跳过 ${r0.skipped} 个跨域脚本、${r0.ms}ms，找到 ${r0.links.length} 条${r0.error ? `；中止: ${r0.error}` : ''}`)
  result.links = r0.links
  if (result.links.length) result.via = '入口页沙箱'

  const iframes = [...new Set([...extractIframeSrcs(page.text), ...dataPlayPaths(page.text)])].map(s => { try { return new URL(s, page.url).href } catch { return '' } }).filter(u => /^https?:/i.test(u))
  if (iframes.length) info(`嵌了 ${iframes.length} 个 iframe: ${iframes.slice(0, 4).map(u => shortUrl(u, 90)).join('  ')}`)
  for (const [i, src] of iframes.slice(0, MAX_IFRAMES).entries()) {
    const u = new URL(src)
    result.iframes.push(`${u.host}${u.pathname}`)
    if (result.links.length) continue
    let fr = await getPage(src, page.url)
    printPage(`  iframe ${shortUrl(src, 90)}`, fr, src)
    dump(`${tag}-iframe${i + 1}.html`, fr.text)
    if (!fr.ok) continue
    let frReferer = page.url
    const wrapped = wrappedPlayerUrl(fr.text)
    if (wrapped) {
      frReferer = fr.url
      fr = await getPage(wrapped, frReferer)
      printPage(`  播放器 ${shortUrl(wrapped, 90)}`, fr, wrapped)
      dump(`${tag}-iframe${i + 1}-player.html`, fr.text)
      if (!fr.ok) continue
      result.iframes.push(hostOf(wrapped))
    }
    const r = await decodeM3u8FromPage(fr.url, { referer: frReferer, html: fr.text })
    info(`  iframe 沙箱：跑了 ${r.ran} 段脚本（${r.errors} 段报错）、跳过 ${r.skipped} 个跨域脚本、${r.ms}ms，找到 ${r.links.length} 条${r.error ? `；中止: ${r.error}` : ''}`)
    if (r.failed.length) info(`    报错: ${r.failed.slice(0, 2).map(f => `${f.name.replace(/^https?:\/\/[^/]+/, '')}: ${f.error}`).join('；')}`)
    if (r.links.length) { result.links = r.links; result.via = `iframe 沙箱 (${u.host})` }
  }

  if (!result.links.length && useBrowser) {
    info(`沙箱没解出，起 Chromium 嗅探…`)
    const got = await extractM3u8FromWeb(entryUrl, { returnAll: true })
    result.links = Array.isArray(got) ? got : got ? [got] : []
    if (result.links.length) result.via = '浏览器嗅探'
  }

  for (const link of result.links.slice(0, 4)) {
    const withRef = await validate(link, { referer: entryUrl })
    const noRef = withRef ? false : await validate(link)
    const exp = expiryOf(link)
    const verdict = withRef ? '带 Referer 可取' : noRef ? '不带 Referer 可取' : '校验未通过（未开赛 / 已结束 / 地域限制都会这样）'
    ;(withRef || noRef ? ok : warn)(`${shortUrl(link)}  ${verdict}${exp ? `  ${exp}` : ''}`)
    if (withRef || noRef) result.playable.push(link)
  }
  if (!result.links.length) bad(`没解出 m3u8${useBrowser ? '' : '（可加 --browser 用 Chromium 兜底再试）'}`)
  result.ms = performance.now() - t0
  return result
}

// ---------- 主流程 ----------
const report = { home: homeUrl, at: new Date().toISOString(), rows: [], entries: [] }
let targets = []   // { row, link }

if (entryOnly) {
  targets = [{ row: { label: '(--entry)' }, link: { text: '入口', href: entryOnly } }]
} else {
  line(`\n=== A. 首页 ${homeUrl} ===`)
  const home = await getPage(homeUrl)
  printPage(homeUrl, home)
  dump('home.html', home.text)
  let html = home.ok ? await expandListScripts(home.text, home.url) : ''
  let rows = html ? parseLiveRows(html, home.url) : []
  const mentions = (stripTags(html).match(new RegExp(LIVE_LINK_RE.source, 'g')) || []).length
  info(`静态 HTML：页面文字里出现 ${mentions} 次编号直播字样，解析出 ${rows.length} 场、${rows.reduce((n, r) => n + r.links.length, 0)} 个 <a> 入口`)
  if (mentions > 0 && rows.length === 0) warn(`有「直播①」字样但不是 <a href> 链接：入口可能写在 onclick / data-* 里，见 --dump 的 home.html`)

  if ((rows.length === 0 || !home.ok) && useBrowser) {
    line(`\n--- 用 Chromium 渲染首页 ---`)
    const rendered = await renderHome(homeUrl)
    dump('home.rendered.html', rendered.html)
    rows = parseLiveRows(rendered.html, homeUrl)
    info(`渲染后解析出 ${rows.length} 场`)
    if (rendered.xhr.length) info(`页面发出的 XHR / fetch（列表若由接口下发，数据就在这里）:\n${rendered.xhr.slice(0, 15).map(x => `       ${x}`).join('\n')}`)
  }
  if (rows.length === 0) {
    bad(`首页没解析出比赛行${useBrowser ? '' : '（可加 --browser 渲染后再试，或 --dump 存下 HTML 发回分析）'}`)
  }

  line(`\n--- 比赛行${matchKw ? `（只看含「${matchKw}」的）` : ''} ---`)
  for (const row of rows) {
    if (matchKw && !row.label.includes(matchKw)) continue
    report.rows.push(row)
    line(`  ▸ ${row.label}`)
    for (const l of row.links) {
      const where = !l.href ? `（无 href${l.onclick ? `，onclick=${shortUrl(l.onclick, 60)}` : ''}${l.dataAttrs.length ? `，${l.dataAttrs.join(' ')}` : ''}）` : l.external ? `↗ 站外 ${shortUrl(l.href, 80)}` : shortUrl(l.href, 90)
      line(`      ${l.text.padEnd(5)} ${where}`)
      if (l.href && (includeExternal || !l.external)) targets.push({ row, link: l })
    }
  }
  const seen = new Set()
  targets = targets.filter(t => !seen.has(t.link.href) && seen.add(t.link.href))
  if (targets.length > limit) info(`共 ${targets.length} 个可探的入口，只探前 ${limit} 个（--limit 调整）`)
  targets = targets.slice(0, limit)
}

line(`\n=== B/C. 逐个直播入口：沙箱解密 → m3u8 校验 ===`)
for (const [i, t] of targets.entries()) {
  if (i) await sleep(PAUSE_BETWEEN_ENTRIES_MS)
  line(`\n[${i + 1}/${targets.length}] ${t.row.label.slice(-50)}  ${t.link.text}`)
  const r = await probeEntry(t.link.href, entryOnly ? undefined : homeUrl, `e${i + 1}`)
  report.entries.push({ row: t.row.label, text: t.link.text, ...r })
}

// ---------- D. 汇总 ----------
line(`\n=== D. 汇总 ===`)
const total = report.entries.length
const decoded = report.entries.filter(e => e.links.length).length
const playable = report.entries.filter(e => e.playable.length).length
const tally = (list) => [...list.reduce((m, k) => m.set(k, (m.get(k) || 0) + 1), new Map())].map(([k, n]) => `${k}×${n}`).join('  ') || '(无)'
info(`入口 ${total} 个：解出 m3u8 ${decoded} 个，校验可取 ${playable} 个`)
info(`解出方式: ${tally(report.entries.filter(e => e.via).map(e => e.via))}`)
info(`播放器 iframe: ${tally(report.entries.flatMap(e => e.iframes))}`)
info(`m3u8 域名: ${tally(report.entries.flatMap(e => e.links.map(hostOf)))}`)
const avg = total ? report.entries.reduce((n, e) => n + e.ms, 0) / total : 0
info(`每个入口平均耗时 ${ms(avg)}`)
if (dumpDir) {
  writeFileSync(join(dumpDir, 'summary.json'), JSON.stringify(report, null, 2))
  info(`HTML 与 summary.json 已存到 ${dumpDir}`)
}
