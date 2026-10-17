import { proxyAwareFetch } from '../../utils/systemProxy.js'
import { CHANNELS, CHANNEL_BY_REF } from './channels.js'
import { mediaUrl, verifyStream } from './media.js'

export { CHANNELS }
export const TV_PAGE = 'https://www.shaoxing.com.cn/app/tv/75'
export const LIST_API = 'https://app.shaoxing.com.cn/video/player/streamlist?site_id=10001&live_type=1'
const API_BASE = 'https://app.shaoxing.com.cn/video/player/'
const MAX_BYTES = 512 * 1024

async function requestJson(url, { fetchImpl = proxyAwareFetch, timeoutMs = 12000 } = {}) {
  // 频道身份只由固定官方接口确认，不把媒体 CDN 当成频道目录。
  const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok || response.status >= 300) {
    await response.body?.cancel()
    throw new Error(`官网 HTTP ${response.status}`)
  }
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body?.cancel()
    throw new Error('官网响应过大')
  }
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > MAX_BYTES) throw new Error('官网响应过大')
    chunks.push(Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const channelName = raw => String(raw || '').replace(/\s+/g, '').replace(/^绍兴/, '').replace(/频道$/, '')
function sameChannel(row, channel) {
  if (!row || String(row.live_type) !== '1' || Number(row.access_type) !== 1) return false
  // 有名称时同时核对，避免频道 ID 被官网复用；ID 变化时仅精确匹配官方原名。
  if (row.name && channelName(row.name) !== channelName(channel.rawName)) return false
  return String(row.id) === channel.id || channelName(row.name) === channelName(channel.rawName)
}

async function catalogRows(options) {
  const payload = await requestJson(LIST_API, options)
  if (payload.state !== true || !Array.isArray(payload.data)) throw new Error('绍兴官网频道列表不可用')
  return payload.data
}

export async function requestCatalog(options) {
  const rows = await catalogRows(options)
  return CHANNELS.flatMap(channel => {
    const row = rows.find(item => sameChannel(item, channel))
    return row ? [{ ...channel, url: mediaUrl(row.play_url) }] : []
  })
}

async function candidates(row, options) {
  if (Number(row.play_control) !== 0) {
    const query = new URLSearchParams({ stream_id: String(row.id), site_id: '10001' })
    const control = await requestJson(`${API_BASE}getcontrol?${query}`, options)
    if (control.state === true) return [mediaUrl(control.data)]
    if (control.state !== false) throw new Error('绍兴播控响应无效')
  }
  const urls = [...new Set([row.play_url_hd, row.play_url, row.play_url_sd].filter(value => typeof value === 'string' && value.trim()))]
  if (!urls.length) throw new Error('官网没有返回直播地址')
  return urls
}

export function claimsRef(ref) { return CHANNEL_BY_REF.has(ref) }

export async function resolveChannel(ref, ctx = {}) {
  const channel = CHANNEL_BY_REF.get(ref)
  if (!channel) return { url: '', desc: '绍兴频道引用无效' }
  const tried = new Set()
  const reasons = []
  async function verifyRow(row) {
    if (!sameChannel(row, channel)) throw new Error('官网没有返回指定的绍兴电视频道')
    for (const candidate of await candidates(row, ctx)) {
      if (tried.has(candidate)) continue
      tried.add(candidate)
      try {
        const verified = await verifyStream(candidate, ctx)
        return { ...verified, desc: `${channel.name} 官网当前直播地址已验证`, relayHls: true }
      } catch (error) { reasons.push(error.message) }
    }
    return null
  }
  try {
    // 每次播放重新发现，缓存和导出目录不保存签名，也不回退到写死的旧源。
    try {
      const detail = await requestJson(`${API_BASE}stream?stream_id=${channel.id}&site_id=10001`, ctx)
      const verified = await verifyRow(detail)
      if (verified) return verified
    } catch (error) { reasons.push(error.message) }
    // 官网更换频道 ID，或详情接口暂留旧地址时，从当前电视目录按频道身份重找。
    const rows = await catalogRows(ctx)
    const row = rows.find(item => sameChannel(item, channel))
    if (!row) throw new Error('官网当前电视目录中没有此频道')
    const verified = await verifyRow(row)
    if (verified) return verified
    throw new Error(reasons.at(-1) || '官网当前直播源不可用')
  } catch (error) {
    // 不输出可能含短期签名的 URL、Cookie 或网络库原始错误。
    const reason = /^(?:绍兴|官网)/.test(error.message) && !/https?:\/\//i.test(error.message)
      ? error.message : '官网地址发现或媒体验证失败'
    return { url: '', desc: `${channel.name} 取流失败：${reason}` }
  }
}
