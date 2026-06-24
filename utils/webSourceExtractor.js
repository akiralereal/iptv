import puppeteer from "puppeteer"
import { printBlue, printGreen, printRed } from "./colorOut.js"

/**
 * 启动 Chromium / Chrome，按以下顺序尽量找到可用浏览器，降低「Could not find Chrome」的踩坑概率：
 *   1) 环境变量 PUPPETEER_EXECUTABLE_PATH / mchromePath 显式指定的可执行文件（最高优先）
 *   2) puppeteer 自带、用 `npx puppeteer browsers install chrome` 下载的 Chrome
 *   3) 找不到自带的时，回退系统已安装的 Google Chrome（channel: 'chrome'），
 *      省去用户必须先下载特定版本 Chrome 的麻烦
 * @param {boolean} headless
 */
async function launchBrowser(headless) {
  const baseArgs = ['--no-sandbox', '--disable-setuid-sandbox']
  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.mchromePath
  if (execPath) {
    return puppeteer.launch({ headless, args: baseArgs, executablePath: execPath })
  }
  try {
    return await puppeteer.launch({ headless, args: baseArgs })
  } catch (err) {
    // 自带 Chrome 未下载/未找到时，尝试系统已安装的 Google Chrome
    if (/Could not find Chrome|Browser was not found|Failed to launch|Could not find expected browser/i.test(err?.message || '')) {
      printRed('未找到 puppeteer 自带 Chrome，尝试使用系统已安装的 Google Chrome（channel: chrome）…')
      return puppeteer.launch({ headless, args: baseArgs, channel: 'chrome' })
    }
    throw err
  }
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
    
    // 启动浏览器（自带 Chrome 找不到时回退系统 Google Chrome）
    browser = await launchBrowser(headless)
    
    const page = await browser.newPage()
    
    // 设置用户代理
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')
    
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
    
    // 也可以尝试查找页面中的 m3u8 链接
    const pageM3u8Links = await page.evaluate(() => {
      const links = []
      // 检查 video 标签的 src
      const videos = document.querySelectorAll('video')
      videos.forEach(video => {
        if (video.src && video.src.includes('.m3u8')) {
          links.push(video.src)
        }
      })
      
      // 检查所有包含 m3u8 的文本
      const allText = document.body.innerText
      const m3u8Regex = /https?:\/\/[^\s]+\.m3u8[^\s]*/g
      const matches = allText.match(m3u8Regex)
      if (matches) {
        links.push(...matches)
      }
      
      return links
    })
    
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
    await closeBrowser(browser)
  }
}

/**
 * 健壮地关闭 Puppeteer 浏览器，避免 Chromium 进程泄漏 / 僵尸进程。
 * - 给 browser.close() 设超时：无响应的 Chromium 不会卡死整个更新流程
 *   （update() 已串行化，一次卡死会阻塞后续所有更新）
 * - 超时或关闭异常时强杀 Chromium 进程组（POSIX 下 puppeteer 以 detached 方式
 *   启动 chromium，其 pid 即进程组组长），连同 renderer/zygote 子进程一并清理
 * @param {import('puppeteer').Browser|null} browser
 */
async function closeBrowser(browser) {
  if (!browser) return
  const proc = browser.process()
  let timer
  try {
    await Promise.race([
      browser.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('browser.close() 超时')), 10000)
      })
    ])
  } catch (error) {
    printRed(`关闭浏览器异常，强制结束 Chromium 进程: ${error.message}`)
    if (proc && proc.pid) {
      try {
        // 优先杀整个进程组，回收 renderer/zygote 等子进程
        process.kill(-proc.pid, 'SIGKILL')
      } catch (groupErr) {
        try { proc.kill('SIGKILL') } catch (_) { /* 进程可能已退出 */ }
      }
    }
  } finally {
    clearTimeout(timer)
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
  validateM3u8
}