import { launchBrowser, closeBrowser } from "./browserLauncher.js"
import { printBlue, printGreen, printRed } from "./colorOut.js"

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

/**
 * 从网页中提取 m3u8 直播链接
 * @param {string} url - 网页地址
 * @param {object} options - 配置选项
 * @param {string} options.playButtonSelector - 播放按钮选择器
 * @param {number} options.waitTime - 等待时间（毫秒）
 * @param {boolean} options.headless - 是否无头模式
 * @returns {Promise<string>} m3u8 链接
 */
async function extractM3u8FromWeb(url, options = {}) {
  const {
    playButtonSelector = null, // 播放按钮选择器，如：'.play-btn', '#play-button'
    waitTime = 5000,           // 等待时间
    headless = true,           // 无头模式
    timeout = 30000,          // 页面超时
    returnAll = false         // 是否返回全部链接
  } = options

  let browser = null
  
  try {
    printBlue(`开始提取: ${url}`)
    
    // 启动浏览器：全进程共用的启动器，受实例数上限约束（见 browserLauncher.js）
    browser = await launchBrowser({ headless, label: '网页抓取', waitMs: 2 * 60 * 1000 })
    
    const page = await browser.newPage()

    // 拦掉分片 / 图片 / 字体：见 shouldBlockRequest
    await page.setRequestInterception(true)
    page.on('request', request => {
      if (shouldBlockRequest(request)) request.abort().catch(() => {})
      else request.continue().catch(() => {})
    })

    // 隐藏 webdriver 指纹 + 使用完整版 Chrome UA：navigator.webdriver=true 和
    // 裸 UA（没有 Chrome/xx 版本号）是站点识别无头爬虫的两大特征，命中后有的站直接白屏（vtvgo.vn 实测）
    await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }) })
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')
    
    // 监听网络请求，捕获 m3u8 链接
    const m3u8Links = []
    
    page.on('response', async (response) => {
      const url = response.url()
      if (url.includes('.m3u8')) {
        m3u8Links.push(url)
        printGreen(`发现 m3u8: ${url}`)
      }
    })
    
    // 访问页面
    printBlue(`访问页面: ${url}`)
    await page.goto(url, { 
      waitUntil: 'networkidle2',
      timeout 
    })
    
    // 等待页面加载
    printBlue(`等待页面加载...`)
    await new Promise(resolve => setTimeout(resolve, 2000))
    
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
    
    // 等待 m3u8 链接出现
    printBlue(`等待 m3u8 链接...`)
    await new Promise(resolve => setTimeout(resolve, waitTime))

    // 仍没嗅探到 m3u8：多数直播页要一次「播放」动作才开始拉流。未配置播放按钮选择器时，
    // 兜底尝试常见播放器的播放按钮，或直接对 video 元素静音起播，再多等几秒
    if (m3u8Links.length === 0 && !playButtonSelector) {
      const triggered = await page.evaluate(() => {
        const selectors = ['.vjs-big-play-button', '.jw-display-icon-display', '.dplayer-play-icon', '[class*="btn-play"]', '[class*="play-btn"]', '[class*="play_btn"]']
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
      }).catch(() => null)
      if (triggered) {
        printBlue(`尝试触发播放: ${triggered}`)
        await new Promise(resolve => setTimeout(resolve, 4000))
      }
    }

    // 也可以尝试查找页面中的 m3u8 链接。URL 里不可能出现原始的 "<>\"'" 字符，用它们
    // 作为边界，避免把地址后面的引号/标签一起吞进来。
    const { videoSrcLinks, textLinks } = await page.evaluate(() => {
      const videoSrcLinks = []
      // video.src 是解析后的 URL 属性，不受 HTML 文本实体解码影响，直接采用
      document.querySelectorAll('video').forEach(video => {
        if (video.src && video.src.includes('.m3u8')) videoSrcLinks.push(video.src)
      })
      const m3u8Regex = /https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/g
      const textLinks = document.body.innerText.match(m3u8Regex) || []
      return { videoSrcLinks, textLinks }
    })
    // innerText 是解析后文本，裸写的 "&timestamp=" 会被误解码成 "×tamp="，需在 Node 侧还原（issue #84）
    const pageM3u8Links = [...videoSrcLinks, ...textLinks.map(restoreLegacyEntities)]
    
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
  shouldBlockRequest
}