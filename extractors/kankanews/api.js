/** 看看新闻（SMG）的接口验签、频道表、播放地址还原与短期缓存。 */
import {
  constants,
  createHash,
  createPublicKey,
  publicDecrypt,
  randomBytes,
} from 'node:crypto'
import fetch from 'node-fetch'

export const CHANNEL_LIST_URL = 'https://kapi.kankanews.com/content/pc/tv/channels'
export const CHANNEL_DETAIL_URL = 'https://kapi.kankanews.com/content/pc/tv/channel/detail'
export const PROGRAM_LIST_URL = 'https://kapi.kankanews.com/content/pc/tv/programs'
export const PROGRAM_DETAIL_URL = 'https://kapi.kankanews.com/content/pc/tv/program/detail'
export const SCENIC_DETAIL_URL = 'https://kapi.kankanews.com/content/pc/news/detail'

// v2 详情接口虽然仍返回成功，但它生成的播放 token 会被 CDN 拒绝（HTTP 403）。
// 官网兼容的 v1 / 2.42.15 组合生成的同一条 HLS 地址可正常取回。
const APP_VERSION = '2.42.15'
const API_VERSION = 'v1'
const SIGN_SALT = '28c8edde3d61a0411511d3b1866f0636'
const NONCE_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const UUID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const DETAIL_RETRY_MS = 60 * 1000
const DEFAULT_REFRESH_MS = 150 * 1000
const EXPIRY_SKEW_MS = 5 * 60 * 1000
const SCENIC_CONTENT_ID = '8029037XEw6'

// 必须与 utils/appUtils.js / utils/hlsProxy.js 的上游 UA 一致。官网把 UA 的 MD5
// 写进播放 token；取详情和随后代理清单/分片若不是同一个 UA，CDN 会直接 403。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export const UPSTREAM_HEADERS = {
  Origin: 'https://live.kankanews.com',
  Referer: 'https://live.kankanews.com/huikan',
}

// 官网 jsencrypt.js 把 RSA decrypt 改成了公钥运算；接口返回的是私钥分块处理后的
// PKCS#1 v1.5 数据。Node 用 RSA_NO_PADDING 做同一公钥运算，再在下面严格去填充。
export const STREAM_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDP5hzPUW5RFeE2xBT1ERB3hHZI
Votn/qatWhgc1eZof09qKjElFN6Nma461ZAwGpX4aezKP8Adh4WJj4u2O54xCXDt
wzKRqZO2oNZkuNmF2Va8kLgiEQAAcxYc8JgTN+uQQNpsep4n/o1sArTJooZIF17E
tSqSgXDcJ7yDj5rc7wIDAQAB
-----END PUBLIC KEY-----`

const CHANNELS = [
  { id: '1', rawName: '东方卫视', name: '东方卫视' },
  { id: '2', rawName: '新闻综合', name: '上海新闻综合' },
  { id: '11', rawName: '魔都眼', name: '魔都眼' },
  { id: '5', rawName: '第一财经', name: '第一财经' },
  { id: '12', rawName: '新纪实', name: '新纪实' },
  { id: '10', rawName: '五星体育', name: '五星体育' },
  { id: '4', rawName: '都市频道', name: '上海都市' },
  { id: '9', rawName: '哈哈炫动', name: '哈哈炫动' },
]

const SCENIC_CHANNELS = [
  { id: '15989', rawName: '陆家嘴', name: '陆家嘴' },
  { id: '13755', rawName: '外滩观光平台', name: '外滩观光平台' },
  // 与电视台频道「魔都眼」不是同一条流，显示名必须区分，避免全局频道去重。
  { id: '12835', rawName: '魔都眼', name: '魔都眼景观' },
  { id: '13973', rawName: '北外滩', name: '北外滩' },
  { id: '13974', rawName: '外白渡桥', name: '外白渡桥' },
]

const CHANNEL_BY_ID = new Map(CHANNELS.map(channel => [channel.id, channel]))
const SCENIC_BY_ID = new Map(SCENIC_CHANNELS.map(channel => [channel.id, channel]))
const detailCache = new Map()
const detailPending = new Map()
let scenicCache = null
let scenicPending = null

function randomString(length, alphabet) {
  const bytes = randomBytes(length)
  return Array.from(bytes, byte => alphabet[byte % alphabet.length]).join('')
}

function md5(value) {
  return createHash('md5').update(value).digest('hex')
}

/** 官网请求头：公共字段与业务参数排序拼接，末尾加盐后连续 MD5 两次。 */
export function buildSignedHeaders(params = {}, options = {}) {
  const common = {
    platform: 'pc',
    version: APP_VERSION,
    nonce: String(options.nonce || randomString(8, NONCE_ALPHABET)),
    timestamp: Math.floor(Number(options.now ?? Date.now()) / 1000),
    'Api-Version': API_VERSION,
  }
  const all = { ...params, ...common }
  const canonical = Object.keys(all).sort()
    .filter(key => all[key] != null)
    .map(key => `${key}=${all[key]}&`)
    .join('') + SIGN_SALT
  return {
    ...common,
    sign: md5(md5(canonical)),
    'm-uuid': String(options.uuid || randomString(21, UUID_ALPHABET)),
    Accept: 'application/json',
    'User-Agent': UA,
    ...UPSTREAM_HEADERS,
  }
}

function validLogo(raw) {
  const text = String(raw || '').trim().replace(/^http:\/\//i, 'https://')
  try {
    const url = new URL(text)
    return url.protocol === 'https:' ? url.href : ''
  } catch {
    return ''
  }
}

export function buildChannels(rows) {
  const found = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row?.id || '')
    const definition = CHANNEL_BY_ID.get(id)
    if (!definition || String(row?.name || '').trim() !== definition.rawName || found.has(id)) continue
    found.set(id, {
      name: definition.name,
      deferredRef: `kankanews-${id}`,
      // 地址 token 绑定取详情时的出口 IP 与 UA，交给客户端直连很容易 403；
      // 全代理保证详情、清单、分片都由同一服务端网络与 UA 发出。
      proxyHls: true,
      logo: validLogo(row?.cover || row?.station_logo),
    })
  }
  return CHANNELS.map(channel => found.get(channel.id)).filter(Boolean)
}

export function buildScenicChannels(rows) {
  const found = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row?.id || '')
    const definition = SCENIC_BY_ID.get(id)
    if (!definition || String(row?.title || '').trim() !== definition.rawName || found.has(id)) continue
    if (!String(row?.play_url || '').trim()) continue
    found.set(id, {
      name: definition.name,
      deferredRef: `kankanews-scenic-${id}`,
      proxyHls: true,
      logo: validLogo(row?.cover),
    })
  }
  return SCENIC_CHANNELS.map(channel => found.get(channel.id)).filter(Boolean)
}

function unpadSignedBlock(block) {
  if (block.length < 12 || block[0] !== 0 || block[1] !== 1) {
    throw new Error('播放地址 RSA 数据头无效')
  }
  let separator = 2
  while (separator < block.length && block[separator] === 0xff) separator++
  // PKCS#1 v1.5 要求至少 8 字节填充。
  if (separator < 10 || block[separator] !== 0) throw new Error('播放地址 RSA 填充无效')
  return block.subarray(separator + 1)
}

/** 还原官网分块 RSA 地址。publicKey 参数仅用于单元测试注入同算法测试密钥。 */
export function decryptLiveAddress(value, publicKey = STREAM_PUBLIC_KEY) {
  const text = String(value || '').trim()
  if (!text || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new Error('播放地址密文格式无效')
  const encrypted = Buffer.from(text, 'base64')
  const key = publicKey?.type === 'public' ? publicKey : createPublicKey(publicKey)
  const modulusBits = Number(key.asymmetricKeyDetails?.modulusLength || 1024)
  const blockSize = Math.ceil(modulusBits / 8)
  if (!encrypted.length || encrypted.length % blockSize !== 0) throw new Error('播放地址密文分块不完整')

  const chunks = []
  for (let offset = 0; offset < encrypted.length; offset += blockSize) {
    const block = publicDecrypt({ key, padding: constants.RSA_NO_PADDING }, encrypted.subarray(offset, offset + blockSize))
    chunks.push(unpadSignedBlock(block))
  }
  return Buffer.concat(chunks).toString('utf8')
}

function validStreamUrl(raw) {
  try {
    const url = new URL(String(raw || ''))
    return url.protocol === 'https:'
      && (url.hostname === 'kksmg.com' || url.hostname.endsWith('.kksmg.com'))
      && /\.m3u8$/i.test(url.pathname)
      && url.search.length > 1
  } catch {
    return false
  }
}

function streamExpiry(rawUrl) {
  try {
    const token = new URL(rawUrl).searchParams.get('token') || ''
    const payload = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8'))
    return Number(payload.exp) * 1000 || 0
  } catch {
    return 0
  }
}

async function requestJson(url, params, options = {}) {
  const controller = new AbortController()
  const timeoutMs = options.timeoutMs || 10000
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const target = new URL(url)
    for (const [key, value] of Object.entries(params || {})) target.searchParams.set(key, String(value))
    const response = await (options.fetchImpl || fetch)(target.href, {
      headers: buildSignedHeaders(params, options),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = await response.json()
    if (String(payload?.code) !== '1000') {
      throw new Error(payload?.message || payload?.code || '返回结构不符合预期')
    }
    return payload.result
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : (error?.message || String(error))
    throw new Error(reason)
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchChannelList(options = {}) {
  const result = await requestJson(CHANNEL_LIST_URL, {}, options)
  if (!Array.isArray(result?.list)) throw new Error('频道接口没有返回列表')
  return result.list
}

export async function fetchScenicList(options = {}) {
  const result = await requestJson(SCENIC_DETAIL_URL, { content_id: SCENIC_CONTENT_ID }, options)
  if (!Array.isArray(result?.play_info)) throw new Error('上海景观接口没有返回线路列表')
  return result
}

// 明确停供时不能沿用旧 token；只有临时网络故障才允许复用尚有效的缓存。
class ChannelUnavailableError extends Error {}

export async function fetchChannelDetail(channelId, options = {}) {
  const id = String(channelId || '')
  if (!CHANNEL_BY_ID.has(id)) throw new Error('频道 ID 无效')
  const result = await requestJson(CHANNEL_DETAIL_URL, { channel_id: id }, options)
  let address = result?.live_address
  let programEnd = 0
  // 官网有节目单的频道已不再从频道详情发放地址，需查当前节目，再读
  // program/detail.channel_info.live_address。无节目单频道仍走原接口。
  if (Number(result?.is_exist_program) === 1) {
    const now = Number(options.now ?? Date.now())
    const date = new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const schedule = await requestJson(PROGRAM_LIST_URL, { channel_id: id, date }, options)
    if (!Array.isArray(schedule?.programs)) throw new Error('节目单接口没有返回节目列表')
    const program = schedule.programs.find(row => row?.id
      && Number(row.start_time) * 1000 <= now && now < Number(row.end_time) * 1000)
    if (!program) throw new ChannelUnavailableError('官网节目单中没有当前正在播出的节目')
    programEnd = Number(program.end_time) * 1000
    const unavailable = () => new ChannelUnavailableError(`当前节目「${program.name || '未命名'}」因版权限制，官网暂停网络直播`)
    if (Number(program.is_shield) === 1) throw unavailable()
    const detail = await requestJson(PROGRAM_DETAIL_URL, { channel_program_id: String(program.id) }, options)
    if (Number(detail?.is_shield) === 1) throw unavailable()
    if (String(detail?.channel_id) !== id || String(detail?.channel_info?.id) !== id) {
      throw new Error('节目详情返回的频道与请求不一致')
    }
    address = detail.channel_info.live_address
  }
  if (!String(address || '').trim()) throw new ChannelUnavailableError('官网当前未提供直播地址，请稍后重试')
  const url = decryptLiveAddress(address, options.publicKey)
  if (!validStreamUrl(url)) throw new Error('还原后的播放地址不是看看新闻 HTTPS HLS')
  return { ...result, url, programEnd }
}

async function cachedChannelDetail(channelId, options = {}) {
  const now = Number(options.now ?? Date.now())
  const cached = detailCache.get(channelId)
  if (cached?.validUntil > now && (cached.refreshAt > now || cached.retryAt > now)) return cached

  let pending = detailPending.get(channelId)
  if (!pending) {
    pending = fetchChannelDetail(channelId, options)
      .then(detail => {
        const apiTtl = Math.max(30 * 1000, Number(detail.limit_time || 180) * 1000 - 30 * 1000)
        const tokenExpiry = streamExpiry(detail.url)
        const validUntil = Math.min(tokenExpiry || now + 30 * 60 * 1000, detail.programEnd || Infinity)
        const entry = {
          detail,
          refreshAt: Math.min(now + Math.min(DEFAULT_REFRESH_MS, apiTtl), validUntil),
          validUntil,
          retryAt: 0,
        }
        detailCache.set(channelId, entry)
        return entry
      })
      .finally(() => {
        if (detailPending.get(channelId) === pending) detailPending.delete(channelId)
      })
    detailPending.set(channelId, pending)
  }

  try {
    return await pending
  } catch (error) {
    if (error instanceof ChannelUnavailableError) {
      detailCache.delete(channelId)
      throw error
    }
    if (!cached || cached.validUntil <= now + EXPIRY_SKEW_MS) throw error
    cached.retryAt = now + DETAIL_RETRY_MS
    return cached
  }
}

async function fetchScenicDetails(options = {}) {
  const result = await fetchScenicList(options)
  const details = new Map()
  for (const row of result.play_info) {
    const id = String(row?.id || '')
    const definition = SCENIC_BY_ID.get(id)
    if (!definition || String(row?.title || '').trim() !== definition.rawName) continue
    const url = decryptLiveAddress(row?.play_url, options.publicKey)
    if (!validStreamUrl(url)) throw new Error(`${definition.name}还原后的地址不是看看新闻 HTTPS HLS`)
    details.set(id, { ...row, url })
  }
  if (!details.size) throw new Error('上海景观接口没有可用播放线路')
  return { details, limit_time: result.limit_time }
}

async function cachedScenicDetails(options = {}) {
  const now = Number(options.now ?? Date.now())
  if (scenicCache?.refreshAt > now || scenicCache?.retryAt > now) return scenicCache

  if (!scenicPending) {
    scenicPending = fetchScenicDetails(options)
      .then(bundle => {
        const apiTtl = Math.max(30 * 1000, Number(bundle.limit_time || 180) * 1000 - 30 * 1000)
        const expiries = [...bundle.details.values()].map(detail => streamExpiry(detail.url)).filter(Boolean)
        const entry = {
          bundle,
          refreshAt: now + Math.min(DEFAULT_REFRESH_MS, apiTtl),
          validUntil: expiries.length ? Math.min(...expiries) : now + 30 * 60 * 1000,
          retryAt: 0,
        }
        scenicCache = entry
        return entry
      })
      .finally(() => { scenicPending = null })
  }

  try {
    return await scenicPending
  } catch (error) {
    if (!scenicCache || scenicCache.validUntil <= now + EXPIRY_SKEW_MS) throw error
    scenicCache.retryAt = now + DETAIL_RETRY_MS
    return scenicCache
  }
}

export async function resolveChannel(ref, ctx = {}) {
  try {
    const scenicMatch = /^kankanews-scenic-(\d{4,5})$/.exec(String(ref || ''))
    if (scenicMatch) {
      const definition = SCENIC_BY_ID.get(scenicMatch[1])
      if (!definition) return { url: '', desc: '看看新闻景观频道引用格式错误' }
      const cached = await cachedScenicDetails(ctx)
      const detail = cached.bundle.details.get(scenicMatch[1])
      if (!detail) return { url: '', desc: `${definition.name}当前没有可用播放线路` }
      return {
        url: detail.url,
        desc: `${definition.name}播放地址获取成功`,
        upstreamHeaders: UPSTREAM_HEADERS,
      }
    }

    const match = /^kankanews-(\d{1,2})$/.exec(String(ref || ''))
    if (!match || !CHANNEL_BY_ID.has(match[1])) return { url: '', desc: '看看新闻频道引用格式错误' }
    const cached = await cachedChannelDetail(match[1], ctx)
    return {
      url: cached.detail.url,
      desc: `${CHANNEL_BY_ID.get(match[1]).name}播放地址获取成功`,
      upstreamHeaders: UPSTREAM_HEADERS,
    }
  } catch (error) {
    return { url: '', desc: `看看新闻链接请求失败：${error?.message || String(error)}` }
  }
}

export function clearCache() {
  detailCache.clear()
  detailPending.clear()
  scenicCache = null
  scenicPending = null
}
