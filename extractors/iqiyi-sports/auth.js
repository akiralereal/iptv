import { mkdir } from 'node:fs/promises'
import { launchBrowser, closeBrowser } from '../../utils/browserLauncher.js'
import { dataPath } from '../../utils/paths.js'
import { parseCookies } from './cookies.js'
import { selectAuthorizedMedia } from './api.js'

export function createBrowserAuth({ getEvent, profile = dataPath('iqiyi-sports/chrome-profile'), launchImpl = launchBrowser, closeImpl = closeBrowser } = {}) {
  let browser, launching, visible = false, busy = false, pages = 0, loginPage, revision = 0
  let state = { status: 'idle', authenticated: false, message: '请关联本人爱奇艺账号，并检查赛事观看权限' }
  const available = process.platform !== 'linux' || !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
  const snapshot = () => ({ ...state, active: busy, running: !!browser?.connected, visible,
    available, reason: available ? '' : '当前服务没有桌面环境，请从本人浏览器复制 Cookie 导入',
    account: state.authenticated ? { nickname: '本人爱奇艺账号', type: state.entitled === false ? '账号有效，当前内容需额外权益' : '当前赛事授权', vip: state.entitled === true ? true : null } : null })
  async function close() {
    if (browser) await closeImpl(browser, { label: '爱奇艺体育' })
    browser = undefined; loginPage = undefined; visible = false
  }
  async function ensure(headful = false) {
    if (browser?.connected && visible === headful) return browser
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
          const url = new URL(response.url())
          if (event.kind ? url.hostname !== 'cache.video.iqiyi.com' || url.pathname !== '/dash'
            : url.hostname !== 'live.video.iqiyi.com' || url.pathname !== '/live') return
          if (event.kind && url.searchParams.get('tvid') !== event.qipuId) return
          try {
            const text = (await response.text()).trim().replace(/^[\w.$]+\s*\(/, '').replace(/\);?\s*$/, '')
            const body = JSON.parse(text)
            if (event.kind) {
              if (String(body.data?.tvid) === event.qipuId || body.code && body.code !== 'A00000') resolve(body)
            // Member rooms answer with bossRet; complete free rooms may only carry streams.
            } else if (body.data?.bossRet || event.free && Array.isArray(body.data?.streams)) resolve({ data: body.data })
          } catch {}
        })
      })
      captured.catch(() => {})
      await page.goto(event.officialPage, { waitUntil: 'domcontentloaded', timeout: 35000 })
      const capturedBody = await captured
      const hasLogin = (await page.cookies()).some(c => c.name === 'P00001' && c.value)
      return { ...capturedBody, hasLogin }
    } finally { clearTimeout(timer); await page?.close().catch(() => {}); pages-- }
  }
  async function capture(event) {
    if (busy || state.status === 'waiting') throw new Error('爱奇艺正在处理登录操作，请完成或关闭登录窗口后再播放')
    pages++
    try { return await captureContext((await ensure()).defaultBrowserContext(), event) } finally { pages-- }
  }
  async function captureAnonymous(event) {
    if (busy || state.status === 'waiting') throw new Error('爱奇艺正在处理登录操作，请稍后核验')
    pages++
    let context
    try {
      context = await (await ensure()).createBrowserContext()
      return { ...await captureContext(context, event), hasLogin: false }
    } finally { await context?.close().catch(() => {}); pages-- }
  }
  async function verifyAccount(context) {
    const page = await context.newPage()
    try {
      // The same logged-in profile gets P00100 on top-level navigation to
      // this API, but A00000 from the official site's credentialed fetch.
      await page.goto('https://sports.iqiyi.com/resource/pc/index_pc.html', { waitUntil: 'domcontentloaded', timeout: 20000 })
      const account = await page.evaluate(async () => {
        const response = await fetch('https://passport.iqiyi.com/apis/user/info.action', { credentials: 'include' })
        const body = await response.json()
        return { ok: response.ok, code: body.code, hasUser: !!(body.data?.userinfo || body.data?.userInfo || body.data?.uid || body.data?.user_id) }
      })
      if (account.ok && account.code === 'P00100') throw Object.assign(new Error('官方未确认账号登录有效，请重新登录'), { credential: true })
      if (!account.ok || account.code !== 'A00000' || !account.hasUser) throw new Error('官方账号状态核验未完成，请稍后重试')
    } finally { await page.close() }
  }
  // The official player gives an expired login and a valid account without this room's
  // rights the same preview; the runtime asks this in the background before alerting.
  async function checkAccount() {
    if (busy || state.status === 'waiting') throw new Error('爱奇艺正在处理登录操作，请稍后核验')
    pages++
    try { await verifyAccount((await ensure()).defaultBrowserContext()) } finally { pages-- }
  }
  async function verify(context, event) {
    // A replay card may be marked paid while its video is publicly playable.
    // Complete VOD + cookie presence alone cannot validate imported credentials.
    if (event.kind) await verifyAccount(context)
    const result = await captureContext(context, event)
    let stream
    try { stream = selectAuthorizedMedia(result, event) }
    catch (error) {
      if (!error.credential) throw error
      // A paid live room answers a valid account without this match's rights the same
      // way it answers a logged-out visitor; ask the account API before blaming the login.
      if (!event.kind) await verifyAccount(context)
      // An extra-charge tennis replay or single-match room does not make a valid sports login expire.
      return { status: 'authenticated', authenticated: true, entitled: false,
        message: `账号登录有效；${event.title} 尚无完整观看权益。体育会员、单场直播、专项回放按官网分别校验；未兑换任何观赛券。` }
    }
    if (!result.hasLogin || !stream.member) throw new Error('没有确认本人登录后的赛事完整权限')
    return { status: 'authenticated', authenticated: true, entitled: true, message: `已确认完整观看权限：${event.title}` }
  }
  async function action(fn) {
    if (busy) throw new Error('爱奇艺正在处理另一个登录操作，请稍候')
    busy = true
    try {
      // Pause background eligibility probes, then let their in-flight pages finish.
      const deadline = Date.now() + 40000
      while (pages) {
        if (Date.now() >= deadline) throw new Error('爱奇艺当前播放解析尚未完成，请稍候')
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      return await fn()
    } finally { busy = false }
  }
  async function finishLoginWindow() {
    // Headful is only for the owner's login interaction. Reopen the same persisted
    // profile headlessly before any checks or background eligibility captures.
    if (visible) await close()
    if (state.status === 'waiting') state = { ...state, status: 'idle' }
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
      state = { ...state, status: 'waiting', message: '请在官方窗口完成扫码或短信验证码登录，然后点击「检查登录与权益」' }
      return snapshot()
    }),
    check: () => action(async () => {
      await finishLoginWindow()
      const event = await getEvent()
      if (!event) return { ...snapshot(), message: '当前目录没有可核验的会员直播或回放，暂时无法核验赛事权益；已保存的登录态保留' }
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
        await finishLoginWindow()
        const event = await getEvent()
        if (!event) throw new Error('当前目录没有可核验的会员直播或回放，无法验证导入凭证；请稍后导入，或在服务本机使用「本机官方网页登录」')
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
          if (error.credential) throw new Error('导入的 Cookie 未通过官方登录校验（可能已过期或已退出登录），现有登录态保留')
          throw error
        } finally { await staging.close() }
      })
    },
    cancel: () => action(async () => { await finishLoginWindow(); state = { ...state, status: 'idle', message: '登录窗口已关闭，后续核验在后台运行；已保存的登录态保留' }; return snapshot() }),
    close: () => action(async () => { await close(); state = { ...state, status: state.status === 'waiting' ? 'idle' : state.status, message: '后台浏览器已关闭，已保存的登录态会在下次播放时恢复' }; return snapshot() }),
  }
  return { flow, capture, captureAnonymous, checkAccount, revision: () => revision, shutdown: close }
}
