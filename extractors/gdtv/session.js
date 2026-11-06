/** 广东台官网匿名取流：HTTP 会话参数 → WebSocket 节点 → 预检与频道接口。 */
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'undici'
import { proxyAwareFetch, systemProxyDispatcher } from '../../utils/systemProxy.js'
import { CHANNEL_BY_ID } from './channels.js'
import { signedHeaders } from './epg.js'

const ORIGIN = 'https://www.gdtv.cn'
const PARAM_URL = 'https://tcdn-api.itouchtv.cn/getParam'
const SOCKET_URL = 'wss://tcdn-ws.itouchtv.cn:3800/connect'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const DEFAULT_TIMEOUT_MS = 20000
const AUTH_KEY_RE = /^(\d{10})-\w+-\w+-[0-9a-f]{32}$/i
const PREFLIGHT_HEADERS = 'content-type,x-itouchtv-ca-key,x-itouchtv-ca-signature,'
  + 'x-itouchtv-ca-timestamp,x-itouchtv-client,x-itouchtv-device-id'

export function isOfficialStreamUrl(raw) {
  try {
    const url = new URL(String(raw || '').trim())
    if (url.protocol !== 'https:' || !url.pathname.startsWith('/live/') || !/\.m3u8$/i.test(url.pathname)) return false
    if (url.hostname === 'tcdn.itouchtv.cn') return !!url.searchParams.get('t_token')
    if (url.hostname === 'lbplay.grtn.cn') return AUTH_KEY_RE.test(url.searchParams.get('auth_key') || '')
    return false
  } catch {
    return false
  }
}

/** 地址自带的过期时刻（毫秒）；t_token 未公开有效期，仍由 resolver 使用保守缓存窗口。 */
export function streamExpiresAt(raw) {
  try {
    const match = AUTH_KEY_RE.exec(new URL(String(raw || '').trim()).searchParams.get('auth_key') || '')
    return match ? Number(match[1]) * 1000 : 0
  } catch {
    return 0
  }
}

function createSocket() {
  const dispatcher = systemProxyDispatcher()
  return new WebSocket(SOCKET_URL, {
    headers: { Origin: ORIGIN, 'User-Agent': USER_AGENT },
    ...(dispatcher ? { dispatcher } : {}),
  })
}

function receiveNode(socket, initialNode, signal) {
  return new Promise((resolve, reject) => {
    const finish = (error, node) => {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null
      signal.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(node)
    }
    const abort = () => finish(signal.reason)
    socket.onopen = () => {
      try { socket.send(JSON.stringify({ route: 'getwsparam', message: initialNode })) }
      catch { finish(new Error('广东台会话参数发送失败')) }
    }
    socket.onerror = () => finish(new Error('广东台 WebSocket 连接失败'))
    socket.onclose = () => finish(new Error('广东台 WebSocket 提前关闭'))
    socket.onmessage = event => {
      let data
      try { data = JSON.parse(event.data) } catch { return }
      if (data?.status !== 201) return
      if (typeof data.wsnode !== 'string' || !data.wsnode || data.wsnode.length > 8192) {
        finish(new Error('广东台返回的会话节点无效'))
        return
      }
      finish(null, data.wsnode)
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

export function createApiSession({ fetchImpl = proxyAwareFetch, socketFactory = createSocket } = {}) {
  const controllers = new Set()
  const deviceId = `WEB_${randomUUID()}`

  async function requestJson(url, signal) {
    const response = await fetchImpl(url, {
      signal,
      headers: {
        ...signedHeaders(url),
        'X-ITOUCHTV-DEVICE-ID': deviceId,
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/plain, */*',
        Origin: ORIGIN,
        Referer: `${ORIGIN}/`,
      },
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`广东台接口返回 HTTP ${response.status}`)
    }
    return response.json()
  }

  async function capture(channelId, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const id = String(channelId)
    if (!CHANNEL_BY_ID.has(id)) throw new Error('广东台频道 ID 无效')
    const controller = new AbortController()
    const { signal } = controller
    const timer = setTimeout(() => controller.abort(new Error('广东台取流超时')),
      Math.max(5000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS))
    controllers.add(controller)
    let socket
    try {
      const initial = await requestJson(PARAM_URL, signal)
      let node = initial?.node
      if (typeof node !== 'string' || !node || node.length > 8192) throw new Error('广东台返回的初始化节点无效')
      signal.throwIfAborted()
      if (node.endsWith('-1')) {
        socket = socketFactory()
        node = await receiveNode(socket, node, signal)
      }
      const url = `https://gdtv-api.gdtv.cn/api/tv/v2/tvChannel/${id}`
        + `?tvChannelPk=${id}&node=${Buffer.from(node, 'latin1').toString('base64')}`

      // 2026-11-06 对照官网验证：省略此预检时接口仍回 200，但下发的短令牌导致 HLS 403。
      // 预检必须针对本次含 node 的完整频道 URL；初始化接口的预检不能替代它。
      const preflight = await fetchImpl(url, {
        method: 'OPTIONS', signal,
        headers: {
          Origin: ORIGIN,
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': PREFLIGHT_HEADERS,
        },
      })
      await preflight.body?.cancel()
      if (!preflight.ok) throw new Error(`广东台频道预检返回 HTTP ${preflight.status}`)
      const detail = await requestJson(url, signal)
      signal.throwIfAborted()
      if (Number(detail?.pk) !== Number(id)) throw new Error('广东台返回的频道不匹配')
      let streams
      try { streams = JSON.parse(detail.playUrl) } catch { throw new Error('广东台播放地址格式无效') }
      const stream = streams?.hd || Object.values(streams || {}).find(isOfficialStreamUrl)
      if (!isOfficialStreamUrl(stream)) throw new Error('官网没有返回有效的广东台 HLS 地址')
      return stream
    } finally {
      clearTimeout(timer)
      controllers.delete(controller)
      try { socket?.close() } catch { /* 已关闭或仍在连接的套接字无需继续使用。 */ }
    }
  }

  function close() {
    for (const controller of controllers) controller.abort(new Error('广东台取流已取消'))
  }

  return { capture, close }
}

export const apiSession = createApiSession()
