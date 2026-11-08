import { outboundFetch } from '../../utils/outboundProxy.js'
import { checkHls } from './hls.js'

export const HOME = 'https://play.xumo.com/live-guide'
export const API = 'https://valencia-app-mds.xumo.com'
export const API_HOSTS = ['play.xumo.com', 'valencia-app-mds.xumo.com', 'ottcms.weathergroup.com']
// 从 Xumo 官方提供的入口、跳转和 HLS 子资源核对；没有接受任意客户端 URL 的接口。
export const MEDIA_HOSTS = ['cloudfront.net', 'akamaized.net', 'amagi.tv', 'dai.google.com', 'googlevideo.com',
  'lura.app', 'lura.live', 'mediatailor.us-east-1.amazonaws.com', 's3.amazonaws.com', 'xumo.com',
  'frequency.stream', 'cbsivideo.com', 'nextologies.com', 'wurl.com', 'wurl.tv', 'gideo.video',
  'otteravision.com', 'fast.nbcuni.com', 'news12static.com', 'fubo.tv', 'stingray.com',
  'livecdn.io', 'lawandcrime.net', 'fsy.nfl.com', 'b-cdn.net', 'vsnt.net']
export function safeUrl(raw, hosts = MEDIA_HOSTS) {
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
      !hosts.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) throw new Error('地址不在已核对的 Xumo 官方链路中')
  return url.href
}
export const redact = error => String(error?.message || error).replace(/https?:\/\/[^\s"'<>]+/g, '[上游地址]').slice(0, 300)
export function validateManifest(body, base) {
  checkHls(body)
  for (const line of body.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
    if (!line.startsWith('#')) safeUrl(new URL(line, base))
    else for (const m of line.matchAll(/(?<![A-Z0-9-])URI="([^"]+)"/g)) safeUrl(new URL(m[1], base))
  }
  return body
}
export async function readLimited(response, limit = 8 * 1024 * 1024) {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Xumo 上游 HTTP ${response.status}`) }
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('Xumo 响应过大') }
  const chunks = []; let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > limit) throw new Error('Xumo 响应过大')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}
export function createTransport({ fetchImpl = outboundFetch, timeoutMs = 20000, signal, canRun = () => true } = {}) {
  async function request(raw, { hosts = MEDIA_HOSTS, ...options } = {}) {
    let url = safeUrl(raw, hosts)
    const signals = [AbortSignal.timeout(timeoutMs), signal, options.signal].filter(Boolean)
    for (let hop = 0; hop < 6; hop++) {
      if (!canRun()) throw new Error('Xumo 模块已关闭')
      const response = await fetchImpl(url, { ...options, headers: { 'User-Agent': 'Mozilla/5.0', ...options.headers }, signal: AbortSignal.any(signals), redirect: 'manual' })
      if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url }
      const next = response.headers.get('location'); await response.body?.cancel()
      if (!next) throw new Error('Xumo 重定向缺少地址')
      url = safeUrl(new URL(next, url), hosts)
    }
    throw new Error('Xumo 重定向过多')
  }
  async function text(raw, options = {}) {
    const { response, url } = await request(raw, options)
    return { text: (await readLimited(response, options.limit)).toString('utf8'), url }
  }
  async function hls(raw) { const result = await text(raw); validateManifest(result.text, result.url); return result }
  async function media(raw, options = {}) {
    const { response, url } = await request(raw, options)
    // 校验每个子清单里的后续地址；字幕、音轨和 AES key 与视频共用同一出站代理。
    if (options.method === 'HEAD' || !response.ok || !(/\.m3u8(?:\?|$)/i.test(url) || /mpegurl/i.test(response.headers.get('content-type') || ''))) return response
    const body = (await readLimited(response, 2 * 1024 * 1024)).toString('utf8')
    validateManifest(body, url)
    const headers = new Headers(response.headers); headers.delete('content-encoding'); headers.delete('content-length')
    const checked = new Response(body, { status: response.status, headers })
    Object.defineProperty(checked, 'url', { value: url })
    return checked
  }
  return { request, text, hls, media, json: async url => JSON.parse((await text(url, { hosts: API_HOSTS })).text),
    bytes: async (url, limit = 30 * 1024 * 1024) => readLimited((await request(url)).response, limit) }
}
