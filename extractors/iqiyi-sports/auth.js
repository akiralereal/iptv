import { mkdir } from 'node:fs/promises'
import { launchBrowser, closeBrowser } from '../../utils/browserLauncher.js'
import { dataPath } from '../../utils/paths.js'
import { parseCookies } from './cookies.js'
import { selectAuthorizedStream } from './api.js'

export function createBrowserAuth({ getEvent, profile = dataPath('iqiyi-sports/chrome-profile'), launchImpl = launchBrowser, closeImpl = closeBrowser } = {}) {
  let browser, launching, visible = false, busy = false, pages = 0, loginPage, revision = 0
  let state = { status: 'idle', authenticated: false, message: '请关联本人爱奇艺账号，并检查赛事观看权限' }
  const available = process.platform !== 'linux' || !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
  const snapshot = () => ({ ...state, active: busy, running: !!browser?.connected, visible,
    available, reason: available ? '' : '当前服务没有桌面环境，请从本人浏览器复制 Cookie 导入',
    account: state.authenticated ? { nickname: '本人爱奇艺账号', type: '当前赛事授权', vip: true } : null })
  async function close() {
    if (browser) await closeImpl(browser, { label: '爱奇艺体育' })
    browser = undefined; loginPage = undefined; visible = false
  }
  async function ensure(headful = false) {
    if (browser?.connected && (!headful || visible)) return browser
    if (launching) return launching
    launching = (async () => {
      if (browser?.connected) await close()
      await mkdir(profile, { recursive: true, mode: 0o700 })
      browser = await launchImpl({ label: '爱奇艺体育', headless: !headful,
        launchOptions: { userDataDir: profile, defaultViewport: headful ? null : { width: 1440, height: 1000 }, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, args: headful ? ['--window-size=1440,1000'] : [] },
        onIdleRequest: async () => { if (busy || pages || loginPage && !loginPage.isClosed()) return false; await close(); return true },
      })
      visible = headful
      const current = browser
      current.on('disconnected', () => { if (browser === current) { browser = undefined; loginPage = undefined; visible = false } })
      return browser
    })()
    try { return await launching } finally { launching = undefined }
  }
  async function captureContext(context, event) {
    pages++
    let page, timer
    try {
      page = await context.newPage()
      const captured = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('爱奇艺官方播放授权检查超时')), 35000)
        page.on('response', async response => {
          if (!response.url().startsWith('https://live.video.iqiyi.com/live?')) return
          try {
            const text = (await response.text()).trim().replace(/^[\w.$]+\s*\(/, '').replace(/\);?\s*$/, '')
            const body = JSON.parse(text)
            if (body.data?.bossRet) resolve(body.data)
          } catch {}
        })
      })
      captured.catch(() => {})
      await page.goto(event.officialPage, { waitUntil: 'domcontentloaded', timeout: 35000 })
      const data = await captured
      const hasLogin = (await page.cookies()).some(c => c.name === 'P00001' && c.value)
      return { data, hasLogin }
    } finally { clearTimeout(timer); await page?.close().catch(() => {}); pages-- }
  }
  async function capture(event) {
    if (busy) throw new Error('爱奇艺正在处理登录操作，请稍后播放')
    pages++
    try { return await captureContext((await ensure()).defaultBrowserContext(), event) } finally { pages-- }
  }
  async function verify(context, event) {
    const result = await captureContext(context, event)
    const stream = selectAuthorizedStream(result.data, result.hasLogin)
    if (!result.hasLogin || !stream.member) throw new Error('没有确认本人登录后的赛事完整权限')
    return { status: 'authenticated', authenticated: true, message: `已确认完整观看权限：${event.title}` }
  }
  async function action(fn) {
    if (busy || pages) throw new Error('爱奇艺正在进行登录或播放解析，请稍候')
    busy = true
    try { return await fn() } finally { busy = false }
  }
  const flow = {
    status: snapshot,
    start: () => action(async () => {
      if (!available) throw new Error('服务没有桌面环境，请使用 Cookie 导入')
      const b = await ensure(true), event = await getEvent()
      if (!loginPage || loginPage.isClosed()) loginPage = await b.newPage()
      await loginPage.setViewport(null)
      await loginPage.goto(event?.officialPage || 'https://www.iqiyi.com/iframe/loginreg', { waitUntil: 'domcontentloaded', timeout: 35000 })
      await loginPage.bringToFront()
      state = { ...state, status: 'waiting', message: '请在官方窗口完成扫码或短信验证码登录，然后点击检查赛事权限' }
      return snapshot()
    }),
    check: () => action(async () => {
      const event = await getEvent()
      if (!event) return { ...snapshot(), message: '当前没有在播赛事，暂时无法核验赛事权益；已保存的登录态保留' }
      try { state = await verify((await ensure()).defaultBrowserContext(), event); revision++ }
      catch (error) {
        if (error.credential || /没有确认/.test(error.message)) state = { status: 'error', authenticated: false, message: error.message }
        else throw error
      }
      return snapshot()
    }),
    import: payload => {
      const cookies = parseCookies(payload)
      return action(async () => {
        const event = await getEvent()
        if (!event) throw new Error('当前没有在播赛事，无法验证导入凭证；请稍后导入或使用官方网页登录')
        const b = await ensure(), staging = await b.createBrowserContext()
        try {
          await staging.setCookie(...cookies)
          const verified = await verify(staging, event)
          const page = await b.newPage(), cdp = await page.createCDPSession()
          try {
            const list = async () => (await cdp.send('Network.getAllCookies')).cookies.filter(c => /(^|\.)iqiyi\.com$/.test(c.domain.replace(/^\./, '')))
            const remove = async items => { for (const c of items) await cdp.send('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path }) }
            const old = await list()
            try {
              await remove(old); await cdp.send('Network.setCookies', { cookies })
              await verify(b.defaultBrowserContext(), event)
            } catch {
              await remove(await list())
              const restored = old.map(c => Object.fromEntries(['name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'sameSite', 'expires'].filter(k => c[k] !== undefined).map(k => [k, c[k]])))
              await cdp.send('Network.setCookies', { cookies: restored })
              throw new Error('Cookie 写入验证失败，已恢复原登录态')
            }
          } finally { await cdp.detach().catch(() => {}); await page.close() }
          state = { ...verified, message: `Cookie 导入成功；${verified.message}` }; revision++
          return snapshot()
        } catch (error) {
          if (error.credential) throw new Error('导入 Cookie 未获此赛事完整权限，现有登录态保留')
          throw error
        } finally { await staging.close() }
      })
    },
    cancel: () => action(async () => { await loginPage?.close().catch(() => {}); loginPage = undefined; state = { ...state, status: 'idle' }; return snapshot() }),
    close: () => action(async () => { await close(); state = { ...state, message: '后台浏览器已关闭，已保存的登录态会在下次播放时恢复' }; return snapshot() }),
  }
  return { flow, capture, revision: () => revision, shutdown: close }
}
