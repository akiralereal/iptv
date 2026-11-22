import { dataPath } from '../../utils/paths.js'
import { isEmbyPath } from './src/media-server.mjs'

const ROOT = '/hongguo'
let service

export function isHongguoPath(pathname) {
  return pathname === ROOT || pathname.startsWith(`${ROOT}/`)
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

export async function handleHongguo(req, res, routePath, { adminPath, accessPrefix = '', passAuthed, userAuthed }) {
  let subPath = routePath.slice(ROOT.length)
  // Emby 官方 App 等客户端会在服务器地址后自动加 /emby：/hongguo/emby/Items 与 /hongguo/Items 等价
  const unprefixed = subPath.replace(/^\/emby(?=\/)/i, '')
  const isEmby = isEmbyPath(unprefixed)
  if (isEmby) subPath = unprefixed
  // 管理页与 IPTV 后台同一规矩：没设访问密码时能进后台就能进；设了密码要带密码路径；用户令牌进不了
  if (!isEmby && (!passAuthed || userAuthed)) {
    fail(res, 403, '请从 IPTV 管理后台进入红果短剧。')
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
  await vod.handle(req, res, subPath, { adminPath, accessPrefix, isEmby })
}

export async function shutdownHongguo() {
  if (service) await (await service).close()
}
