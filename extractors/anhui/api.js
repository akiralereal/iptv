/**
 * 安徽广电「安徽视讯」App：七路电视频道，按 App 公开算法生成腾讯云直播签名。
 *
 * 取流链路（由独立实验台 asian-live-lab/anhui-live-lab 验证后移植）：
 *   1. 公开配置接口返回 AES 加密的密钥配置，用租户 id 与固定种子的 md5 片段解出 tx_auth_key；
 *   2. 从 App「看电视」栏目接口的 132 电视组件读取当前 liveDomain / liveId，再签名；
 *   3. 2026-10-25 官方迁至 seclive，卫视流 ID 也已变更；新域名要求 ijkplayer，旧域名用 Chrome。
 *      seclive 的 HTTPS 证书当前不匹配，仅该域名遇到此错误时改用同域 HTTP，不关闭 TLS 校验。
 *      清单与分片使用同一标识全代理，不附加 Referer / Origin。
 *
 * 官网旧接口还会返回 8 路地址，能取到清单和分片，但画面全是「网站直播已下线，请使用安徽视讯」
 * 的占位告示，所以只收 App 这条链路；/forbid/ 路径在媒体边界里显式拒绝。
 */
import { createDecipheriv, createHash } from 'node:crypto'

import { proxyAwareFetch } from '../../utils/systemProxy.js'

export const ANHUI_CONFIG_API = 'https://console.ahsx.ahtv.cn/api/appapi/api/config-other-encrypt'
export const ANHUI_TV_CATALOG_API = 'https://console.ahsx.ahtv.cn/api/appapi/api/content/list/15'
export const MEDIA_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
export const MEDIA_HOSTS = Object.freeze(['live.ahsx.ahtv.cn', 'lives.ahsx.ahtv.cn', 'nrtapush.ahsx.ahtv.cn', 'seclive.ahsx.ahtv.cn'])
const SEC_LIVE_HOST = 'seclive.ahsx.ahtv.cn'
export const APP_TOKEN_LIFETIME_MS = 2 * 60 * 60 * 1000
export const AUTH_KEY_TTL_MS = 15 * 60 * 1000
export const STREAM_URL_TTL_MS = 30 * 60 * 1000
export const TV_CATALOG_TTL_MS = 60 * 1000

const LIVE_ORIGIN = 'https://live.ahsx.ahtv.cn'
const TENANT_ID = '771d57f88da621c541053ca5be56cd7a'
const APP_CONFIG_SEED = 'fa7ecd4f54066ee282b8a3413553c77f'
const APP_API_VERSION = '4.0.3'
const LOGO_BASE = `https://image.ahsx.ahtv.cn/0/${TENANT_ID}/`
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
// 配置接口不校验 UA，沿用项目里其它模块请求接口时的浏览器 UA
const API_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// ref 保留最初的频道引用；articleId 用来匹配 App 电视组件，实际 liveId / 域名随台方更新。
export const CHANNELS = Object.freeze([
  Object.freeze({
    ref: 'anhui-ahwssx', articleId: '121120', liveId: 'ahwssx', rawName: '安徽卫视', name: '安徽卫视',
    logo: `${LOGO_BASE}2024/11/14/9f1ef24154a949c79bcf29965e4b6f98.jpg`,
  }),
  Object.freeze({
    ref: 'anhui-jjshtv', articleId: '7363', liveId: 'jjshtv', rawName: '经济生活', name: '安徽经济生活',
    logo: `${LOGO_BASE}2023/12/27/3d5744f424364079b3ad3e3c4cabccf5.png`,
  }),
  Object.freeze({
    ref: 'anhui-ystv', articleId: '7364', liveId: 'ystv', rawName: '影视频道', name: '安徽影视',
    logo: `${LOGO_BASE}2023/12/27/1f29ff31c44d4dd7b3e2e72af2534380.png`,
  }),
  Object.freeze({
    ref: 'anhui-ggtv', articleId: '7365', liveId: 'ggtv', rawName: '公共频道', name: '安徽公共',
    logo: `${LOGO_BASE}2023/12/27/55025591656d4a079c8b9d0c18324830.png`,
  }),
  Object.freeze({
    ref: 'anhui-nykjtv', articleId: '10270', liveId: 'nykjtv', rawName: '农业科教', name: '安徽农业科教',
    logo: `${LOGO_BASE}2023/12/27/294acfe672f246c782a412da98f1d044.png`,
  }),
  Object.freeze({
    ref: 'anhui-zytytv', articleId: '10266', liveId: 'zytytv', rawName: '综艺体育', name: '安徽综艺体育',
    logo: `${LOGO_BASE}2023/12/27/05f013ea51614c88a95140df787d351f.png`,
  }),
  Object.freeze({
    ref: 'anhui-gjtv', articleId: '10157', liveId: 'gjtv', rawName: '国际频道', name: '安徽国际',
    logo: `${LOGO_BASE}2023/12/27/4412c09c5ba64c7e8a251664e1c7ca79.png`,
  }),
])

const CHANNEL_BY_REF = new Map(CHANNELS.map(channel => [channel.ref, channel]))

function md5(value) {
  return createHash('md5').update(value, 'utf8').digest('hex')
}

function safeUrl(raw, label) {
  try {
    return new URL(String(raw || '').trim())
  } catch {
    throw new Error(`安徽视讯返回了无效${label}地址`)
  }
}

/** 只放行 App 自己的直播域名；旧官网 /forbid/ 路径是「直播已下线」占位画面，能取到清单也不能当频道。 */
export function officialMediaUrl(raw) {
  const url = safeUrl(raw, '媒体')
  const protocolAllowed = url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === SEC_LIVE_HOST)
  if (!protocolAllowed || url.username || url.password || url.port
      || !MEDIA_HOSTS.includes(url.hostname) || /%2f|%5c/i.test(url.pathname) || url.hash) {
    throw new Error('安徽视讯返回了非官方媒体地址')
  }
  if (/^\/forbid(?:\/|$)/i.test(url.pathname)) throw new Error('安徽视讯返回了直播下线占位地址')
  return url.href
}

export function officialHlsUrl(raw) {
  const url = new URL(officialMediaUrl(raw))
  if (!/\.m3u8$/i.test(url.pathname)) throw new Error('安徽视讯返回的不是有效 HLS 入口')
  return url.href
}

/**
 * 清单与分片回源统一带该域名放行的标识。刻意不带 Referer / Origin：实测同一 Chrome UA
 * 加上浏览器式的 Referer / Origin / Sec-Fetch 头后清单与分片全部 403。
 * 函数形态：代理层只对函数返回的 User-Agent 放行（见 utils/hlsProxy.js）。
 */
export function upstreamHeadersFor(raw) {
  const url = new URL(officialMediaUrl(raw))
  return { 'User-Agent': url.hostname === SEC_LIVE_HOST ? 'ijkplayer' : MEDIA_USER_AGENT }
}

function parseObject(value, label) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {}
  }
  throw new Error(`安徽视讯接口没有返回有效的${label}`)
}

// App 端固定算法：key 取租户 id 的 md5 第 8~24 位，iv 取固定种子的 md5 第 8~24 位，AES-128-CBC。
function decryptClientValue(value) {
  if (typeof value !== 'string' || !value) throw new Error('安徽视讯加密配置为空')
  const key = Buffer.from(md5(TENANT_ID).slice(8, 24), 'utf8')
  const iv = Buffer.from(md5(APP_CONFIG_SEED).slice(8, 24), 'utf8')
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, iv)
    return Buffer.concat([decipher.update(Buffer.from(value, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('安徽视讯加密配置无法解码')
  }
}

/** 从配置接口响应里解出直播鉴权密钥；兼容 is_encrypt=0 的明文形态。 */
export function parseConfig(text) {
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error('安徽视讯配置接口返回了无效 JSON')
  }
  const data = payload?.state === true ? payload.data : null
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('安徽视讯配置接口没有返回配置')
  const encrypted = Number(data.is_encrypt) === 1
  const keyConfig = parseObject(encrypted ? decryptClientValue(data.key) : data.key, '密钥配置')
  const authKey = encrypted ? decryptClientValue(keyConfig.tx_auth_key) : keyConfig.tx_auth_key
  if (typeof authKey !== 'string' || !/^[\x21-\x7e]{16,128}$/.test(authKey)) {
    throw new Error('安徽视讯配置没有返回有效的直播鉴权密钥')
  }
  return authKey
}

export function configUrl() {
  const url = new URL(ANHUI_CONFIG_API)
  url.search = new URLSearchParams({
    client: 'android', tenantid: TENANT_ID, cms_app_id: '1', app_id: '1', api_version: APP_API_VERSION,
  })
  return url.href
}

export function tvCatalogUrl() {
  const url = new URL(ANHUI_TV_CATALOG_API)
  url.search = new URL(configUrl()).search
  // LiveAlbumListFragment → DataInvokeUtil.getContentList，与 App 的首屏请求一致。
  url.searchParams.set('no_content', '1')
  url.searchParams.set('page', '1')
  url.searchParams.set('perPage', '50')
  return url.href
}

export function parseTvCatalog(text) {
  let payload
  try { payload = JSON.parse(text) } catch { throw new Error('安徽电视栏目返回了无效 JSON') }
  const components = payload?.state === true ? payload.data?.components : null
  if (!Array.isArray(components)) throw new Error('安徽电视栏目没有返回组件列表')
  const knownIds = new Set(CHANNELS.map(channel => channel.articleId))
  const records = []
  for (const component of components) {
    // Component132Holder 直接从 element 读取电视配置；不处理广播、纪录片或其它栏目内容。
    if (Number(component?.widget) !== 132) continue
    if (!Array.isArray(component.element)) throw new Error('安徽电视组件没有返回频道列表')
    records.push(...component.element.filter(record => knownIds.has(String(record?.id))))
  }
  if (!records.length) throw new Error('安徽电视栏目没有返回已收录的电视频道')
  return records
}

export function channelConfigFromCatalog(records, channel) {
  const matches = records.filter(record => String(record?.id) === channel.articleId)
  if (matches.length !== 1) throw new Error('安徽电视栏目缺少频道配置或存在重复频道')
  const meta = matches[0]
  if (!meta || String(meta.id) !== channel.articleId || meta.title !== channel.rawName) {
    throw new Error('安徽电视栏目配置与请求频道不符')
  }
  // 官方栏目配置可能省略 status；缺少该字段不代表下架。仍拒绝明确的非发布状态，
  // 并要求 PayType 明确为免费，不能把缺少权限信息当成开放直播。
  const explicitlyUnpublished = Object.hasOwn(meta, 'status') && Number(meta.status) !== 30
  if (explicitlyUnpublished || ![0, '0'].includes(meta.PayType)) {
    throw new Error('安徽频道未发布或未开放免费直播')
  }
  const custom = parseObject(meta.AppCustomParams, '频道配置')
  const movie = parseObject(custom.movie, '直播配置')
  if (String(movie.txFlag) !== '1' || !/^[a-z\d_-]{1,96}$/.test(String(movie.liveId || ''))) {
    throw new Error('安徽频道直播配置无效或签名方式已变化')
  }
  const domain = new URL(officialMediaUrl(movie.liveDomain))
  if (domain.search || !/^\/(?:[a-z\d_-]+\/){0,3}(?:[a-z\d_-]+\/?)?$/i.test(domain.pathname)) {
    throw new Error('安徽频道直播目录无效')
  }
  return { liveId: movie.liveId, liveDomain: domain.href }
}

export async function requestTvCatalog({ timeoutMs = 15000, fetchImpl = proxyAwareFetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(tvCatalogUrl(), {
      redirect: 'manual', signal: controller.signal,
      headers: { 'User-Agent': API_UA, Accept: 'application/json' },
    })
    if (REDIRECT_STATUSES.has(response.status)) {
      await discardResponse(response)
      throw new Error('安徽电视栏目返回了不安全的重定向')
    }
    if (!response.ok) {
      await discardResponse(response)
      throw new Error(`安徽电视栏目 HTTP ${response.status}`)
    }
    return parseTvCatalog(await responseText(response))
  } finally { clearTimeout(timer) }
}

/** 与 App 运行时完全一致的腾讯云直播签名：txTime 取过期时刻（秒，十六进制），txSecret = md5(key + liveId + txTime)。 */
export function signedStreamUrl(liveId, authKey, now = Date.now(), liveDomain = `${LIVE_ORIGIN}/live/`) {
  if (!/^[a-z\d_-]{1,96}$/.test(String(liveId || ''))) throw new Error('安徽视讯 liveId 无效')
  if (typeof authKey !== 'string' || !authKey) throw new Error('安徽视讯直播鉴权密钥无效')
  const txTime = Math.floor((Number(now) + APP_TOKEN_LIFETIME_MS) / 1000).toString(16)
  const txSecret = md5(`${authKey}${liveId}${txTime}`)
  // 与 App 一样直接在 liveDomain 后拼接斜杠，保留配置末尾斜杠带来的双斜杠。
  return officialHlsUrl(`${liveDomain}/${liveId}.m3u8?txSecret=${txSecret}&txTime=${txTime}`)
}

async function discardResponse(response) {
  response.body?.destroy?.()
  await response.body?.cancel?.().catch(() => {})
}

async function responseText(response, maxBytes = MAX_RESPONSE_BYTES) {
  const declaredHeader = response.headers?.get?.('content-length')
  const declared = declaredHeader == null ? NaN : Number(declaredHeader)
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discardResponse(response)
    throw new Error('安徽视讯上游响应过大')
  }
  if (!response.body) return ''
  const chunks = []
  let total = 0
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk)
    total += bytes.length
    if (total > maxBytes) {
      response.body?.destroy?.()
      throw new Error('安徽视讯上游响应过大')
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

export async function requestAuthKey({
  timeoutMs = 15000,
  fetchImpl = proxyAwareFetch,
} = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(configUrl(), {
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': API_UA, Accept: 'application/json' },
    })
    if (REDIRECT_STATUSES.has(response.status)) {
      await discardResponse(response)
      throw new Error('安徽视讯配置接口返回了不安全的重定向')
    }
    const text = await responseText(response, 512 * 1024)
    if (!response.ok) throw new Error(`安徽视讯配置接口 HTTP ${response.status}`)
    return parseConfig(text)
  } finally {
    clearTimeout(timer)
  }
}

function hlsRefs(text, baseUrl) {
  const refs = []
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const value = line.trim()
    if (!value) continue
    if (value.startsWith('#')) {
      for (const match of value.matchAll(/URI="([^"]+)"/g)) {
        refs.push(new URL(match[1], baseUrl).href)
      }
    } else {
      refs.push(new URL(value, baseUrl).href)
    }
  }
  return refs
}

export function validateHls(text, baseUrl) {
  if (typeof text !== 'string' || !text.trimStart().startsWith('#EXTM3U')) {
    throw new Error('安徽视讯上游不是 HLS 清单')
  }
  for (const ref of hlsRefs(text, baseUrl)) officialMediaUrl(ref)
  return text
}

/**
 * 拉取当前滚动清单。官方清单只含 3 个 2 秒分片、且声明 ALLOW-CACHE:NO，
 * 所以播放器每次轮询都必须重新拉，模块层不缓存清单文本。
 */
export async function requestManifest(raw, {
  timeoutMs = 15000,
  fetchImpl = proxyAwareFetch,
} = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let url = officialHlsUrl(raw)
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      let response
      try {
        response = await fetchImpl(url, {
          redirect: 'manual', signal: controller.signal, headers: upstreamHeadersFor(url),
        })
      } catch (error) {
        const target = new URL(url)
        // 新官方 CDN 的证书只有 *.liveplay.myqcloud.com；不关闭验证，也不向其他主机降级。
        if ((error?.cause?.code || error?.code) !== 'ERR_TLS_CERT_ALTNAME_INVALID'
            || target.hostname !== SEC_LIVE_HOST || target.protocol !== 'https:') throw error
        target.protocol = 'http:'
        url = officialHlsUrl(target.href)
        continue
      }
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location')
        await discardResponse(response)
        if (!location) throw new Error('安徽直播清单重定向缺少地址')
        url = officialHlsUrl(new URL(location, url).href)
        continue
      }
      if (!response.ok) {
        await discardResponse(response)
        throw new Error(`安徽直播清单 HTTP ${response.status}`)
      }
      const text = await responseText(response)
      validateHls(text, url)
      return { text, url }
    }
    throw new Error('安徽直播清单重定向次数过多')
  } finally {
    clearTimeout(timer)
  }
}

export function buildChannels() {
  return CHANNELS.map(channel => ({
    name: channel.name,
    deferredRef: channel.ref,
    logo: channel.logo,
    opts: ['network-caching=3000'],
    catchup: 'none',
  }))
}

export function claimsRef(ref) {
  return CHANNEL_BY_REF.has(String(ref || ''))
}

export function createResolver({ fetchImpl: defaultFetch = proxyAwareFetch } = {}) {
  // 按 fetchImpl 分开：测试注入的假 fetch 不能污染真实进程的密钥缓存
  const states = new Map()
  let generation = 0

  function stateFor(fetchImpl) {
    let state = states.get(fetchImpl)
    if (!state) {
      state = { authKey: null, pendingAuth: null, catalog: null, pendingCatalog: null, streams: new Map() }
      states.set(fetchImpl, state)
    }
    return state
  }

  async function authKeyFor(options) {
    const state = stateFor(options.fetchImpl)
    const now = Number(options.now ?? Date.now())
    if (state.authKey && state.authKey.expiresAt > now) return state.authKey.value
    if (!state.pendingAuth) {
      const requestGeneration = generation
      const promise = requestAuthKey(options).then(value => {
        if (requestGeneration === generation) state.authKey = { value, expiresAt: now + AUTH_KEY_TTL_MS }
        return value
      }).finally(() => {
        if (state.pendingAuth === promise) state.pendingAuth = null
      })
      state.pendingAuth = promise
    }
    return state.pendingAuth
  }

  async function catalogFor(options) {
    const state = stateFor(options.fetchImpl)
    const now = Number(options.now ?? Date.now())
    if (state.catalog && state.catalog.expiresAt > now) return state.catalog.records
    if (!state.pendingCatalog) {
      const requestGeneration = generation
      const promise = requestTvCatalog(options).then(records => {
        if (requestGeneration === generation) state.catalog = { records, expiresAt: now + TV_CATALOG_TTL_MS }
        return records
      }).finally(() => {
        if (state.pendingCatalog === promise) state.pendingCatalog = null
      })
      state.pendingCatalog = promise
    }
    return state.pendingCatalog
  }

  // 签名两小时有效；半小时内复用同一份，避免每次轮询都换 txTime 让日志和登记表无谓抖动
  async function streamUrlFor(channel, options) {
    const state = stateFor(options.fetchImpl)
    const now = Number(options.now ?? Date.now())
    const cached = state.streams.get(channel.ref)
    if (cached && cached.expiresAt > now) return cached.url
    const [authKey, records] = await Promise.all([authKeyFor(options), catalogFor(options)])
    const current = channelConfigFromCatalog(records, channel)
    const url = signedStreamUrl(current.liveId, authKey, now, current.liveDomain)
    state.streams.set(channel.ref, { url, expiresAt: now + STREAM_URL_TTL_MS })
    return url
  }

  function invalidate(channel, fetchImpl) {
    const state = stateFor(fetchImpl)
    state.streams.delete(channel.ref)
    state.authKey = null
    state.catalog = null
  }

  async function resolve(ref, ctx = {}) {
    const channel = CHANNEL_BY_REF.get(String(ref || ''))
    if (!channel) return { url: '', desc: '安徽频道引用格式错误' }
    const options = {
      fetchImpl: ctx.fetchImpl || defaultFetch,
      timeoutMs: ctx.timeoutMs || 15000,
      now: ctx.now,
    }
    try {
      let streamUrl = await streamUrlFor(channel, options)
      let manifest
      try {
        manifest = await requestManifest(streamUrl, options)
      } catch (error) {
        // 密钥、域名或流 ID 变化都可能拒绝旧源：重新读配置并签名一次，再失败才放弃。
        if (error?.name === 'AbortError') throw error
        invalidate(channel, options.fetchImpl)
        streamUrl = await streamUrlFor(channel, options)
        manifest = await requestManifest(streamUrl, options)
      }
      // 同域 HTTP 兼容或官方跳转成功后复用实际入口，避免每次轮询重复遇到同一证书错误。
      const cached = stateFor(options.fetchImpl).streams.get(channel.ref)
      if (cached && cached.url === streamUrl) cached.url = manifest.url
      return {
        url: manifest.url,
        desc: `${channel.name} 官方直播地址获取成功`,
        relayHls: true,
        manifestText: manifest.text,
        manifestUrl: manifest.url,
        upstreamHeaders: upstreamHeadersFor,
        upstreamUrlTransform: officialMediaUrl,
      }
    } catch (error) {
      const reason = error?.name === 'AbortError'
        ? `超时 ${options.timeoutMs}ms`
        : (error?.message || String(error))
      return { url: '', desc: `安徽广电链接请求失败：${reason}` }
    }
  }

  function clear() {
    generation++
    states.clear()
  }

  return { resolve, clear }
}

const resolver = createResolver()

export const resolveChannel = resolver.resolve
export const clearCache = resolver.clear
