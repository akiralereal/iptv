import { createHash } from 'node:crypto'
import { proxyAwareFetch } from '../../utils/systemProxy.js'

export const BEIJING_PAGE = 'https://www.btime.com/btv/btvsy_index'
export const BEIJING_LIVE_PAGE = 'https://www.btime.com/live'
export const BEIJING_ACCOUNT_API = 'https://user.btime.com/getUserInfo'
export const BEIJING_PLAY_API = 'https://pc.api.btime.com/video/play'

const PLAY_TYPE_ID = '151'
const PLAY_SIGN_SECRET = 'TtJSg@2g*$K4PjUH'
const PLAY_URL_TTL_MS = 60_000
const DEFAULT_HEADERS = Object.freeze({
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  accept: '*/*',
})
// 媒体 CDN 的防盗链请求头。电视台专用 CDN（brtv-play.v.btime.com，MC_VCLOUD_LIVE）校验的是
// Referer 的**完整页面路径**：2026-09-07 用真实登录态实测，同一条签名地址带
// `https://www.btime.com/btv/btvsy_index` 回 200，带根路径 `https://www.btime.com/`、
// `/live`、`/btv/` 或任意别的路径一律 403 且空正文；分片则两种都放行。独立验证台当时能播
// 正是因为它的服务端代理写的是完整页面路径，移植时收成根路径就全军覆没。
// 公开活动流（hls.playlive.360.v.btime.com）实测不查 Referer / Origin，按来源页给即可。
const TV_MEDIA_HEADERS = Object.freeze({
  Referer: BEIJING_PAGE,
  Origin: 'https://www.btime.com',
})
const LIVE_MEDIA_HEADERS = Object.freeze({
  Referer: BEIJING_LIVE_PAGE,
  Origin: 'https://www.btime.com',
})

/**
 * 官网不认这份 Cookie：账号接口回 code 1016「用户未登录」，取流接口回 errno 401（2026-10-06 用乱填的
 * Cookie 实测，过期、退出登录都是这两种回应）。网络失败等其它错误不归这里，免得冤枉 Cookie。
 */
export class CookieRejectedError extends Error {
  constructor() {
    super('北京时间 Cookie 已失效，请重新登录后导入')
    this.name = 'CookieRejectedError'
  }
}

export const COOKIE_REJECTED_NOTICE = '北京时间官网不认当前 Cookie（已过期或已退出登录），9 个电视台暂时播不了；请在官网重新登录后重新导入 Cookie'

const credentialKey = cookie => createHash('sha256').update(cookie).digest('base64url').slice(0, 12)

// 播放时发现被拒的 Cookie（只存摘要）。后台据此立刻提醒，不等下一轮刷新；换了 Cookie 自然不再相等。
let rejectedCookieKey = ''

/** 后台状态接口用：当前生效的 Cookie 是否已被官网拒绝（见 registry.js 的 credentialRejected）。 */
export function credentialRejected(config) {
  let cookie = ''
  try { cookie = parseCredential(config?.cookie) } catch { return '' }
  return cookie && credentialKey(cookie) === rejectedCookieKey ? COOKIE_REJECTED_NOTICE : ''
}

/** 测试用：清掉内存里记下的被拒 Cookie。 */
export function resetCredentialState() {
  rejectedCookieKey = ''
}

export const BEIJING_CHANNELS = [
  { slug: 'sn', name: '北京卫视', gid: '573ib1kp5nk92irinpumbo9krlb' },
  { slug: 'wy', name: 'BRTV文艺', gid: '54db6gi5vfj8r8q1e6r89imd64s' },
  { slug: 'kj', name: 'BRTV纪实科教', gid: '53bn9rlalq08lmb8nf8iadoph0b' },
  { slug: 'ys', name: 'BRTV影视', gid: '50mqo8t4n4e8gtarqr3orj9l93v' },
  { slug: 'cj', name: 'BRTV财经', gid: '50e335k9dq488lb7jo44olp71f5' },
  { slug: 'ty', name: 'BRTV体育休闲', gid: '54hv0f3pq079d4oiil2k12dkvsc' },
  { slug: 'sh', name: 'BRTV i生活', gid: '50j015rjrei9vmp3h8upblr41jf' },
  { slug: 'xw', name: 'BRTV新闻', gid: '53gpt1ephlp86eor6ahtkg5b2hf' },
  { slug: 'se', name: '卡酷少儿', gid: '55skfjq618b9kcq9tfjr5qllb7r' },
]

const tvGids = new Map(BEIJING_CHANNELS.map(channel => [channel.slug, channel.gid]))
const signedCache = new Map()

function cookieEntries(value) {
  const entries = Array.isArray(value) ? value : value?.cookies
  if (!Array.isArray(entries)) return null
  return entries
    .filter(item => {
      const domain = String(item?.domain || '').replace(/^\./, '').toLowerCase()
      return !domain || domain === 'btime.com' || domain.endsWith('.btime.com')
    })
    .map(item => `${String(item?.name || '').trim()}=${String(item?.value || '')}`)
    .filter(item => !item.startsWith('='))
    .join('; ')
}

export function parseCredential(input) {
  if (input === undefined || input === null) return ''
  let value = typeof input === 'string' ? input.trim() : input
  if (typeof value === 'string') {
    value = value.replace(/^cookie\s*:\s*/i, '').trim()
    if (value.startsWith('{') || value.startsWith('[')) {
      let parsed
      try { parsed = JSON.parse(value) } catch { throw new Error('Cookie JSON 格式无效') }
      value = typeof parsed?.cookie === 'string' ? parsed.cookie : cookieEntries(parsed)
      if (value === null) throw new Error('Cookie JSON 中没有 cookie 或 cookies')
    }
  } else {
    value = typeof value?.cookie === 'string' ? value.cookie : cookieEntries(value)
    if (value === null) throw new Error('Cookie JSON 中没有 cookie 或 cookies')
  }
  value = String(value || '').trim()
  if (!value) return ''
  if (value.length > 16_000 || /[\r\n\0]/.test(value)) throw new Error('Cookie 格式无效')
  const pairs = value.split(';').map(part => part.trim()).filter(Boolean)
  if (!pairs.length || pairs.some(pair => !/^[^=;,\s]+=[^;\r\n]*$/.test(pair))) {
    throw new Error('Cookie 格式无效，请粘贴请求头中的完整 Cookie 值')
  }
  return pairs.join('; ')
}

async function request(raw, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000)
  try {
    const fetchImpl = options.fetchImpl || proxyAwareFetch
    const requestOptions = {
      redirect: 'follow',
      headers: { ...DEFAULT_HEADERS, ...options.headers },
      signal: controller.signal,
    }
    return await fetchImpl(String(raw), requestOptions)
  } finally {
    clearTimeout(timer)
  }
}

async function textResponse(raw, options = {}) {
  const response = await request(raw, options)
  const text = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText || ''}`.trim())
  return { response, text }
}

export async function verifyCredential(input, options = {}) {
  const cookie = parseCredential(input)
  if (!cookie) throw new Error('未配置北京时间 Cookie')
  const { text } = await textResponse(BEIJING_ACCOUNT_API, {
    ...options,
    headers: { Cookie: cookie, Origin: 'https://www.btime.com', Referer: BEIJING_PAGE },
  })
  const payload = JSON.parse(text)
  if (payload?.code === 1016) throw new CookieRejectedError()
  if (payload?.code !== 0) throw new Error(`账号接口返回 ${payload?.code} ${payload?.message || ''}`.trim())
  if (!payload?.data || Array.isArray(payload.data)) throw new CookieRejectedError()
  return payload.data
}

function decodeJsonString(value) {
  try { return JSON.parse(`"${value}"`) } catch { return value }
}

export function parseChannels(html) {
  const discovered = new Map()
  const pattern = /"gid":"([a-z0-9]+)"[^{}]{0,400}"data":\{"title":"((?:\\.|[^"\\])*)"/g
  for (const match of String(html).matchAll(pattern)) discovered.set(decodeJsonString(match[2]), match[1])
  return BEIJING_CHANNELS.map(channel => ({ ...channel, gid: discovered.get(channel.name) || channel.gid }))
}

function jsonArrayAfter(source, marker) {
  const markerAt = source.indexOf(marker)
  const newsAt = markerAt >= 0 ? source.indexOf('"news":[', markerAt) : -1
  const start = newsAt >= 0 ? source.indexOf('[', newsAt) : -1
  if (start < 0) return []
  let depth = 0, inString = false, escaped = false
  for (let index = start; index < source.length; index++) {
    const character = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '[') depth++
    else if (character === ']' && --depth === 0) {
      try { return JSON.parse(source.slice(start, index + 1)) } catch { return [] }
    }
  }
  return []
}

export function parseLiveEvents(html) {
  const items = jsonArrayAfter(String(html), '"template":"live_module"')
  const seen = new Set()
  return items.flatMap(item => {
    const gid = String(item?.gid || '')
    const name = String(item?.data?.title || '').replace(/\s+/g, ' ').trim()
    const typeId = String(item?.type || 6)
    if (!/^[a-z0-9]{1,64}$/.test(gid) || !/^\d{1,4}$/.test(typeId) || !name || seen.has(gid)) return []
    seen.add(gid)
    return [{ gid, name, typeId }]
  })
}

export function signPlayRequest(gid, timestamp, typeId = PLAY_TYPE_ID) {
  return createHash('md5').update(`${gid}${typeId}${timestamp}${PLAY_SIGN_SECRET}`).digest('hex').slice(0, 8)
}

export function officialMediaUrl(raw) {
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.username || url.password || !['', '443'].includes(url.port)
      || !url.hostname.toLowerCase().endsWith('.v.btime.com') || !url.pathname.endsWith('.m3u8')) {
    throw new Error('北京时间取流接口返回了非官方 HLS 地址')
  }
  return url.href
}

function streamCandidates(data) {
  const values = []
  const append = value => {
    if (!value) return
    if (typeof value === 'string') {
      if (/^https:\/\//i.test(value)) values.push(value)
      else if (value.startsWith('//')) values.push(`https:${value}`)
      else if (value.startsWith('{') || value.startsWith('[')) {
        try { append(JSON.parse(value)) } catch {}
      } else if (value.length > 64 && /^[A-Za-z0-9+/=]+$/.test(value)) {
        try {
          const once = Buffer.from([...value].reverse().join(''), 'base64').toString('utf8')
          append(Buffer.from(once, 'base64').toString('utf8'))
        } catch {}
      }
      return
    }
    if (Array.isArray(value)) value.forEach(append)
    else if (typeof value === 'object') Object.values(value).forEach(append)
  }
  append(data)
  return values
}

export function extractStream(payload) {
  if (payload?.errno !== 0 || !payload?.data) {
    if (payload?.errno === 401) throw new CookieRejectedError()
    throw new Error(payload?.errmsg || payload?.message || '北京时间取流接口返回异常')
  }
  const candidates = streamCandidates(payload.data)
  if (!candidates.length) throw new Error('北京时间取流接口没有返回 HLS 地址')
  return officialMediaUrl(candidates[0])
}

async function requestPlayUrl(gid, cookie = '', options = {}) {
  const typeId = String(options.typeId || PLAY_TYPE_ID)
  const cacheKey = `${cookie ? credentialKey(cookie) : 'public'}:${typeId}:${gid}`
  const now = options.now ?? Date.now()
  const cached = signedCache.get(cacheKey)
  if (cached && now - cached.createdAt < PLAY_URL_TTL_MS) return cached.url
  const timestamp = Math.floor(now / 1000)
  const endpoint = new URL(BEIJING_PLAY_API)
  endpoint.searchParams.set('from', 'pc')
  endpoint.searchParams.set('id', gid)
  endpoint.searchParams.set('type_id', typeId)
  endpoint.searchParams.set('timestamp', timestamp)
  endpoint.searchParams.set('sign', signPlayRequest(gid, timestamp, typeId))
  const { text } = await textResponse(endpoint, {
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
    headers: { ...(cookie ? { Cookie: cookie } : {}), Referer: options.referer || BEIJING_PAGE },
  })
  const url = extractStream(JSON.parse(text))
  signedCache.set(cacheKey, { url, createdAt: now })
  return url
}

async function publicEventAvailable(event, options = {}) {
  const url = await requestPlayUrl(event.gid, '', {
    ...options,
    typeId: event.typeId,
    referer: BEIJING_LIVE_PAGE,
  })
  const response = await request(url, {
    timeoutMs: options.timeoutMs,
    fetchImpl: options.mediaFetchImpl || options.fetchImpl,
    headers: LIVE_MEDIA_HEADERS,
  })
  if (!response.ok) return false
  const text = await response.text()
  return text.trimStart().startsWith('#EXTM3U')
}

export async function fetchCatalog(options = {}) {
  const cookie = parseCredential(options.cookie)
  const warnings = []
  const [tvPage, livePage] = await Promise.all([
    textResponse(BEIJING_PAGE, options).catch(error => ({ error })),
    textResponse(BEIJING_LIVE_PAGE, options).catch(error => ({ error })),
  ])

  let tvRows = []
  const channels = tvPage.error ? BEIJING_CHANNELS : parseChannels(tvPage.text)
  if (tvPage.error) warnings.push(`电视台目录获取失败，暂用内置的 9 个官方频道：${tvPage.error.message}`)
  else for (const channel of channels) tvGids.set(channel.slug, channel.gid)
  let credentialRejected = ''
  if (!cookie) warnings.push('未配置登录 Cookie，9 个电视频道暂不加入；免登录直播不受影响')
  else {
    // 配了 Cookie 就一直保留电视台：失效时频道照留、后台提醒，不让它们从播放列表里悄悄消失
    tvRows = channels
    try {
      await verifyCredential(cookie, options)
      if (rejectedCookieKey === credentialKey(cookie)) rejectedCookieKey = ''
    } catch (error) {
      if (error instanceof CookieRejectedError) {
        rejectedCookieKey = credentialKey(cookie)
        credentialRejected = COOKIE_REJECTED_NOTICE
      } else {
        const reason = error?.name === 'AbortError' || error?.name === 'TimeoutError' ? '请求超时' : (error?.message || String(error))
        warnings.push(`北京时间 Cookie 检查没有完成：${reason}`)
        // 没查成不下结论，后台沿用上一轮（registry.js）
        credentialRejected = undefined
      }
    }
  }

  let publicRows = []
  if (livePage.error) warnings.push(`免登录直播目录获取失败：${livePage.error.message}`)
  else {
    const events = parseLiveEvents(livePage.text)
    const checked = await Promise.all(events.map(async event => {
      try { return await publicEventAvailable(event, options) ? event : null } catch { return null }
    }))
    publicRows = checked.filter(Boolean)
    const skipped = events.length - publicRows.length
    if (skipped) warnings.push(`官网目录中有 ${skipped} 个活动流已失效，已自动排除`)
  }
  return { tvRows, publicRows, warnings, credentialRejected }
}

export function buildGroups({ tvRows = [], publicRows = [] }) {
  const groups = []
  if (tvRows.length) groups.push({
    name: '北京',
    dataList: tvRows.map(channel => ({ name: channel.name, deferredRef: `beijing-tv-${channel.slug}`, logo: '', catchup: 'none' })),
  })
  if (publicRows.length) groups.push({
    name: '北京景观',
    dataList: publicRows.map(event => ({ name: event.name, deferredRef: `beijing-live-${event.typeId}-${event.gid}`, logo: '', catchup: 'none' })),
  })
  return groups
}

export function claimsRef(ref) {
  return /^beijing-tv-(?:sn|wy|kj|ys|cj|ty|sh|xw|se)$/.test(String(ref || ''))
    || /^beijing-live-\d{1,4}-[a-z0-9]{1,64}$/.test(String(ref || ''))
}

export async function resolveChannel(ref, ctx = {}) {
  try {
    const value = String(ref || '')
    const tv = value.match(/^beijing-tv-(sn|wy|kj|ys|cj|ty|sh|xw|se)$/)
    if (tv) {
      const cookie = parseCredential(ctx.config?.cookie)
      if (!cookie) return { url: '', desc: '北京电视台需要先在后台配置北京时间登录 Cookie' }
      try {
        const url = await requestPlayUrl(tvGids.get(tv[1]), cookie, ctx)
        return { url, upstreamHeaders: TV_MEDIA_HEADERS }
      } catch (error) {
        if (error instanceof CookieRejectedError) rejectedCookieKey = credentialKey(cookie)
        throw error
      }
    }
    const event = value.match(/^beijing-live-(\d{1,4})-([a-z0-9]{1,64})$/)
    if (!event) return { url: '', desc: '北京时间频道地址格式错误' }
    const url = await requestPlayUrl(event[2], '', { ...ctx, typeId: event[1], referer: BEIJING_LIVE_PAGE })
    return { url, upstreamHeaders: LIVE_MEDIA_HEADERS }
  } catch (error) {
    const message = String(error?.message || error).replace(/(?:Cookie|cookie)\s*[:=]\s*[^\s,;]+/g, 'Cookie=<已隐藏>')
    return { url: '', desc: message }
  }
}

export function clearCache() {
  signedCache.clear()
}
