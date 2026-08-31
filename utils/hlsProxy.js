import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { printRed, printYellow } from "./colorOut.js";

/**
 * 全代理模式（issue #98 续）：清单里的地址全部改写成「本机同源相对地址」，分片由服务器转发。
 *
 * 为什么还需要这一档：兼容版（/relay/，清单直出）已经替播放器走完了 302 与 master→媒体清单
 * 两跳，服务端实测返回的就是一份合法媒体清单（200 + application/vnd.apple.mpegurl +
 * #EXTINF + .ts 列表），但极空间「极影视」仍播不了；而同一条 CDN 地址**直接**填进播放器却能播。
 * 两次兼容版尝试（master 里一条绝对子清单 / 媒体清单里一串绝对分片）都失败，唯一共同点是：
 * 清单由本机下发、里面的地址是**绝对且跨主机**的。CDN 自己下发的清单里是相对地址（与清单同源），
 * 那份能播。所以剩下的唯一变量就是「清单里的地址是否与清单同源」。
 *
 * 全代理模式把这个变量消掉：下发的清单里只有相对地址（`<key>.ts`），播放器不需要理解绝对地址、
 * 不跨主机、不跨端口、也没有超长查询串；分片请求回到本机后再由服务器取回 CDN 内容转发。
 * 代价是视频流经服务器（家庭 NAS 与电视同网，多花的是一段内网带宽，外网下行量不变）。
 *
 * 地址表：清单每次刷新都会重新登记（同一条 CDN 地址恒定映射到同一 key），带 TTL 与条数上限，
 * 避免直播长跑把内存吃满。
 */

/**
 * 清单取回失败后的短期熔断。
 *
 * 播放器取不到清单会立刻连环重试——实测 AptvPlayer 在 1 秒内重试 9 次。若每次重试都替它
 * 去打上游，平台按 IP 的频率限制会被越推越深，形成「越失败越重试、越重试越失败」的循环，
 * 连正在正常播放的其它频道也会被一起拖垮。
 *
 * 熔断期内直接走 302 回退（能跟随跳转的播放器照样能播），把恢复的机会留给上游。窗口取 2 秒：
 * 大于播放器的重试间隔，又远小于一个分片的时长，不会让真正恢复了的频道多等一轮。
 */
const MANIFEST_FAIL_COOLDOWN_MS = 2000
const manifestFailUntil = new Map()   // pid -> 熔断到期时间戳

function manifestCooling(key, now = Date.now()) {
  const until = manifestFailUntil.get(key)
  if (!until) return false
  if (now >= until) { manifestFailUntil.delete(key); return false }
  return true
}

function markManifestResult(key, ok, now = Date.now()) {
  if (ok) { manifestFailUntil.delete(key); return }
  // 频道数有限，超量只可能是畸形路径打进来的，整表丢弃即可（熔断丢失只是多打一次上游）
  if (manifestFailUntil.size > 500) manifestFailUntil.clear()
  manifestFailUntil.set(key, now + MANIFEST_FAIL_COOLDOWN_MS)
}

const TTL_MS = 10 * 60 * 1000     // 分片地址带时效签名，10 分钟足够覆盖播放器的重试窗口
const MAX_ENTRIES = 5000          // 一个直播频道 10 分钟约 100 条，这个上限够几十路同放，超出按最早登记淘汰

const registry = new Map()        // key -> { url, pid, transform, upstreamHeaders, upstreamUrlTransform, expires }

// 已知的媒体后缀：保留原后缀，按后缀识别流格式的播放器（极影视）才认得出分片
const KNOWN_EXT = new Set(['ts', 'm3u8', 'aac', 'mp3', 'mp4', 'm4s', 'm4a', 'vtt', 'key'])

function extOf(url, fallback) {
  try {
    const name = new URL(url).pathname.split('/').pop() || ''
    const dot = name.lastIndexOf('.')
    const ext = dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
    return KNOWN_EXT.has(ext) ? ext : fallback
  } catch {
    return fallback
  }
}

function sweep() {
  const now = Date.now()
  for (const [key, entry] of registry) {
    if (entry.expires <= now) registry.delete(key)
  }
  // 扫完仍超上限：Map 迭代序即插入序，从最早的开始丢
  while (registry.size > MAX_ENTRIES) {
    const oldest = registry.keys().next()
    if (oldest.done) break
    registry.delete(oldest.value)
  }
}

/**
 * 登记一条上游地址，返回稳定的短 key（同一地址永远同一 key，清单每 6 秒刷新一次也不会撑爆表）。
 * key 前缀固定为 s：让分片路径 /proxy/s<hex>.ts 与频道清单路径 /proxy/<纯数字频道号>.m3u8
 * 在词法上永不相交，两条路由怎么排都不会互相误吃。
 */
function register(url, pid = '', transform, upstreamHeaders, upstreamUrlTransform) {
  const key = 's' + createHash('md5').update(url).digest('hex').slice(0, 16)
  const targetUrl = upstreamUrlTransform ? upstreamUrlTransform(url) : url
  // 先删再插：Map 的 set 覆盖不改变迭代位置，重复登记（清单每 6 秒刷新）会让最活跃
  // 频道的 key 恒在队首，超上限淘汰时反而最先被丢。删后重插把迭代序变成「最近登记在尾」
  registry.delete(key)
  registry.set(key, {
    url: targetUrl,
    pid,
    transform,
    upstreamHeaders,
    upstreamUrlTransform,
    expires: Date.now() + TTL_MS,
  })
  if (registry.size > MAX_ENTRIES) sweep()
  return key
}

/** 取回登记项 { url, pid }；未登记或已过期返回 null */
function lookup(key) {
  const entry = registry.get(key)
  if (!entry) return null
  if (entry.expires <= Date.now()) {
    registry.delete(key)
    return null
  }
  const result = { url: entry.url, pid: entry.pid }
  if (entry.transform) result.transform = entry.transform
  if (entry.upstreamHeaders) result.upstreamHeaders = entry.upstreamHeaders
  if (entry.upstreamUrlTransform) result.upstreamUrlTransform = entry.upstreamUrlTransform
  return result
}

/** 仅供测试与自检：当前登记条数 */
function registrySize() {
  return registry.size
}

/**
 * 把（已改写为绝对地址的）HLS 清单里的每条地址换成本机同源相对地址。
 *
 * 刻意生成**不含斜杠的同目录相对地址**（`s<key>.ts`）——这正是 CDN 自己下发、
 * 且极影视实测能播的那种形态：清单在 /proxy/<pid>.m3u8，分片就在 /proxy/s<key>.ts，
 * 播放器只要会「同目录取下一个文件」就够用，不必理解绝对地址，也不必跨目录解析。
 * 嵌套子清单（/proxy/s<key>.m3u8）同在这一层目录，两层共用同一套相对地址，无需按层区分。
 *
 * 纯字符串处理（除登记地址表外无副作用），便于单测。
 */
function toProxyManifest(text, pid = '', transform, upstreamHeaders, upstreamUrlTransform) {
  const toRef = (uri, fallbackExt) => {
    if (!/^https?:\/\//i.test(uri)) return null   // 非绝对地址说明上一步改写没覆盖到，保持原样别弄坏
    try {
      return `${register(uri, pid, transform, upstreamHeaders, upstreamUrlTransform)}.${extOf(uri, fallbackExt)}`
    } catch {
      return null
    }
  }
  return text.split('\n').map(line => {
    const t = line.trim()
    if (!t) return line
    if (t.startsWith('#')) {
      return line.replace(/URI="([^"]*)"/g, (whole, uri) => {
        const ref = toRef(uri, 'key')
        return ref ? `URI="${ref}"` : whole
      })
    }
    return toRef(t, 'ts') || line
  }).join('\n')
}

/**
 * 代理向上游取流时统一使用的 UA。
 *
 * ⚠️ 下面三处都写作 `{ ...upstreamHeaders, 'User-Agent': UA }`——后写的键覆盖先展开的，
 * 所以**模块在 upstreamHeaders 里声明的 User-Agent 不会生效**，一律被换成这个值。
 * 这与 registry.js 中「upstreamHeaders 是平台要求的上游请求头」的说法有出入，特此说明，
 * 免得下一个人照着声明 UA 却查不出为何没起作用。
 *
 * 保持现状是有意的：目前声明了 UA 的模块（mgtv/songjiang/douyu-live 等）全都是在这个
 * Chrome UA 下开发并验证通过的，它们声明的 Mac / Android / iPhone UA 从未真正发出过。
 * 调换顺序等于把一批正常工作的模块换到未经验证的取流路径上——移动端 UA 很可能拿到不同的
 * 码率或流格式。真遇到某个平台因 UA 取流异常，就针对那一个模块改并实测，不要整体翻。
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// 上游 → 客户端要原样带过去的响应头（其余一律不带，避免上游的 CORS / 缓存策略干扰播放器）
const PASS_THROUGH = ['content-type', 'content-length', 'accept-ranges', 'content-range']

function fallbackType(url) {
  return /\.m3u8(?:\?|$)/i.test(url) ? 'application/vnd.apple.mpegurl' : 'video/mp2t'
}

function responseHeaders(upstream, url) {
  const out = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  }
  for (const name of PASS_THROUGH) {
    const value = upstream.headers.get(name)
    if (value != null) out[name] = value
  }
  if (!out['content-type']) out['content-type'] = fallbackType(url)
  return out
}

// 分片失败此前只走 printDebug（默认不可见），CDN 拒绝服务器代取时排查者对着空日志没法定位
// （issue #98）。改为可见黄行，10 秒限一行防止播放器高频重试刷屏。
let lastPipeFailLog = 0
function logPipeFail(msg) {
  const now = Date.now()
  if (now - lastPipeFailLog < 10 * 1000) return
  lastPipeFailLog = now
  printYellow(msg)
}

/**
 * 把上游分片流式转发给客户端。
 * 返回 { ok, status, bytes, complete, error? }，供调用方输出一次即可判定的诊断日志。
 *
 * 不缓冲整片：分片几百 KB 到几 MB，直播长跑时缓冲会顶着内存跑；直接 pipe 过去。
 * 客户端切台 / 关闭连接时中止上游请求，否则一次切台会留下一串还在下载的孤儿请求。
 */
async function pipeUpstream(url, req, res, transform, upstreamHeaders = {}) {
  const ctrl = new AbortController()
  const onClose = () => ctrl.abort()
  res.on('close', onClose)
  let bytes = 0
  let upstreamStatus = 0
  // 只给「拿到响应头」设超时，拿到之后是流式传输，不能再掐
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const headers = { ...upstreamHeaders, 'User-Agent': UA }
    // 要做整片变换时不能把 Range 片段单独交给解码器；回完整 200 对播放器仍合法。
    if (!transform && req.headers.range) headers.range = req.headers.range
    const upstream = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers })
    upstreamStatus = upstream.status
    clearTimeout(timer)
    if (!upstream.ok) logPipeFail(`分片上游回 ${upstream.status}: ${new URL(url).host}`)

    const out = responseHeaders(upstream, url)
    if (transform && upstream.ok) {
      const input = Buffer.from(await upstream.arrayBuffer())
      const transformed = await transform(input)
      const body = Buffer.isBuffer(transformed) ? transformed : input
      delete out['content-range']
      delete out['accept-ranges']
      out['content-length'] = body.length
      res.writeHead(200, out)
      res.end(body)
      return { ok: true, status: 200, bytes: body.length, complete: true }
    }

    res.writeHead(upstream.status, out)
    if (!upstream.body) {
      res.end()
      return { ok: upstream.ok, status: upstream.status, bytes: 0, complete: true }
    }
    let complete = false
    await new Promise((resolve, reject) => {
      const src = Readable.fromWeb(upstream.body)
      const meter = new Transform({
        transform(chunk, encoding, callback) {
          bytes += chunk.length
          callback(null, chunk)
        },
      })
      src.on('error', reject)
      meter.on('error', reject)
      res.on('error', reject)
      res.on('close', () => { src.destroy(); meter.destroy() })
      src.pipe(meter).pipe(res)
        .on('finish', () => { complete = true; resolve() })
        .on('close', resolve)
    })
    return { ok: upstream.ok && complete, status: upstream.status, bytes, complete }
  } catch (error) {
    clearTimeout(timer)
    // 客户端自己断开（切台 / 关闭播放器）是常态，不当错误刷屏
    if (ctrl.signal.aborted && res.destroyed) {
      return { ok: false, status: upstreamStatus || res.statusCode || 0, bytes, complete: false, error: '客户端提前断开' }
    }
    logPipeFail(`分片转发失败: ${error?.message || error}`)
    if (!res.headersSent) {
      try { res.writeHead(502, { 'Content-Type': 'text/plain;charset=UTF-8' }); res.end('上游分片获取失败') } catch { /* 连接可能已断 */ }
    } else {
      try { res.end() } catch { /* 连接可能已断 */ }
    }
    return { ok: false, status: upstreamStatus || (res.headersSent ? res.statusCode : 502), bytes, complete: false, error: error?.message || String(error) }
  } finally {
    res.off('close', onClose)
  }
}

/**
 * 回答播放器对代理分片的 HEAD 探测。
 *
 * 普通分片向上游发送真实 HEAD，带回 Content-Length / Accept-Ranges 等信息；这与极影视
 * 直接访问咪咕 CDN 时拿到的响应一致。需要 segmentTransform 的平台不能照搬上游长度，
 * 因此保留旧的合成 200。上游不支持 HEAD 或临时失败时同样回退合成响应，不破坏原有 GET。
 */
async function probeUpstream(url, req, res, transform, upstreamHeaders = {}) {
  const synthetic = (reason) => {
    res.writeHead(200, {
      'Content-Type': fallbackType(req.url || url),
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    })
    res.end()
    return { ok: true, status: 200, bytes: 0, complete: true, mode: 'fallback', reason }
  }

  if (transform) return synthetic('分片需转换，不能透传上游长度')

  // 嵌套子清单 key（/proxy/s<hex>.m3u8）的 GET 会把上游清单改写后再下发，长度必然与
  // 上游不同——透传上游长度反而让 HEAD 与随后的 GET 自相矛盾，对长度较真的播放器有害
  if (/\.m3u8(?:\?|$)/i.test(req.url || '')) return synthetic('嵌套子清单会改写，长度以 GET 为准')

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10000)
  try {
    const headers = { ...upstreamHeaders, 'User-Agent': UA }
    if (req.headers.range) headers.range = req.headers.range
    const upstream = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: ctrl.signal,
      headers,
    })
    clearTimeout(timer)

    // 404/410 表示清单里的短效分片确实失效，应让播放器重新取清单；其余非 2xx
    // 常见于 CDN 不实现/拦截 HEAD，维持旧行为回退合成 200，GET 链路不受影响。
    if (!upstream.ok && upstream.status !== 404 && upstream.status !== 410) {
      return synthetic(`上游 HEAD ${upstream.status}`)
    }

    // 部分 CDN 对流媒体路径的 HEAD 回 200 但 Content-Length: 0——透传会让严格播放器
    // 把分片当空文件跳过。长度不可信时视同上游不支持 HEAD，回退合成 200
    if (upstream.ok && upstream.headers.get('content-length') === '0') {
      return synthetic('上游 HEAD 长度为 0，不可信')
    }

    const out = responseHeaders(upstream, url)
    res.writeHead(upstream.status, out)
    res.end()
    return {
      ok: upstream.ok,
      status: upstream.status,
      bytes: 0,
      complete: true,
      mode: 'upstream',
      contentLength: upstream.headers.get('content-length') || '',
      acceptRanges: upstream.headers.get('accept-ranges') || '',
    }
  } catch (error) {
    clearTimeout(timer)
    return synthetic(error?.name === 'AbortError' ? '上游 HEAD 超时' : `上游 HEAD 失败: ${error?.message || error}`)
  }
}

/** 取回一份嵌套子清单（全代理模式下清单里再出现 .m3u8 时用），返回 { text, finalUrl } 或 null */
async function fetchNested(url, upstreamHeaders = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10000)
  try {
    const resp = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { ...upstreamHeaders, 'User-Agent': UA },
    })
    if (!resp.ok) return null
    const text = await resp.text()
    if (!text.trimStart().startsWith('#EXTM3U')) return null
    return { text, finalUrl: resp.url || url }
  } catch (error) {
    printRed(`子清单代理获取失败: ${error?.message || error}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

export { toProxyManifest, register, lookup, registrySize, pipeUpstream, probeUpstream, fetchNested, manifestCooling, markManifestResult, MANIFEST_FAIL_COOLDOWN_MS }
