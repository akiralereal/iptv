const API = 'https://api.fengshows.cn/'
const CLIENT = 'app(fs-web,1000000);'

// Fixed television scope: no business lives, VOD, schedules or replay.
export const CHANNELS = Object.freeze([
  { key: 'info', id: '7c96b084-60e1-40a9-89c5-682b994fb680', name: '凤凰资讯', logo: 'https://c1.fengshows-cdn.com/a/2021_22/79dcc3a9da358a3.png' },
  { key: 'chinese', id: 'f7f48462-9b13-485b-8101-7b54716411ec', name: '凤凰中文', logo: 'https://c1.fengshows-cdn.com/a/2021_22/ede3d9e09be28e5.png' },
  { key: 'hongkong', id: '15e02d92-1698-416c-af2f-3e9a872b4d78', name: '凤凰香港', logo: 'https://c1.fengshows-cdn.com/a/2021_23/325d941090bee17.png' },
])

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
    name: channel.name, deferredRef: `fengshows-${channel.key}.flv`,
    logo: channel.logo, groupTitle: '香港', catchup: 'none',
  })) }]
}

export function claimsRef(ref) {
  return CHANNELS.some(channel => ref === `fengshows-${channel.key}.flv`)
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
  if (String(body?.status) === '10005') throw new Error('凤凰秀登录凭证无效或已过期，请更新 Token；无需购买付费会员')
  if (body?.status !== undefined && String(body.status) !== '0') throw new Error('凤凰秀接口拒绝请求')
  return body?.status === undefined ? body : body.data
}

export async function resolveChannel(ref, ctx = {}) {
  const channel = CHANNELS.find(item => ref === `fengshows-${item.key}.flv`)
  if (!channel) return { url: '', desc: '未知的凤凰卫视直播频道' }
  try {
    const token = parseToken(ctx.config?.token || '')
    const options = { token, fetchImpl: ctx.fetchImpl, timeoutMs: ctx.timeoutMs || 10000 }
    const detail = await api(`hub/resource/live/${channel.id}`, { platform: 'web' }, options)
    if (!detail || detail.available === 0 || detail.region_unauthorized || detail.live_type !== 'tv') {
      return { url: '', desc: '该凤凰卫视频道当前不可访问' }
    }
    const quality = token ? 'fhd' : 'hd'
    const ticket = await api('hub/live/auth-url', { live_qa: quality, live_id: channel.id }, options)
    officialMediaUrl(ticket?.live_url)
    // Each connection obtains a fresh signature; do not cache signed URLs.
    return { url: ticket.live_url, desc: '', quality, validateMediaUrl: officialMediaUrl }
  } catch (error) {
    // Transport errors can embed request headers; expose only known safe messages.
    const message = String(error?.message || '')
    const known = /^(凤凰秀接口 HTTP \d{3}|凤凰秀接口拒绝请求|凤凰秀登录凭证无效或已过期，请更新 Token；无需购买付费会员|凤凰秀 Token 格式无效|凤凰秀 Cookie 编码无效|请粘贴凤凰秀 App\.user\.token 的值或包含它的 Cookie|凤凰秀返回了不支持的直播地址)$/.test(message)
    return { url: '', desc: known ? message : '凤凰卫视取流失败，请检查网络或稍后重试' }
  }
}
