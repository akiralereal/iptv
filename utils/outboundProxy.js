import { createHash } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { Agent, ProxyAgent, buildConnector, fetch as undiciFetch } from 'undici'
import { SocksClient } from 'socks'
import { proxy as configuredProxy } from '../config.js'
import { proxyAwareFetch, systemProxyUrl } from './systemProxy.js'

/**
 * 后台「系统配置 → 网络代理」。
 *
 * 只给必须出境的请求用：YouTube 直播（yt-dlp 解析、清单与分片转发）和 Telegram 消息推送。
 * 其他模块一律不读它 —— 省台等国内源不会因为用户的代理开了全局模式、或分流规则判错而被带到境外。
 *
 * 没填时沿用原来的 HTTPS_PROXY 环境变量 / macOS 系统代理（systemProxy.js），老部署行为不变；
 * 那条路径的作用范围也保持原样（各模块照旧读它），这里不去收窄。
 *
 * 支持 http(s):// 与 socks5(h)://。SOCKS 一律把域名交给代理解析：大陆本地 DNS 对
 * YouTube / Telegram 的解析结果是被污染的，本地先解析再连等于连错地址。
 */

export const PROXY_MASK = '******'
const SCHEMES = new Set(['http:', 'https:', 'socks5:', 'socks5h:'])
const CONNECT_TIMEOUT_MS = 10000

/**
 * 校验并规整用户填的代理地址，返回规整后的字符串；空值返回 ''；格式不对抛错（信息可直接给用户看）。
 * 只写「ip:端口」时补 http://（Clash / mihomo 的混合端口两种协议都认）。
 */
export function normalizeProxyUrl(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return ''
  if (text.length > 1000 || /[\s\x00-\x1f\x7f]/.test(text)) throw new Error('代理地址里不能有空格或换行')
  let url
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'http://' + text) }
  catch { throw new Error('代理地址格式不对，示例：http://192.168.1.10:7890') }
  if (!SCHEMES.has(url.protocol)) throw new Error('代理只支持 http://、https://、socks5:// 开头的地址')
  if (!url.hostname) throw new Error('代理地址缺少主机')
  if (!url.port) throw new Error('代理地址要带端口，如 http://192.168.1.10:7890')
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) throw new Error('代理地址只填「协议://主机:端口」，后面不要带路径')
  return url.href.replace(/\/$/, '')
}

/** 给界面回显用：密码换成占位符，别的原样。 */
export function maskProxyUrl(raw) {
  if (!raw) return ''
  try {
    const url = new URL(raw)
    if (url.password) url.password = PROXY_MASK
    return url.href.replace(/\/$/, '')
  } catch { return '' }
}

/**
 * 界面回显的是打码后的地址；用户没改密码就点保存或测试时，把占位符换回已保存的密码。
 * 用户名变了就不沿用（多半是换了另一台代理）。
 */
export function restoreMaskedProxy(submitted, saved) {
  const text = typeof submitted === 'string' ? submitted.trim() : ''
  if (!text || !saved) return text
  let next, old
  try { next = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'http://' + text) } catch { return text }
  if (decodeURIComponent(next.password) !== PROXY_MASK) return text
  try { old = new URL(saved) } catch { return text }
  if (next.username !== old.username) return text
  next.password = old.password
  return next.href.replace(/\/$/, '')
}

/** 后台填的代理（已规整）；没填或配置里的值坏了时为 ''。 */
export function settingProxyUrl() {
  try { return normalizeProxyUrl(configuredProxy) } catch { return '' }
}

/** 实际生效的代理：后台设置优先，其次环境变量 / 系统代理。 */
export function outboundProxyUrl() {
  return settingProxyUrl() || systemProxyUrl() || ''
}

/** 'setting' | 'env' | ''，界面据此提示当前用的是哪一个。 */
export function outboundProxySource() {
  if (settingProxyUrl()) return 'setting'
  return systemProxyUrl() ? 'env' : ''
}

/** 换代理后解析结果要作废（YouTube 的播放地址绑定解析时的出口 IP），用它做缓存键的一部分。 */
export function outboundProxyKey() {
  const url = outboundProxyUrl()
  return url ? createHash('sha256').update(url).digest('hex').slice(0, 12) : 'direct'
}

/** yt-dlp 的 --proxy 参数：socks5:// 改成 socks5h://，让代理端解析域名。 */
export function ytDlpProxyArg() {
  return outboundProxyUrl().replace(/^socks5:/i, 'socks5h:')
}

function bareHost(hostname) {
  return hostname.replace(/^\[(.*)\]$/, '$1')
}

function socksAgent(url, requestTls) {
  const proxy = {
    host: bareHost(url.hostname),
    port: Number(url.port),
    type: 5,
    ...(url.username ? { userId: decodeURIComponent(url.username), password: decodeURIComponent(url.password) } : {}),
  }
  const tls = buildConnector({ timeout: CONNECT_TIMEOUT_MS, ...requestTls })
  return new Agent({
    connect(opts, callback) {
      const https = opts.protocol === 'https:'
      const host = bareHost(opts.hostname)
      SocksClient.createConnection({
        proxy,
        command: 'connect',
        // 域名原样交给代理（ATYP=域名）；只有本来就是 IP 时才按 IP 发
        destination: { host, port: Number(opts.port) || (https ? 443 : 80) },
        timeout: CONNECT_TIMEOUT_MS,
      }).then(({ socket }) => {
        if (!https) return callback(null, socket)
        tls({ ...opts, servername: opts.servername || (isIP(host) ? undefined : host), httpSocket: socket }, callback)
      }, err => callback(err))
    },
  })
}

/** requestTls 只给测试用（信任自签证书）；线上一律按系统证书校验目标站。 */
export function createProxyDispatcher(raw, { requestTls } = {}) {
  const url = new URL(raw)
  if (url.protocol === 'socks5:' || url.protocol === 'socks5h:') return socksAgent(url, requestTls)
  return new ProxyAgent({ uri: url.href, ...(requestTls ? { requestTls } : {}) })
}

let current = { url: '', dispatcher: undefined }
function dispatcherFor(url) {
  if (current.url === url) return current.dispatcher
  const old = current.dispatcher
  current = { url, dispatcher: createProxyDispatcher(url) }
  // 正在转发的分片照常传完，新请求走新代理
  old?.close().catch(() => {})
  return current.dispatcher
}

function isLoopback(raw) {
  try {
    const host = bareHost(new URL(raw).hostname.toLowerCase())
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
  } catch { return false }
}

/**
 * YouTube / Telegram 专用的 fetch：后台填了代理就走它；没填按原来的环境变量 / 系统代理。
 * 本机回环地址（Telegram 填了本机反代时）不走代理。
 */
export function outboundFetch(url, options = {}) {
  const proxy = settingProxyUrl()
  if (!proxy) return proxyAwareFetch(url, options)
  if (isLoopback(url)) return undiciFetch(url, options)
  return undiciFetch(url, { ...options, dispatcher: dispatcherFor(proxy) })
}

const TEST_TARGETS = [
  { name: 'YouTube', url: 'https://www.youtube.com/generate_204' },
  { name: 'Telegram', url: 'https://api.telegram.org/' },
]

/**
 * undici 6 把代理对 CONNECT 的拒绝（如 407）只报成「Request was cancelled.」，看不出原因。
 * 测试失败时自己发一次 CONNECT 读状态码，好告诉用户是账号密码不对还是代理拒绝。
 */
function connectStatus(proxy, target, timeoutMs) {
  const url = new URL(proxy)
  const dest = new URL(target)
  const headers = { Host: `${dest.hostname}:${dest.port || (dest.protocol === 'https:' ? 443 : 80)}` }
  if (url.username) {
    const auth = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
    headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(auth).toString('base64')
  }
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).request({
      host: bareHost(url.hostname), port: Number(url.port), method: 'CONNECT', path: headers.Host, headers,
      timeout: timeoutMs, servername: isIP(bareHost(url.hostname)) ? undefined : url.hostname,
    })
    req.once('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode) })
    req.once('response', res => { res.resume(); resolve(res.statusCode) })
    req.once('timeout', () => req.destroy(Object.assign(new Error('timeout'), { name: 'TimeoutError' })))
    req.once('error', reject)
    req.end()
  })
}

function describeError(err, proxy, status) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return '超时没有响应'
  const cause = err?.cause || err
  const text = [cause?.code, cause?.message].filter(Boolean).join(' ') || err?.message || '连接失败'
  status ||= text.match(/Proxy response \((\d+)\)/)?.[1]
  let message = String(status) === '407' ? '代理要求账号密码，或账号密码不对（HTTP 407）'
    : status ? `代理拒绝了连接（HTTP ${status}）`
    : /Authentication failed/i.test(text) ? '代理账号密码不对'
    : /ECONNREFUSED/.test(text) ? '连不上代理：端口没开，或没打开「允许局域网连接」'
    : /EHOSTUNREACH|ENETUNREACH/.test(text) ? '连不上代理所在的机器'
    : /ENOTFOUND|EAI_AGAIN/.test(text) ? '代理主机名解析失败'
    : text
  // 错误里可能带回代理地址，账号密码别显示出去
  if (proxy) {
    try {
      const url = new URL(proxy)
      for (const secret of [url.password, decodeURIComponent(url.password)]) {
        if (secret) message = message.split(secret).join(PROXY_MASK)
      }
    } catch { /* 无效地址前面已拦 */ }
  }
  return message.slice(0, 300)
}

/**
 * 后台「测试」按钮：经输入框里的代理连一下 YouTube 和 Telegram（还没保存也能测）。
 * 输入框为空时按保存后会用的路子测：环境变量 / 系统代理，都没有就直连。
 * 收到任何 HTTP 响应就算通 —— 这里只验证网络，不验证账号。
 */
export async function testOutboundProxy(raw, { targets = TEST_TARGETS, timeoutMs = 10000 } = {}) {
  const proxy = raw ? normalizeProxyUrl(raw) : ''
  const effective = proxy || systemProxyUrl()
  const dispatcher = proxy ? createProxyDispatcher(proxy) : undefined
  try {
    const results = await Promise.all(targets.map(async target => {
      const started = Date.now()
      try {
        const options = { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'Mozilla/5.0' } }
        const res = dispatcher
          ? await undiciFetch(target.url, { ...options, dispatcher })
          : await proxyAwareFetch(target.url, options)
        await res.body?.cancel().catch(() => {})
        return { name: target.name, ok: true, status: res.status, ms: Date.now() - started }
      } catch (err) {
        let status
        if (proxy && /^https?:/.test(proxy) && err?.name !== 'TimeoutError') {
          try { status = await connectStatus(proxy, target.url, 5000) } catch { /* 连代理本身失败，原错误已经说明 */ }
          if (status === 200) status = undefined
        }
        return { name: target.name, ok: false, ms: Date.now() - started, message: describeError(err, effective, status) }
      }
    }))
    return { via: proxy ? 'input' : (systemProxyUrl() ? 'env' : ''), results }
  } finally {
    dispatcher?.close().catch(() => {})
  }
}
