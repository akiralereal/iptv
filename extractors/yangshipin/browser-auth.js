import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { closeBrowser, launchBrowser } from '../../utils/browserLauncher.js'
import { dataPath } from '../../utils/paths.js'

export const YSP_HOME = 'https://www.yangshipin.cn/tv/home'
export const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const DEFAULT_PROFILE = dataPath('yangshipin/chrome-profile')
const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))
const firstLine = error => String(error?.message || error || '未知错误').split('\n')[0]

/** 可见登录窗只能出现在运行服务的桌面会话中；远端后台不能把窗口“传送”到客户端。 */
export function browserLoginAvailability({ platform = process.platform, env = process.env } = {}) {
  if (platform === 'darwin' || platform === 'win32') return { available: true, reason: '' }
  if (platform === 'linux' && (env.DISPLAY || env.WAYLAND_DISPLAY || env.YSP_ALLOW_HEADFUL === '1')) {
    return { available: true, reason: '' }
  }
  return {
    available: false,
    reason: '当前服务没有可用的桌面显示环境；自动弹窗登录仅支持在服务所在电脑本机运行，Docker/NAS 暂不支持。',
  }
}

/**
 * 央视频网页登录态分两层（2026-09 用真实账号实测）：
 * - 官网 SDK 用 js-cookie 写的 ysp_str* 令牌、endtime 等，document.cookie 看得到；
 * - 账号服务用 Set-Cookie 下发的 vusession / accesstoken / refreshtoken / openid / appid / yspappid，
 *   全是 HttpOnly。用户信息接口靠它们认人，续期接口没有它们直接回「inner token失效」并让 SDK 清空令牌。
 * 所以书签工具那种只读 document.cookie 的路子在这里走不通，必须导入浏览器发出去的整段 Cookie 请求头
 * （开发者工具 Network 里复制），它同时包含两层。
 */
export const SESSION_COOKIES = Object.freeze(['vusession', 'accesstoken', 'refreshtoken', 'openid', 'appid', 'yspappid'])
export const LOGIN_IDENTITY_COOKIES = Object.freeze(['vusession', 'accesstoken', 'refreshtoken'])
const IMPORT_COOKIE_TTL_S = 48 * 3600
const MAX_IMPORT_COOKIES = 120
const COOKIE_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/

function cookiesFromHeader(text) {
  const out = {}
  for (const part of String(text).split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const name = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (name) out[name] = value
  }
  return out
}

/**
 * 解析后台粘贴进来的登录态。收两种形态：
 * - 从开发者工具复制的整段 Cookie 请求头（a=b; c=d），这是唯一能带上 HttpOnly 会话 cookie 的来源；
 * - JSON（{ cookies: {...} } 或裸 {name: value}），给脚本化导入用。
 * 只做形态与名字合法性校验，不猜每个 cookie 的含义——SDK 自己会用它认得的那些。
 * 返回 [{ name, value }]；缺 vusession / accesstoken / refreshtoken 时直接抛错说明原因，
 * 免得白起一次 Chromium 再被官网拒绝。
 */
export function parseImportedLoginState(payload) {
  let text = String(payload ?? '').trim()
  if (!text) throw new Error('请先粘贴从浏览器开发者工具复制的 Cookie 值')
  if (text.length > 64 * 1024) throw new Error('内容过长，不像是一段 Cookie 请求头')
  if (/^cookie:\s*/i.test(text)) text = text.replace(/^cookie:\s*/i, '')
  let cookies
  if (text.startsWith('{')) {
    let decoded
    try { decoded = JSON.parse(text) } catch { throw new Error('登录态 JSON 无法解析') }
    cookies = decoded?.cookies && typeof decoded.cookies === 'object' ? decoded.cookies : decoded
  } else {
    cookies = cookiesFromHeader(text)
  }
  if (!cookies || typeof cookies !== 'object' || Array.isArray(cookies)) throw new Error('登录态内容里没有 cookie 列表')
  const list = []
  for (const [rawName, rawValue] of Object.entries(cookies)) {
    const name = String(rawName).trim()
    if (!COOKIE_NAME_RE.test(name)) continue
    const value = String(rawValue ?? '').trim()
    if (!value || value.length > 4096 || /[;\r\n\u0000-\u001f]/.test(value)) continue
    list.push({ name, value })
    if (list.length > MAX_IMPORT_COOKIES) throw new Error('cookie 数量异常，请只复制央视频官网请求的 Cookie 值')
  }
  if (!list.length) throw new Error('内容里没有 cookie；请在开发者工具 Network 里点开一个 yangshipin.cn 的请求，复制 Request Headers 中 Cookie 的完整值')
  if (!list.some(cookie => LOGIN_IDENTITY_COOKIES.includes(cookie.name))) {
    const hint = list.some(cookie => /^ysp_/.test(cookie.name))
      ? '这份内容只有网页脚本能看到的那部分 cookie，缺少 vusession / accesstoken 这类 HttpOnly 会话 cookie，官网不会认。'
      : '内容里没有 vusession / accesstoken 这类央视频会话 cookie。'
    throw new Error(`${hint}请先在官网右上角确认已登录，再在开发者工具 Network 里点开任一 yangshipin.cn 请求，复制 Request Headers 中 Cookie 的完整值`)
  }
  return list
}

export class LoginRequiredError extends Error {
  constructor(message = '央视频登录态不存在或已过期，请先在服务所在电脑本机完成登录') {
    super(message)
    this.name = 'LoginRequiredError'
  }
}

/**
 * 央视频账号级浏览器会话。专用 profile 放在 data 目录，重启后继续由官网 SDK
 * 刷新短效登录材料；profile 本身等同凭据，不进入 JSON 配置或配置备份。
 */
export class YspBrowserSession {
  constructor({
    profileDir = process.env.YSP_PROFILE_DIR || DEFAULT_PROFILE,
    launchImpl = launchBrowser,
    closeImpl = closeBrowser,
    logger = () => {},
    // 每次「确定性」读到账号结果时回调（SDK 明确说有 / 没有登录）；读取过程本身出错不回调，
    // 免得一次网络抖动就把「已关联」的记录抹掉。runtime 用它维护保活用的关联标记。
    onAccount = () => {},
  } = {}) {
    this.profileDir = resolve(profileDir)
    this.launchImpl = launchImpl
    this.closeImpl = closeImpl
    this.logger = logger
    this.onAccount = onAccount
    this.browser = null
    this.page = null
    this.visible = false
    this.account = null
    this.lifecycle = Promise.resolve()
    this.lifecycleJobs = 0
    this.accountReads = 0
    this.canYield = () => false
  }

  get running() { return Boolean(this.browser?.connected) }

  withLifecycle(work) {
    this.lifecycleJobs++
    const job = this.lifecycle.then(work).finally(() => { this.lifecycleJobs-- })
    this.lifecycle = job.catch(() => {})
    return job
  }

  ensureBrowser(options = {}) {
    return this.withLifecycle(() => this.ensureBrowserNow(options))
  }

  async requestIdleYield() {
    if (this.lifecycleJobs > 0 || this.accountReads > 0 || !this.running || this.visible || !this.canYield()) return false
    await this.close()
    return true
  }

  async ensureBrowserNow({ visible = false } = {}) {
    if (this.running && (!visible || this.visible)) return this.page
    if (this.running) await this.closeNow()

    await mkdir(this.profileDir, { recursive: true })
    this.logger(`启动${visible ? '可见' : '后台'}央视频浏览器会话`)
    const browser = await this.launchImpl({
      headless: !visible,
      label: '央视频会员会话',
      onIdleRequest: () => this.requestIdleYield(),
      launchOptions: {
        userDataDir: this.profileDir,
        protocolTimeout: 30_000,
        defaultViewport: visible ? null : { width: 1440, height: 900 },
        // app.js 自己处理 SIGTERM / SIGINT：browser.close() 让 Chromium 把 cookie 落盘、删掉 Singleton 锁再退出。
        // puppeteer 默认也挂这两个信号，收到就 SIGKILL 整个进程组（SIGINT 还立刻 process.exit），抢在正常关闭
        // 之前——docker stop 后锁必然残留，停止前约 30 秒内导入 / 续期的登录 cookie 也会丢（issue #153）。
        // 进程退出时 puppeteer 的 exit 钩子仍会杀掉没关掉的 Chromium，不留孤儿；SIGHUP 没人接，保持默认。
        handleSIGINT: false,
        handleSIGTERM: false,
      },
    })
    this.browser = browser
    this.visible = visible
    browser.once?.('disconnected', () => {
      if (this.browser !== browser) return
      this.browser = null
      this.page = null
      this.visible = false
      this.account = null
    })

    try {
      const pages = await browser.pages()
      this.page = pages[0] || await browser.newPage()
      await this.configurePage(this.page)
      await this.ensureHome()
      return this.page
    } catch (error) {
      await this.closeNow()
      throw error
    }
  }

  async configurePage(page) {
    await page.setUserAgent(BROWSER_UA)
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    })
    page.on('dialog', dialog => dialog.dismiss().catch(() => {}))
    await page.setRequestInterception(true)
    page.on('request', request => {
      const url = request.url()
      const type = request.resourceType()
      // 账号页只运行 SDK，不需要持续下载/解码默认频道；真正媒体由 VIP bridge 页面处理。
      if (type === 'media' || /\.(?:ts|m4s|mp4|aac)(?:[?#]|$)/i.test(url)) request.abort().catch(() => {})
      else request.continue().catch(() => {})
    })
  }

  async ensureHome() {
    const page = this.page
    if (!page || page.isClosed()) throw new Error('央视频浏览器页面不可用')
    if (!page.url().startsWith(YSP_HOME)) {
      await page.goto(YSP_HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    }
    await page.waitForFunction(
      () => window.yspLogin?.default && document.querySelectorAll('.tv-main-con-r-list-left-imga').length >= 40,
      { timeout: 30_000 },
    )
  }

  async readAccount() {
    this.accountReads++
    try { return await this.readAccountNow() }
    finally { this.accountReads-- }
  }

  async readAccountNow() {
    if (!this.running || !this.page || this.page.isClosed()) {
      return { running: false, visible: false, authenticated: false, account: null }
    }
    try {
      const cookies = await this.page.cookies('https://www.yangshipin.cn')
      const hasLoginCookie = cookies.some(cookie => ['ysp_openid', 'yspopenid', 'vusession'].includes(cookie.name) && cookie.value)
      if (!hasLoginCookie) {
        this.account = null
        this.notifyAccount({ authenticated: false, account: null })
        return { running: true, visible: this.visible, authenticated: false, account: null }
      }
      const account = await this.page.evaluate(async () => {
        const sdk = window.yspLogin?.default
        if (!sdk) return null
        const info = await sdk.info()
        if (!info) return null
        return {
          nickname: String(info.nickname || info.nick || ''),
          type: String(info.type || ''),
          vip: [true, 1, '1', 'true'].includes(info.isVip ?? info.vip ?? info.vip_status),
        }
      })
      this.account = account
      this.notifyAccount({ authenticated: Boolean(account), account })
      return { running: true, visible: this.visible, authenticated: Boolean(account), account }
    } catch (error) {
      this.account = null
      this.logger(`读取央视频登录态失败：${firstLine(error)}`)
      return { running: this.running, visible: this.visible, authenticated: false, account: null }
    }
  }

  notifyAccount(status) {
    try { this.onAccount(status) } catch (error) { this.logger(`记录央视频账号状态失败：${firstLine(error)}`) }
  }

  /**
   * 把用户在自己浏览器里拿到的登录 cookie 种进后台 profile（Docker / NAS 没有桌面时的登录路径）。
   * 先清掉 profile 里旧的 yangshipin.cn cookie 再写，避免新旧两套令牌混用；然后重新加载首页
   * 让 SDK 用新 cookie 初始化，readAccount 里的 sdk.info() 会在需要时自动拿刷新令牌换新一套，
   * 相当于把登录态「接管」到服务端。返回和 readAccount 同构的状态。
   */
  async importLoginCookies(cookies) {
    return this.withLifecycle(async () => {
      const page = await this.ensureBrowserNow({ visible: false })
      const stale = await page.cookies('https://www.yangshipin.cn', 'https://yangshipin.cn')
      if (stale.length) await page.deleteCookie(...stale.map(cookie => ({ name: cookie.name, domain: cookie.domain, path: cookie.path })))
      const expires = Math.floor(Date.now() / 1000) + IMPORT_COOKIE_TTL_S
      await page.setCookie(...cookies.map(cookie => ({
        name: cookie.name,
        value: cookie.value,
        domain: '.yangshipin.cn',
        path: '/',
        expires,
        secure: false,
        // 会话层 cookie 在官网本来就是 HttpOnly；按原样标记，页面脚本读不到、行为和真登录一致
        httpOnly: SESSION_COOKIES.includes(cookie.name),
      })))
      this.account = null
      this.logger(`已导入 ${cookies.length} 个央视频登录 cookie，正在让官网 SDK 校验`)
      // 记下官网账号接口的每次回应：导入失败时要能说清是哪一步被拒（刷新令牌作废 / 用户信息接口不认 / SDK 清掉了 cookie），
      // 而不是一句「没认出」。只记路径、HTTP 状态和返回码，不记正文里的令牌。
      const apiLog = []
      const onResponse = async response => {
        const url = response.url()
        if (!/\.yangshipin\.cn\/(?:v1\/|auth_|third\/)/.test(url)) return
        let summary = ''
        try {
          const json = await response.json()
          summary = `code=${json?.code ?? '-'} data.code=${json?.data?.code ?? '-'}${json?.msg || json?.message || json?.data?.msg ? ` msg=${json.msg || json.message || json.data.msg}` : ''}`
        } catch { /* 非 JSON 或正文已消费 */ }
        let path = url
        try { path = `${new URL(url).hostname}${new URL(url).pathname}` } catch { /* 保留原样 */ }
        apiLog.push(`${path} HTTP ${response.status()} ${summary}`.trim())
      }
      page.on('response', onResponse)
      try {
        await page.goto(YSP_HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        await this.ensureHome()
        const status = await this.readAccount()
        if (!status.authenticated) {
          const remaining = (await page.cookies('https://www.yangshipin.cn').catch(() => [])).map(cookie => cookie.name)
          const signed = await page.evaluate(async () => {
            const sdk = window.yspLogin?.default
            if (!sdk?.isSigned) return 'sdk-missing'
            try { return await sdk.isSigned() } catch (error) { return `error:${error?.message || error}` }
          }).catch(error => `error:${firstLine(error)}`)
          status.diagnostic = {
            imported: cookies.map(cookie => cookie.name),
            remaining,
            signed,
            api: [...apiLog],
          }
        }
        return status
      } finally {
        page.off('response', onResponse)
      }
    })
  }

  async openLogin() {
    return this.withLifecycle(async () => {
      const page = await this.ensureBrowserNow({ visible: true })
      await page.bringToFront()
      const status = await this.readAccount()
      if (!status.authenticated) {
        await page.evaluate(() => window.yspLogin.default.signin({ mobile: true, wechat: true, qq: false, weibo: false }))
      }
      return status
    })
  }

  close() {
    return this.withLifecycle(() => this.closeNow())
  }

  async closeNow() {
    const browser = this.browser
    this.browser = null
    this.page = null
    this.visible = false
    this.account = null
    if (!browser) return
    await this.closeImpl(browser, { label: '央视频会员会话' })
  }
}

const LOGIN_ACTIVE = new Set(['opening', 'waiting', 'restoring'])

/** 单路登录状态机：自动识别官网登录，关闭可见窗口，再以同一 profile 切回后台。 */
export class YspBrowserLogin {
  constructor(browserSession, {
    beforeOpen = async () => {},
    restore = async () => {},
    pollMs = 2_000,
    timeoutMs = 6 * 60_000,
    sleepImpl = sleep,
  } = {}) {
    this.browserSession = browserSession
    this.beforeOpen = beforeOpen
    this.restore = restore
    this.pollMs = pollMs
    this.timeoutMs = timeoutMs
    this.sleep = sleepImpl
    this.runId = 0
    this.task = null
    this.restoreTask = null
    this.lastVerifiedAt = null
    this.state = { status: 'idle', message: '尚未检查央视频登录态', account: null }
  }

  status() {
    return {
      ...this.state,
      account: this.state.account ? { ...this.state.account } : null,
      active: LOGIN_ACTIVE.has(this.state.status),
      lastVerifiedAt: this.lastVerifiedAt,
    }
  }

  active() { return LOGIN_ACTIVE.has(this.state.status) }

  noteAccount(status) {
    if (this.active()) return this.status()
    this.lastVerifiedAt = Date.now()
    if (status.authenticated) {
      const vipMessage = status.account?.vip ? 'VIP 权益已识别' : '未识别到有效 VIP 权益'
      this.state = { status: 'success', message: `已关联央视频账号，${vipMessage}`, account: status.account }
    } else {
      this.state = { status: 'idle', message: '尚未检测到有效央视频登录态', account: null }
    }
    return this.status()
  }

  start() {
    if (this.active()) return this.status()
    const runId = ++this.runId
    this.state = { status: 'opening', message: '正在打开央视频官方登录窗口…', account: null }
    const task = this.run(runId)
    this.task = task
    task.finally(() => { if (this.task === task) this.task = null })
    return this.status()
  }

  async cancel({ restore = true } = {}) {
    const runningTask = this.task
    const shouldRestore = this.active() || this.browserSession.visible
    ++this.runId
    this.state = restore && shouldRestore
      ? { status: 'restoring', message: '正在取消登录并恢复后台会话…', account: null }
      : { status: 'idle', message: '已取消央视频登录关联', account: null }
    if (restore && shouldRestore) {
      try {
        await this.restoreBackground()
        if (runningTask) await runningTask
        this.state = { status: 'idle', message: '已取消登录，后台会话已恢复', account: null }
      } catch (error) {
        this.state = { status: 'error', message: `取消登录后恢复后台会话失败：${firstLine(error)}`, account: null }
      }
    }
    if (!restore && runningTask) await runningTask
    return this.status()
  }

  async restoreBackground() {
    if (this.restoreTask) return this.restoreTask
    const task = (async () => {
      await this.browserSession.close()
      await this.restore()
    })()
    this.restoreTask = task
    try { await task }
    finally { if (this.restoreTask === task) this.restoreTask = null }
  }

  async finish(status, runId) {
    if (runId !== this.runId) return
    this.state = { status: 'restoring', message: '已识别登录，正在切回后台播放会话…', account: status.account }
    await this.restoreBackground()
    if (runId !== this.runId) return
    const confirmed = await this.browserSession.readAccount()
    if (runId !== this.runId) return
    if (!confirmed.authenticated) throw new LoginRequiredError('登录已识别，但切回后台后未能恢复央视频会话')
    const vipMessage = confirmed.account?.vip ? 'VIP 权益已识别' : '未识别到有效 VIP 权益'
    this.state = {
      status: 'success',
      message: `央视频账号已自动关联，${vipMessage}；官方窗口已关闭`,
      account: confirmed.account,
    }
    this.lastVerifiedAt = Date.now()
  }

  async run(runId) {
    let prepared = false
    try {
      const existing = await this.browserSession.readAccount()
      if (runId !== this.runId) return
      if (existing.authenticated) {
        const vipMessage = existing.account?.vip ? 'VIP 权益已识别' : '未识别到有效 VIP 权益'
        this.state = { status: 'success', message: `已关联现有央视频账号，${vipMessage}`, account: existing.account }
        this.lastVerifiedAt = Date.now()
        return
      }

      prepared = true
      await this.beforeOpen()
      if (runId !== this.runId) return
      const opened = await this.browserSession.openLogin()
      if (runId !== this.runId) return
      if (opened.authenticated) return this.finish(opened, runId)

      this.state = {
        status: 'waiting',
        message: '请在弹出的央视频官方页面完成登录；成功后会自动识别并关闭窗口',
        account: null,
      }
      const deadline = Date.now() + this.timeoutMs
      while (Date.now() < deadline && runId === this.runId) {
        await this.sleep(this.pollMs)
        if (runId !== this.runId) return
        const status = await this.browserSession.readAccount()
        if (runId !== this.runId) return
        if (status.authenticated) return this.finish(status, runId)
        if (!status.running) throw new Error('央视频登录窗口已关闭，请重试')
      }
      if (runId === this.runId) throw new Error('等待央视频官网登录超时，请重新打开登录窗口')
    } catch (error) {
      if (runId !== this.runId) return
      let reason = firstLine(error)
      if (prepared) {
        this.state = { status: 'restoring', message: '登录未完成，正在恢复后台会话…', account: null }
        try { await this.restoreBackground() }
        catch (restoreError) { reason += `；恢复后台会话失败：${firstLine(restoreError)}` }
      }
      if (runId === this.runId) this.state = { status: 'error', message: reason, account: null }
    }
  }
}
