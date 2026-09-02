/** 广东台官网浏览器取票会话：复用一个 Chromium 页面，避免每次清单轮询都启动浏览器。 */
import { launchBrowser, closeBrowser } from '../../utils/browserLauncher.js'
import { printBlue } from '../../utils/colorOut.js'
import { channelPageUrl } from './channels.js'

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const IDLE_CLOSE_MS = 5 * 60 * 1000
// 排队等浏览器位子的上限：略长于单次取票超时，等不到就让本次解析失败、播放器稍后重试
const SLOT_WAIT_MS = 30 * 1000
const DEFAULT_CAPTURE_TIMEOUT_MS = 20 * 1000

export function isOfficialStreamUrl(raw) {
  try {
    const url = new URL(String(raw || '').trim())
    return url.protocol === 'https:'
      && url.hostname === 'tcdn.itouchtv.cn'
      && url.pathname.startsWith('/live/')
      && /\.m3u8$/i.test(url.pathname)
      && !!url.searchParams.get('t_token')
  } catch {
    return false
  }
}

export class GdtvBrowserSession {
  constructor({ idleCloseMs = IDLE_CLOSE_MS } = {}) {
    this.idleCloseMs = idleCloseMs
    this.browser = null
    this.page = null
    this.opening = null
    this.queue = Promise.resolve()
    this.idleTimer = null
    this.active = 0 // 排队中 + 进行中的取票数，为 0 才算空闲、可让出浏览器位子
  }

  async #ensurePage() {
    if (this.page && !this.page.isClosed() && this.browser?.connected) return this.page
    if (!this.opening) {
      this.opening = (async () => {
        const browser = await launchBrowser({
          label: '广东台续签',
          waitMs: SLOT_WAIT_MS,
          onIdleRequest: () => this.#yieldIfIdle(),
        })
        // 启动后立刻登记：后面 newPage / 设置 UA 任一步失败都由下方 catch 关闭，
        // 不留无人管理的 Chromium 进程（此前这里没有兜底）。
        this.browser = browser
        browser.once('disconnected', () => {
          if (this.browser === browser) {
            this.browser = null
            this.page = null
          }
        })
        const page = await browser.newPage()
        await page.evaluateOnNewDocument(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
        })
        await page.setUserAgent(USER_AGENT)
        await page.setRequestInterception(true)
        page.on('request', request => {
          if (['image', 'font'].includes(request.resourceType())) request.abort().catch(() => {})
          else request.continue().catch(() => {})
        })
        this.page = page
        printBlue('广东台续签浏览器会话已启动')
        return page
      })().catch(async error => {
        const browser = this.browser
        this.browser = null
        this.page = null
        await closeBrowser(browser, { label: '广东台浏览器会话' })
        throw error
      }).finally(() => { this.opening = null })
    }
    return this.opening
  }

  /** 浏览器位子被别的任务排队时由启动器回调：当前没活就关掉自己让位。 */
  async #yieldIfIdle() {
    if (this.active > 0 || this.opening) return false
    await this.close()
    return true
  }

  // 注意：取票后不要把页面导航走（about:blank 等）。官网在页面卸载时会调用停止播放的
  // 接口，刚拿到的短效票会被立刻作废，服务端随后取清单只能拿到 403。空闲浪费由
  // idleCloseMs 兜底：5 分钟无人取票就整个关掉浏览器。
  #armIdleClose() {
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => { void this.close() }, this.idleCloseMs)
    this.idleTimer.unref?.()
  }

  async #capture(channelId, timeoutMs) {
    const page = await this.#ensurePage()
    const target = channelPageUrl(channelId)
    let timer
    let onResponse
    const captured = new Promise((resolve, reject) => {
      onResponse = response => {
        const url = response.url()
        if (isOfficialStreamUrl(url)) resolve(url)
      }
      page.on('response', onResponse)
      timer = setTimeout(() => reject(new Error(`等待官网播放地址超时 ${timeoutMs}ms`)), timeoutMs)
    })
    // 机器很慢时 goto 可能拖过 timeoutMs，captured 会在被 await 之前先 reject：
    // 先挂一个空 catch，避免报「未处理的 Promise rejection」（真正的结果仍由下方 await 取）
    captured.catch(() => {})

    let navigationError = null
    try {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: Math.min(timeoutMs, 15000) })
    } catch (error) {
      navigationError = error
    }

    // 官网通常自动起播；浏览器策略或页面改版导致没起播时再补一次用户动作。
    await page.evaluate(() => {
      const video = document.querySelector('video')
      if (video) {
        video.muted = true
        const playing = video.play()
        if (playing?.catch) playing.catch(() => {})
      }
      const button = document.querySelector('.vjs-big-play-button, [class*="play-btn"], [class*="btn-play"]')
      if (button) button.click()
    }).catch(() => {})

    try {
      return await captured
    } catch (error) {
      if (navigationError) {
        throw new Error(`官网页面加载失败：${navigationError?.message || navigationError}`)
      }
      throw error
    } finally {
      clearTimeout(timer)
      if (onResponse) page.off('response', onResponse)
      this.#armIdleClose()
    }
  }

  /** 同一个 page 不能并行导航；所有频道取票在模块内部排队。 */
  capture(channelId, options = {}) {
    const timeoutMs = Math.max(5000, Number(options.timeoutMs || DEFAULT_CAPTURE_TIMEOUT_MS))
    const task = () => this.#capture(channelId, timeoutMs)
    this.active++
    const pending = this.queue.then(task, task).finally(() => { this.active-- })
    this.queue = pending.catch(() => {})
    return pending
  }

  async close() {
    clearTimeout(this.idleTimer)
    this.idleTimer = null
    // clearResolveCache 可能正好撞在首次启动 Chromium 的窗口；等启动动作落地后再
    // 取 browser 引用，避免「关闭时还是 null，下一拍却冒出一个无人管理的进程」。
    if (this.opening) await this.opening.catch(() => {})
    const browser = this.browser
    this.browser = null
    this.page = null
    if (browser) await closeBrowser(browser, { label: '广东台浏览器会话' })
  }
}

export const browserSession = new GdtvBrowserSession()
