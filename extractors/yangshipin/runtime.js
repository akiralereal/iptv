import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { debug } from '../../config.js'
import { checkModuleBurst } from '../../utils/clientScanGuard.js'
import { printBlue, printGrey, printRed, printYellow } from '../../utils/colorOut.js'
import { dataPath } from '../../utils/paths.js'
import { AUTH_CHANNEL_BY_ID, AUTH_CHANNEL_BY_REF } from './channels.js'
import {
  browserLoginAvailability,
  LoginRequiredError,
  parseImportedLoginState,
  YspBrowserLogin,
  YspBrowserSession,
} from './browser-auth.js'
import { VipMseBridge } from './vip-bridge.js'

const firstLine = error => String(error?.message || error || '未知错误').split('\n')[0]
const log = message => printBlue(`[央视频] ${message}`)
const ACCOUNT_STATUS_TTL = 5 * 60_000

/**
 * 登录态保活。官网 SDK 只在浏览器页面开着时才续期：刷新令牌 48 小时一到就作废，而后台
 * Chromium 会员频道停播 3 分钟后就关掉、不会自己再开——家里两天没人看会员频道，登录就没了。
 * 所以只要「关联过账号」（标记文件在），就每隔一段时间静默拉起后台会话、让 SDK 续一次
 * 再由空闲回收关掉。标记里只有昵称和时间，不含任何凭据；没关联过的部署永远不会为此启动浏览器。
 */
const LOGIN_LINK_MARKER = dataPath('yangshipin/login-linked.json')
const LOGIN_KEEPALIVE_INTERVAL_MS = 6 * 60 * 60_000
const LOGIN_KEEPALIVE_INITIAL_DELAY_MS = 90_000

function readLoginLink() {
  try { return JSON.parse(readFileSync(LOGIN_LINK_MARKER, 'utf8')) } catch { return null }
}

function rememberLoginLink(status) {
  try {
    if (status?.authenticated) {
      mkdirSync(dirname(LOGIN_LINK_MARKER), { recursive: true })
      writeFileSync(LOGIN_LINK_MARKER, JSON.stringify({
        linkedAt: readLoginLink()?.linkedAt || new Date().toISOString(),
        verifiedAt: new Date().toISOString(),
        nickname: String(status.account?.nickname || ''),
        vip: status.account?.vip === true,
      }, null, 2))
      scheduleLoginKeepalive()
    } else if (existsSync(LOGIN_LINK_MARKER)) {
      unlinkSync(LOGIN_LINK_MARKER)
    }
  } catch (error) {
    printYellow(`[央视频] 记录登录关联状态失败：${firstLine(error)}`)
  }
}

const browserSession = new YspBrowserSession({ logger: log, onAccount: rememberLoginLink })
const vipBridge = new VipMseBridge(browserSession, { logger: log, traceNetwork: debug })
const browserLogin = new YspBrowserLogin(browserSession, {
  beforeOpen: async () => {
    await vipBridge.suspend()
  },
  restore: async () => {
    await vipBridge.resume()
    // finish() 紧接着会读 SDK 再确认一次；这里必须先用同一 profile 恢复后台页。
    await browserSession.ensureBrowser({ visible: false })
  },
})

browserSession.canYield = () => vipBridge.isIdle() && !browserLogin.active()

function statusSnapshot() {
  const state = browserLogin.status()
  // 浏览器运行时只信刚从当前页面验证过的 session.account；关闭后可短暂展示上次
  // 已确认结果，但不永久把旧昵称/VIP 标成有效。详情页会主动 check() 刷新。
  const cachedAccountFresh = state.account && state.lastVerifiedAt
    && Date.now() - state.lastVerifiedAt < ACCOUNT_STATUS_TTL
  const account = browserSession.running
    ? browserSession.account
    : (cachedAccountFresh ? state.account : null)
  const snapshot = {
    ...state,
    ...browserLoginAvailability(),
    running: browserSession.running,
    visible: browserSession.visible,
    authenticated: Boolean(account),
    account: account ? { ...account } : null,
  }
  if (!snapshot.active && state.account && !account) {
    snapshot.status = 'idle'
    snapshot.message = '央视频登录态需要重新检查'
  }
  return snapshot
}

export const browserLoginFlow = {
  status() {
    return statusSnapshot()
  },

  start() {
    const availability = browserLoginAvailability()
    if (!availability.available) throw new Error(availability.reason)
    browserLogin.start()
    return statusSnapshot()
  },

  async check() {
    if (browserLogin.active()) return statusSnapshot()
    vipBridge.lastActivity = Date.now()
    await browserSession.ensureBrowser({ visible: false })
    const account = await browserSession.readAccount()
    vipBridge.lastActivity = Date.now()
    browserLogin.noteAccount(account)
    return statusSnapshot()
  },

  async cancel() {
    await browserLogin.cancel()
    return statusSnapshot()
  },

  async close() {
    await browserLogin.cancel({ restore: false })
    await vipBridge.suspend()
    await browserSession.close()
    await vipBridge.resume()
    browserLogin.noteAccount({ authenticated: false, account: null })
    return statusSnapshot()
  },

  /**
   * 导入用户自己浏览器里的登录态（书签工具 / Cookie 头）。不需要桌面，远程后台也能调。
   * 先解析再碰浏览器：内容不对时不会白起一次 Chromium。
   */
  async import(payload) {
    if (browserLogin.active()) throw new Error('央视频正在进行登录关联，请等它完成或取消后再导入')
    const cookies = parseImportedLoginState(payload)
    await vipBridge.suspend()
    let status
    try {
      vipBridge.lastActivity = Date.now()
      status = await browserSession.importLoginCookies(cookies)
    } finally {
      await vipBridge.resume()
    }
    browserLogin.noteAccount(status)
    if (!status.authenticated) {
      throw new Error(explainImportFailure(status.diagnostic))
    }
    log(`已通过导入关联央视频账号：${status.account?.nickname || '已登录'}${status.account?.vip ? ' · VIP 有效' : ' · 未识别 VIP'}`)
    return statusSnapshot()
  },
}

/**
 * 把导入失败翻译成用户能照着做的话，并把完整诊断打进日志。
 * 判断顺序：刷新接口被拒（令牌已作废）→ 用户信息接口被拒 → SDK 校验后清空了 cookie → 导入内容本身缺身份 cookie。
 */
function explainImportFailure(diagnostic) {
  const generic = '请在央视频官网确认右上角已显示昵称，刷新页面后在开发者工具 Network 里重新复制 Cookie 值并立即导入'
  if (!diagnostic) return `官网没有认出这份登录态：${generic}`
  const api = diagnostic.api || []
  printYellow(`[央视频] 导入登录态未通过官网校验：种入 ${diagnostic.imported?.length ?? 0} 个 cookie [${(diagnostic.imported || []).join(', ')}]；校验后剩余 [${(diagnostic.remaining || []).join(', ')}]；isSigned=${JSON.stringify(diagnostic.signed)}；接口：${api.length ? api.join(' | ') : '（无账号接口请求）'}`)
  const failed = api.filter(line => !/ HTTP 2\d\d code=0 data\.code=(?:0|-)/.test(line))
  const refresh = failed.find(line => line.includes('/v1/auth/account/refresh'))
  if (refresh) {
    if (/10005|inner token/i.test(refresh)) {
      return `官网续期接口回「inner token失效」（${refresh}）：会话 cookie 已作废或不配套，通常是电脑上的官网页面在你复制之后又续期了一次。请回到官网刷新页面确认仍是登录状态，重新复制 Cookie 值后马上导入`
    }
    return `官网拒绝了这份登录态的刷新令牌（${refresh}）：${generic}`
  }
  const userinfo = failed.find(line => line.includes('/v1/user/userinfo'))
  if (userinfo) {
    return `官网用户信息接口不认这份登录态（${userinfo}）：${generic}`
  }
  const identity = ['ysp_openid', 'yspopenid', 'vusession']
  const importedIdentity = (diagnostic.imported || []).filter(name => identity.includes(name))
  const remainingIdentity = (diagnostic.remaining || []).filter(name => identity.includes(name))
  if (importedIdentity.length && !remainingIdentity.length) {
    return `官网 SDK 校验后清掉了登录 cookie，说明这份登录态已失效：${generic}`
  }
  if (!importedIdentity.length) {
    return `导入内容里没有 vusession 这类会话 cookie，官网无法识别账号：请在开发者工具 Network 里点开任一 yangshipin.cn 请求，复制 Request Headers 中 Cookie 的完整值`
  }
  return `官网没有认出这份登录态（isSigned=${JSON.stringify(diagnostic.signed)}）：${generic}`
}

let keepaliveTimer = null
let keepaliveRunning = null

/** 拉起后台会话读一次账号：SDK 会在 endtime 临近时自动续期；之后交给空闲回收关掉浏览器。 */
export async function runLoginKeepalive({ force = false } = {}) {
  if (keepaliveRunning) return keepaliveRunning
  keepaliveRunning = (async () => {
    if (!force && !existsSync(LOGIN_LINK_MARKER)) return { skipped: 'unlinked' }
    if (browserLogin.active() || browserSession.visible) return { skipped: 'busy' }
    try {
      vipBridge.lastActivity = Date.now()
      await browserSession.ensureBrowser({ visible: false })
      const status = await browserSession.readAccount()
      vipBridge.lastActivity = Date.now()
      browserLogin.noteAccount(status)
      if (status.authenticated) {
        log(`登录态保活完成：${status.account?.nickname || '已登录'}${status.account?.vip ? ' · VIP 有效' : ''}`)
      } else {
        printYellow('[央视频] 登录态保活：官网未识别到账号，会员频道需要重新登录或导入登录态')
      }
      return status
    } catch (error) {
      printYellow(`[央视频] 登录态保活失败：${firstLine(error)}`)
      return { error: firstLine(error) }
    }
  })().finally(() => { keepaliveRunning = null })
  return keepaliveRunning
}

function scheduleLoginKeepalive() {
  if (keepaliveTimer) return
  // 首次延后一会儿再跑：让启动时的频道表生成先过去，别和它抢浏览器池
  const first = setTimeout(() => {
    runLoginKeepalive().catch(() => {})
    keepaliveTimer = setInterval(() => runLoginKeepalive().catch(() => {}), LOGIN_KEEPALIVE_INTERVAL_MS)
    keepaliveTimer.unref?.()
  }, LOGIN_KEEPALIVE_INITIAL_DELAY_MS)
  first.unref?.()
  keepaliveTimer = first
}

if (existsSync(LOGIN_LINK_MARKER)) scheduleLoginKeepalive()

function isTopLevelRef(path) {
  const ref = String(path || '').split('/').filter(Boolean).at(-1) || ''
  return AUTH_CHANNEL_BY_REF.has(ref) ? ref : ''
}

export function claimsLocalPath(path) {
  const value = String(path || '')
  return value.startsWith('/ysp-vip/') || Boolean(isTopLevelRef(value))
}

function response(status, contentType, body = '', headers = {}) {
  const length = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(String(body))
  return {
    status,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store',
      ...(length ? { 'Content-Length': length } : {}),
      ...headers,
    },
    body,
  }
}

function rangeResponse(body, rangeHeader) {
  const total = body.length
  const baseHeaders = { 'Accept-Ranges': 'bytes' }
  if (!rangeHeader) return response(200, 'video/mp4', body, baseHeaders)
  const match = String(rangeHeader).match(/^bytes=(\d*)-(\d*)$/)
  if (!match) return response(416, 'video/mp4', '', { ...baseHeaders, 'Content-Range': `bytes */${total}` })
  let start = 0
  let end = total - 1
  if (!match[1] && match[2]) start = Math.max(0, total - Number(match[2]))
  else {
    start = Number(match[1] || 0)
    if (match[2]) end = Number(match[2])
  }
  end = Math.min(end, total - 1)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= total) {
    return response(416, 'video/mp4', '', { ...baseHeaders, 'Content-Range': `bytes */${total}` })
  }
  const part = body.subarray(start, end + 1)
  return response(206, 'video/mp4', part, {
    ...baseHeaders,
    'Content-Range': `bytes ${start}-${end}/${total}`,
  })
}

/**
 * 会员频道的批量探测防护。公开频道经 channel() → resolve 已有 resolveBurstGuard，会员频道走本地
 * 媒体路由、不经 resolve，得在这里自己接上，并与公开频道共用「央视频｜客户端」一本账：一次扫描
 * 从 63 个公开台一路扫进会员台，是同一次扫描。
 *
 * 真正花钱的是启动解扰桥：开一个浏览器页、用会员账号打开官网点进频道、最多等 25 秒片段，
 * 启动还是排队串行的，客户端断开也不取消，同时最多 3 路、第 4 路会挤掉最久没用的一路。
 * 入口主清单本身是本地写死的文本，但放行它播放器就会接着拉子清单、触发启动，所以两处都卡。
 * 该频道的桥已在跑或正在启动时照常放行（exempt）：再给它请求不多开页，也不会误伤重拉主清单的观众。
 * 分片只读已在跑的桥、HEAD/OPTIONS 本地应答，都不会启动任何东西，不过防护。
 */
function vipBurstRefusal(channel, client) {
  const verdict = checkModuleBurst({
    moduleId: 'yangshipin',       // 与 index.js 的 id 一致，公开/会员两条路由才落到同一本账
    moduleName: '央视频',
    client,
    channelKey: `ysp-vip-${channel.id}`,
    exempt: vipBridge.isActive(channel.id),
  })
  if (verdict.allowed) return null
  if (verdict.logLine) printYellow(verdict.logLine)
  return response(429, 'text/plain;charset=UTF-8', verdict.desc, { 'Retry-After': String(verdict.retryAfterSeconds) })
}

/**
 * 会员频道请求跟踪：mdebug=1 时逐条打印播放器拉了哪份清单、哪个分片、离最新几片。
 * 排「刚打开卡 / 播着播着卡」时，用它对照「解扰桥就绪」日志与官网分片到达节奏，看卡在哪一侧。
 */
function traceVip(channel, client, describe) {
  if (!debug) return
  try { printGrey(`[央视频] ${channel.name} ${describe()}｜${client?.tag || ''}`) } catch { /* 跟踪日志不影响播放 */ }
}

/** 模块本地媒体路由；app.js 只负责鉴权、选择模块及写 HTTP 响应。 */
export async function handleLocalRequest({ path, method = 'GET', headers = {}, accessPrefix = '', client } = {}) {
  const value = String(path || '')
  const playlistMatch = value.match(/^\/ysp-vip\/([a-z0-9]+)\/(video|audio)\.m3u8$/i)
  const assetMatch = value.match(/^\/ysp-vip\/([a-z0-9]+)\/(video|audio)\/(init|v?\d+|vpad\d+)\.(?:mp4|m4s)$/i)
  const topRef = isTopLevelRef(value)
  const channel = topRef
    ? AUTH_CHANNEL_BY_REF.get(topRef)
    : AUTH_CHANNEL_BY_ID.get(playlistMatch?.[1] || assetMatch?.[1] || '')

  if (!channel) return response(404, 'text/plain;charset=UTF-8', '没有这个央视频会员频道')
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    return response(405, 'text/plain;charset=UTF-8', '只支持 GET/HEAD', { Allow: 'GET, HEAD, OPTIONS' })
  }
  if (method === 'OPTIONS') {
    return response(200, playlistMatch || topRef ? 'application/vnd.apple.mpegurl' : 'video/mp4')
  }
  if (method === 'HEAD') {
    if (topRef) {
      const result = response(200, 'application/vnd.apple.mpegurl', vipBridge.master(channel, accessPrefix))
      result.body = ''
      return result
    }
    if (playlistMatch) return response(200, 'application/vnd.apple.mpegurl')
    const body = vipBridge.asset(channel, assetMatch[2].toLowerCase(), assetMatch[3], { touch: false })
    if (!body) return response(404, 'text/plain;charset=UTF-8', '央视频会员片段已过期，请让播放器刷新清单')
    const result = rangeResponse(body, headers.range)
    result.body = ''
    return result
  }
  if (browserLogin.active()) {
    return response(409, 'text/plain;charset=UTF-8', '央视频正在完成登录关联，请稍后重试')
  }
  if (topRef || playlistMatch) {
    const refused = vipBurstRefusal(channel, client)
    if (refused) return refused
  }

  try {
    if (topRef) {
      return response(200, 'application/vnd.apple.mpegurl', vipBridge.master(channel, accessPrefix))
    }
    if (playlistMatch) {
      const kind = playlistMatch[2].toLowerCase()
      const body = await vipBridge.playlist(channel, kind, accessPrefix, { userAgent: headers['user-agent'] })
      if (debug) {
        const state = vipBridge.streams.get(channel.id)
        const media = state ? await vipBridge.mediaState(state) : null
        traceVip(channel, client, () => {
          const sequences = [...body.matchAll(/\/(v?\d+)\.m4s/g)].map(match => match[1])
          return `${kind} 清单 ${sequences.length} 片 #${sequences[0]}..#${sequences.at(-1)}；${vipBridge.describeMedia(media)}`
        })
      }
      return response(200, 'application/vnd.apple.mpegurl', body)
    }
    const kind = assetMatch[2].toLowerCase()
    const body = vipBridge.asset(channel, kind, assetMatch[3])
    traceVip(channel, client, () => {
      if (assetMatch[3] === 'init') return `${kind} init${body ? '' : '（已过期）'}`
      const edge = /^\d+$/.test(assetMatch[3]) ? vipBridge.edge(channel, kind) : null
      const behind = edge == null ? '' : `，距最新 ${edge - Number(assetMatch[3])} 片`
      return `${kind} #${assetMatch[3]}${behind}${headers.range ? ` range=${headers.range}` : ''}${body ? '' : '（已过期）'}`
    })
    if (!body) return response(404, 'text/plain;charset=UTF-8', '央视频会员片段已过期，请让播放器刷新清单')
    return rangeResponse(body, headers.range)
  } catch (error) {
    const reason = error?.name === 'AbortError' ? '请求超时' : firstLine(error)
    if (error instanceof LoginRequiredError) printYellow(`[央视频] ${channel.name}：${reason}`)
    else printRed(`[央视频] ${channel.name} 播放失败：${reason}`)
    return response(error instanceof LoginRequiredError ? 401 : 502, 'text/plain;charset=UTF-8', reason)
  }
}

let shuttingDown = null
export function shutdown() {
  if (shuttingDown) return shuttingDown
  shuttingDown = (async () => {
    clearTimeout(keepaliveTimer)
    clearInterval(keepaliveTimer)
    keepaliveTimer = null
    await browserLogin.cancel({ restore: false })
    await vipBridge.close()
    await browserSession.close()
  })().catch(error => printRed(`[央视频] 关闭浏览器会话失败：${firstLine(error)}`))
  return shuttingDown
}

// 测试只读导出，不在业务层直接操纵这些对象。
export const runtime = {
  browserSession,
  vipBridge,
  browserLogin,
  loginLink: { markerPath: LOGIN_LINK_MARKER, read: readLoginLink, remember: rememberLoginLink },
}
