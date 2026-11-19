import http from 'node:http'
import { pipeline } from 'node:stream'
import { createHash } from 'node:crypto'
import { CastProcess } from './process.js'
import { createAudioVividFilter, filtersResponse } from './ts-audio-filter.js'
import { checkModuleBurst } from '../../../utils/clientScanGuard.js'
import { printBlue } from '../../../utils/colorOut.js'

export const UHD_REFS = Object.freeze(['ysp-cctv4k', 'ysp-cctv164k', 'ysp-cctv8k'])
// 频道引用 → 投屏引擎频道名。引擎只有这 26 台走设备协议（CCTV6、卫视、CETV 等没有）；
// CGTN 外语台两边叫法不同，按官方 pid/livePid 一一对过。
export const CAST_SLUGS = Object.freeze(Object.fromEntries([
  ...['cctv1', 'cctv2', 'cctv3', 'cctv4', 'cctv5', 'cctv5p', 'cctv7', 'cctv8', 'cctv9', 'cctv10', 'cctv11',
    'cctv12', 'cctv13', 'cctv14', 'cctv15', 'cctv16', 'cctv17', 'cctv4k', 'cctv164k', 'cctv8k', 'cgtn']
    .map(slug => [`ysp-${slug}`, slug]),
  ['ysp-cgtnfy', 'cgtnfr'], ['ysp-cgtney', 'cgtnru'], ['ysp-cgtnalby', 'cgtnar'],
  ['ysp-cgtnxby', 'cgtnes'], ['ysp-cgtnwyjl', 'cgtndoc'],
]))
const castable = ref => Object.hasOwn(CAST_SLUGS, ref)
/** 这次开播是否交给本网关：超高清三台除「原方案」外都由这里固定来源；其他可投屏的台只在「全部走投屏」时接管。 */
export const routesRef = (ref, config = {}) => UHD_REFS.includes(ref) || (castable(ref) && config.uhdSource === 'all')
const HEADERS = new Set(['accept', 'range', 'if-none-match', 'if-modified-since', 'user-agent'])
const RESPONSE_HEADERS = new Set(['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'])
const MIME = 'application/vnd.apple.mpegurl'
// 原方案的普通台停止取清单多久后，才算停播、下次开按新设置走投屏（播放器重取间隔是几秒到十来秒）
const ORIGINAL_GRACE_MS = 30000
const reply = (status, body = '', type = MIME) => ({ status, body,
  headers: { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) } })
const failure = (status, body) => reply(status, body, 'text/plain;charset=utf-8')
const topRef = path => String(path).split('/').filter(Boolean).at(-1)?.replace(/\.m3u8$/, '')

export function createCastGateway({ worker = new CastProcess(), resolveMain,
  log = message => printBlue(`[央视频] ${message}`), now = Date.now } = {}) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 4 })
  const assets = new Map(), pending = new Map()
  // 只按路径认领（注册表拿不到设置）；普通台没开「全部走投屏」时 handle 回 null，交回原方案的通用流程。
  const claims = path => path.startsWith('/ysp-cast/') || castable(topRef(path))
  // 普通台走原方案时，入口地址本身就是媒体清单（relay / proxy 直出），播放器每隔几秒原地重取。
  // 正播着改成「全部走投屏」，下一次重取要是拿到下面的单行主清单，播放器会因清单类型变了直接报错。
  // 所以按「客户端｜频道」记下原方案最近一次取清单，半分钟内接着来的照旧交回原方案；停播半分钟以上再开才走投屏
  const originalLive = new Map()
  const liveKey = (ref, client) => `${client?.key ?? ''}|${ref}`
  function noteOriginal(ref, method, client) {
    if (method !== 'GET') return
    const key = liveKey(ref, client), at = now()
    originalLive.delete(key); originalLive.set(key, at)
    // 按最近一次排序（先删再放到末尾），从头清掉过期的；再多也只留 4096 条
    for (const [k, seen] of originalLive) {
      if (at - seen <= ORIGINAL_GRACE_MS && originalLive.size <= 4096) break
      originalLive.delete(k)
    }
  }
  function stillOnOriginal(ref, method, client) {
    const key = liveKey(ref, client), seen = originalLive.get(key)
    if (seen == null) return false
    if (now() - seen > ORIGINAL_GRACE_MS) { originalLive.delete(key); return false }
    noteOriginal(ref, method, client)
    return true
  }
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
      const { req, res } = await open(base, '/' + CAST_SLUGS[ref] + '.m3u8', headers)
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
    const route = path.match(/^\/ysp-cast\/(cast|main)\/(ysp-[a-z0-9]+)\.m3u8$/)
    const token = path.match(/^\/ysp-cast\/media\/([a-f0-9]{32})$/)?.[1]
    const ref = route?.[2] || topRef(path)
    // 入口按当前设置分流；已开播的子清单/分片不看设置，保存后正在播的不中途换源。
    // 原方案下正在播的普通台（入口就是媒体清单）同样不换，见 originalLive
    if (!path.startsWith('/ysp-cast/')) {
      if (!routesRef(ref, config)) { noteOriginal(ref, method, client); return null }
      if (stillOnOriginal(ref, method, client)) return null
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) return failure(405, '只支持 GET/HEAD/OPTIONS')
    if (method === 'OPTIONS') return reply(204)
    if (path.startsWith('/ysp-cast/') && !route && !token) return failure(404, '没有此媒体入口')
    if (!token && !castable(ref)) return failure(404, '没有此投屏频道')
    const asset = token && assets.get(token)
    if (token && (!asset || now() - asset.at > 30 * 60000)) return failure(404, '分片入口已过期，请重新开播')
    if (method === 'HEAD') return reply(200, '', token ? 'video/mp2t' : MIME)
    const started = now()
    try {
      if (token) {
        worker.touch()
        const { req, res } = await open(asset.base, asset.path, headers)
        // Same bytes and length, minus the Audio Vivid track players pick and cannot decode.
        const body = filtersResponse(res) ? pipeline(res, createAudioVividFilter(), () => {}) : res
        return { status: res.statusCode,
          headers: { ...Object.fromEntries(Object.entries(res.headers).filter(([k]) => RESPONSE_HEADERS.has(k))), 'Cache-Control': 'no-store' },
          body, dispose: () => { body.destroy(); res.destroy(); req.destroy() } }
      }
      if (!route) {
        // Only the three UHD channels reach here under 'main'; the rest returned null above.
        const source = config.uhdSource === 'main' ? 'main' : 'cast'
        const bandwidth = UHD_REFS.includes(ref) ? 40000000 : 15000000
        // A one-variant master pins this playback to its selected source, without a
        // redirect or a request to either source. Old subscriptions remain valid.
        return reply(200, `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth}\n${accessPrefix}/ysp-cast/${source}/${ref}.m3u8\n`)
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
      return failure(503, '投屏来源暂不可用，请稍后重试或在源管理切回原方案')
    }
  }
  return { claims, handle,
    async close() { agent.destroy(); assets.clear(); await worker.close(); pending.clear() },
  }
}
