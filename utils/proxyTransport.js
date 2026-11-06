import { isIP } from 'node:net'
import { Agent, ProxyAgent, buildConnector } from 'undici'
import { SocksClient } from 'socks'

const SCHEMES = new Set(['http:', 'https:', 'socks5:', 'socks5h:'])
const CONNECT_TIMEOUT_MS = 10000

/**
 * 校验并规整用户填的代理地址，返回规整后的字符串；空值返回 ''；格式不对抛错（信息可直接给用户看）。
 * 只写「ip:端口」时补 http://（Clash / mihomo 的混合端口两种协议都认）。
 */
export function normalizeProxyUrl(raw, { requirePort = true } = {}) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return ''
  if (text.length > 1000 || /[\s\x00-\x1f\x7f]/.test(text)) throw new Error('代理地址里不能有空格或换行')
  const address = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'http://' + text
  let url
  try { url = new URL(address) }
  catch { throw new Error('代理地址格式不对，示例：http://192.168.1.10:7890') }
  if (!SCHEMES.has(url.protocol)) throw new Error('代理只支持 http://、https://、socks5:// 开头的地址')
  if (!url.hostname) throw new Error('代理地址缺少主机')
  const authority = address.split('://')[1].split(/[/?#]/)[0].split('@').at(-1)
  if (!url.port && ((requirePort && !/:\d+$/.test(authority)) || !/^https?:$/.test(url.protocol))) {
    throw new Error('代理地址要带端口，如 http://192.168.1.10:7890')
  }
  validateProxyCredentials(url)
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) throw new Error('代理地址只填「协议://主机:端口」，后面不要带路径')
  return formatProxyUrl(url)
}

/** 在保存、测试及运行前使用同一套凭据校验；错误信息不包含账号密码。 */
export function validateProxyCredentials(url) {
  try {
    decodeURIComponent(url.username)
    decodeURIComponent(url.password)
  } catch {
    throw new Error('代理账号或密码的 URL 编码无效：% 请写成 %25，@ 请写成 %40，# 请写成 %23')
  }
}

/** WHATWG URL 会隐藏默认端口；回显与持久化时补回，确保再次保存仍合法。 */
export function formatProxyUrl(url) {
  const credentials = url.username || url.password ? `${url.username}${url.password ? ':' + url.password : ''}@` : ''
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  return `${url.protocol}//${credentials}${url.hostname}:${port}`
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
  const url = new URL(normalizeProxyUrl(raw, { requirePort: false }))
  if (url.protocol === 'socks5:' || url.protocol === 'socks5h:') return socksAgent(url, requestTls)
  return new ProxyAgent({ uri: url.href, ...(requestTls ? { requestTls } : {}) })
}

