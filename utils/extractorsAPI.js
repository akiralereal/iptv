/**
 * 抓取模块管理 API —— 后台「源模块」板块的读写。
 *
 * 形态照 utils/epgSourcesAPI.js：每个操作都返回 { success, data: 整份最新状态 }，
 * 前端拿到就整体重渲染，不做增量补丁——省掉「前端副本已过期、整份 POST 把
 * 服务端新数据回滚成打开页面时的旧值」那类问题（外部源那边为此打过补丁）。
 *
 * 凭据不回传明文：getState() 里 secret 字段只回 hasValue。未设访问密码的部署
 * 后台是无鉴权的，别把新增的凭据也做成明文可读。
 */
import { getExtractorManager } from "./extractorManager.js"
import { getModule, listModules } from "../extractors/registry.js"
import { setSystemFlagAPI } from "./systemConfigAPI.js"
import { enableBuiltInSources, enableBuiltInSubscriptions } from "../config.js"
import { updateExtractors } from "./channelMerger.js"
import update from "./updateData.js"
import { printRed } from "./colorOut.js"
import { reseedBuiltInSubscriptions } from "./externalSources.js"
import { externalSourceManager } from "./channelMerger.js"

/**
 * 触发一次播放列表重新生成，让开关即时反映到 /m3u。
 *
 * /m3u 吐的是预生成的 interface.txt，光改内存态不重生成的话，关掉的模块的频道
 * 还会留在播放列表里，直到下一轮定时更新——与「关掉即不出现在播放列表」不符。
 *
 * hours 传 1 而不是 0：updateTV 里 `if (enableMigu && !(hours % 720))` 会顺带打
 * 一次咪咕 token 刷新，而 0 % 720 === 0 恒真。那本该是每月一次的动作
 * （config.js 原注释：可能是导致封号的原因），不该被一次点开关带出来。
 * regenerateOnly 的早退在这段之前，护不住它。
 *
 * fire-and-forget：不阻塞响应；update() 内部有串行队列，并发安全。
 */
function regeneratePlaylist() {
  update(1, { regenerateOnly: true })
    .catch(error => printRed(`抓取模块变更后重新生成播放列表失败: ${error.message}`))
}

function ok(manager) {
  return { success: true, data: { ...manager.getState(), contentFlags: readContentFlags() } }
}

/** 「其它内容来源」那一段的当前值。放在同一个响应里，前端一次渲染完。 */
function readContentFlags() {
  return {
    enableBuiltInSources,
    enableBuiltInSubscriptions,
  }
}

/** 这一页能改的全部内容开关（单开关与批量共用），数组顺序即批量写入顺序。咪咕不在此列，见 contentFlagChanges。 */
const CONTENT_FLAG_KEYS = ['enableBuiltInSources', 'enableBuiltInSubscriptions']
/** 报错里用的名字，与后台「内置源」两张卡片的标题一致。 */
const CONTENT_FLAG_NAMES = { enableBuiltInSources: '内置单频道源', enableBuiltInSubscriptions: '内置订阅源' }

function fail(error) {
  const result = { success: false, message: error?.message || String(error) }
  if (error?.fieldErrors) result.fieldErrors = error.fieldErrors
  return result
}

/** 整份状态：模块清单 + 各自的开关/配置/健康。 */
export function getExtractorsAPI() {
  try {
    return ok(getExtractorManager())
  } catch (error) {
    return fail(error)
  }
}

/**
 * 写一个内容开关，连同它的附带动作。单开关与批量开关共用；不重生成播放列表——
 * 由调用方在全部改完后统一触发一次。
 */
function writeContentFlag(key, enabled) {
  const result = setSystemFlagAPI(key, enabled)
  if (!result.success) return result

  // 打开「内置订阅源」时把它播种回来。
  //
  // 内置订阅在「源管理 → 自定义源」里已经不露面了（那是维护者策展的内容，不给用户
  // 改名/换序/删除），用户唯一的控制就是这个开关。而启动期的 ensureBuiltInSubscriptions
  // 认 seededBuiltInUrls 账本 —— 对「曾经删过它的老用户」直接 continue，于是开关
  // 点了也不会回来，等于没有控制。这里显式重新播种，绕开那个账本：
  // 账本的意思是「别自己复活」，用户主动点开关是明确要它，两回事。
  if (key === 'enableBuiltInSubscriptions' && enabled !== false) {
    try {
      if (reseedBuiltInSubscriptions(externalSourceManager.sources)) {
        externalSourceManager.saveSources()
      }
    } catch (error) {
      printRed(`重新加入内置订阅源失败: ${error.message}`)
    }
  }
  return result
}

/**
 * 「源模块」页下半部分那两个内容开关：内置单频道源 / 内置订阅源。
 *
 * 它们不是抓取模块（由 builtInSourceManager 与内置订阅管），但用户希望所有
 * 内容来源的开关集中在一处，所以一并放在这一页、单独成段，避免让人以为
 * 上面那个「启用源模块」总开关也管着它们。
 */
export function setContentFlagAPI(key, enabled) {
  if (!CONTENT_FLAG_KEYS.includes(key)) return { success: false, message: `不支持的开关: ${key}` }
  const result = writeContentFlag(key, enabled)
  if (!result.success) return result
  regeneratePlaylist()
  return ok(getExtractorManager())
}

/**
 * 批量请求里的内容开关：只认上面那两个键、值必须是严格布尔，否则抛错。
 * 返回要写的 [key, value]，与当前值相同的跳过（不为没变的开关白写一次 system-config.json）。
 *
 * 必须在动任何开关**之前**调——它挡下的请求要保证什么都没变。咪咕不在这里：它是抓取
 * 模块，走 modules 那一半（代理到 enableMigu 的 setter），两条路写同一个值只会打架。
 * current 可注入，测试不用碰 config.js 的真实值。
 */
export function contentFlagChanges(contentFlags, current = readContentFlags()) {
  if (contentFlags === undefined) return []
  if (!contentFlags || typeof contentFlags !== 'object' || Array.isArray(contentFlags)) {
    throw new Error('contentFlags 要传「开关名 → true/false」的对象')
  }
  for (const [key, value] of Object.entries(contentFlags)) {
    if (!CONTENT_FLAG_KEYS.includes(key)) throw new Error(`不支持的开关: ${key}`)
    if (typeof value !== 'boolean') throw new Error(`${key} 的值要是 true / false`)
  }
  return CONTENT_FLAG_KEYS
    .filter(key => Object.prototype.hasOwnProperty.call(contentFlags, key) && contentFlags[key] !== current[key])
    .map(key => [key, contentFlags[key]])
}

/** 各模块此刻的生效开关，批量前后各取一次，比出「到底变没变」。 */
function enabledSnapshot(manager) {
  return new Map(listModules().map(module => [module.id, manager.isModuleEnabled(module)]))
}

/**
 * 批量开关（后台「批量开关」弹窗，issue #189「建议出个精简版」）。
 *
 * 一次改多张模块卡片 + 两个内置源开关，省掉挨个点七十来张卡片。模块那一半交给
 * manager.setModulesEnabled（整批原子：报错即什么都没变）；它写的就是每张卡片自己的开关，
 * 不是另一层白名单，理由见那里的注释。
 *
 * 顺序：先校验内容开关 → 再改模块 → 最后写内容开关。内容开关写在最后，是因为模块那一半
 * 能整批回滚，system-config.json 的写入撤不回来；两边都校验过了才动手。
 * 播放列表只在真有东西变了时重生成一次，不是每个开关一次。
 */
export function setExtractorsEnabledAPI({ modules, contentFlags } = {}) {
  let flagChanges
  try {
    flagChanges = contentFlagChanges(contentFlags)
  } catch (error) {
    return fail(error)
  }

  let manager
  let modulesChanged = false
  try {
    manager = getExtractorManager()
    const before = enabledSnapshot(manager)
    manager.setModulesEnabled(modules)
    for (const [id, on] of enabledSnapshot(manager)) {
      if (before.get(id) !== on) { modulesChanged = true; break }
    }
  } catch (error) {
    return fail(error)
  }

  const savedFlags = []
  for (const [key, value] of flagChanges) {
    const result = writeContentFlag(key, value)
    if (!result.success) {
      // 前面已经落盘生效的（模块开关、先写成功的那个内容开关）不能因为后半截失败就当整单
      // 没发生：照样重生成，让播放列表跟上已经变了的那部分；报错里说清楚哪些存上了、哪个没有。
      if (modulesChanged || savedFlags.length) regeneratePlaylist()
      const saved = [
        ...(modulesChanged ? ['模块开关'] : []),
        ...savedFlags.map(flag => `「${CONTENT_FLAG_NAMES[flag]}」`),
      ]
      const prefix = saved.length ? `${saved.join('、')}已保存，但` : ''
      return { success: false, message: `${prefix}「${CONTENT_FLAG_NAMES[key]}」保存失败：${result.message}` }
    }
    savedFlags.push(key)
  }

  if (modulesChanged || savedFlags.length) regeneratePlaylist()
  return ok(manager)
}

/**
 * 模块登录流程：生成二维码。
 *
 * 通用实现：模块声明 loginFlow.start 就有，本层不认识任何平台。二维码在**服务端**
 * 生成成 data URI —— 前端因此不用 vendor 任何第三方二维码代码进 admin.html
 *（那是个 7000 行的无构建单文件，往里塞第三方实现既难审也难验）。
 */
/**
 * 扫码会话：qrcode_key → 该次登录用的设备标识（cookie）。
 *
 * 必须服务端自己记：B 站把这次登录绑在设备标识上，generate 与 poll 得用同一个，
 * 换一个等于换了台设备。**不经过前端**——它是会话凭据的一部分，没理由在浏览器里绕一圈。
 * 只留最近若干条，避免长期运行的实例里无限堆积（每条也就百来字节，但没有上限就是泄漏）。
 */
const loginSessions = new Map()
const MAX_LOGIN_SESSIONS = 20

export async function startModuleLoginAPI(id) {
  const module = getModule(id)
  if (!module?.loginFlow?.start) return { success: false, message: `${id} 不支持扫码登录` }
  try {
    const { url, key, cookie } = await module.loginFlow.start()
    if (cookie) {
      // 先进先出地裁剪：Map 保持插入顺序，最早的那条就是最没用的
      while (loginSessions.size >= MAX_LOGIN_SESSIONS) {
        loginSessions.delete(loginSessions.keys().next().value)
      }
      loginSessions.set(key, cookie)
    }
    const { default: QRCode } = await import('qrcode')
    const image = await QRCode.toDataURL(url, { margin: 1, width: 240, errorCorrectionLevel: 'M' })
    return { success: true, data: { key, image } }
  } catch (error) {
    return { success: false, message: error?.message || String(error) }
  }
}

/**
 * 模块登录流程：轮询扫码状态。成功时把凭据直接写进模块配置。
 *
 * 凭据**不回传给前端**：它等同登录态，而未设访问密码的部署后台是无鉴权的。
 * 服务端拿到就直接存，前端只需要知道「成了」。
 */
export async function pollModuleLoginAPI(id, key) {
  const module = getModule(id)
  if (!module?.loginFlow?.poll) return { success: false, message: `${id} 不支持扫码登录` }
  try {
    const k = String(key || '')
    const result = await module.loginFlow.poll(k, { cookie: loginSessions.get(k) || '' })
    if (result.status !== 'ok') {
      // 终态就把会话丢掉，别让失败的 key 一直占着
      if (result.status === 'expired' || result.status === 'failed') loginSessions.delete(k)
      return { success: true, data: { status: result.status, message: result.message } }
    }
    loginSessions.delete(k)
    const manager = getExtractorManager()
    manager.updateModuleConfig(id, { [module.loginFlow.configKey]: result.sessdata })
    return { ...ok(manager), data: { ...ok(manager).data, status: 'ok', message: '登录成功，凭据已保存' } }
  } catch (error) {
    return { success: false, message: error?.message || String(error) }
  }
}

/**
 * 持久浏览器登录流程。与上面的二维码 loginFlow 分开：这里没有要写进
 * extractors.json 的 token，登录态只留在模块自己的浏览器 profile 中。
 */
function safeBrowserLoginState(value = {}) {
  const account = value.account && typeof value.account === 'object'
    ? {
        nickname: String(value.account.nickname || '').slice(0, 120),
        type: String(value.account.type || '').slice(0, 40),
        vip: value.account.vip === true,
      }
    : null
  return {
    status: String(value.status || 'idle').slice(0, 32),
    message: String(value.message || '').slice(0, 500),
    active: value.active === true,
    available: value.available !== false,
    reason: String(value.reason || '').slice(0, 500),
    running: value.running === true,
    visible: value.visible === true,
    authenticated: value.authenticated === true,
    ...(typeof value.entitled === 'boolean' ? { entitled: value.entitled } : {}),
    account,
  }
}

function browserLoginModule(id, method) {
  const module = getModule(id)
  if (!module?.browserLoginFlow || typeof module.browserLoginFlow[method] !== 'function') {
    throw new Error(`${id} 不支持浏览器登录${method === 'status' ? '状态查询' : ''}`)
  }
  return module
}

async function runBrowserLoginAction(id, method, ...args) {
  try {
    const module = browserLoginModule(id, method)
    const state = await module.browserLoginFlow[method](...args)
    return { success: true, data: safeBrowserLoginState(state) }
  } catch (error) {
    return fail(error)
  }
}

export const startBrowserLoginAPI = id => runBrowserLoginAction(id, 'start')
export const getBrowserLoginStatusAPI = id => runBrowserLoginAction(id, 'status')
export const checkBrowserLoginAPI = id => runBrowserLoginAction(id, 'check')
export const cancelBrowserLoginAPI = id => runBrowserLoginAction(id, 'cancel')
export const closeBrowserLoginAPI = id => runBrowserLoginAction(id, 'close')
/**
 * 导入用户在自己浏览器里拿到的登录态（Docker / NAS 没有桌面、弹不出登录窗时的路径）。
 * 内容只透传给模块种进它自己的浏览器 profile，本层不解析、不落盘、不进 extractors.json。
 */
export const importBrowserLoginAPI = (id, payload) => {
  if (typeof payload !== 'string' || !payload.trim()) return fail(new Error('请先粘贴登录态内容'))
  if (payload.length > 64 * 1024) return fail(new Error('登录态内容过长'))
  return runBrowserLoginAction(id, 'import', payload)
}

/** 单模块开关。 */
export function setExtractorEnabledAPI(id, enabled) {
  try {
    const manager = getExtractorManager()
    manager.setModuleEnabled(id, enabled)
    // 开关改变的是「已抓到的频道要不要出现」，用缓存重生成即可，不必重抓
    regeneratePlaylist()
    return ok(manager)
  } catch (error) {
    return fail(error)
  }
}

/** 保存单模块配置。校验不过直接拒绝并返回字段级错误，不落盘。 */
export function updateExtractorConfigAPI(id, config, refreshMinutes) {
  try {
    const manager = getExtractorManager()
    manager.updateModuleConfig(id, config, { refreshMinutes })
    return ok(manager)
  } catch (error) {
    return fail(error)
  }
}

/**
 * 立即抓一次。
 *
 * 抓取可能是数十秒（模块级墙钟上限 90s），HTTP 请求不等它——立即返回，
 * 前端靠轮询 GET 看 health 变化。否则后台按钮会转很久，用户以为卡死。
 */
export function runExtractorNowAPI(id) {
  const manager = getExtractorManager()
  try {
    if (!manager.getState().modules.some(m => m.id === id)) {
      return { success: false, message: `未知的抓取模块: ${id}` }
    }
  } catch (error) {
    return fail(error)
  }

  // fire-and-forget。这里刻意不 await，也不能让它的异常冒泡成未处理拒绝。
  // 抓完要重生成播放列表，否则新地址要等到下一轮定时更新才写进 /m3u。
  updateExtractors({ onlyId: id, forceAll: true })
    .then(() => regeneratePlaylist())
    .catch(error => printRed(`抓取模块 ${id} 手动刷新失败: ${error.message}`))

  // 走 ok() 而不是裸 getState()：前端是「整份替换 extractorsState 后重渲染」，
  // 少了 contentFlags 那一半，两个内置源开关会在界面上弹回「开」——后端明明是关的，
  // 且不报错、不还原，直到下一次 loadExtractors。
  return { ...ok(manager), message: '已开始刷新，稍后刷新页面查看结果' }
}
