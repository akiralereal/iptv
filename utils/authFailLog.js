/**
 * 访问密码拒绝（「身份认证失败」）的日志行。
 *
 * 原来只打一句「身份认证失败」，看不出是哪台设备、拿什么地址来的，用户自己没法排查；
 * 播放器拿着不带密码的旧地址会每隔几秒重试，日志就一直刷同一句。
 * 这里补上：被拒的请求路径、来源 IP、播放器 UA，并按「同一来源 + 同一路径」每分钟只打一行，
 * 其间又被拒的次数记在下一行里。
 *
 * 路径里可能有旧密码、大小写打错的密码、用户令牌、历史地址 /<咪咕userId>/<token>/m3u 的账号段，
 * 用户常把日志截图贴到 issue / 群里，所以只留固定路由词和最后一段，其余段一律打成 ***；
 * 与当前密码只差大小写的段、/u/ 后面的令牌段，即使在最后也打码。不记查询串。
 */

const WINDOW_MS = 60 * 1000
const MAX_KEYS = 5000
const MASK = '***'
// 固定路由词：不是凭据，留着能看出请求的是台标、全代理还是令牌地址
const ROUTE_WORDS = new Set(['u', 'logos', 'logo-cache', 'logo-pack', 'relay', 'proxy'])

const windows = new Map()   // 「IP|UA|路径」 -> { last, suppressed }

function clean(value, max) {
  return String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max)
}

/** 被拒请求的路径，打码后用于日志。 */
export function maskAuthFailPath(urlPath, pass = '') {
  const segments = String(urlPath || '/').split('/').filter(Boolean)
  if (segments.length === 0) return '/'
  const lowerPass = String(pass || '').toLowerCase()
  const shown = segments.map((segment, index) => {
    if (lowerPass && segment.toLowerCase() === lowerPass) return MASK
    if (ROUTE_WORDS.has(segment)) return segment
    const isLast = index === segments.length - 1
    if (isLast && segments[index - 1] !== 'u') return clean(segment, 60)
    return MASK
  })
  return '/' + shown.join('/')
}

/**
 * 返回要打印的日志行；同一来源同一路径一分钟内已打过则返回 null（只计数）。
 * client: { ip, ua }
 */
export function authFailLogLine({ method, urlPath, pass, client, now = Date.now() }) {
  const ip = clean(client?.ip || '未知', 64)
  const ua = clean(client?.ua || '无UA', 120)
  const path = maskAuthFailPath(urlPath, pass)
  const key = `${ip}|${ua}|${path}`
  const state = windows.get(key)
  if (state && now - state.last < WINDOW_MS) {
    state.suppressed++
    return null
  }
  if (!state && windows.size >= MAX_KEYS) windows.clear()   // 诊断辅助表，粗暴清空即可
  const repeated = state?.suppressed ? `（距上一条又被拒 ${state.suppressed} 次）` : ''
  windows.set(key, { last: now, suppressed: 0 })
  return `身份认证失败（地址没带访问密码或密码不对）：${clean(method, 10)} ${path}｜${ip} UA:${ua.slice(0, 80)}${repeated}`
}

/** 测试用：清空计数窗口 */
export function resetAuthFailLog() {
  windows.clear()
}
