import { CHANNELS, channelRef } from './channels.js'
import { printYellow } from '../../utils/colorOut.js'

export { CHANNELS }

const API = 'https://api.fengshows.cn/'
const CLIENT = 'app(fs-web,1000000);'
const EXPIRED = '凤凰秀登录凭证无效或已过期，请更新 Token；无需购买付费会员'

/** 官网回 10005「賬號已過期，請重新登錄」：Token 过期、退出登录或乱填都是这一种回应。 */
export class TokenRejectedError extends Error {
  constructor() {
    super(EXPIRED)
    this.name = 'TokenRejectedError'
  }
}

export const TOKEN_REJECTED_NOTICE = '凤凰秀官网不认当前 Token（账号已过期或已退出登录），三台已自动改用游客 480p；请在官网重新登录后重新获取 Token'

// 官网已经拒过的 Token。播放时直接走游客，不再每次先撞一次 10005；
// 换了 Token 自然不再相等，刷新检查重新通过时清掉。只在内存里，重启后由下一次播放或刷新重新确认。
let rejectedToken = ''

function markRejected(token) {
  if (rejectedToken === token) return
  rejectedToken = token
  printYellow(TOKEN_REJECTED_NOTICE)
}

/** 后台状态接口用：当前生效的 Token 是否已被官网拒绝（见 registry.js 的 credentialRejected）。 */
export function credentialRejected(config) {
  let token = ''
  try { token = parseToken(config?.token || '') } catch { return '' }
  return token && token === rejectedToken ? TOKEN_REJECTED_NOTICE : ''
}

/** 测试用：清掉内存里记下的被拒 Token。 */
export function resetTokenState() {
  rejectedToken = ''
}

export function parseToken(input = '') {
  if (typeof input !== 'string' || input.length > 12000) throw new Error('凤凰秀 Token 格式无效')
  let value = input.trim()
  if (!value) return ''
  const cookie = /(?:^|;\s*)App\.user\.token=([^;]*)/.exec(value.replace(/^Cookie:\s*/i, ''))
  if (cookie) value = cookie[1]
  try { value = decodeURIComponent(value) } catch { throw new Error('凤凰秀 Cookie 编码无效') }
  if (value.startsWith('"')) {
    try { value = JSON.parse(value) } catch { throw new Error('凤凰秀 Token 格式无效') }
  }
  if (typeof value !== 'string' || !value || value.length > 8192 || /[^\x21-\x7e]|[";,]/.test(value)) {
    throw new Error('请粘贴凤凰秀 App.user.token 的值或包含它的 Cookie')
  }
  return value
}

export function officialMediaUrl(raw) {
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      !/(^|\.)fengshows\.(cn|com)$/.test(url.hostname) ||
      (url.port && !['80', '443', '8484'].includes(url.port)) || !/\.flv$/i.test(url.pathname)) {
    throw new Error('凤凰秀返回了不支持的直播地址')
  }
  return url
}

export function buildGroups() {
  return [{ name: '香港', dataList: CHANNELS.map(channel => ({
    name: channel.name, deferredRef: channelRef(channel),
    logo: channel.logo, groupTitle: '香港', catchup: 'none',
  })) }]
}

export function claimsRef(ref) {
  return CHANNELS.some(channel => ref === channelRef(channel))
}

async function api(path, params, { token, fetchImpl = fetch, timeoutMs = 10000 }) {
  const url = new URL(path, API)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  const response = await fetchImpl(url, {
    redirect: 'error', // Account headers must not follow a redirect.
    headers: { Accept: 'application/json', 'fengshows-client': CLIENT, ...(token ? { token } : {}) },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) { await response.body?.cancel(); throw new Error(`凤凰秀接口 HTTP ${response.status}`) }
  const body = await response.json()
  if (String(body?.status) === '10005') throw new TokenRejectedError()
  if (body?.status !== undefined && String(body.status) !== '0') throw new Error('凤凰秀接口拒绝请求')
  return body?.status === undefined ? body : body.data
}

// 已知不含请求头等敏感内容的错误措辞；传输层异常可能带上请求头，只能换成通用说法。
const SAFE_ERROR = /^(凤凰秀接口 HTTP \d{3}|凤凰秀接口拒绝请求|凤凰秀登录凭证无效或已过期，请更新 Token；无需购买付费会员|凤凰秀 Token 格式无效|凤凰秀 Cookie 编码无效|请粘贴凤凰秀 App\.user\.token 的值或包含它的 Cookie|凤凰秀返回了不支持的直播地址)$/

async function requestLive(channel, token, base) {
  const options = { ...base, token }
  const detail = await api(`hub/resource/live/${channel.id}`, { platform: 'web' }, options)
  if (!detail || detail.available === 0 || detail.region_unauthorized || detail.live_type !== 'tv') {
    return { url: '', desc: '该凤凰卫视频道当前不可访问' }
  }
  const quality = token ? 'fhd' : 'hd'
  const ticket = await api('hub/live/auth-url', { live_qa: quality, live_id: channel.id }, options)
  officialMediaUrl(ticket?.live_url)
  // Each connection obtains a fresh signature; do not cache signed URLs.
  return { url: ticket.live_url, desc: '', quality, validateMediaUrl: officialMediaUrl }
}

export async function resolveChannel(ref, ctx = {}) {
  const channel = CHANNELS.find(item => ref === channelRef(item))
  if (!channel) return { url: '', desc: '未知的凤凰卫视直播频道' }
  try {
    let token = parseToken(ctx.config?.token || '')
    if (token && token === rejectedToken) token = ''
    const options = { fetchImpl: ctx.fetchImpl, timeoutMs: ctx.timeoutMs || 10000 }
    try {
      return await requestLive(channel, token, options)
    } catch (error) {
      if (!token || !(error instanceof TokenRejectedError)) throw error
      // Token 过期不该让三台一起断：记下来让后台提醒，这一次和之后都改走游客 480p
      markRejected(token)
      return await requestLive(channel, '', options)
    }
  } catch (error) {
    // Transport errors can embed request headers; expose only known safe messages.
    const message = String(error?.message || '')
    return { url: '', desc: SAFE_ERROR.test(message) ? message : '凤凰卫视取流失败，请检查网络或稍后重试' }
  }
}

/**
 * 刷新时用 Token 要一次 720p 签名，确认官网还认它，免得后台显示「已配置」、一播才发现过期。
 * 返回 { rejected } 或 { warning }；没配 Token 或检查通过时返回空对象。
 */
export async function checkToken(config, ctx = {}) {
  const token = parseToken(config?.token || '')
  if (!token) return {}
  try {
    await api('hub/live/auth-url', { live_qa: 'fhd', live_id: CHANNELS[0].id },
      { token, fetchImpl: ctx.fetchImpl, timeoutMs: ctx.timeoutMs || 10000 })
    if (rejectedToken === token) rejectedToken = ''
    return {}
  } catch (error) {
    if (error instanceof TokenRejectedError) {
      markRejected(token)
      return { rejected: TOKEN_REJECTED_NOTICE }
    }
    const message = String(error?.message || '')
    return { warning: `凤凰秀 Token 检查没有完成：${SAFE_ERROR.test(message) ? message : '网络异常或接口超时'}` }
  }
}
