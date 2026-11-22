import { createServer } from 'node:http'
import { join } from 'node:path'
import { dataPath } from '../../utils/paths.js'
import { HongguoEmbyPort } from './src/emby-port.mjs'
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

function embySubPath(pathname) {
  // 一些播放器会在服务器地址后自动加 /emby。
  const unprefixed = pathname.replace(/^\/emby(?=\/)/i, '')
  return isEmbyPath(unprefixed) ? unprefixed : null
}

async function dispatch(req, res, pathname, options) {
  if (Number(process.versions.node.split('.')[0]) < 22) {
    fail(res, 503, '红果短剧需要 Node.js 22 或更新版本。')
    return
  }
  service ||= import('./src/server.mjs').then(({ createHongguo }) => createHongguo(dataPath('hongguo-vod')))
  const vod = await service
  await vod.handle(req, res, pathname, options)
}

export async function handleHongguo(req, res, routePath, { adminPath, accessPrefix = '', passAuthed, userAuthed, embyPort }) {
  const subPath = routePath.slice(ROOT.length)
  const embyPath = embySubPath(subPath)
  // 管理页与 IPTV 后台同一规矩：没设访问密码时能进后台就能进；设了密码要带密码路径；用户令牌进不了
  if (!embyPath && (!passAuthed || userAuthed)) {
    fail(res, 403, '请从 IPTV 管理后台进入红果短剧。')
    return
  }
  if (!embyPath && !sameOriginWrite(req)) {
    fail(res, 403, '请从同一 IPTV 页面提交操作。')
    return
  }
  if (routePath === ROOT && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(308, { Location: './hongguo/', 'Cache-Control': 'no-store' })
    res.end()
    return
  }
  await dispatch(req, res, embyPath ?? subPath, { adminPath, accessPrefix, isEmby: !!embyPath, embyPort })
}

function createHongguoEmbyServer() {
  return createServer((req, res) => {
    const pathname = embySubPath(req.url.split('?')[0])
    if (!pathname) {
      fail(res, 404, '此端口仅提供红果 Emby 点播。')
      return
    }
    dispatch(req, res, pathname, { isEmby: true }).catch(() => {
      if (res.headersSent) res.destroy()
      else fail(res, 503, '红果 Emby 点播暂不可用。')
    })
  })
}

export function createHongguoEmbyPort(mainPort, { host, initialPort = process.env.mHongguoEmbyPort } = {}) {
  return new HongguoEmbyPort({
    file: join(dataPath('hongguo-vod'), '.runtime', 'emby-port.json'),
    mainPort, host, initialPort, createServer: createHongguoEmbyServer,
  })
}

export async function shutdownHongguo() {
  if (service) await (await service).close()
}
