/**
 * 咪咕体育赛事直播弹幕（统一弹幕接口的直播扩展，协议见仓库 DANMAKU.md）。
 *
 * 弹幕来自咪咕官网的赛事聊天室，不用登录：
 *   - 聊天室 ID 是赛事 basic-data 里的 roomId（形如 room20261013104522520_SR4），
 *     不是 pID 也不是 mgdbId——拿 pID 当房间号去拉，接口照样 200 但永远是空的。
 *     抓赛事列表（utils/updateData.js updatePE）时按直播 pID 记下 roomId，落盘到数据目录
 *     migu-danmaku-rooms.json；快速模式 / 重启只恢复赛事缓存不重抓时，靠这个文件接上。
 *   - 消息用 chatcache/v1/msg/msg-chat/<roomId>（最近一批，纯 JSON，带 id/time/content，
 *     extendInfo 里 c 是颜色）。官网自己走的 push-lbs 增量接口是 gzip 套 protobuf，
 *     解起来不值当；历史接口 5 秒拉一次、按 id 去重，效果一样。
 *
 * 只有有人在看才拉：直播包每被请求一次就续 30 秒，30 秒没人要就停。每个聊天室
 * 一条定时器，同一场比赛多少人看都只打官网一次。
 *
 * 本文件只依赖 paths / colorOut / net 三个叶子模块：appUtils 与 updateData 都要
 * import 它，不能再把 migu/index.js（经 systemConfigAPI → updateData）绕成环。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dataPath } from '../../utils/paths.js'
import { printGrey, printYellow } from '../../utils/colorOut.js'
import { fetchUrl } from '../../utils/net.js'

export const ROOMS_FILE = 'migu-danmaku-rooms.json'
export const POLL_SECONDS = 5
const IDLE_MS = 30_000
// 内存里只留最近 3 分钟：首包要 2×pollSeconds，游标落后再多也不该追到几分钟前
const KEEP_MS = 180_000
const MAX_ITEMS_PER_PACKET = 10_000
const MAX_TEXT = 300
const MAX_ID = 128

const PATH_RE = /(?:^|\/)danmaku\/migu\/(\d{1,20})(?:\/(live|segments))?$/
const historyUrl = roomId => `https://vms-sc.miguvideo.com/chatcache/v1/msg/msg-chat/${encodeURIComponent(roomId)}`

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
      const c = String(extra?.c ?? '').trim()
      if (/^#[0-9a-fA-F]{6}$/.test(c)) color = c.toUpperCase()
    } catch { /* 颜色拿不到就白色 */ }
  }
  return { id, timeMs, time: timeMs / 1000, text: text.slice(0, MAX_TEXT), color, mode: 'scroll' }
}

const publicItem = ({ id, time, text, color, mode }) => ({ id, time, text, color, mode })

export function createDanmakuService({ fetchImpl = fetchUrl, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, persist = true } = {}) {
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
      feed = { roomId, items: [], seen: new Map(), lastAccess: 0, timer: null, running: false, failures: 0 }
      feeds.set(roomId, feed)
    }
    return feed
  }

  async function pollOnce(feed) {
    let result
    try {
      result = await fetchImpl(historyUrl(feed.roomId), { headers: { Referer: 'https://www.miguvideo.com/', 'User-Agent': 'Mozilla/5.0' } }, 6000)
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
    const cutoff = now() - KEEP_MS
    let added = 0
    for (const msg of list) {
      const item = toItem(msg)
      if (!item || item.timeMs < cutoff || feed.seen.has(item.id)) continue
      feed.seen.set(item.id, item.timeMs)
      feed.items.push(item)
      added++
    }
    if (added) feed.items.sort((a, b) => a.timeMs - b.timeMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    while (feed.items.length && feed.items[0].timeMs < cutoff) feed.items.shift()
    for (const [id, t] of feed.seen) if (t < cutoff) feed.seen.delete(id)
  }

  function schedule(feed) {
    feed.timer = setTimer(async () => {
      feed.timer = null
      if (now() - feed.lastAccess > IDLE_MS) {
        feed.running = false
        printGrey(`咪咕弹幕：聊天室 ${feed.roomId} 30 秒无人请求，停止拉取`)
        return
      }
      await pollOnce(feed)
      if (feed.running) schedule(feed)
    }, POLL_SECONDS * 1000)
    if (typeof feed.timer?.unref === 'function') feed.timer.unref()
  }

  /** 有人要这间聊天室的弹幕：续命，并保证轮询在跑。首次调用先同步拉一次，首包不空 */
  async function touch(feed) {
    feed.lastAccess = now()
    if (feed.running) return
    feed.running = true
    printGrey(`咪咕弹幕：聊天室 ${feed.roomId} 开始拉取`)
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
      feed.running = false
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
    feedState: roomId => { const f = feeds.get(roomId); return f ? { running: f.running, items: f.items.length } : null },
  }
}

const service = createDanmakuService()
export default service
