import { createHash } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { fetch as undiciFetch } from 'undici'
import { normalizeProxyUrl, createProxyDispatcher, formatProxyUrl, validateProxyCredentials } from './proxyTransport.js'
export { normalizeProxyUrl, createProxyDispatcher } from './proxyTransport.js'
import { proxy as configuredProxy } from '../config.js'
import { proxyAwareFetch, systemProxyUrl } from './systemProxy.js'

/**
 * 后台「设置 → 网络代理」。
 *
 * 用于 YouTube、澳门（澳广视）、海外频道及 Telegram；包含取址、节目单与媒体回源。
 * 其他模块一律不读它 —— 省台等国内源不会因为用户的代理开了全局模式、或分流规则判错而被带到境外。
 * 用户自己加的订阅源、直连源勾了「经网络代理转发」的也用它（customSourceProxy.js），那是用户逐个源自己选的。
 *
 * 没填时沿用原来的 HTTPS_PROXY 环境变量 / macOS 系统代理（systemProxy.js），老部署行为不变；
 * 那条路径的作用范围也保持原样（各模块照旧读它），这里不去收窄。
 *
 * 支持 http(s):// 与 socks5(h)://。SOCKS 一律把域名交给代理解析：大陆本地 DNS 对
 * YouTube / Telegram 的解析结果是被污染的，本地先解析再连等于连错地址。
 */

export const PROXY_MASK = '******'
/** 给界面回显用：密码换成占位符，别的原样。 */
export function maskProxyUrl(raw) {
  if (!raw) return ''
  try {
    const url = new URL(raw)
    if (url.password) url.password = PROXY_MASK
    return formatProxyUrl(url)
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
  validateProxyCredentials(next)
  if (decodeURIComponent(next.password) !== PROXY_MASK) return text
  try { old = new URL(saved) } catch { return text }
  if (next.username !== old.username) return text
  next.password = old.password
  return formatProxyUrl(next)
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
 * 指定模块与 Telegram 的出站 fetch：后台填了代理就走它；没填按原来的环境变量 / 系统代理。
 * 本机回环地址（Telegram 填了本机反代时）不走代理。
 */
export function outboundFetch(url, options = {}) {
  const proxy = settingProxyUrl()
  if (!proxy) return proxyAwareFetch(url, options)
  if (isLoopback(url)) return undiciFetch(url, options)
  return undiciFetch(url, { ...options, dispatcher: dispatcherFor(proxy) })
}

/**
 * 「测试」按钮的目标：Telegram 推送不是模块，固定在这里；各模块的目标来自它们的 proxyProbe 声明，
 * 由 utils/systemConfigAPI.js 的 proxyTestTargets() 拼起来（这里不能 import 注册表：模块反过来 import 本文件）。
 */
// 公共二级后缀（com.mo、com.tr、co.uk…）：放行域名要收到可注册域，不能只剩 com.tr
const PUBLIC_SLD_RE = /^(com|net|org|co|gov|edu|ac|ne|or|go)$/

/**
 * 主机名收成代理规则用的域名后缀（Clash 的 DOMAIN-SUFFIX 口径）：
 * www.tdm.com.mo → tdm.com.mo，x.playouts.now.amagi.tv → amagi.tv，api.telegram.org → telegram.org
 */
export function domainSuffix(hostname) {
  const labels = String(hostname || '').toLowerCase().replace(/\.$/, '').split('.').filter(Boolean)
  if (labels.length <= 2) return labels.join('.')
  const keep = labels.at(-1).length === 2 && PUBLIC_SLD_RE.test(labels.at(-2)) ? 3 : 2
  return labels.slice(-keep).join('.')
}

/** 主机名是否被某条后缀盖住（相等，或以 .后缀 结尾） */
export function hostCoveredBy(hostname, suffixes) {
  const host = String(hostname || '').toLowerCase()
  return (suffixes || []).some(suffix => host === suffix || host.endsWith('.' + suffix))
}

// hosts：这一项要在代理规则里放行的域名后缀，测试结果原样带回给后台写在失败项旁边
export const TELEGRAM_TEST_TARGET = { name: 'Telegram', url: 'https://api.telegram.org/', hosts: ['telegram.org'] }

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
      host: bareHost(url.hostname), port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80), method: 'CONNECT', path: headers.Host, headers,
      timeout: timeoutMs, servername: isIP(bareHost(url.hostname)) ? undefined : url.hostname,
    })
    req.once('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode) })
    req.once('response', res => { res.resume(); resolve(res.statusCode) })
    req.once('timeout', () => req.destroy(Object.assign(new Error('timeout'), { name: 'TimeoutError' })))
    req.once('error', reject)
    req.end()
  })
}

/** SOCKS 代理回的拒绝码（socks 库给的是枚举名），翻成能看懂的话。 */
const SOCKS_REJECT_REASONS = {
  Failure: '一般性失败', NetworkUnreachable: '网络不可达', HostUnreachable: '主机不可达',
  ConnectionRefused: '连接被拒绝', TTLExpired: 'TTL 超时',
}

/**
 * 一次失败分到哪一段：
 *   'proxy'  连代理这一步就失败——端口没开、账号密码不对、代理按规则拒绝这个目标；
 *   'target' 代理已经接通，往对方站点那一步失败——连接被断开、代理报告连不上、CONNECT 被回 5xx；
 *   ''       分不清（整次超时、认不出的错误），由 testOutboundProxy 按别的目标的结果再判。
 * 「YouTube 通、澳门 ECONNRESET」就是 'target'：代理本身没问题，是代理软件把该域名分流成了直连、
 * 节点连不上它，或对方站点拒绝了这个出口——都不是这边的设置能改的，不说清楚用户会一直改代理地址。
 * 没有代理（直连测试）时不分段，错误原样给。
 */
function describeError(err, proxy, status) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return { stage: '', message: '超时没有响应' }
  // undici 会把真正的原因包好几层：代理回 502 时是 fetch failed ← Request was cancelled. ← Proxy response (502)…，
  // 只看第一层就只剩一句看不懂的话，所以整条 cause 链都拿来认
  const chain = []
  for (let e = err?.cause || err, depth = 0; e && depth < 4; e = e.cause, depth++) {
    const part = [e.code, e.message].filter(Boolean).join(' ')
    if (part) chain.push(part)
  }
  const text = chain.join(' ← ') || err?.message || '连接失败'
  status ||= text.match(/Proxy response \((\d+)\)/)?.[1]
  const code = Number(status) || 0
  const socksReject = text.match(/proxy rejected connection - (\w+)/i)?.[1]
  // UND_ERR_SOCKET（other side closed）：Clash / mihomo 这类代理先答应隧道、再去连对方，连不上就直接断开
  const resetCode = text.match(/\b(ECONNRESET|EPIPE|UND_ERR_SOCKET)\b/)?.[1]
  let stage = '', message = text
  if (!proxy) { /* 直连：没有代理可分段 */ }
  else if (code === 407) { stage = 'proxy'; message = '代理要求账号密码，或账号密码不对（HTTP 407）' }
  else if (code >= 500) { stage = 'target'; message = `代理已接通，但它连不上对方站点（代理回 HTTP ${code}）` }
  else if (code) { stage = 'proxy'; message = `代理拒绝了连接（HTTP ${code}）` }
  else if (/Authentication failed/i.test(text)) { stage = 'proxy'; message = '代理账号密码不对' }
  else if (/ECONNREFUSED/.test(text)) { stage = 'proxy'; message = '连不上代理：端口没开，或没打开「允许局域网连接」' }
  else if (/EHOSTUNREACH|ENETUNREACH/.test(text)) { stage = 'proxy'; message = '连不上代理所在的机器' }
  else if (/ENOTFOUND|EAI_AGAIN/.test(text)) { stage = 'proxy'; message = '代理主机名解析失败' }
  else if (/Proxy connection timed out/i.test(text)) { stage = 'proxy'; message = '连代理超时没有响应' }
  else if (socksReject === 'NotAllowed') { stage = 'proxy'; message = '代理按它的规则拒绝了这个目标' }
  else if (socksReject) { stage = 'target'; message = `代理已接通，但它连不上对方站点（${SOCKS_REJECT_REASONS[socksReject] || socksReject}）` }
  else if (resetCode || /secure TLS connection|socket hang up/i.test(text)) { stage = 'target'; message = `代理已接通，往对方站点的连接被断开（${resetCode || 'ECONNRESET'}）` }
  // 错误里可能带回代理地址，账号密码别显示出去
  if (proxy) {
    try {
      const url = new URL(proxy)
      for (const secret of [url.password, decodeURIComponent(url.password)]) {
        if (secret) message = message.split(secret).join(PROXY_MASK)
      }
    } catch { /* 无效地址前面已拦 */ }
  }
  return { stage, message: message.slice(0, 300) }
}

/**
 * 经网络代理的请求失败了，翻成能看懂的话（和「测试」按钮同一套分段与措辞）。
 * 给自定义源的「经网络代理转发」用：报错页、日志、订阅卡片上的失败原因。
 * @returns {{ stage: 'proxy'|'target'|'', message: string }}
 */
export function describeProxyFailure(err, proxy = outboundProxyUrl()) {
  return describeError(err, proxy)
}

/**
 * 后台「测试」按钮：经输入框里的代理检查代表性官方接口和直播清单（还没保存也能测）；目标见 proxyTestTargets()。
 * 输入框为空时按保存后会用的路子测：环境变量 / 系统代理，都没有就直连。
 * 2xx/3xx 表示可达；HTTP 错误直接展示。仅验证这些目标，不代表全部频道可播。
 * 每项带 stage（见 describeError），整体带 proxyReachable：true 代理本身能用、false 连代理就失败、
 * null 看不出来（直连测试，或全部超时）。
 */
export async function testOutboundProxy(raw, { targets = [TELEGRAM_TEST_TARGET], timeoutMs = 10000 } = {}) {
  const proxy = raw ? normalizeProxyUrl(raw) : ''
  const effective = proxy || systemProxyUrl()
  const dispatcher = proxy ? createProxyDispatcher(proxy) : undefined
  try {
    const results = await Promise.all(targets.map(async target => {
      const started = Date.now()
      // 带上这一项要在代理规则里放行的域名后缀：后台把它写在断在代理之后的失败项旁边
      const base = { name: target.name, ...(Array.isArray(target.hosts) && target.hosts.length ? { hosts: target.hosts } : {}) }
      try {
        const options = { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'Mozilla/5.0' } }
        const res = dispatcher
          ? await undiciFetch(target.url, { ...options, dispatcher })
          : await proxyAwareFetch(target.url, options)
        await res.body?.cancel().catch(() => {})
        const ok = res.status >= 200 && res.status < 400
        // 对方答了 HTTP 状态：隧道已经通了，失败在对方那一段
        return { ...base, ok, status: res.status, ms: Date.now() - started, ...(!ok ? { stage: 'target', message: `目标返回 HTTP ${res.status}` } : {}) }
      } catch (err) {
        let status, accepted = false
        if (proxy && /^https?:/.test(proxy) && err?.name !== 'TimeoutError') {
          try { status = await connectStatus(proxy, target.url, 5000) } catch { /* 连代理本身失败，原错误已经说明 */ }
          if (status === 200) { status = undefined; accepted = true }   // 隧道建得起来：失败在代理之后
        }
        // 本机回环目标不经代理（proxyAwareFetch 同样跳过），它的失败不能算到代理头上
        const { stage, message } = describeError(err, isLoopback(target.url) ? '' : effective, status)
        return { ...base, ok: false, ms: Date.now() - started, stage: stage || (accepted ? 'target' : ''), message }
      }
    }))
    // 有一项经代理连上了（或已证明隧道能建），别的失败就不会是连不上代理：分不清的归到对方那一段
    const reachable = Boolean(effective) && results.some(r => r.ok || r.stage === 'target')
    for (const r of results) {
      if (r.ok) continue
      if (!r.stage && reachable) r.stage = 'target'
      if (r.stage === 'target' && !/^(代理已接通|目标返回)/.test(r.message)) {
        r.message = r.message === '超时没有响应' ? '代理已接通，对方站点超时没有响应' : `代理已接通，往对方站点那一步失败：${r.message}`
      }
    }
    const proxyReachable = !effective ? null : reachable ? true : results.length && results.every(r => r.stage === 'proxy') ? false : null
    return { via: proxy ? 'input' : (systemProxyUrl() ? 'env' : ''), proxyReachable, results }
  } finally {
    dispatcher?.close().catch(() => {})
  }
}
