/** 斗鱼直播：分类热门房间、移动官网房间数据与匿名 HLS 签名。 */
import { createHash } from 'node:crypto'
import vm from 'node:vm'
import fetch from 'node-fetch'
import { qualityFrom } from '../../utils/qualityOverride.js'

export const DOUYU_GROUP = '斗鱼'
export const REFERER = 'https://m.douyu.com/'
export const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) '
  + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
export const DEFAULT_MIN_HEAT = 100000
export const DEFAULT_QUALITY = 3
// 后台下拉框与播放地址 ?quality= 共用这一份档位表
export const QUALITY_OPTIONS = Object.freeze([
  { value: 0, label: '原画 / 最高画质' },
  { value: 3, label: '超清 2M（推荐）' },
  { value: 2, label: '高清 900K' },
])

// 这些都是官网分类页 var $DATA.pagePath 当前指向的 JSON 接口。与直接解析页面卡片
// 相比，字段更稳定、响应也小得多；分类名仍与官网导航保持一致。
export const AREA_APIS = Object.freeze({
  全部: 'https://www.douyu.com/gapi/rknc/directory/mixListV1/0_0/1',
  网游竞技: 'https://www.douyu.com/gapi/rkc/directory/mixListV1/1_1/1',
  单机热游: 'https://www.douyu.com/gapi/rkc/directory/mixListV1/1_15/1',
  手游休闲: 'https://www.douyu.com/gapi/rkc/directory/mixListV1/1_9/1',
  娱乐: 'https://www.douyu.com/gapi/rkc/directory/mixListV1/1_2/1',
})

// 斗鱼网页播放器没有登录时使用的固定设备号。它不是账号凭据，只是匿名设备标识；
// 官方 web-encrypt 脚本也以同一个值作为没有 dy_did cookie 时的 fallback。
export const ANONYMOUS_DID = '10000000000000000000000000001501'
const MOBILE_PLAYER_VERSION = '238110521'
const RESOLVE_TTL_MS = 60 * 1000
const resolveCache = new Map()
const resolvePending = new Map()

export class DouyuError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DouyuError'
  }
}

export class DouyuOfflineError extends DouyuError {
  constructor(message) {
    super(message)
    this.name = 'DouyuOfflineError'
  }
}

function md5(text) {
  return createHash('md5').update(String(text)).digest('hex')
}

export function parseHeat(raw) {
  const text = String(raw || '').replace(/,/g, '').trim()
  const match = /([\d.]+)\s*(亿|万)?/.exec(text)
  if (!match) return 0
  const multiplier = match[2] === '亿' ? 100000000 : match[2] === '万' ? 10000 : 1
  return Math.round(Number(match[1]) * multiplier) || 0
}

export function normalizeRoom(raw) {
  let value = String(raw || '').normalize('NFKC').trim()
  if (!value) throw new DouyuError('斗鱼房间号为空')
  if (/^https?:\/\//i.test(value)) {
    let url
    try { url = new URL(value) } catch { throw new DouyuError(`不是有效的斗鱼直播间地址：${value}`) }
    const host = url.hostname.toLowerCase()
    if (host !== 'douyu.com' && !host.endsWith('.douyu.com')) {
      throw new DouyuError(`不是斗鱼直播间地址：${value}`)
    }
    const queryRoom = url.searchParams.get('rid')
    const pathRoom = url.pathname.split('/').filter(Boolean).reverse().find(part => /^\d+$/.test(part))
    value = queryRoom && /^\d+$/.test(queryRoom) ? queryRoom : (pathRoom || '')
  }
  if (!/^\d{1,12}$/.test(value) || Number(value) <= 0) {
    throw new DouyuError(`斗鱼房间号格式不正确：${value || raw}`)
  }
  return String(Number(value))
}

export function parseRoomList(text) {
  const seen = new Set()
  const rooms = []
  for (const line of String(text || '').split('\n')) {
    const value = line.trim()
    if (!value || value.startsWith('#')) continue
    const room = normalizeRoom(value)
    if (!seen.has(room)) {
      seen.add(room)
      rooms.push(room)
    }
  }
  return rooms
}

async function fetchResponse(url, options = {}) {
  const { timeoutMs = 10000, fetchImpl = fetch, ...request } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      ...request,
      headers: {
        'User-Agent': UA,
        Referer: REFERER,
        Accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
        ...(request.headers || {}),
      },
      redirect: 'follow',
      signal: controller.signal,
    })
    if (!response.ok) throw new DouyuError(`HTTP ${response.status}`)
    return response
  } catch (error) {
    if (error instanceof DouyuError) throw error
    const reason = error?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : (error?.message || String(error))
    throw new DouyuError(reason)
  } finally {
    clearTimeout(timer)
  }
}

export function normalizeCategoryPayload(payload) {
  if (Number(payload?.code) !== 0 || !Array.isArray(payload?.data?.rl)) {
    throw new DouyuError(`斗鱼分类接口异常：${payload?.msg || payload?.code || '缺少房间列表'}`)
  }
  const seen = new Set()
  const rooms = []
  for (const row of payload.data.rl) {
    const rawRoom = row?.rid || row?.room_id
    let roomId
    try { roomId = normalizeRoom(rawRoom) } catch { continue }
    if (seen.has(roomId)) continue
    seen.add(roomId)
    rooms.push({
      roomId,
      name: String(row?.rn || row?.room_name || row?.nn || `斗鱼 ${roomId}`).trim(),
      nick: String(row?.nn || row?.nickname || '').trim(),
      logo: String(row?.rs16 || row?.roomSrc || row?.av || '').replace(/^\/\//, 'https://'),
      heat: Number(row?.ol || 0) || parseHeat(row?.hn),
      category: String(row?.c2name || '').trim(),
    })
  }
  return rooms
}

export async function topRoomsOfArea(areaName, limit, options = {}) {
  const url = AREA_APIS[areaName]
  if (!url) throw new DouyuError(`未知分类「${areaName}」`)
  const response = await fetchResponse(url, options)
  const rooms = normalizeCategoryPayload(await response.json())
  return rooms
    .filter(room => room.heat >= Number(options.minHeat || 0))
    .sort((a, b) => b.heat - a.heat)
    .slice(0, Math.max(0, Number(limit) || 0))
}

function pageContextJson(html) {
  const match = /<script\b[^>]*\bid=(['"])vike_pageContext\1[^>]*>([\s\S]*?)<\/script>/i.exec(String(html || ''))
  if (!match) throw new DouyuError('斗鱼房间页缺少 vike_pageContext')
  try { return JSON.parse(match[2]) } catch (error) {
    throw new DouyuError(`斗鱼房间数据解析失败：${error.message}`)
  }
}

export function parseMobileRoomPage(html, requestedRoom = '') {
  const context = pageContextJson(html)
  const info = context?.pageProps?.room?.roomInfo?.roomInfo
  if (!info || !info.rid) throw new DouyuError(`斗鱼房间 ${requestedRoom || ''} 数据不完整`.trim())
  const roomId = normalizeRoom(info.rid)
  if (Number(info.isLive) !== 1) throw new DouyuOfflineError(`斗鱼房间 ${roomId} 当前未开播`)
  const signerCode = String(context?.crptext || '')
  if (!signerCode.includes('function ub98484234')) {
    throw new DouyuError('斗鱼房间页缺少匿名播放签名函数')
  }
  return {
    roomId,
    name: String(info.roomName || info.nickname || `斗鱼 ${roomId}`).trim(),
    nick: String(info.nickname || '').trim(),
    logo: String(info.roomSrcSixteen || info.roomSrc || info.avatar || '').replace(/^\/\//, 'https://'),
    heat: parseHeat(info.hn),
    signerCode,
  }
}

export async function fetchRoom(roomRef, options = {}) {
  const room = normalizeRoom(roomRef)
  const response = await fetchResponse(`https://m.douyu.com/${room}`, options)
  return parseMobileRoomPage(await response.text(), room)
}

/**
 * 执行移动官网下发的动态签名函数。
 *
 * 斗鱼会轮换 crptext，签名函数本身还会解开几段短代码；把某一版算法硬抄进仓库会
 * 很快失效。这里只在无 Node/网络/文件对象的 vm 上下文里开放 MD5，并给整个编译+
 * 调用设 1 秒硬超时。输出随后按字段白名单校验，远端脚本不能决定请求地址或方法。
 */
export function createMobileSign(signerCode, roomId, did = ANONYMOUS_DID, timestamp = Math.floor(Date.now() / 1000)) {
  const code = String(signerCode || '')
  const room = normalizeRoom(roomId)
  const device = String(did || '')
  const tt = Math.trunc(Number(timestamp))
  if (!code.includes('function ub98484234') || code.length < 100 || code.length > 200000) {
    throw new DouyuError('斗鱼匿名播放签名代码不完整')
  }
  if (!/^\d{32}$/.test(device) || !Number.isSafeInteger(tt) || tt <= 0) {
    throw new DouyuError('斗鱼匿名播放签名参数不合法')
  }

  let signed
  try {
    signed = vm.runInNewContext(
      `${code}\n;ub98484234(${JSON.stringify(room)}, ${JSON.stringify(device)}, ${tt})`,
      { CryptoJS: { MD5: md5 } },
      { timeout: 1000 },
    )
  } catch (error) {
    throw new DouyuError(`斗鱼匿名播放签名失败：${error.message}`)
  }
  const params = new URLSearchParams(String(signed || ''))
  if (!/^\d+$/.test(params.get('v') || '')
      || params.get('did') !== device
      || params.get('tt') !== String(tt)
      || !/^[0-9a-f]{32}$/i.test(params.get('sign') || '')) {
    throw new DouyuError('斗鱼匿名播放签名结果不完整')
  }
  return params
}

export function isOfficialStreamUrl(raw) {
  try {
    const url = new URL(raw)
    const host = url.hostname.toLowerCase()
    return ['douyucdn.cn', 'douyucdn2.cn', 'edgesrv.com']
      .some(domain => host === domain || host.endsWith(`.${domain}`))
      && /\.m3u8$/i.test(url.pathname)
  } catch {
    return false
  }
}

// 流名后缀 → 档位；没有后缀是原画
const STREAM_SUFFIX_TIERS = new Map([['4000', '蓝光4M'], ['2000', '超清'], ['900', '高清']])

function streamSuffix(pathname) {
  return /_(\d+)\.m3u8$/i.exec(String(pathname || ''))?.[1] || ''
}

export function streamTierName(pathname) {
  return STREAM_SUFFIX_TIERS.get(streamSuffix(pathname)) || ''
}

async function resolveFresh(room, ctx) {
  const page = await fetchRoom(room, { timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl })
  const now = Number(ctx.now ?? Date.now())
  const timestamp = Math.floor(now / 1000)
  const signed = createMobileSign(page.signerCode, page.roomId, ANONYMOUS_DID, timestamp)
  signed.set('ver', MOBILE_PLAYER_VERSION)
  signed.set('rid', page.roomId)
  signed.set('rate', String(qualityFrom(ctx, QUALITY_OPTIONS, DEFAULT_QUALITY)))

  const response = await fetchResponse('https://m.douyu.com/hgapi/livenc/room/getStreamUrl', {
    timeoutMs: ctx.timeoutMs,
    fetchImpl: ctx.fetchImpl,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: signed.toString(),
  })
  const payload = await response.json()
  if (Number(payload?.error) !== 0) throw new DouyuError(payload?.msg || `取流错误 ${payload?.error}`)
  const data = payload?.data || {}
  if (data.pass) throw new DouyuError(`斗鱼房间 ${page.roomId} 需要房间密码`)
  const url = new URL(String(data.url || ''))
  if (url.protocol === 'http:') url.protocol = 'https:'
  if (!isOfficialStreamUrl(url.href)) throw new DouyuError('斗鱼返回的 HLS 地址不属于官方 CDN')
  const requested = Number(signed.get('rate'))
  const selected = (Array.isArray(data.settings) ? data.settings : [])
    .find(item => Number(item?.rate) === Number(data.rate))
  // 接口回的 rate 跟着请求走、不可信：未登录要原画也照样回「原画1080P60」，地址却是
  // xxx_2000.m3u8（超清 720P）。档位以地址里的流名后缀为准。
  const actual = streamTierName(url.pathname) || selected?.name || '直播'
  const capped = requested === 0 && STREAM_SUFFIX_TIERS.has(streamSuffix(url.pathname))
  return {
    url: url.href,
    desc: `斗鱼「${page.name}」${actual}地址获取成功${capped ? '（未登录官方最高只给到这一档）' : ''}`,
    relayHls: true,
    upstreamHeaders: { Referer: REFERER, 'User-Agent': UA },
  }
}

export async function resolveRoom(ref, ctx = {}) {
  try {
    const match = /^douyu-(\d{1,12})$/.exec(String(ref || ''))
    if (!match) return { url: '', desc: '斗鱼房间引用格式错误' }
    const room = normalizeRoom(match[1])
    const now = Number(ctx.now ?? Date.now())
    const quality = qualityFrom(ctx, QUALITY_OPTIONS, DEFAULT_QUALITY)
    const key = `${room}:${quality}`
    const cached = resolveCache.get(key)
    if (cached && cached.expiresAt > now) return cached.value

    let pending = resolvePending.get(key)
    if (!pending) {
      pending = resolveFresh(room, ctx)
        .then(value => {
          resolveCache.set(key, { value, expiresAt: now + RESOLVE_TTL_MS })
          return value
        })
        .finally(() => {
          if (resolvePending.get(key) === pending) resolvePending.delete(key)
        })
      resolvePending.set(key, pending)
    }
    return await pending
  } catch (error) {
    return { url: '', desc: error?.message || '斗鱼播放地址获取失败' }
  }
}

export function clearResolveCache() {
  resolveCache.clear()
  resolvePending.clear()
}
