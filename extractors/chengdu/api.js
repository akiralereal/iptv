/** 官方接口只解析当前地址；默认交给主项目 302，媒体由播放器直连。 */
import { proxyAwareFetch } from '../../utils/systemProxy.js'
import { CHANNELS, CHANNEL_BY_REF } from './channels.js'

export { CHANNELS }
export const API_BASE = 'https://mob.api.cditv.cn/show/'
const MAX_TEXT_BYTES = 512 * 1024

const OFFICIAL_HOST = /(^|\.)cditv\.cn$/

/** 路径里带频道标识的段（去掉扩展名，忽略 live 与末尾的清单文件名）必须都属于本频道。 */
function matchesChannel(pathname, channel) {
  const keys = pathname.split('/').slice(1, -1).map(part => part.split('.')[0].toLowerCase())
    .filter(part => part && part !== 'live')
  return keys.length > 0 && keys.every(key => channel.streamKeys.includes(key))
}

export function officialPlayUrl(raw, channel) {
  let url
  try { url = new URL(raw) } catch { throw new Error('官方播放地址无效') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
      || url.port || url.hash || !OFFICIAL_HOST.test(url.hostname) || !url.pathname.endsWith('.m3u8')
      || !matchesChannel(url.pathname, channel)
      || !url.searchParams.get('wsSecret') || !url.searchParams.get('wsTime')) {
    throw new Error('官方播放地址不符合频道配置')
  }
  // 与用户提供的 NAS 脚本一致：成都主频道的 HTTP 地址升级为 HTTPS；区县保留官方协议。
  if (channel.main) url.protocol = 'https:'
  return url.href
}

export function playUrlFromPayload(payload, channel) {
  if (payload?.state !== true || payload?.result !== 1 || payload?.code !== 0 || !payload?.data) {
    throw new Error('官方接口当前没有可用频道数据')
  }
  const data = payload.data
  const candidates = [channel.main && data.android_HDlive_url, data.android_url].filter(Boolean)
  if (!candidates.length) throw new Error('官方接口当前没有直播地址')
  // 高清地址不合规时退回标清，两者都不合规才报错。
  let lastError
  for (const raw of candidates) {
    try { return officialPlayUrl(raw, channel) } catch (error) { lastError = error }
  }
  throw lastError
}

export async function requestPlayUrl(channel, { fetchImpl = proxyAwareFetch, timeoutMs = 8000 } = {}) {
  let response
  try {
    response = await fetchImpl(`${API_BASE}192-${channel.code}.html`, {
      redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
    })
  } catch (error) {
    throw new Error(['AbortError', 'TimeoutError'].includes(error?.name) ? '官方接口请求超时' : '官方接口网络请求失败')
  }
  if (!response.ok) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error(`官方接口 HTTP ${response.status}`)
  }
  if (Number(response.headers.get('content-length')) > MAX_TEXT_BYTES) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error('官方接口响应过大')
  }
  const chunks = []
  let size = 0
  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength
      if (size > MAX_TEXT_BYTES) throw new Error('官方接口响应过大')
      chunks.push(Buffer.from(chunk))
    }
  } catch (error) {
    if (error?.message === '官方接口响应过大') throw error
    throw new Error(['AbortError', 'TimeoutError'].includes(error?.name) ? '官方接口请求超时' : '官方接口响应读取失败')
  }
  let payload
  try { payload = JSON.parse(Buffer.concat(chunks, size).toString('utf8')) }
  catch { throw new Error('官方接口返回无效 JSON') }
  return playUrlFromPayload(payload, channel)
}

export function buildChannels() {
  return CHANNELS.map(channel => ({
    name: channel.name, deferredRef: channel.ref, catchup: 'none', logo: channel.logo,
    opts: ['network-caching=3000'],
  }))
}

export function claimsRef(ref) {
  return typeof ref === 'string' && CHANNEL_BY_REF.has(ref)
}

export function createResolver({ fetchImpl = proxyAwareFetch } = {}) {
  return {
    async resolve(ref, ctx = {}) {
      const channel = CHANNEL_BY_REF.get(ref)
      if (!channel) return { url: '', desc: '成都频道引用格式错误' }
      try {
        const url = await requestPlayUrl(channel, { fetchImpl: ctx.fetchImpl || fetchImpl, timeoutMs: ctx.timeoutMs ?? 8000 })
        return { url, desc: `${channel.name} 官方直播地址获取成功` }
      } catch (error) {
        return { url: '', desc: `${channel.name} 取流失败：${error.message}` }
      }
    },
  }
}

export const resolveChannel = createResolver().resolve
