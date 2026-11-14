import http from 'node:http'
import { createHash } from 'node:crypto'
import { CastProcess } from './process.js'
import { checkModuleBurst } from '../../../utils/clientScanGuard.js'
import { printBlue } from '../../../utils/colorOut.js'

export const UHD_REFS = Object.freeze(['ysp-cctv4k', 'ysp-cctv164k', 'ysp-cctv8k'])
const HEADERS = new Set(['accept', 'range', 'if-none-match', 'if-modified-since', 'user-agent'])
const RESPONSE_HEADERS = new Set(['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'])
const MIME = 'application/vnd.apple.mpegurl'
const reply = (status, body = '', type = MIME) => ({ status, body,
  headers: { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) } })
const failure = (status, body) => reply(status, body, 'text/plain;charset=utf-8')
const topRef = path => String(path).split('/').filter(Boolean).at(-1)?.replace(/\.m3u8$/, '')

export function createCastGateway({ worker = new CastProcess(), resolveMain,
  log = message => printBlue(`[央视频] ${message}`), now = Date.now } = {}) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 4 })
  const assets = new Map(), pending = new Map()
  const claims = path => path.startsWith('/ysp-cast/') || UHD_REFS.includes(topRef(path))
  async function open(base, path, headers, method = 'GET') {
    const target = new URL(base)
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1') throw new Error('投屏服务地址无效')
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: target.hostname, port: target.port, path, method, agent,
        headers: { ...Object.fromEntries(Object.entries(headers || {}).filter(([k]) => HEADERS.has(k.toLowerCase()))),
          Host: target.host, 'Accept-Encoding': 'identity' } }, res => {
        res.on('error', () => {})
        resolve({ req, res })
      })
      req.once('error', reject)
      req.setTimeout(30000, () => req.destroy(new Error('投屏服务响应超时')))
      req.end()
    })
  }
  function rewrite(text, base, ref, prefix) {
    function asset(uri) {
      const target = new URL(uri, base)
      if (target.origin !== base || !['/proxy', '/proxy.ts'].includes(target.pathname) || target.username || target.password) {
        throw new Error('投屏未返回设备中转分片')
      }
      const path = target.pathname + target.search
      const key = createHash('sha256').update(base + '\n' + ref + '\n' + path).digest('hex').slice(0, 32)
      assets.delete(key); assets.set(key, { base, path, ref, at: now() })
      while (assets.size > 8192) assets.delete(assets.keys().next().value)
      return `${prefix}/ysp-cast/media/${key}`
    }
    return text.split('\n').map(line => !line.trim() ? line : line.startsWith('#')
      ? line.replace(/URI="([^"]+)"/g, (_, value) => `URI="${asset(value)}"`) : asset(line.trim())).join('\n')
  }
  async function playlist(ref, headers) {
    // Concurrent audio/probe/player opens share a ticket request. No retry here.
    if (pending.has(ref)) return pending.get(ref)
    const task = (async () => {
      const base = await worker.ensure()
      const { req, res } = await open(base, '/' + ref.slice(4) + '.m3u8', headers)
      const buffers = []; let size = 0
      try {
        for await (const chunk of res) {
          size += chunk.length
          if (size > 2 * 1024 * 1024) throw new Error('投屏清单过大')
          buffers.push(chunk)
        }
        const text = Buffer.concat(buffers).toString('utf8')
        if (res.statusCode !== 200 || !text.trimStart().startsWith('#EXTM3U') || !/^#EXTINF:/m.test(text)) {
          throw new Error('投屏取流失败，请稍后重试或切回原方案')
        }
        return { base, text }
      } finally { req.destroy() }
    })()
    pending.set(ref, task)
    try { return await task }
    finally { if (pending.get(ref) === task) pending.delete(ref) }
  }
  async function handle(ctx) {
    const { path, method = 'GET', headers = {}, accessPrefix = '', config = {}, client } = ctx
    if (!claims(path)) return null
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) return failure(405, '只支持 GET/HEAD/OPTIONS')
    if (method === 'OPTIONS') return reply(204)
    const route = path.match(/^\/ysp-cast\/(cast|main)\/(ysp-[a-z0-9]+)\.m3u8$/)
    const token = path.match(/^\/ysp-cast\/media\/([a-f0-9]{32})$/)?.[1]
    if (path.startsWith('/ysp-cast/') && !route && !token) return failure(404, '没有此媒体入口')
    const ref = route?.[2] || topRef(path)
    if (!token && !UHD_REFS.includes(ref)) return failure(404, '没有此超高清频道')
    const asset = token && assets.get(token)
    if (token && (!asset || now() - asset.at > 30 * 60000)) return failure(404, '分片入口已过期，请重新开播')
    if (method === 'HEAD') return reply(200, '', token ? 'video/mp2t' : MIME)
    const started = now()
    try {
      if (token) {
        worker.touch()
        const { req, res } = await open(asset.base, asset.path, headers)
        return { status: res.statusCode,
          headers: { ...Object.fromEntries(Object.entries(res.headers).filter(([k]) => RESPONSE_HEADERS.has(k))), 'Cache-Control': 'no-store' },
          body: res, dispose: () => { res.destroy(); req.destroy() } }
      }
      if (!route) {
        const source = config.uhdSource === 'main' ? 'main' : 'cast'
        // A one-variant master pins this playback to its selected source, without a
        // redirect or a request to either source. Old subscriptions remain valid.
        return reply(200, `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=40000000\n${accessPrefix}/ysp-cast/${source}/${ref}.m3u8\n`)
      }
      const verdict = checkModuleBurst({ moduleId: 'yangshipin', moduleName: '央视频', client, channelKey: ref })
      if (!verdict.allowed) return failure(429, verdict.desc)
      if (route[1] === 'main') {
        const result = await resolveMain(ref, ctx)
        if (!result?.url || typeof result.manifestText !== 'string') return failure(result?.status || 503, result?.desc || '原方案取流失败')
        const text = result.manifestText.replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n').map(line => {
          const absolute = uri => new URL(uri, result.manifestUrl || result.url).href
          return !line.trim() ? line : line.startsWith('#')
            ? line.replace(/URI="([^"]*)"/g, (_, uri) => `URI="${absolute(uri)}"`) : absolute(line.trim())
        }).join('\n')
        log(`${ref} 原方案清单 ${now() - started}ms`)
        return reply(200, text)
      }
      const { text, base } = await playlist(ref, headers)
      const body = rewrite(text, base, ref, accessPrefix)
      log(`${ref} 投屏清单 ${now() - started}ms`)
      return reply(200, body)
    } catch {
      log(`${token ? asset.ref : ref} 投屏入口失败 ${now() - started}ms`)
      return failure(503, '超高清来源暂不可用，请稍后重试或在源管理切回原方案')
    }
  }
  return { claims, handle,
    async close() { agent.destroy(); assets.clear(); await worker.close(); pending.clear() },
  }
}
