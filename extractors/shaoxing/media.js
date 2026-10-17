/** 只请求官网当前配置及其 HLS 引用；逐跳检查公网地址，保留完整查询参数。 */
import { lookup } from 'node:dns/promises'
import { lookup as lookupCallback } from 'node:dns'
import { BlockList, isIP } from 'node:net'
import { Agent } from 'undici'
import { proxyAwareFetch } from '../../utils/systemProxy.js'

const blocked = new BlockList()
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['192.0.2.0', 24], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]]) blocked.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [['::', 96], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) blocked.addSubnet(network, prefix, 'ipv6')
// 与主项目台标下载一致，允许 OpenClash / TUN 的 198.18.0.0/15 fake-IP。
function publicAddress(address) {
  const family = isIP(address)
  return family !== 0 && !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6')
}
function checkAnswers(answers) {
  if (!answers.length || answers.some(answer => !publicAddress(answer.address))) throw new Error('绍兴媒体域名解析到非公网地址')
}
const dispatcher = new Agent({ connect: { lookup(hostname, options, callback) {
  lookupCallback(hostname, { ...options, all: true }, (error, answers) => {
    if (error) return callback(error)
    try { checkAnswers(answers) } catch (error) { return callback(error) }
    if (options.all) callback(null, answers)
    else callback(null, answers[0].address, answers[0].family)
  })
} } })

export function mediaUrl(raw, base) {
  const url = base ? new URL(raw, base) : new URL(raw)
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  // 不接受字面 IP、本机别名或带凭据的地址；TLS 仍由 HTTP 客户端正常校验。
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash
      || isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(host)) {
    throw new Error('绍兴媒体地址不是可用的公网 HTTP(S) 地址')
  }
  return url.href
}

export function createMediaClient({ fetchImpl = proxyAwareFetch, lookupImpl = host => lookup(host, { all: true }), timeoutMs = 12000 } = {}) {
  const origins = new Set()
  async function request(raw, { limit = 512 * 1024, sample = false } = {}) {
    let url = mediaUrl(raw)
    const signal = AbortSignal.timeout(timeoutMs)
    for (let hop = 0; hop <= 3; hop++) {
      const target = new URL(url)
      // DNS 查询与整个下载共享超时，不让卡住的解析阻塞播放器。
      const answers = await new Promise((resolve, reject) => {
        signal.throwIfAborted()
        const abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        Promise.resolve().then(() => lookupImpl(target.hostname)).then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', abort))
      })
      checkAnswers(answers)
      const response = await fetchImpl(url, {
        redirect: 'manual', signal,
        ...(fetchImpl === proxyAwareFetch ? { dispatcher } : {}),
        ...(sample ? { headers: { Range: `bytes=0-${limit - 1}` } } : {}),
      })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        await response.body?.cancel()
        if (!location || hop === 3) throw new Error('绍兴媒体跳转无效或次数过多')
        url = mediaUrl(location, url)
        origins.add(target.origin)
        continue
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`绍兴上游 HTTP ${response.status}`)
      }
      if (!sample && Number(response.headers.get('content-length')) > limit) {
        await response.body?.cancel()
        throw new Error('绍兴上游响应过大')
      }
      const reader = response.body.getReader()
      const chunks = []
      let size = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (!sample && size + value.byteLength > limit) throw new Error('绍兴上游响应过大')
          const chunk = sample ? value.subarray(0, limit - size) : value
          chunks.push(Buffer.from(chunk)); size += chunk.byteLength
          if (sample && size >= limit) break
        }
      } finally { await reader.cancel().catch(() => {}) }
      origins.add(target.origin)
      return { url, body: Buffer.concat(chunks, size) }
    }
  }
  return {
    request,
    allowResource(raw, base) {
      const url = mediaUrl(raw, base)
      if (!origins.has(new URL(url).origin)) throw new Error('绍兴媒体资源未通过本轮官网取流验证')
      return url
    },
  }
}

export function parseManifest(text, url) {
  if (!text.trimStart().startsWith('#EXTM3U') || /#EXT-X-(?:ENDLIST|KEY|MAP|I-FRAMES-ONLY)\b/.test(text)) throw new Error('绍兴上游不是支持的未加密实时 TS HLS')
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const variants = [], segments = []
  // 外置音轨不能直接拍平成单一媒体清单；不丢掉音轨或绕过加密。
  if (/#EXT-X-MEDIA:.*TYPE=AUDIO/i.test(text)) throw new Error('绍兴 HLS 使用独立音轨，需要适配')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
      const next = lines.slice(i + 1).find(line => !line.startsWith('#'))
      if (!next) throw new Error('绍兴 HLS 档位缺少地址')
      variants.push({ url: mediaUrl(next, url), bandwidth: Number(/(?:^|,)BANDWIDTH=(\d+)/.exec(lines[i].split(':')[1])?.[1] || 0) })
    } else if (!lines[i].startsWith('#')) segments.push(mediaUrl(lines[i], url))
    else if (/URI\s*=/i.test(lines[i])) throw new Error('绍兴 HLS 含有未支持的额外资源')
  }
  if (variants.length) return { variants: variants.sort((a, b) => b.bandwidth - a.bandwidth) }
  const sequence = /#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text)
  if (!segments.length || !text.includes('#EXTINF:') || !sequence || !/#EXT-X-TARGETDURATION:\d+/.test(text)) throw new Error('绍兴清单没有实时媒体分片')
  return { segments }
}

export async function verifyStream(raw, options) {
  const client = createMediaClient(options)
  let url = mediaUrl(raw)
  for (let depth = 0; depth < 3; depth++) {
    const fetched = await client.request(url)
    const text = fetched.body.toString('utf8')
    const parsed = parseManifest(text, fetched.url)
    if (parsed.variants) { url = parsed.variants[0].url; continue }
    // 不加载整段直播，取首片前 64KiB，要求至少连续五个 MPEG-TS 同步包。
    const sample = await client.request(parsed.segments[0], { sample: true, limit: 65536 })
    const bytes = sample.body
    let ts = false
    for (let offset = 0; offset < Math.min(188, bytes.length - 188 * 4); offset++) {
      if ([0, 1, 2, 3, 4].every(index => bytes[offset + 188 * index] === 0x47)) { ts = true; break }
    }
    if (!ts) throw new Error('绍兴直播分片不是有效的 MPEG-TS 音视频')
    // 验证清单中所有媒体主机；未知跨域资源不能被主项目的代理登记。
    for (const segment of parsed.segments) client.allowResource(segment, fetched.url)
    return {
      url: fetched.url, manifestText: text, manifestUrl: fetched.url,
      upstreamUrlTransform: raw => client.allowResource(raw, fetched.url),
    }
  }
  throw new Error('绍兴 HLS 嵌套层数过多')
}
