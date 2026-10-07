/**
 * 咪咕账号 Token 失效的发现与提醒。
 *
 * 咪咕对过期、被顶掉或乱填的 Token 不报错：取流接口照样回 200 和可播地址，只是按游客给
 * （auth.logined=false，最高 540P）。2026-10-06 用乱填的 userId/Token 实测如此。不查的话
 * 画质静默掉档，用户根本察觉不到。所以「配了账号、回应却是未登录」= Token 已失效。
 *
 * 两条路发现：播放时取流回应里带着 logined（noteAuth），刷新时用第一个频道要一次地址
 * （checkAccount）。结论交给后台提醒中心（见 registry.js 的 credentialRejected）。
 */
import { createHash } from 'node:crypto'
import { getAndroidURL } from './androidURL.js'

export const TOKEN_REJECTED_NOTICE = '咪咕不认当前账号 Token（已过期或已在别处退出登录），已自动按游客播放（最高 540p）；请重新获取咪咕账号'

const accountKey = (userId, token) => createHash('sha256').update(`${userId}\n${token}`).digest('base64url').slice(0, 12)

// 被拒的账号（只存摘要）。换了账号自然不再相等；刷新检查或播放时重新登录成功就清掉。
let rejectedKey = ''

/**
 * 播放时记下取流回应里的登录结果。只认后台配置的账号——地址里 /userId/token 带的别人账号
 * 不该让站长的后台报警。
 */
export function noteAuth(userId, token, config, content) {
  if (!userId || !token || userId !== (config?.userId || '') || token !== (config?.token || '')) return
  const logined = content?.body?.auth?.logined
  if (logined === false) rejectedKey = accountKey(userId, token)
  else if (logined === true && rejectedKey === accountKey(userId, token)) rejectedKey = ''
}

/** 后台状态接口用：当前配置的账号是否已被咪咕拒绝。 */
export function credentialRejected(config) {
  const userId = config?.userId || ''
  const token = config?.token || ''
  return userId && token && accountKey(userId, token) === rejectedKey ? TOKEN_REJECTED_NOTICE : ''
}

/**
 * 刷新时用配置的账号给一个频道要一次 720p 地址，看咪咕认不认这个账号。
 * 返回 { rejected } / { warning } / {}；没配账号或检查通过时返回空对象。
 */
export async function checkAccount(config, pid, opts = {}) {
  const userId = config?.userId || ''
  const token = config?.token || ''
  if (!userId || !token || !pid) return {}
  let resObj
  try {
    resObj = await getAndroidURL(userId, token, String(pid), 3, opts)
  } catch (error) {
    return { warning: `咪咕账号检查没有完成：${error?.message || error}` }
  }
  const logined = resObj?.content?.body?.auth?.logined
  if (logined === false) {
    rejectedKey = accountKey(userId, token)
    return { rejected: TOKEN_REJECTED_NOTICE }
  }
  if (logined === true) {
    if (rejectedKey === accountKey(userId, token)) rejectedKey = ''
    return {}
  }
  return { warning: '咪咕账号检查没有完成：取流接口没有返回登录状态' }
}

/** 测试用：清掉内存里记下的被拒账号。 */
export function resetAccountState() {
  rejectedKey = ''
}
