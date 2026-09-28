/**
 * 天津广播电视台：津云 App 的七路电视频道，播放时按 App 的 WiseTV 协议签发直播地址。
 *
 * 由独立实验台 tv-lab/jinyun-live-lab 的纯 Node 模式验证后移植（App 模式那套安卓模拟器 +
 * Frida 没有搬）。链路：
 *   1. POST /fdl/crypt/getWise4PK 取 RSA 公钥（一小时复用一次）；
 *   2. 明文「包名|8 位十六进制会话键|32 位频道 ID」按 64 字节分块 RSA-PKCS1 → base64 →
 *      App 内置 24 字节密钥 3DES-ECB → hex → 正向 2 字节循环移位，作 wise4ParaBody 发给
 *      POST /fdl/crypt/getWise4Url；
 *   3. 回来的 data.url 反向移位 → 同一把 3DES 解出内层 hex → 以会话键重复三遍为密钥再 3DES
 *      解出直播地址。
 * AK / SK 与 3DES 密钥都是 App 内置参数（见 auth.js），环境变量可覆盖。
 *
 * ⚠️ 这条协议不是 App 当前版本播放时走的路径：9 月中旬曾被判「对 4.6.0 已废」，后来查明是
 * 移植时漏了第 2 步的循环移位、又拿 SK 当了 3DES 密钥；改正后 2026-09-25 关掉模拟器七路全通。
 * 接口还活着，但平台随时可能下线它——哪天整体只回错误，就是这条路断了，不是本模块的毛病。
 *
 * 实测（2026-09-25）签发结果：
 * - 每次签发由接口在三家 CDN 间轮换，同一频道这次 live-tx（腾讯）下次 live2（网宿）或
 *   live-bd（百度）；都是 HTTP、1280x720 H.264 / AAC，入口是只含一路码率的 master，
 *   媒体清单里每个分片各自带签名，去掉签名一律 403。三家的分片命名、时长和序号各不相同。
 * - 地址里的 txTime / wsTime 是签发时刻（十六进制秒，等于签发当下），live-bd 的 timestamp
 *   是签发后 10 分钟。入口本身的有效期：live2 与 live-bd 签发后 9.5 分钟还能取、整 10 分钟起 403；
 *   live-tx 长得多，签发 60 分钟后仍能重取（没再往后测）。
 * - 入口换出来的媒体清单地址（live2 带 wsHlsSession 会话）不跟着入口过期：三家各一路每 3 秒
 *   轮询，连续 40 分钟都在出新分片；隔十分钟才轮询一次的旧地址到 60 分钟也照样能取。
 *   经本机 /proxy/ 三家各一路连续解码 25 分钟（两轮半签名有效期），媒体时长走满、中途没有缺片，
 *   一直没换 CDN。所以正在播的频道直接轮询媒体清单，不回入口、不重签：重签多半会换到另一家
 *   CDN，分片命名、序号和时间戳整个换掉，清单里又没有 DISCONTINUITY 标记，对播放器就是一次
 *   没预告的断点。媒体清单取不到、或停播超过 SESSION_IDLE_MS，才从入口重来；入口签名按频道缓存，
 *   SIGN_POLICY 内复用，签发接口不随清单轮询被打。
 * - live-tx / live-bd 不看 UA 与 Referer（Lavf、okhttp、Chrome、不带 UA，带不带 Referer，
 *   清单和分片都 200/206）。live2 不一样：wsHlsSession 绑定取清单那一方的 UA 与 Referer，
 *   换一个 UA 或多带一个 Referer 去取分片就 403。relay 下清单由本机取、分片由播放器直连，
 *   两边 UA 必然不同，落到 live2 的频道一播就断；而哪路会落到 live2 是接口每次签发时定的。
 *   所以只能全代理：清单与分片都由本机以同一个 UA 回源（index.js 声明 channelHlsMode: 'proxy'）。
 */
import {
  constants,
  createCipheriv,
  createDecipheriv,
  publicEncrypt,
  randomBytes,
} from 'node:crypto'

import { proxyAwareFetch } from '../../utils/systemProxy.js'
import { API_ROOT, API_UA, wiseConfig, wiseHeaders } from './auth.js'
import { CHANNELS } from './channels.js'

export { CHANNELS }

export const BUNDLE_ID = 'cn.com.enorth.jinyun'
export const PUBLIC_KEY_API = `${API_ROOT}/fdl/crypt/getWise4PK`
export const SIGN_API = `${API_ROOT}/fdl/crypt/getWise4Url`
// 清单与分片回源用同一个标识：live2 的会话认的就是「取清单的那个 UA」，两边一致即可
export const MEDIA_UA = API_UA
export const PUBLIC_KEY_TTL_MS = 60 * 60 * 1000
// 入口签名：live2 / live-bd 签发后整 10 分钟起 403（见文件头）。7 分钟换新；换签失败时
// 9.5 分钟内沿用旧地址，retryMs 内不再打接口
export const SIGN_POLICY = Object.freeze({ refreshMs: 7 * 60 * 1000, retryMs: 10 * 1000, hardTtlMs: 9.5 * 60 * 1000 })
// 正在播的频道直接轮询媒体清单（会话），这么久没人轮询就当停播，下次从入口重新开始
export const SESSION_IDLE_MS = 60 * 1000
// 旧签名取不到清单时丢掉重签，同一路 FORCE_RESIGN_GAP_MS 内只强制一次，
// 免得 CDN 整体拒绝时播放器的连环重试把签发接口一起打爆
export const FORCE_RESIGN_GAP_MS = 15 * 1000
// 签发接口本身失败（没有可沿用的旧地址时）同一路这么久内直接回上次的错误
const FAILURE_COOLDOWN_MS = 5 * 1000

const MAX_API_BYTES = 256 * 1024
const MAX_MANIFEST_BYTES = 512 * 1024
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const CHANNEL_ID_RE = /^\d{32}$/
// 实测三家：live-tx、live2、live-bd；接口哪天多轮换一家同名规则的也照收，但只认 wisetv.com.cn
const MEDIA_HOST_RE = /^live(?:\d{1,2}|-[a-z0-9]{1,16})?\.wisetv\.com\.cn$/
const MEDIA_PATH_RE = /^(?:\/[A-Za-z0-9_-]{1,96}){1,4}\.(?:m3u8|ts)$/

const CHANNEL_BY_REF = new Map(CHANNELS.map(channel => [channel.ref, channel]))

// ---------------------------------------------------------------------------
// 加解密（与 App 内 FDLUtil 一致）
// ---------------------------------------------------------------------------

function cipherKeyBytes(value) {
  const key = Buffer.from(String(value || ''), 'utf8')
  if (key.length !== 24) throw new Error('津云 3DES 密钥必须正好 24 字节')
  return key
}

function tripleDes(value, key, decrypt = false) {
  const cipher = decrypt ? createDecipheriv('des-ede3', key, null) : createCipheriv('des-ede3', key, null)
  return Buffer.concat([cipher.update(value), cipher.final()])
}

/** App 在 3DES 外层对 hex 串做 2 字节（4 个字符）的循环移位：发出去左移，收回来右移。 */
export function rotateHex(value, forward) {
  const text = String(value)
  return forward ? text.slice(4) + text.slice(0, 4) : text.slice(-4) + text.slice(0, -4)
}

/** 8 位小写十六进制会话键；解直播地址时它重复三遍就是内层 3DES 密钥。 */
export function createSessionKey(random = randomBytes) {
  let value = ''
  for (const byte of random(8)) value += '0123456789abcdef'[byte & 0x0f]
  return value
}

export function encryptWiseRequest(channelId, publicKey, cipherKey, sessionKey) {
  if (!CHANNEL_ID_RE.test(String(channelId))) throw new Error('津云频道 ID 格式无效')
  if (!/^[0-9a-f]{8}$/.test(String(sessionKey))) throw new Error('津云会话键格式无效')
  const plaintext = Buffer.from(`${BUNDLE_ID}|${sessionKey}|${channelId}`, 'utf8')
  const chunks = []
  for (let offset = 0; offset < plaintext.length; offset += 64) {
    chunks.push(publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_PADDING }, plaintext.subarray(offset, offset + 64)))
  }
  const rsaBase64 = Buffer.concat(chunks).toString('base64')
  return rotateHex(tripleDes(Buffer.from(rsaBase64, 'utf8'), cipherKeyBytes(cipherKey)).toString('hex'), true)
}

export function decryptWiseUrl(value, cipherKey, sessionKey) {
  const text = String(value || '')
  if (!/^[0-9a-f]+$/i.test(text) || text.length % 16 !== 0) throw new Error('津云签发接口返回了无效的加密地址')
  try {
    const innerHex = tripleDes(Buffer.from(rotateHex(text, false), 'hex'), cipherKeyBytes(cipherKey), true).toString('utf8')
    if (!/^[0-9a-f]+$/i.test(innerHex) || innerHex.length % 16 !== 0) throw new Error('内层不是 hex')
    const session = Buffer.from(String(sessionKey), 'utf8')
    return tripleDes(Buffer.from(innerHex, 'hex'), Buffer.concat([session, session, session]), true).toString('utf8')
  } catch (error) {
    throw new Error(`津云直播地址解密失败：${error?.message || String(error)}`)
  }
}

/** 应用参数自检：环境变量覆盖时最常见的错是把 SK 当成 3DES 密钥填进去。 */
export function validateConfig(config) {
  if (!config?.ak || !config?.sk) throw new Error('津云接口缺少 AK / SK')
  cipherKeyBytes(config.cipherKey)
  if (config.cipherKey === config.ak || config.cipherKey === config.sk) {
    throw new Error('津云 3DES 密钥不能与 AK / SK 相同')
  }
  return config
}

// ---------------------------------------------------------------------------
// 媒体边界
// ---------------------------------------------------------------------------

/** 只放行 wisetv.com.cn 的 live* 直播主机上的清单与分片；relay/proxy 登记每条地址前都经这里。 */
export function officialMediaUrl(raw) {
  let url
  try {
    url = new URL(String(raw || '').trim())
  } catch {
    throw new Error('津云返回了无效媒体地址')
  }
  const defaultPort = url.protocol === 'http:' ? '80' : '443'
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash
      || !['', defaultPort].includes(url.port) || !MEDIA_HOST_RE.test(url.hostname)
      || /%2f|%5c/i.test(url.pathname) || !MEDIA_PATH_RE.test(url.pathname)) {
    throw new Error('津云返回了非官方媒体地址')
  }
  return url.href
}

function officialHlsUrl(raw) {
  const href = officialMediaUrl(raw)
  if (!new URL(href).pathname.endsWith('.m3u8')) throw new Error('津云返回的不是 HLS 入口')
  return href
}

/**
 * 清单与分片统一以 MEDIA_UA 回源、不带 Referer（live2 的会话绑 UA 和 Referer，见文件头）。
 * 函数形态：代理层只对函数返回的 User-Agent 放行（见 utils/hlsProxy.js），且每一跳重定向
 * 发出前都会经过这里，跳出白名单即拒绝。
 */
export function upstreamHeadersFor(raw) {
  officialMediaUrl(raw)
  return { 'User-Agent': MEDIA_UA }
}

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

async function discard(response) {
  response.body?.destroy?.()
  await response.body?.cancel?.().catch(() => {})
}

async function readText(response, maxBytes, label) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discard(response)
    throw new Error(`${label}响应过大`)
  }
  const text = await response.text()
  if (text.length > maxBytes) throw new Error(`${label}响应过大`)
  return text
}

async function withTimeout(timeoutMs, run) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await run(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

async function postApi(url, body, label, { fetchImpl, timeoutMs, config }) {
  return withTimeout(timeoutMs, async signal => {
    const response = await fetchImpl(url, {
      method: 'POST',
      redirect: 'manual',
      signal,
      headers: { ...wiseHeaders(config), 'content-type': 'application/x-www-form-urlencoded' },
      ...(body ? { body: body.toString() } : {}),
    })
    const text = await readText(response, MAX_API_BYTES, label)
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      throw new Error(`${label}返回的不是 JSON（HTTP ${response.status}）`)
    }
    if (!response.ok || Number(payload?.code) !== 200) {
      throw new Error(`${label}失败：${String(payload?.message || `HTTP ${response.status}`).slice(0, 80)}`)
    }
    return payload
  })
}

function variantOf(text, base) {
  // 实测只有一路码率；真有多路时取带宽最高的
  let best = null
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim()
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue
    const bandwidth = Number(/BANDWIDTH=(\d+)/.exec(line)?.[1] || 0)
    const uri = lines.slice(index + 1).map(next => next.trim()).find(next => next && !next.startsWith('#'))
    if (uri && (!best || bandwidth > best.bandwidth)) best = { bandwidth, url: new URL(uri, base).href }
  }
  return best?.url || null
}

async function getHls(raw, { fetchImpl, signal }) {
  let url = officialHlsUrl(raw)
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetchImpl(url, { redirect: 'manual', signal, headers: upstreamHeadersFor(url) })
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location')
      await discard(response)
      if (!location) throw new Error('津云直播清单重定向缺少地址')
      url = officialHlsUrl(new URL(location, url).href)
      continue
    }
    if (!response.ok) {
      await discard(response)
      throw new Error(`津云直播清单 HTTP ${response.status}`)
    }
    const text = await readText(response, MAX_MANIFEST_BYTES, '津云直播清单')
    if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('津云直播清单不是 HLS')
    return { text, url }
  }
  throw new Error('津云直播清单重定向次数过多')
}

function mediaPlaylist(playlist) {
  if (!/#EXTINF/.test(playlist.text)) throw new Error('津云直播清单没有分片')
  return playlist
}

/** 入口 master → 媒体清单。两跳都以 MEDIA_UA 取，媒体清单才和随后代理取分片的 UA 对得上。 */
export async function requestPlaylist(entryUrl, { fetchImpl = proxyAwareFetch, timeoutMs = 15000 } = {}) {
  return withTimeout(timeoutMs, async signal => {
    const entry = await getHls(entryUrl, { fetchImpl, signal })
    const variant = variantOf(entry.text, entry.url)
    return mediaPlaylist(variant ? await getHls(variant, { fetchImpl, signal }) : entry)
  })
}

/** 直接轮询上次拿到的媒体清单地址（播放中的会话）。 */
export async function requestMedia(mediaUrl, { fetchImpl = proxyAwareFetch, timeoutMs = 15000 } = {}) {
  return withTimeout(timeoutMs, async signal => mediaPlaylist(await getHls(mediaUrl, { fetchImpl, signal })))
}

export function buildChannels() {
  return CHANNELS.map(channel => ({
    name: channel.name,
    deferredRef: channel.ref,
    logo: channel.logo,
    groupTitle: '天津',
    opts: ['network-caching=3000'],
    catchup: 'none',
  }))
}

export function claimsRef(ref) {
  return CHANNEL_BY_REF.has(String(ref || ''))
}

// ---------------------------------------------------------------------------
// 解析器：公钥与签名的缓存都在这里，按实例隔离，测试注入的假 fetch 不会污染真实进程
// ---------------------------------------------------------------------------

export function createResolver({
  fetchImpl = proxyAwareFetch,
  env = process.env,
  random = randomBytes,
  now = () => Date.now(),
  sessionIdleMs = SESSION_IDLE_MS,
} = {}) {
  let publicKey = null            // { value, expiresAt }
  let publicKeyPending = null
  const signatures = new Map()    // ref → { url, refreshAt, hardExpiresAt, retryAt }
  const pending = new Map()       // ref → 进行中的签发
  const failures = new Map()      // ref → { error, until }
  const forcedAt = new Map()      // ref → 上次强制重签的时刻
  const sessions = new Map()      // ref → { entryUrl, mediaUrl, okAt } 正在播的媒体清单
  let generation = 0

  async function publicKeyFor(options) {
    if (publicKey && publicKey.expiresAt > now()) return publicKey.value
    if (!publicKeyPending) {
      const requestGeneration = generation
      const promise = postApi(PUBLIC_KEY_API, null, '津云公钥接口', options).then(payload => {
        const value = payload?.data
        if (typeof value !== 'string' || !value.includes('BEGIN PUBLIC KEY')) throw new Error('津云公钥接口没有返回公钥')
        if (requestGeneration === generation) publicKey = { value, expiresAt: now() + PUBLIC_KEY_TTL_MS }
        return value
      }).finally(() => {
        if (publicKeyPending === promise) publicKeyPending = null
      })
      publicKeyPending = promise
    }
    return publicKeyPending
  }

  async function sign(channel, options) {
    const key = await publicKeyFor(options)
    const sessionKey = createSessionKey(random)
    const body = new URLSearchParams({
      wise4ParaBody: encryptWiseRequest(channel.channelId, key, options.config.cipherKey, sessionKey),
    })
    let payload
    try {
      payload = await postApi(SIGN_API, body, '津云签发接口', options)
    } catch (error) {
      // 公钥轮换后旧公钥加密的请求会被拒：下次重新取
      publicKey = null
      throw error
    }
    if (typeof payload?.data?.url !== 'string') throw new Error('津云签发接口没有返回直播地址')
    return officialHlsUrl(decryptWiseUrl(payload.data.url, options.config.cipherKey, sessionKey))
  }

  /** 到期才重签；重签失败时在硬期限内沿用上次成功值并退避，过了硬期限照实报错。 */
  async function signedUrl(channel, options, { force = false } = {}) {
    const current = now()
    const hit = signatures.get(channel.ref)
    const usable = hit?.hardExpiresAt > current
    if (!force && (hit?.refreshAt > current || (usable && hit.retryAt > current))) return hit.url
    // 签发接口刚失败过、手里又没有能用的旧地址：冷却期内直接回上次的错误
    const failure = failures.get(channel.ref)
    if (failure?.until > current && (force || !usable)) throw failure.error

    let active = pending.get(channel.ref)
    if (!active) {
      const requestGeneration = generation
      const promise = sign(channel, options).then(url => {
        if (requestGeneration === generation) {
          const signedAt = now()
          signatures.set(channel.ref, {
            url,
            refreshAt: signedAt + SIGN_POLICY.refreshMs,
            hardExpiresAt: signedAt + SIGN_POLICY.hardTtlMs,
            retryAt: 0,
          })
          failures.delete(channel.ref)
        }
        return url
      }).finally(() => {
        if (pending.get(channel.ref) === promise) pending.delete(channel.ref)
      })
      active = promise
      pending.set(channel.ref, promise)
    }

    try {
      return await active
    } catch (error) {
      failures.set(channel.ref, { error, until: now() + FAILURE_COOLDOWN_MS })
      if (force || !hit || hit.hardExpiresAt <= now()) throw error
      hit.retryAt = now() + SIGN_POLICY.retryMs
      return hit.url
    }
  }

  /** 旧签名取不到清单：丢掉重签。限频，免得 CDN 整体拒绝时连环重签。 */
  function mayForceResign(channel) {
    const current = now()
    const last = forcedAt.get(channel.ref)
    if (last != null && current - last < FORCE_RESIGN_GAP_MS) return false
    forcedAt.set(channel.ref, current)
    return true
  }

  /** 正在播的频道：直接轮询上次的媒体清单，不回入口、不重签。取不到返回 null，由调用方从入口重来。 */
  async function fromSession(channel, options) {
    const session = sessions.get(channel.ref)
    if (!session || now() - session.okAt >= sessionIdleMs) {
      sessions.delete(channel.ref)
      return null
    }
    try {
      const playlist = await requestMedia(session.mediaUrl, options)
      session.okAt = now()
      return { url: session.entryUrl, playlist }
    } catch (error) {
      if (sessions.get(channel.ref) === session) sessions.delete(channel.ref)
      if (error?.name === 'AbortError') throw error
      return null
    }
  }

  async function fromEntry(channel, options) {
    const requestGeneration = generation
    let url = await signedUrl(channel, options)
    let playlist
    try {
      playlist = await requestPlaylist(url, options)
    } catch (error) {
      if (error?.name === 'AbortError' || !mayForceResign(channel)) throw error
      url = await signedUrl(channel, options, { force: true })
      playlist = await requestPlaylist(url, options)
    }
    if (requestGeneration === generation) sessions.set(channel.ref, { entryUrl: url, mediaUrl: playlist.url, okAt: now() })
    return { url, playlist }
  }

  async function resolve(ref, ctx = {}) {
    const channel = CHANNEL_BY_REF.get(String(ref || ''))
    if (!channel) return { url: '', desc: '天津频道引用格式错误' }
    const timeoutMs = ctx.timeoutMs || 15000
    try {
      const options = { fetchImpl, timeoutMs, config: validateConfig(wiseConfig(env)) }
      const { url, playlist } = await fromSession(channel, options) || await fromEntry(channel, options)
      return {
        // 302 回退与旧的无后缀入口用入口地址，播放器自己取 master、按自己的 UA 建会话。
        // /proxy/ 下代理层直接用下面的 manifestText，不会去碰它
        url,
        desc: `${channel.name}当前直播地址获取成功`,
        manifestText: playlist.text,
        manifestUrl: playlist.url,
        upstreamHeaders: upstreamHeadersFor,
        upstreamUrlTransform: officialMediaUrl,
      }
    } catch (error) {
      const reason = error?.name === 'AbortError'
        ? `超时 ${timeoutMs}ms`
        : (error?.message || String(error))
      return { url: '', desc: `天津广电链接请求失败：${reason}` }
    }
  }

  function clear() {
    generation++
    publicKey = null
    publicKeyPending = null
    signatures.clear()
    pending.clear()
    failures.clear()
    forcedAt.clear()
    sessions.clear()
  }

  return { resolve, clear }
}

const resolver = createResolver()

export const resolveChannel = resolver.resolve
export const clearCache = resolver.clear
