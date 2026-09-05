import { launchBrowser, closeBrowser } from "./browserLauncher.js"
import { printBlue, printGreen, printRed, printYellow } from "./colorOut.js"

// 只嗅探地址、不看画面：视频分片 / 图片 / 字体一律不下载。此前页面会真的把直播
// 播上几十秒，分片不停落盘缓存，是「硬盘不停读写」的来源之一；开启请求拦截后
// Chromium 也会关掉页面缓存。分片按扩展名识别（.m3u8 本身永远放行）。
const SEGMENT_EXT_RE = /\.(?:ts|m4s|mp4|aac|m4a|flv|webm|mp3|mpd)$/i
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'font', 'media'])

function shouldBlockRequest(request) {
  const url = request.url()
  if (url.includes('.m3u8')) return false
  if (BLOCKED_RESOURCE_TYPES.has(request.resourceType())) return true
  try {
    return SEGMENT_EXT_RE.test(new URL(url).pathname)
  } catch {
    return false
  }
}

// U+00A0–U+00FF 每个字符对应的 HTML 遗留命名实体名（按码点顺序排列）。整段 Latin-1
// 补充区恰好都是「不带分号也会被解码」的旧式实体：Chromium 解析网页文本时会把
// "&timestamp=" 里的 "&times" 解成 ×、"&notin=" 里的 "&not" 解成 ¬ 等，导致从
// innerText 提取的 m3u8 地址被写坏（issue #84 同源问题）。合法 URL 里不会出现这些
// 未编码的原始字符，故提取结果中凡命中此区间的字符都可安全还原回 "&实体名"。
const LEGACY_ENTITY_NAMES = [
  'nbsp', 'iexcl', 'cent', 'pound', 'curren', 'yen', 'brvbar', 'sect',
  'uml', 'copy', 'ordf', 'laquo', 'not', 'shy', 'reg', 'macr',
  'deg', 'plusmn', 'sup2', 'sup3', 'acute', 'micro', 'para', 'middot',
  'cedil', 'sup1', 'ordm', 'raquo', 'frac14', 'frac12', 'frac34', 'iquest',
  'Agrave', 'Aacute', 'Acirc', 'Atilde', 'Auml', 'Aring', 'AElig', 'Ccedil',
  'Egrave', 'Eacute', 'Ecirc', 'Euml', 'Igrave', 'Iacute', 'Icirc', 'Iuml',
  'ETH', 'Ntilde', 'Ograve', 'Oacute', 'Ocirc', 'Otilde', 'Ouml', 'times',
  'Oslash', 'Ugrave', 'Uacute', 'Ucirc', 'Uuml', 'Yacute', 'THORN', 'szlig',
  'agrave', 'aacute', 'acirc', 'atilde', 'auml', 'aring', 'aelig', 'ccedil',
  'egrave', 'eacute', 'ecirc', 'euml', 'igrave', 'iacute', 'icirc', 'iuml',
  'eth', 'ntilde', 'ograve', 'oacute', 'ocirc', 'otilde', 'ouml', 'divide',
  'oslash', 'ugrave', 'uacute', 'ucirc', 'uuml', 'yacute', 'thorn', 'yuml',
]

/**
 * 还原从 innerText 提取的地址里被浏览器误解码的旧式命名实体（见上）。整段
 * U+00A0–U+00FF 都按码点还原回 "&实体名"。纯字符串处理，放在 Node 侧便于单测。
 */
function restoreLegacyEntities(url) {
  return url.replace(/[ -ÿ]/g, ch => '&' + LEGACY_ENTITY_NAMES[ch.charCodeAt(0) - 0xA0])
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// 嗅探轮询间隔，以及嗅到第一条后再多收一会儿同批链接的时间（master / media 清单往往前后脚到）
const SNIFF_POLL_MS = 200
const SNIFF_GRACE_MS = 1000

// 主文档连一个字节都没回来就等这么久即放弃：域名被污染 / 连接不通时 TCP 会一直挂到导航超时，
// 国内访问被污染的 jrkan.com 就是每轮白等 30 秒；正常入口页的首个响应都在几秒内
const NO_RESPONSE_GIVE_UP_MS = 10 * 1000

// 单次在 frame 里执行脚本的上限。渲染进程被阻塞（脚本死循环 / 同步请求卡住 / 进程假死）时
// CDP 命令没有回应，puppeteer 要等到 protocolTimeout（默认 180 秒）才报错，而兜底「触发播放」
// 与页内找链接各执行一次——实测 NAS 上一个入口就此耗掉 6 分钟，错误还被静默吞掉。
// 超时的 frame 记下来，后续步骤不再碰它
const EVALUATE_TIMEOUT_MS = 10 * 1000
const EVALUATE_TIMED_OUT = Symbol('evaluate-timed-out')

/** puppeteer 的导航超时（页面一直没到 networkidle2）；其它导航错误（DNS / 连接被拒）另论 */
function isNavigationTimeout(err) {
  return err?.name === 'TimeoutError' || /Navigation timeout/i.test(err?.message || '')
}

// 常见播放器的播放按钮；都没有就直接对 video 静音起播
const PLAY_SELECTORS = ['.vjs-big-play-button', '.jw-display-icon-display', '.dplayer-play-icon', '[class*="btn-play"]', '[class*="play-btn"]', '[class*="play_btn"]']

function frameLabel(frame) {
  try { return new URL(frame.url()).host } catch { return frame.url() }
}

/** 页面里所有已加载的 frame（主页面在前）；about:blank 之类的空 frame 跳过 */
function liveFrames(page) {
  return page.frames().filter(f => /^https?:/i.test(f.url()))
}

/**
 * frame.evaluate 加上限：超时按「没结果」处理，并把 frame 记进 stuckFrames 让后续步骤跳过。
 * 超时后底层 CDP 调用仍挂着，等浏览器关闭时一并了结；其拒绝在这里已接住，不会变成 unhandledRejection。
 */
async function evaluateWithTimeout(frame, fn, arg, stuckFrames) {
  let timer
  const timeoutP = new Promise(resolve => { timer = setTimeout(() => resolve(EVALUATE_TIMED_OUT), EVALUATE_TIMEOUT_MS) })
  try {
    const result = await Promise.race([frame.evaluate(fn, arg).catch(() => null), timeoutP])
    if (result === EVALUATE_TIMED_OUT) {
      stuckFrames.add(frame)
      return null
    }
    return result
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 把「还没结束的请求」按域名汇总成一行，供导航超时时打日志：哪个域名挂着几个、最久挂了多久、
 * 有没有收到过响应。内网抓不到时这一行就是答案（多半是某个跨境域名一直不回），不必再进容器跑探测脚本。
 * @param {Iterable<[string, {start:number, type?:string, responded?:boolean}]>} pending url → 记录
 */
function describePendingRequests(pending, now = Date.now(), maxHosts = 6) {
  const byHost = new Map()
  for (const [url, rec] of pending) {
    let host
    try { host = new URL(url).host } catch { host = url }
    const agg = byHost.get(host) || { count: 0, types: new Set(), maxWaitMs: 0, responded: false }
    agg.count++
    agg.types.add(rec.type || '?')
    agg.maxWaitMs = Math.max(agg.maxWaitMs, now - rec.start)
    agg.responded = agg.responded || !!rec.responded
    byHost.set(host, agg)
  }
  return [...byHost.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, maxHosts)
    .map(([host, a]) => `${host}×${a.count}(${[...a.types].join('/')}${a.responded ? '' : ',无响应'},${Math.round(a.maxWaitMs / 1000)}s)`)
    .join(' ')
}

/**
 * 兜底触发播放：多数直播页要一次「播放」动作才开始拉流。播放器经常在跨域 iframe 里
 * （如纬来体育所在的 jrs 系页面），只查主页面等于没查，所以逐个 frame 试。
 * @returns {Promise<string|null>} 触发了什么（选择器 / video.play()），没找到返回 null
 */
async function triggerPlayback(page, stuckFrames = new Set()) {
  for (const frame of liveFrames(page)) {
    if (stuckFrames.has(frame)) continue
    const hit = await evaluateWithTimeout(frame, (selectors) => {
      for (const s of selectors) {
        const el = document.querySelector(s)
        if (el) { el.click(); return s }
      }
      const v = document.querySelector('video')
      if (v) {
        v.muted = true
        const p = v.play()
        if (p && p.catch) p.catch(() => {})
        return 'video.play()'
      }
      return null
    }, PLAY_SELECTORS, stuckFrames)
    if (hit) return frame === page.mainFrame() ? hit : `${hit} @ ${frameLabel(frame)}`
  }
  return null
}

/**
 * 从页面（含所有 frame）的 video.src 与可见文本里找 m3u8 地址。URL 里不可能出现原始的
 * "<>\"'" 字符，用它们作为边界，避免把地址后面的引号 / 标签一起吞进来。
 */
async function collectPageLinks(page, stuckFrames = new Set()) {
  const links = []
  for (const frame of liveFrames(page)) {
    if (stuckFrames.has(frame)) continue
    const found = await evaluateWithTimeout(frame, () => {
      const videoSrcLinks = []
      // video.src 是解析后的 URL 属性，不受 HTML 文本实体解码影响，直接采用
      document.querySelectorAll('video').forEach(video => {
        if (video.src && video.src.includes('.m3u8')) videoSrcLinks.push(video.src)
      })
      const m3u8Regex = /https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/g
      const textLinks = (document.body ? document.body.innerText : '').match(m3u8Regex) || []
      return { videoSrcLinks, textLinks }
    }, undefined, stuckFrames)
    if (!found) continue
    // innerText 是解析后文本，裸写的 "&timestamp=" 会被误解码成 "×tamp="，需在 Node 侧还原（issue #84）
    links.push(...found.videoSrcLinks, ...found.textLinks.map(restoreLegacyEntities))
  }
  return links
}

/**
 * 从网页中提取 m3u8 直播链接
 *
 * 只要嗅探到 m3u8 就尽快收工，不陪页面把所有资源都加载完：
 *   - 导航（networkidle2）与嗅探赛跑，多数直播页在页面「空闲」之前早就请求了清单；
 *   - 导航超时不算失败——内网访问这类页面时常有某个跨境资源一直挂着，页面永远到不了
 *     networkidle2，但清单早在几秒内就到手了。此前这里直接返回 null，把已嗅到的链接一并丢掉，
 *     正是「科学上网能抓、内网经常抓不到」的主因之一；
 *   - 页面一个响应都没有（站点不通 / 域名被污染）则尽快放弃，把时间留给下一个入口。
 *
 * @param {string} url - 网页地址
 * @param {object} options - 配置选项
 * @param {string} options.playButtonSelector - 播放按钮选择器
 * @param {number} options.waitTime - 页面加载后等待 m3u8 的最长时间（毫秒），嗅到即走
 * @param {boolean} options.headless - 是否无头模式
 * @param {number} options.timeout - 页面导航超时（毫秒）
 * @param {boolean} options.returnAll - 是否返回全部链接
 * @returns {Promise<string|string[]|null>} m3u8 链接（returnAll 时为数组），没有则 null
 */
async function extractM3u8FromWeb(url, options = {}) {
  const {
    playButtonSelector = null, // 播放按钮选择器，如：'.play-btn', '#play-button'
    waitTime = 5000,           // 等待 m3u8 的上限
    headless = true,           // 无头模式
    // 页面导航（到 networkidle2）的上限。只是上限：嗅到 m3u8 就立刻退出，健康的直播页 4~5 秒
    // 就会请求清单；等满只发生在页面卡死 / 某个资源一直挂着的时候，所以不必沿用 puppeteer
    // 默认的 30 秒。超时后仍会再嗅探几秒并兜底触发播放，不是到点就判失败
    timeout = 15000,
    returnAll = false          // 是否返回全部链接
  } = options

  let browser = null

  try {
    printBlue(`开始提取: ${url}`)

    // 启动浏览器：全进程共用的启动器，受实例数上限约束（见 browserLauncher.js）
    browser = await launchBrowser({ headless, label: '网页抓取', waitMs: 2 * 60 * 1000 })

    const page = await browser.newPage()

    // 拦掉分片 / 图片 / 字体：见 shouldBlockRequest。放行的请求记下来，导航超时时能报出是谁挂着
    const pending = new Map()   // url → { start, type, responded }
    await page.setRequestInterception(true)
    page.on('request', request => {
      if (shouldBlockRequest(request)) { request.abort().catch(() => {}); return }
      pending.set(request.url(), { start: Date.now(), type: request.resourceType(), responded: false })
      request.continue().catch(() => {})
    })
    page.on('requestfinished', request => pending.delete(request.url()))
    page.on('requestfailed', request => pending.delete(request.url()))

    // 隐藏 webdriver 指纹 + 使用完整版 Chrome UA：navigator.webdriver=true 和
    // 裸 UA（没有 Chrome/xx 版本号）是站点识别无头爬虫的两大特征，命中后有的站直接白屏（vtvgo.vn 实测）
    await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }) })
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')

    // alert / confirm 会挂起渲染进程主线程：不关掉的话页面停在那里，后面的脚本不跑、CDP 命令也没有回应
    page.on('dialog', dialog => {
      printYellow(`页面弹出 ${dialog.type()} 对话框，已自动关闭: ${String(dialog.message() || '').slice(0, 100)}`)
      dialog.dismiss().catch(() => {})
    })

    // 监听网络请求，捕获 m3u8 链接
    const m3u8Links = []
    let responded = false   // 页面收到过任何响应吗？一个都没有 = 站点根本不通，不必再等
    page.on('response', (response) => {
      responded = true
      const responseUrl = response.url()
      const rec = pending.get(responseUrl)
      if (rec) rec.responded = true
      if (responseUrl.includes('.m3u8') && !m3u8Links.includes(responseUrl)) {
        m3u8Links.push(responseUrl)
        printGreen(`发现 m3u8: ${responseUrl}`)
      }
    })
    const sniffed = () => m3u8Links.length > 0
    const waitForM3u8 = async (maxMs) => {
      const deadline = Date.now() + maxMs
      while (!sniffed() && Date.now() < deadline) await sleep(SNIFF_POLL_MS)
      return sniffed()
    }

    // 访问页面：导航与嗅探赛跑，嗅到就不再等页面空闲
    printBlue(`访问页面: ${url}`)
    let navError = null
    let navSettled = false
    page.goto(url, { waitUntil: 'networkidle2', timeout })
      .then(() => {}, err => { navError = err })
      .finally(() => { navSettled = true })
    const navStart = Date.now()
    while (!navSettled && !sniffed()) {
      if (!responded && Date.now() - navStart >= NO_RESPONSE_GIVE_UP_MS) {
        printRed(`${NO_RESPONSE_GIVE_UP_MS / 1000} 秒内没有收到任何响应（域名被污染 / 连接不通），放弃`)
        return null
      }
      await sleep(SNIFF_POLL_MS)
    }

    if (!navSettled) {
      printBlue(`页面尚未加载完就已嗅到 m3u8，不再等待页面空闲`)
    } else if (navError && !sniffed()) {
      if (!isNavigationTimeout(navError)) {
        printRed(`页面打不开: ${navError.message}`)
        return null
      }
      if (!responded) {
        printRed(`页面加载超时（${timeout}ms）且没有收到任何响应，放弃`)
        return null
      }
      printYellow(`页面加载超时（${timeout}ms），继续在已加载的内容里嗅探`)
      if (pending.size) printYellow(`  超时时仍挂着 ${pending.size} 个请求: ${describePendingRequests(pending)}`)
    }

    // 等待页面加载（最多 2 秒，嗅到即走）
    if (!sniffed()) {
      printBlue(`等待页面加载...`)
      await waitForM3u8(2000)
    }

    // 如果指定了播放按钮，则点击
    if (playButtonSelector) {
      try {
        printBlue(`查找播放按钮: ${playButtonSelector}`)
        await page.waitForSelector(playButtonSelector, { timeout: 10000 })
        await page.click(playButtonSelector)
        printGreen(`播放按钮已点击`)
      } catch (error) {
        printRed(`播放按钮点击失败: ${error.message}`)
      }
    }

    // 等待 m3u8 链接出现（最多 waitTime，嗅到即走）
    if (!sniffed()) {
      printBlue(`等待 m3u8 链接...`)
      await waitForM3u8(waitTime)
    }

    // 仍没嗅探到：未配置播放按钮选择器时，兜底在各个 frame 里试常见播放器的播放按钮 / 对 video 静音起播
    const stuckFrames = new Set()   // 脚本执行超时的 frame（渲染进程被阻塞），见 evaluateWithTimeout
    if (!sniffed() && !playButtonSelector) {
      const triggered = await triggerPlayback(page, stuckFrames)
      if (triggered) {
        printBlue(`尝试触发播放: ${triggered}`)
        await waitForM3u8(4000)
      }
    }

    // 嗅到了：再给一点时间把同批的其它清单收进来
    if (sniffed()) await sleep(SNIFF_GRACE_MS)

    // 也从页面（含所有 frame）的 video.src / 文本里找
    const pageM3u8Links = await collectPageLinks(page, stuckFrames)

    // 合并所有找到的链接
    const allLinks = [...new Set([...m3u8Links, ...pageM3u8Links])]

    if (allLinks.length > 0) {
      printGreen(`提取成功! 找到 ${allLinks.length} 个链接:`)
      allLinks.forEach((link, index) => {
        printGreen(`${index + 1}: ${link}`)
      })
      return returnAll ? allLinks : allLinks[0]
    } else {
      printRed(`未找到 m3u8 链接`)
      if (stuckFrames.size) {
        printYellow(`  ${stuckFrames.size} 个 frame 在 ${EVALUATE_TIMEOUT_MS / 1000} 秒内不响应脚本执行（渲染进程被阻塞）: ${[...stuckFrames].map(frameLabel).join(', ')}`)
      }
      if (pending.size && navSettled && !navError) {
        // 导航正常结束却没等到 m3u8：把此刻还挂着的请求也报出来（导航超时的情况上面已经报过）
        printYellow(`  结束时仍挂着 ${pending.size} 个请求: ${describePendingRequests(pending)}`)
      }
      return null
    }

  } catch (error) {
    printRed(`提取失败: ${error.message}`)
    return null
  } finally {
    await closeBrowser(browser, { label: '网页抓取浏览器', timeoutMs: 10000 })
  }
}

/**
 * 批量提取多个网页的 m3u8 链接
 * @param {Array} sources - 源配置数组
 * @returns {Promise<Array>} 提取结果
 */
async function batchExtractM3u8(sources) {
  const results = []
  
  for (const source of sources) {
    const result = await extractM3u8FromWeb(source.url, source.options)
    results.push({
      name: source.name,
      url: source.url,
      m3u8: result,
      success: !!result
    })
  }
  
  return results
}

/**
 * 验证 m3u8 链接是否有效
 * @param {string} m3u8Url - m3u8 链接
 * @returns {Promise<boolean>} 是否有效
 */
async function validateM3u8(m3u8Url, options = {}) {
  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/vnd.apple.mpegurl, application/x-mpegURL, application/octet-stream, */*',
      'Range': 'bytes=0-2048'
    }

    if (options.referer) {
      headers.Referer = options.referer
      try {
        headers.Origin = new URL(options.referer).origin
      } catch (error) {
        // Ignore invalid referer
      }
    }

    const response = await fetch(m3u8Url, { headers })
    if (!response.ok) {
      return false
    }

    const contentType = response.headers.get('content-type') || ''
    const normalizedType = contentType.toLowerCase()
    if (
      normalizedType.includes('mpegurl') ||
      normalizedType.includes('application') ||
      normalizedType.includes('octet-stream') ||
      normalizedType.includes('text/plain')
    ) {
      return true
    }

    const body = await response.text()
    return body.includes('#EXTM3U')
  } catch (error) {
    return false
  }
}

export {
  extractM3u8FromWeb,
  batchExtractM3u8,
  validateM3u8,
  restoreLegacyEntities,
  isNavigationTimeout,
  shouldBlockRequest,
  describePendingRequests,
  EVALUATE_TIMEOUT_MS,
  NO_RESPONSE_GIVE_UP_MS
}