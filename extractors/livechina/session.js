/** 央视网播放器会话：由官网 Worker 生成 auth-key，再读取官方 VDN 返回的 HLS。 */
import { launchBrowser, closeBrowser } from '../../utils/browserLauncher.js'
import { printBlue } from '../../utils/colorOut.js'
import { UPSTREAM_HEADERS } from './api.js'

const IDLE_CLOSE_MS = 5 * 60 * 1000
// 排队等浏览器位子的上限：略长于单次取票超时，等不到就让本次解析失败、播放器稍后重试
const SLOT_WAIT_MS = 30 * 1000
const DEFAULT_TIMEOUT_MS = 20 * 1000
const VDN_HOSTS = new Set(['vdnx.live.cntv.cn', 'vdnxbk.live.cntv.cn'])

export function isOfficialPageUrl(raw, channelId) {
  try {
    const url = new URL(String(raw || ''))
    return url.protocol === 'https:'
      && url.hostname === 'livechina.cctv.com'
      && /^\/live_zb\/LIVE\d{1,8}\.html$/i.test(url.pathname)
      && url.searchParams.get('isPlaying') === channelId
  } catch {
    return false
  }
}

export function isOfficialStreamUrl(raw) {
  try {
    const url = new URL(String(raw || '').trim())
    if (url.protocol !== 'https:' || !/\.m3u8$/i.test(url.pathname)) return false
    if (url.hostname === 'gcalic.v.myalicdn.com') return /^\/gc\/[A-Za-z0-9_-]+\/index\.m3u8$/i.test(url.pathname)
    return /^ldncctvwb(?:cd|nd)(?:ali\.v\.myalicdn\.com|bd\.a\.bdydns\.com|cnc\.v\.wscdns\.com|hwy\.cntv\.myhwcdn\.cn|ks\.v\.kcdnvip\.com|txy\.liveplay\.myqcloud\.com|byte\.volcfcdn\.com)$/i.test(url.hostname)
      && /^\/ldncctvwb(?:cd|nd)\/[A-Za-z0-9_./-]+\.m3u8$/i.test(url.pathname)
  } catch {
    return false
  }
}

export function manifestUrlFromVdn(payload) {
  if (payload?.ack !== 'yes' || String(payload?.status) !== '1' || String(payload?.play) !== '1') return ''
  const manifest = payload?.manifest || {}
  const candidates = [manifest.hls_nd, manifest.hls_url, manifest.hls, ...Object.values(manifest)]
  return candidates.find(isOfficialStreamUrl) || ''
}

function isVdnResponse(response, channelId) {
  try {
    const request = response.request()
    const url = new URL(response.url())
    return request.method() === 'GET'
      && VDN_HOSTS.has(url.hostname)
      && url.pathname === '/api/v3/vdn/live'
      && url.searchParams.get('channel') === channelId
  } catch {
    return false
  }
}

export class LiveChinaBrowserSession {
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
          label: '央视景观',
          waitMs: SLOT_WAIT_MS,
          onIdleRequest: () => this.#yieldIfIdle(),
        })
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
        await page.setUserAgent(UPSTREAM_HEADERS['User-Agent'])
        await page.setRequestInterception(true)
        page.on('request', request => {
          if (['image', 'font', 'media'].includes(request.resourceType())) request.abort().catch(() => {})
          else request.continue().catch(() => {})
        })
        this.page = page
        printBlue('央视直播中国浏览器会话已启动')
        return page
      })().catch(async error => {
        const browser = this.browser
        this.browser = null
        this.page = null
        await closeBrowser(browser, { label: '央视景观浏览器会话' })
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

  /**
   * 取票结束后把页面停到 about:blank：官网播放器否则会在后台持续播直播
   * （解码 + 不停拉分片），空闲 5 分钟等于白烧 5 分钟 CPU / 带宽 / 磁盘。
   */
  async #park(page) {
    if (!page || page.isClosed()) return
    await page.goto('about:blank', { timeout: 5000 }).catch(() => {})
  }

  #armIdleClose() {
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => { void this.close() }, this.idleCloseMs)
    this.idleTimer.unref?.()
  }

  async #capture(row, timeoutMs) {
    if (!row || !/^[A-Za-z0-9_-]{1,64}$/.test(row.id) || !isOfficialPageUrl(row.pageUrl, row.id)) {
      throw new Error('央视景观页面或频道编号非法')
    }
    const page = await this.#ensurePage()
    let timer
    let onResponse
    const captured = new Promise((resolve, reject) => {
      onResponse = response => {
        if (!isVdnResponse(response, row.id)) return
        response.json().then(payload => {
          const url = manifestUrlFromVdn(payload)
          if (url) resolve(url)
          else reject(new Error('央视 VDN 没有返回可播放的官方 HLS'))
        }).catch(error => reject(new Error(`央视 VDN 响应解析失败：${error?.message || error}`)))
      }
      page.on('response', onResponse)
      timer = setTimeout(() => reject(new Error(`等待央视景观播放地址超时 ${timeoutMs}ms`)), timeoutMs)
    })
    // 机器很慢时 goto 可能拖过 timeoutMs，captured 会在被 await 之前先 reject（用户日志里
    // 的「未处理的 Promise rejection: 等待央视景观播放地址超时」即此）：先挂一个空 catch
    captured.catch(() => {})

    let navigationError = null
    try {
      await page.goto(row.pageUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(timeoutMs, 15000) })
    } catch (error) {
      navigationError = error
    }
    await page.evaluate(channelId => {
      if (typeof window.playVideo === 'function') window.playVideo(channelId, 'yd_video_pay', '')
    }, row.id).catch(() => {})

    try {
      return await captured
    } catch (error) {
      if (navigationError) throw new Error(`央视景观页面加载失败：${navigationError?.message || navigationError}`)
      throw error
    } finally {
      clearTimeout(timer)
      if (onResponse) page.off('response', onResponse)
      await this.#park(page)
      this.#armIdleClose()
    }
  }

  capture(row, options = {}) {
    const timeoutMs = Math.max(5000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS))
    const task = () => this.#capture(row, timeoutMs)
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
    if (browser) await closeBrowser(browser, { label: '央视景观浏览器会话' })
  }
}

export const browserSession = new LiveChinaBrowserSession()
