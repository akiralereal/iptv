/**
 * 咪咕体育赛事直播弹幕（统一弹幕接口的直播扩展，协议见仓库 DANMAKU.md）。
 *
 * 弹幕来自咪咕官网的赛事聊天室，不用登录：
 *   - 聊天室 ID 是赛事 basic-data 里的 roomId（形如 room20261013104522520_SR4），
 *     不是 pID 也不是 mgdbId——拿 pID 当房间号去拉，接口照样 200 但永远是空的。
 *     抓赛事列表（utils/updateData.js updatePE）时按直播 pID 记下 roomId，落盘到数据目录
 *     migu-danmaku-rooms.json；快速模式 / 重启只恢复赛事缓存不重抓时，靠这个文件接上。
 *   - 消息走官网同一条 WebSocket（wsschatpush.miguvideo.com/push_ws），匿名 token 就能进房间；
 *     PushSvrChat 帧是 gzip 的 JSON，里面 protobuf 字段是 URL 编码的 base64（LiveBroadcast）。
 *     chatcache/v1/msg/msg-chat/<roomId> 热门场次只剩快捷热词，只在长连接断开时兜底；
 *     push-lbs 静态增量接口入口被 CDN 缓存，实测晚 6 分钟多，不用。
 *   - 官网上屏靠「收到就滚」，消息发送时间不能当时间轴：真实聊天审核后约晚 30 秒、
 *     热词最多晚 5 分钟，而播放器只画比服务器晚 6～14 秒的条目。所以 time 一律打成
 *     本机收到的时刻（按间隔排开），发送时间只用来丢太旧的消息。
 *   - 热词刷屏（热门场次占大半）：同样的话 10 秒内只放一条，排队超过 5 秒的直接丢。
 *
 * 只有有人在看才连：直播包每被请求一次就续 30 秒，30 秒没人要就断开。每个聊天室
 * 一条连接，同一场比赛多少人看都只占官网一个连接。
 *
 * 本文件只依赖 paths / colorOut / net / systemProxy 这几个叶子模块：appUtils 与 updateData 都要
 * import 它，不能再把 migu/index.js（经 systemConfigAPI → updateData）绕成环。
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { WebSocket as UndiciWebSocket } from 'undici'
import { dataPath } from '../../utils/paths.js'
import { printGrey, printYellow } from '../../utils/colorOut.js'
import { fetchUrl } from '../../utils/net.js'
import { systemProxyDispatcher } from '../../utils/systemProxy.js'

export const ROOMS_FILE = 'migu-danmaku-rooms.json'
export const POLL_SECONDS = 5
const IDLE_MS = 30_000
// 内存里只留最近 3 分钟：首包要 2×pollSeconds，游标落后再多也不该追到几分钟前
const KEEP_MS = 180_000
// 比这更旧的官网消息不上屏：热词最多晚 5 分钟，再旧就是冷场聊天室的陈年记录
const MAX_MESSAGE_AGE_MS = 360_000
const STAMP_SPACING_MS = 300
const MAX_STAMP_AHEAD_MS = 5_000
const REPEAT_WINDOW_MS = 10_000
const CONNECT_TIMEOUT_MS = 15_000
const SILENCE_TIMEOUT_MS = 60_000
const HEARTBEAT_MS = 20_000
const RECONNECT_MS = 10_000
const MAX_ITEMS_PER_PACKET = 10_000
const MAX_TEXT = 300
const MAX_ID = 128

const PATH_RE = /(?:^|\/)danmaku\/migu\/(\d{1,20})(?:\/(live|segments))?$/
const historyUrl = roomId => `https://vms-sc.miguvideo.com/chatcache/v1/msg/msg-chat/${encodeURIComponent(roomId)}`
const TOKEN_URL = 'https://webapi.miguvideo.com/gateway/push-lbs/pushlbs/phone/v2/getWsToken'
const SOCKET_URL = 'wss://wsschatpush.miguvideo.com/push_ws'
const OFFICIAL_HEADERS = { Referer: 'https://www.miguvideo.com/', 'User-Agent': 'Mozilla/5.0' }

function json(status, body, extra = {}) {
  const text = JSON.stringify(body)
  return {
    status,
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'Cache-Control': 'no-cache, no-store',
      'Content-Length': Buffer.byteLength(text),
      ...extra,
    },
    body: text,
  }
}

const encodeCursor = (timeMs, id) => Buffer.from(`${timeMs}:${id}`, 'utf8').toString('base64url')
function decodeCursor(raw) {
  if (!raw || typeof raw !== 'string' || raw.length > MAX_ID) return null
  let text
  try { text = Buffer.from(raw, 'base64url').toString('utf8') } catch { return null }
  const at = text.indexOf(':')
  if (at <= 0) return null
  const timeMs = Number(text.slice(0, at))
  if (!Number.isFinite(timeMs)) return null
  return { timeMs, id: text.slice(at + 1) }
}

/** 官网一条聊天消息 → 统一弹幕条目（内部多带 timeMs 用于游标比较）；不合格返回 null */
export function toItem(msg) {
  if (!msg || typeof msg !== 'object') return null
  const id = msg.id == null ? '' : String(msg.id)
  const timeMs = Number(msg.time)
  const text = String(msg.content ?? '').replace(/\s+/g, ' ').trim()
  if (!id || id.length > MAX_ID || !Number.isFinite(timeMs) || timeMs <= 0 || !text) return null
  let color = '#FFFFFF'
  if (msg.extendInfo) {
    try {
      const extra = typeof msg.extendInfo === 'string' ? JSON.parse(msg.extendInfo) : msg.extendInfo
      const c = String(extra?.c ?? extra?.textcolor ?? '').trim()
      if (/^#[0-9a-fA-F]{6}$/.test(c)) color = c.toUpperCase()
    } catch { /* 颜色拿不到就白色 */ }
  }
  return { id, timeMs, time: timeMs / 1000, text: text.slice(0, MAX_TEXT), color, mode: 'scroll' }
}

const publicItem = ({ id, time, text, color, mode }) => ({ id, time, text, color, mode })

/** 依次回调 protobuf 的字段（varint 是 Number，length-delimited 是 Buffer）；截断就停 */
function readFields(buf, onField) {
  let at = 0
  const varint = () => {
    let value = 0
    for (let scale = 1; at < buf.length; scale *= 128) {
      const byte = buf[at++]
      value += (byte & 127) * scale
      if (byte < 128) return value
    }
    return null
  }
  while (at < buf.length) {
    const key = varint()
    if (key === null) return
    const field = Math.floor(key / 8)
    const wire = key % 8
    if (wire === 0) {
      const value = varint()
      if (value === null) return
      onField(field, value)
    } else if (wire === 2) {
      const length = varint()
      if (length === null || at + length > buf.length) return
      onField(field, buf.subarray(at, at + length))
      at += length
    } else if (wire === 1) at += 8
    else if (wire === 5) at += 4
    else return
  }
}

/** LiveBroadcast → toItem 能吃的消息；msgList 是字段 4，LiveMsg 见官网 miguMsgSdk.js */
function broadcastMessages(buf) {
  const messages = []
  readFields(buf, (field, value) => {
    if (field !== 4 || !Buffer.isBuffer(value)) return
    const msg = {}
    readFields(value, (f, v) => {
      if (f === 17 && Buffer.isBuffer(v)) msg.id = v.toString('utf8')
      else if (f === 18) msg.time = v
      else if (f === 19 && Buffer.isBuffer(v)) msg.content = v.toString('utf8')
      else if (f === 24 && Buffer.isBuffer(v)) msg.extendInfo = v.toString('utf8')
    })
    messages.push(msg)
  })
  return messages
}

/** 长连接一帧（已 JSON.parse）→ 聊天消息；不是聊天帧返回空，解不开抛异常 */
export function chatMessagesOf(frame) {
  if (frame?.svrSign !== 'PushSvrChat' || !frame.msg) return []
  const payload = frame.compressType === 1 ? gunzipSync(Buffer.from(frame.msg, 'latin1')).toString('utf8') : frame.msg
  const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload
  const packets = Array.isArray(parsed) ? parsed : [parsed]
  return packets.flatMap(packet => typeof packet?.protobuf === 'string'
    ? broadcastMessages(Buffer.from(decodeURIComponent(packet.protobuf), 'base64'))
    : [])
}

function defaultCreateSocket(url) {
  const dispatcher = systemProxyDispatcher()
  return new UndiciWebSocket(url, {
    headers: { Origin: 'https://www.miguvideo.com', 'User-Agent': OFFICIAL_HEADERS['User-Agent'] },
    ...(dispatcher ? { dispatcher } : {}),
  })
}

export function createDanmakuService({ fetchImpl = fetchUrl, createSocket = defaultCreateSocket, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, persist = true } = {}) {
  /** pID → { roomId, title, mgdbId, endTime } */
  let rooms = new Map()
  let pendingRound = null
  /** roomId → feed */
  const feeds = new Map()

  function roomsPath() { return dataPath(ROOMS_FILE) }

  function loadRooms() {
    if (!persist) return
    try {
      const file = roomsPath()
      if (!existsSync(file)) return
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      const next = new Map()
      for (const [pid, info] of Object.entries(parsed?.rooms || {})) {
        if (/^\d{1,20}$/.test(pid) && info && typeof info.roomId === 'string' && info.roomId) {
          next.set(pid, { roomId: info.roomId, title: String(info.title || ''), mgdbId: String(info.mgdbId || ''), endTime: Number(info.endTime) || 0 })
        }
      }
      rooms = next
    } catch (e) {
      printYellow(`咪咕弹幕：聊天室记录读取失败，本次忽略：${e.message}`)
    }
  }

  function saveRooms() {
    if (!persist) return
    try {
      const file = roomsPath()
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify({ updatedAt: new Date(now()).toISOString(), rooms: Object.fromEntries(rooms) }), 'utf8')
      renameSync(tmp, file)
    } catch (e) {
      printYellow(`咪咕弹幕：聊天室记录保存失败：${e.message}`)
    }
  }

  /** updatePE 一轮开始：先攒着，整轮成功才替换，抓到一半失败不丢上一份 */
  function beginRound() { pendingRound = new Map() }
  function recordRoom(pid, { roomId, title = '', mgdbId = '', endTime = 0 } = {}) {
    const key = String(pid ?? '')
    if (!pendingRound || !/^\d{1,20}$/.test(key) || typeof roomId !== 'string' || !/^[\w-]{1,80}$/.test(roomId)) return false
    pendingRound.set(key, { roomId, title: String(title).slice(0, 200), mgdbId: String(mgdbId), endTime: Number(endTime) || 0 })
    return true
  }
  function commitRound() {
    if (!pendingRound) return
    rooms = pendingRound
    pendingRound = null
    saveRooms()
  }
  function abandonRound() { pendingRound = null }

  function feedFor(roomId) {
    let feed = feeds.get(roomId)
    if (!feed) {
      feed = {
        roomId, items: [], seen: new Map(), recent: new Map(), lastStampMs: 0, lastAccess: 0, timer: null, running: false, failures: 0,
        socket: null, connecting: false, joined: false, socketStartedAt: 0, lastFrameAt: 0, lastHeartbeatAt: 0, nextConnectAt: 0, socketFailures: 0,
      }
      feeds.set(roomId, feed)
    }
    return feed
  }

  /** 官网消息进队列：time 打成收到的时刻（见文件头），太旧、重复、排不下的丢掉 */
  function admit(feed, msg) {
    const item = toItem(msg)
    const nowMs = now()
    if (!item || nowMs - item.timeMs > MAX_MESSAGE_AGE_MS || feed.seen.has(item.id)) return
    feed.seen.set(item.id, nowMs)
    const key = item.text.replace(/[\s\p{P}]/gu, '') || item.text
    if (nowMs - (feed.recent.get(key) ?? -Infinity) < REPEAT_WINDOW_MS) return
    const stampMs = Math.max(nowMs, feed.lastStampMs + STAMP_SPACING_MS)
    if (stampMs - nowMs > MAX_STAMP_AHEAD_MS) return
    feed.recent.set(key, nowMs)
    feed.lastStampMs = stampMs
    feed.items.push({ ...item, timeMs: stampMs, time: stampMs / 1000 })
  }

  function prune(feed) {
    const nowMs = now()
    while (feed.items.length && feed.items[0].timeMs < nowMs - KEEP_MS) feed.items.shift()
    for (const [id, t] of feed.seen) if (t < nowMs - MAX_MESSAGE_AGE_MS) feed.seen.delete(id)
    for (const [key, t] of feed.recent) if (t < nowMs - REPEAT_WINDOW_MS) feed.recent.delete(key)
  }

  /** 长连接不通时的兜底：只能拿到 chatcache 剩下的那点消息 */
  async function pollOnce(feed) {
    let result
    try {
      result = await fetchImpl(historyUrl(feed.roomId), { headers: OFFICIAL_HEADERS }, 6000)
    } catch (e) {
      result = undefined
    }
    const list = Array.isArray(result?.body) ? result.body : null
    if (!list) {
      feed.failures++
      if (feed.failures === 1 || feed.failures % 12 === 0) printYellow(`咪咕弹幕：聊天室 ${feed.roomId} 拉取失败 ${feed.failures} 次`)
      return
    }
    feed.failures = 0
    for (const msg of list) admit(feed, msg)
    prune(feed)
  }

  function dropSocket(feed) {
    const socket = feed.socket
    feed.socket = null
    feed.joined = false
    feed.nextConnectAt = now() + RECONNECT_MS
    try { socket?.close() } catch { /* 已经断了 */ }
  }

  function socketFailed(feed, reason) {
    feed.socketFailures++
    if (feed.socketFailures === 1 || feed.socketFailures % 12 === 0) printYellow(`咪咕弹幕：聊天室 ${feed.roomId} 长连接失败 ${feed.socketFailures} 次（${reason}），先用 chatcache 兜底`)
    dropSocket(feed)
  }

  function onSocketFrame(feed, socket, raw, wsToken) {
    feed.lastFrameAt = now()
    let frame
    try { frame = JSON.parse(String(raw)) } catch { return }
    if (Number(frame?.msg?.optType) === 1 && frame.msg.result === 'SUCC' && !feed.joined) {
      socket.send(JSON.stringify({ domainName: 'PushSvrChat', groupId: feed.roomId, wsToken, type: 6 }))
      feed.joined = true
      feed.socketFailures = 0
      printGrey(`咪咕弹幕：聊天室 ${feed.roomId} 长连接已进房间`)
      return
    }
    let messages
    try { messages = chatMessagesOf(frame) } catch { return }
    for (const msg of messages) admit(feed, msg)
    if (messages.length) prune(feed)
  }

  async function connect(feed) {
    feed.connecting = true
    feed.nextConnectAt = now() + RECONNECT_MS
    try {
      const clientId = randomBytes(16).toString('hex')
      const token = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { ...OFFICIAL_HEADERS, 'Content-Type': 'application/json;charset=UTF-8' },
        body: JSON.stringify({ plat: 'miguvideo', clientId, phoneInfo: '', userId: '' }),
      }, 6000)
      const wsToken = token?.body?.wsToken
      if (!wsToken) return socketFailed(feed, '取不到 token')
      if (!feed.running) return
      const socket = createSocket(SOCKET_URL)
      feed.socket = socket
      feed.socketStartedAt = feed.lastFrameAt = feed.lastHeartbeatAt = now()
      socket.addEventListener('open', () => {
        if (feed.socket !== socket) return
        socket.send(JSON.stringify({
          wsToken, type: 1, compressType: 1,
          param: { uuid: clientId, uToken: '', clientId, uid: clientId.slice(0, 18), appId: 'miguvideo', appCode: 'miguvideo_default_www', os: 'WEB' },
        }))
      })
      socket.addEventListener('message', event => { if (feed.socket === socket) onSocketFrame(feed, socket, event.data, wsToken) })
      socket.addEventListener('close', () => { if (feed.socket === socket) socketFailed(feed, '连接断开') })
      socket.addEventListener('error', () => { if (feed.socket === socket) socketFailed(feed, '连接出错') })
    } catch (e) {
      socketFailed(feed, e.message)
    } finally {
      feed.connecting = false
    }
  }

  /** 每轮看一眼长连接：没连就连、卡住就断、连着就发心跳 */
  function tendSocket(feed) {
    const nowMs = now()
    if (feed.connecting) return
    if (!feed.socket) {
      if (nowMs >= feed.nextConnectAt) connect(feed)
    } else if (!feed.joined) {
      if (nowMs - feed.socketStartedAt > CONNECT_TIMEOUT_MS) socketFailed(feed, '进房间超时')
    } else if (nowMs - feed.lastFrameAt > SILENCE_TIMEOUT_MS) {
      socketFailed(feed, '长时间没有数据')
    } else if (nowMs - feed.lastHeartbeatAt >= HEARTBEAT_MS) {
      feed.lastHeartbeatAt = nowMs
      try { feed.socket.send(JSON.stringify({ type: 8, ts: nowMs })) } catch (e) { socketFailed(feed, e.message) }
    }
  }

  function stop(feed) {
    feed.running = false
    dropSocket(feed)
    feed.nextConnectAt = 0
  }

  function schedule(feed) {
    feed.timer = setTimer(async () => {
      feed.timer = null
      if (now() - feed.lastAccess > IDLE_MS) {
        stop(feed)
        printGrey(`咪咕弹幕：聊天室 ${feed.roomId} 30 秒无人请求，停止拉取`)
        return
      }
      tendSocket(feed)
      prune(feed)
      if (!feed.joined) await pollOnce(feed)
      if (feed.running) schedule(feed)
    }, POLL_SECONDS * 1000)
    if (typeof feed.timer?.unref === 'function') feed.timer.unref()
  }

  /** 有人要这间聊天室的弹幕：续命，并保证连接在跑。首次调用先同步拉一次，首包不空 */
  async function touch(feed) {
    feed.lastAccess = now()
    if (feed.running) return
    feed.running = true
    printGrey(`咪咕弹幕：聊天室 ${feed.roomId} 开始拉取`)
    tendSocket(feed)
    await pollOnce(feed)
    if (feed.running) schedule(feed)
  }

  function metadata(pid, room) {
    return {
      schemaVersion: 1,
      videoID: `migu:${room.roomId}`,
      title: room.title,
      available: true,
      live: true,
      pollSeconds: POLL_SECONDS,
      liveURL: `${pid}/live`,
      // 老客户端（只认点播）按分钟来取，给合法的空分段
      duration: 86400,
      segmentSeconds: 60,
      segmentsURL: `${pid}/segments`,
    }
  }

  function livePacket(room, feed, cursorRaw) {
    const cursor = decodeCursor(cursorRaw)
    const nowMs = now()
    let selected
    if (cursor) {
      selected = feed.items.filter(i => i.timeMs > cursor.timeMs || (i.timeMs === cursor.timeMs && i.id > cursor.id))
    } else {
      const since = nowMs - 2 * POLL_SECONDS * 1000
      selected = feed.items.filter(i => i.timeMs >= since)
    }
    if (selected.length > MAX_ITEMS_PER_PACKET) selected = selected.slice(-MAX_ITEMS_PER_PACKET)
    const last = selected[selected.length - 1]
    const nextCursor = last ? encodeCursor(last.timeMs, last.id) : (cursor ? cursorRaw : encodeCursor(nowMs, ''))
    return {
      schemaVersion: 1,
      videoID: `migu:${room.roomId}`,
      live: true,
      serverTime: nowMs / 1000,
      pollSeconds: POLL_SECONDS,
      cursor: nextCursor,
      items: selected.map(publicItem),
    }
  }

  function claimsLocalPath(path) { return PATH_RE.test(String(path || '')) }

  /** app.js 本机路由钩子：鉴权（访问密码 / 用户令牌）已在外层完成 */
  async function handleLocalRequest({ path, method = 'GET', url = '' } = {}) {
    const match = String(path || '').match(PATH_RE)
    if (!match) return null
    if (method !== 'GET' && method !== 'HEAD') return json(405, { success: false, message: '只支持 GET' })
    const [, pid, kind] = match
    const room = rooms.get(pid)
    if (!room) {
      return json(200, kind === 'live'
        ? { schemaVersion: 1, videoID: `migu:${pid}`, live: true, serverTime: now() / 1000, pollSeconds: POLL_SECONDS, cursor: encodeCursor(now(), ''), items: [] }
        : kind === 'segments'
          ? { schemaVersion: 1, videoID: `migu:${pid}`, part: 1, start: 0, end: 60, items: [] }
          : { schemaVersion: 1, videoID: `migu:${pid}`, title: '', available: false, live: true, pollSeconds: POLL_SECONDS, liveURL: `${pid}/live`, duration: 86400, segmentSeconds: 60, segmentsURL: `${pid}/segments` })
    }
    const query = new URLSearchParams(String(url || '').split('?')[1] || '')
    if (!kind) return json(200, metadata(pid, room))
    if (kind === 'segments') {
      const part = Math.max(1, Math.min(1440, Number.parseInt(query.get('part') || '1', 10) || 1))
      return json(200, { schemaVersion: 1, videoID: `migu:${room.roomId}`, part, start: (part - 1) * 60, end: part * 60, items: [] })
    }
    const feed = feedFor(room.roomId)
    if (method === 'GET') await touch(feed)
    return json(200, livePacket(room, feed, query.get('cursor') || ''))
  }

  /**
   * 给播放列表里有聊天室的赛事条目补 `danmaku-url`。只认「${replace}/纯数字」这一形态的
   * 地址行（咪咕 pID），且要在 relay/proxy 改写与 ${replace} 展开之前调用；后台重生成的
   * 列表（generateM3u8）不带这个属性，所以放在输出口统一补而不是存进 interface.txt。
   */
  function decorateM3u(content) {
    if (!rooms.size || typeof content !== 'string' || !content.includes('#EXTINF')) return content
    return content.replace(/^(#EXTINF:-1)([^\n]*\n\$\{replace\}\/(\d{1,20})\r?$)/gm, (whole, head, rest, pid) => {
      if (!rooms.has(pid) || / danmaku-url=/.test(rest)) return whole
      return `${head} danmaku-url="\${replace}/danmaku/migu/${pid}"${rest}`
    })
  }

  function shutdown() {
    for (const feed of feeds.values()) {
      stop(feed)
      if (feed.timer) { clearTimer(feed.timer); feed.timer = null }
    }
  }

  loadRooms()

  return {
    beginRound, recordRoom, commitRound, abandonRound,
    claimsLocalPath, handleLocalRequest, decorateM3u, shutdown,
    // 测试 / 排查用
    roomOf: pid => rooms.get(String(pid)) || null,
    roomCount: () => rooms.size,
    feedState: roomId => { const f = feeds.get(roomId); return f ? { running: f.running, items: f.items.length, joined: f.joined } : null },
  }
}

const service = createDanmakuService()
export default service
