/** 长江云 CDN 浏览器会话：匿名换防盗链票并读取 Chromium 专属 HLS 清单。 */
import { launchBrowser, closeBrowser } from '../../utils/browserLauncher.js'
import { printBlue } from '../../utils/colorOut.js'
import { CHANNEL_PAGE_URL } from './api.js'

const IDLE_CLOSE_MS = 5 * 60 * 1000
// 排队等浏览器位子的上限：略长于单次取票超时，等不到就让本次解析失败、播放器稍后重试
const SLOT_WAIT_MS = 30 * 1000
const DEFAULT_TIMEOUT_MS = 15 * 1000

export function isOfficialResolvedUrl(raw) {
  try {
    const url = new URL(String(raw || ''))
    return url.protocol === 'https:'
      && url.hostname === 'live21-cjy.hbtv.com.cn'
      && url.pathname.startsWith('/new-hbtv/')
      && /\.m3u8$/i.test(url.pathname)
      && !!url.searchParams.get('auth_key')
      && !!url.searchParams.get('extrakey')
      && !!url.searchParams.get('aalook')
  } catch {
    return false
  }
}

export class HbtvBrowserSession {
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
          label: '湖北台防盗链',
          waitMs: SLOT_WAIT_MS,
          onIdleRequest: () => this.#yieldIfIdle(),
        })
        // 启动后立刻登记，后续 page.goto / Cookie 校验任一步失败都能由 catch 关闭，
        // 避免初始化半途失败留下无人管理的 Chromium 进程。
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
        await page.setRequestInterception(true)
        page.on('request', request => {
          if (['image', 'font', 'media'].includes(request.resourceType())) request.abort().catch(() => {})
          else request.continue().catch(() => {})
        })
        await page.goto(CHANNEL_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS })
        const hasClientId = await page.evaluate(() => document.cookie.split('; ').some(item => item.startsWith('client-id=')))
        if (!hasClientId) throw new Error('官网没有下发匿名 client-id')
        this.page = page
        printBlue('湖北台防盗链浏览器会话已启动')
        return page
      })().catch(async error => {
        const browser = this.browser
        this.browser = null
        this.page = null
        await closeBrowser(browser, { label: '湖北台浏览器会话' })
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

  #armIdleClose() {
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => { void this.close() }, this.idleCloseMs)
    this.idleTimer.unref?.()
  }

  async #capture(rawUrl, timeoutMs) {
    const page = await this.#ensurePage()
    try {
      const captured = await Promise.race([
        page.evaluate(async (sourceUrl) => {
          const clientId = document.cookie.split('; ')
            .find(item => item.startsWith('client-id='))
            ?.split('=').slice(1).join('=') || ''
          const ticketResponse = await fetch(
            `/ajax/get_cdn_leech?url=${encodeURIComponent(sourceUrl)}&client-id=${encodeURIComponent(clientId)}`,
            { headers: { 'X-Requested-With': 'XMLHttpRequest' }, cache: 'no-store' },
          )
          const ticket = await ticketResponse.json()
          if (!ticket?.state || !ticket?.data) throw new Error(ticket?.message || '防盗链接口没有返回播放地址')

          // 该 CDN 对新浏览器会话的第一次跨域清单请求固定返回 403，第二次才放行。
          // 官网 Aliplayer 也会自然发起两次请求；这里显式重试，且只接受真正的 HLS。
          let lastStatus = 0
          for (let attempt = 0; attempt < 3; attempt++) {
            const response = await fetch(ticket.data, { cache: 'no-store' })
            const text = await response.text()
            lastStatus = response.status
            if (response.ok && text.trimStart().startsWith('#EXTM3U')) {
              return { url: response.url || ticket.data, text }
            }
          }
          throw new Error(`CDN 清单连续返回非 HLS（HTTP ${lastStatus}）`)
        }, rawUrl),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`读取官网 HLS 超时 ${timeoutMs}ms`)), timeoutMs)),
      ])
      if (!isOfficialResolvedUrl(captured?.url)) throw new Error('官网返回了非湖北台 CDN 地址')
      if (new URL(captured.url).pathname !== new URL(rawUrl).pathname) throw new Error('官网返回的频道路径发生错配')
      if (!String(captured?.text || '').trimStart().startsWith('#EXTM3U')) throw new Error('官网返回内容不是 HLS')
      return captured
    } finally {
      this.#armIdleClose()
    }
  }

  /** 同一个页面中的匿名会话与 Cookie 必须串行复用。 */
  capture(rawUrl, options = {}) {
    const timeoutMs = Math.max(5000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS))
    const task = () => this.#capture(rawUrl, timeoutMs)
    this.active++
    const pending = this.queue.then(task, task).finally(() => { this.active-- })
    this.queue = pending.catch(() => {})
    return pending
  }

  async close() {
    clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (this.opening) await this.opening.catch(() => {})
    const browser = this.browser
    this.browser = null
    this.page = null
    if (browser) await closeBrowser(browser, { label: '湖北台浏览器会话' })
  }
}

export const browserSession = new HbtvBrowserSession()
