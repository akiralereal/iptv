import { dataPath } from '../../utils/paths.js'
import { isEmbyPath } from './src/media-server.mjs'

const ROOT = '/hongguo'
let service

export function isHongguoPath(pathname) {
  return pathname === ROOT || pathname.startsWith(`${ROOT}/`)
}

function localRequest(req) {
  // 同机反代（nginx proxy_pass 127.0.0.1）只带 X-Real-IP 或 Via 时也不算本机，免得外网访问者被当成本机
  const { host, forwarded, via, 'x-forwarded-for': forwardedFor, 'x-forwarded-host': forwardedHost, 'x-real-ip': realIp } = req.headers
  return !forwarded && !via && !forwardedFor && !forwardedHost && !realIp &&
    ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) &&
    /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host || '')
}

function sameOriginWrite(req) {
  if (req.method !== 'POST') return true
  const site = req.headers['sec-fetch-site']
  if (site) return site === 'same-origin'
  const origin = req.headers.origin
  if (!origin) return true
  try { return new URL(origin).host === (req.headers['x-forwarded-host'] || req.headers.host) } catch { return false }
}

function fail(res, status, error) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify({ error }))
}

export async function handleHongguo(req, res, routePath, { adminPath, accessPrefix = '', passAuthed, userAuthed, passConfigured }) {
  const isEmby = isEmbyPath(routePath.slice(ROOT.length))
  if (!isEmby && (!passAuthed || userAuthed || (!passConfigured && !localRequest(req)))) {
    fail(res, 403, '请从 IPTV 管理后台进入红果短剧。远程访问需要设置 IPTV 访问密码。')
    return
  }
  if (!isEmby && !sameOriginWrite(req)) {
    fail(res, 403, '请从同一 IPTV 页面提交操作。')
    return
  }
  if (routePath === ROOT && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(308, { Location: './hongguo/', 'Cache-Control': 'no-store' })
    res.end()
    return
  }
  if (Number(process.versions.node.split('.')[0]) < 22) {
    fail(res, 503, '红果短剧需要 Node.js 22 或更新版本。')
    return
  }

  service ||= import('./src/server.mjs').then(({ createHongguo }) => createHongguo(dataPath('hongguo-vod')))
  const vod = await service
  await vod.handle(req, res, routePath.slice(ROOT.length), { adminPath, accessPrefix, isEmby })
}

export async function shutdownHongguo() {
  if (service) await (await service).close()
}
