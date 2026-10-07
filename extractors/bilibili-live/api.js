/**
 * 哔哩哔哩直播的平台知识层：房间号归一、三个 API 调用、选流、组频道对象。
 *
 * 这一层刻意只做「输入 → 频道对象」，不碰磁盘、不读全局配置、不写播放列表，
 * 所以可以整层单测。调度、缓存、健康记账都在 utils/extractorManager.js。
 *
 * 由维护者自己早年的本地 Python 脚本 bili-live-m3u 改写而来，不是移植第三方项目；
 * 几处刻意没有照搬旧脚本的做法，理由都写在各自函数上。
 */
import fetch from 'node-fetch'
import { printYellow } from '../../utils/colorOut.js'

const API = 'https://api.live.bilibili.com'
export const REFERER = 'https://live.bilibili.com/'
export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// 画质档位。高清以上要登录态，顶档还要大会员——服务端不会拒绝请求，而是
// 静默降档，所以实际给到哪一档值得报出来（也是判断 cookie 有没有生效的信号）。
const QN_NAMES = {
  30000: '杜比', 20000: '4K', 10000: '原画',
  400: '蓝光', 250: '超清', 150: '高清', 80: '流畅',
}

export const BILIBILI_GROUP = 'B站'

/** 一间房失败。其余房间照常，不影响整张播放列表。 */
export class RoomError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RoomError'
  }
}

/**
 * 房间没在播。
 *
 * 与其它 RoomError 分开：全部房间都没开播是「今天没人播」这个正常状态，
 * 而全部房间都报网络错是「这一轮失败了」。两者都表现为 0 个频道，但前者应当
 * 如实写出空结果，后者必须保留上一轮缓存——不区分就会在断网时把用户的频道清空。
 */
export class RoomOfflineError extends RoomError {
  constructor(message) {
    super(message)
    this.name = 'RoomOfflineError'
  }
}

/**
 * 触发了 B 站风控（code -352）。
 *
 * 必须与 RoomError 区分开：风控不是「这一间房失败」而是「所有房间同时失败」，
 * 但表现出来是一串 skipped，和「所有主播都下播了」长得一模一样。不单独识别的话，
 * 用户看到的是「频道全没了」而没有任何线索。
 */
export class RiskControlError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RiskControlError'
  }
}

/**
 * 私有的 HTTP 取数。刻意不复用 utils/net.js 的 fetchUrl——它恒调 .json()、
 * 失败返回 undefined 而不抛、还会 printRed 刷屏；而这里需要读 HTTP 状态码、
 * 需要按 code 分辨风控、需要把错误结构化交给 health() 展示。
 */
async function apiGet(path, params, { cookie, timeoutMs = 10000, fetchImpl } = {}) {
  const url = `${API}${path}?${new URLSearchParams(params)}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let payload
  try {
    // fetchImpl 只供测试注入：播放时解析的缓存 / 失败记忆逻辑要能离线单测
    const response = await (fetchImpl || fetch)(url, {
      headers: {
        'User-Agent': UA,
        Referer: REFERER,
        Accept: 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      signal: controller.signal,
    })
    if (!response.ok) throw new RoomError(`HTTP ${response.status} from ${path}`)
    payload = await response.json()
  } catch (error) {
    if (error instanceof RoomError) throw error
    // AbortError 的 message 是 'The operation was aborted'，对用户没有信息量
    const reason = error.name === 'AbortError' ? `超时 ${timeoutMs}ms` : error.message
    throw new RoomError(`${path} 请求失败: ${reason}`)
  } finally {
    clearTimeout(timer)
  }

  if (payload?.code !== 0) {
    const message = payload?.message || payload?.code
    if (payload?.code === -352) throw new RiskControlError(`B 站风控 (-352): ${message}`)
    throw new RoomError(`${path}: ${message}`)
  }
  return payload.data || {}
}

/**
 * 房间号归一：纯数字 / 房间 URL / b23.tv 短链 三种写法都认。
 *
 * 与 Python 版的两处差异：
 * 1. 先做全角→半角。Python 的 str.isdigit() 是 Unicode 感知的，「１３」会被当成
 *    房间号发出去（必然失败）；JS 的 /^\d+$/ 只匹配 ASCII，会直接报「不是房间号」。
 *    两种都不好，归一之后两种输入都能用。
 * 2. 短链跟随显式限制跳数并把最终地址写进错误信息，避免跳转环。
 */
/**
 * 热门榜的默认人气下限。低于这个数的房间不进播放列表。
 *
 * 光有「取前 N 名」调不好——比赛多的时候 N 不够，没比赛的时候 N 个全是垃圾；
 * 加了下限之后是自适应的。B 站的人气量级会调整，因此这只是模块默认值，用户可在
 * 后台按自己的分区和时段修改，0 表示不设门槛。
 *
 * 默认 3000 来自 2026-08 的赛事区分布：正常官方赛事约 3000~43000，二路直播和
 * 小型转播多在 1500 以下。它比旧默认 10000 少漏掉 K甲 / PCL / EWC 等真实赛事，
 * 同时仍能挡掉大部分低热度重复机位。
 *
 * 注意：B 站的「人气」不是真实观看人数，历史上做过量级调整。哪天这个门槛显得
 * 不合理了（大量真赛事被挡掉、或垃圾又漏进来），照上面的方法重新量一次分布再定。
 */
export const DEFAULT_MIN_ONLINE = 3000

/**
 * 扫码登录：生成二维码。
 *
 * 为什么要有它：SESSDATA 是 **HttpOnly** cookie，咪咕那种「书签读 document.cookie」
 * 的招在这里读不到。剩下的路只有让用户去 F12 → Application → Cookies 里翻，
 * 对家用 IPTV 的普通用户是道硬门槛。扫码登录把它变成「用 B 站 App 扫一下」。
 *
 * 用 passport 域名，不是 api.live —— 所以不能复用 apiGet（那个写死了 API 常量）。
 *
 * @returns {Promise<{url: string, key: string}>} url 是要编成二维码的内容
 */
export async function qrLoginStart({ timeoutMs = 10000 } = {}) {
  // 先拿一个设备标识（buvid3）。真实浏览器打开 bilibili.com 就会被种上它，
  // generate / poll 全程都带着；而我们原本是两次**裸请求**。
  // 症状正是这么来的：没扫码时轮询一切正常（86101），手机一确认就变 86038
  // 「二维码已失效」—— B 站把这次登录绑在设备标识上，找不到该把会话交给谁。
  const cookie = await fetchBuvidCookie(timeoutMs)
  const payload = await passportGet('/x/passport-login/web/qrcode/generate', {}, timeoutMs, cookie)
  const url = payload?.url
  const key = payload?.qrcode_key
  if (!url || !key) throw new RoomError('二维码生成失败：B 站返回的数据里没有 url/qrcode_key')
  // 把 cookie 跟 key 绑在一起交出去：poll 必须用**同一个**设备标识，
  // 换一个等于换了台设备，B 站照样不认。
  return { url, key, cookie }
}

/**
 * 取一个 buvid3 设备标识。
 * 用官方的指纹接口而不是解 bilibili.com 首页的 Set-Cookie —— 后者是网页副作用，
 * 随时可能变；前者是专门干这个的（返回 b_3 / b_4）。
 * 拿不到就返回空串，让流程继续：至少还能维持改动前的行为，不至于连二维码都出不来。
 */
async function fetchBuvidCookie(timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
      headers: { 'User-Agent': UA, Referer: REFERER, Accept: 'application/json' },
      signal: controller.signal,
    })
    const body = await response.json()
    const b3 = body?.data?.b_3
    const b4 = body?.data?.b_4
    if (!b3) return ''
    return `buvid3=${b3}` + (b4 ? `; buvid4=${b4}` : '')
  } catch {
    printYellow('B 站设备标识获取失败，扫码登录仍会尝试，但成功率可能下降')
    return ''
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 扫码登录：轮询扫码状态。
 *
 * 成功时 SESSDATA **直接在返回的 url 查询参数里**（形如
 * https://passport.biligame.com/crossDomain?DedeUserID=…&SESSDATA=…&bili_jct=…），
 * 不用去解 Set-Cookie —— 省掉一整套 cookie jar 的处理。
 *
 * B 站的状态码：0=成功 / 86101=未扫码 / 86090=已扫码待确认 / 86038=二维码已失效。
 *
 * @returns {Promise<{status:'pending'|'scanned'|'expired'|'ok', message:string, sessdata?:string}>}
 */
export async function qrLoginPoll(key, { timeoutMs = 10000, cookie = '' } = {}) {
  const payload = await passportGet('/x/passport-login/web/qrcode/poll', { qrcode_key: key }, timeoutMs, cookie)
  const code = Number(payload?.code)
  const message = String(payload?.message || '')

  if (code === 86101) return { status: 'pending', message: message || '未扫码' }
  if (code === 86090) {
    printYellow('B 站扫码登录：已扫码，等待手机端确认')
    return { status: 'scanned', message: message || '已扫码，请在手机上确认' }
  }
  if (code === 86038) {
    // 排查用：这一条太容易被当成「用户手慢了」，但它也可能是别的原因——
    // 二维码只活 180 秒；生成与轮询之间若换过出口 IP（比如中途开关代理），
    // B 站也会作废这个 key。日志里留一行，配合前端的倒计时就能分清是哪种。
    printYellow('B 站扫码登录：二维码已失效（有效期 180 秒；若期间切换过网络/代理也会失效）')
    return { status: 'expired', message: message || '二维码已失效，请重新获取' }
  }
  if (code !== 0) {
    // 别把没见过的状态一律说成「已失效」—— 那会掩盖真正的原因（风控、跨地域拒绝、
    // 接口改版…），用户只看到「二维码已失效」，重试多少次都一样，而日志里什么都没有。
    // 原样把 code 和 message 交出去，并落一行日志，让问题可查。
    printYellow(`B 站扫码登录返回未知状态 code=${code} message=${message || '(空)'}`)
    return { status: 'failed', message: `${message || '登录失败'}（B 站状态码 ${code}）` }
  }

  const crossDomainUrl = String(payload?.url || '')
  let sessdata = ''

  // 旧格式：凭据直接在查询参数里（?DedeUserID=…&SESSDATA=…）。
  // 线上实测已经不是这个了，但留着——B 站两种格式都出现过，先试免得多打一次请求。
  try {
    sessdata = new URL(crossDomainUrl).searchParams.get('SESSDATA') || ''
  } catch { /* url 形状不对就走下面的换票 */ }

  // 新格式：给的是一张一次性 ticket，得拿它去 crossDomain 换，SESSDATA 在响应的
  // Set-Cookie 里。实测返回形如
  //   https://passport.biligame.com/x/passport-login/web/crossDomain
  //     ?ticket=…&gourl=https%3A%2F%2Fwww.bilibili.com&first_domain=.bilibili.com
  if (!sessdata && crossDomainUrl) {
    sessdata = await exchangeTicketForSessdata(crossDomainUrl, timeoutMs, cookie)
  }

  if (!sessdata) {
    printYellow(`B 站扫码登录成功但取不到 SESSDATA，返回地址：${crossDomainUrl.slice(0, 200) || '(空)'}`)
    throw new RoomError('登录成功但没能取到 SESSDATA —— B 站可能又改了返回格式，详见服务端日志')
  }
  return { status: 'ok', message: '登录成功', sessdata }
}

/**
 * 拿 ticket 换 SESSDATA。
 *
 * **不跟随重定向**：那个 crossDomain 地址会 302 回 bilibili.com，跟过去就白跑一趟，
 * 而我们要的东西就在这一跳的 Set-Cookie 里。
 * 带上同一个设备标识 —— 整条登录链路 B 站都在按设备核对。
 */
async function exchangeTicketForSessdata(url, timeoutMs, cookie) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      headers: {
        'User-Agent': UA,
        Referer: REFERER,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      signal: controller.signal,
    })
    // node-fetch 用 headers.raw()，标准 fetch 用 getSetCookie()——两边都兼容一下，
    // 免得将来换掉 node-fetch 时这里静默拿不到 cookie。
    const raw = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : (response.headers.raw?.()['set-cookie'] || [])
    for (const line of raw) {
      const m = /(?:^|;\s*)SESSDATA=([^;]+)/.exec(line)
      if (m) return decodeURIComponent(m[1])
    }
    printYellow(`B 站 ticket 换取没返回 SESSDATA，HTTP ${response.status}，Set-Cookie 条数 ${raw.length}`)
    return ''
  } catch (error) {
    printYellow(`B 站 ticket 换取失败：${error.message}`)
    return ''
  } finally {
    clearTimeout(timer)
  }
}

/** passport 域名的取数。与 apiGet 同款错误处理，只是 base 不同。 */
async function passportGet(path, params, timeoutMs, cookie = '') {
  const url = `https://passport.bilibili.com${path}?${new URLSearchParams(params)}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Referer: 'https://www.bilibili.com/',
        Accept: 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      signal: controller.signal,
    })
    if (!response.ok) throw new RoomError(`HTTP ${response.status} from ${path}`)
    const body = await response.json()
    if (body?.code !== 0) throw new RoomError(`${path}: ${body?.message || body?.code}`)
    return body.data || {}
  } catch (error) {
    if (error instanceof RoomError) throw error
    const reason = error.name === 'AbortError' ? `超时 ${timeoutMs}ms` : error.message
    throw new RoomError(`${path} 请求失败: ${reason}`)
  } finally {
    clearTimeout(timer)
  }
}

export const SESSDATA_REJECTED_NOTICE = 'B 站不认当前 SESSDATA（已过期或已退出登录），直播画质已自动降到「超清」；请在后台重新扫码登录'

/**
 * 刷新时用登录态问一次 B 站「当前是谁」（/x/web-interface/nav）。登录态失效时 B 站照样给流、
 * 只是画质封顶超清，播放时分不出来，不查的话用户根本察觉不到。乱填、过期的 SESSDATA
 * 实测都回 code -101「账号未登录」、isLogin false（2026-10-06）。
 * 返回 { rejected } / { warning } / {}；网络失败只算检查没做完，不冤枉登录态。
 */
export async function checkLogin(cookie, { timeoutMs = 10000, fetchImpl } = {}) {
  if (!cookie) return {}
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await (fetchImpl || fetch)('https://api.bilibili.com/x/web-interface/nav', {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Accept: 'application/json', Cookie: cookie },
      signal: controller.signal,
    })
    if (!response.ok) { await response.body?.cancel?.().catch(() => {}); return { warning: `B 站登录态检查没有完成：HTTP ${response.status}` } }
    const body = await response.json()
    if (body?.code === -101 || (body?.code === 0 && body?.data?.isLogin === false)) return { rejected: SESSDATA_REJECTED_NOTICE }
    if (body?.code === 0) return {}
    return { warning: `B 站登录态检查没有完成：${body?.message || body?.code}` }
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : (error?.message || String(error))
    return { warning: `B 站登录态检查没有完成：${reason}` }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * B 站的直播大区清单（网游 / 手游 / 单机游戏 / 娱乐 / 电台 / 虚拟主播 / 聊天室 / 生活）。
 *
 * 动态拉而不是把 8 个 id 写死：B 站增删过大区，写死的话表现是「用户填的分区名突然
 * 匹配不上、热门榜静默变空」。一次抓取只多一个请求，不值得为此冒僵化的风险。
 *
 * @returns {Promise<Array<{id:number,name:string}>>}
 */
export async function areaList(options) {
  const data = await apiGet('/room/v1/Area/getList', {}, options)
  const list = Array.isArray(data) ? data : []
  return list
    .filter(area => area && area.id != null && area.name)
    .map(area => ({ id: Number(area.id), name: String(area.name).trim() }))
}

/**
 * 某个大区按人气排的前 N 个直播间。
 *
 * 用**老接口** /room/v1/Area/getRoomList：新版的
 * /xlive/web-interface/v1/second/getList 需要 WBI 签名（不签就回 -352），
 * 那意味着要实现并长期维护 B 站一套没文档、会变的签名算法——对这个项目太重了。
 * 老接口同样按 sort_type=online 排序，够用。
 *
 * 大型赛事天然排在最前：实测网游大区前 5 里 4 个是赛事直播（TI 决赛、CS2、无畏契约
 * 总决赛），因为百万级人气碾压普通主播。所以不需要专门的赛事接口。
 *
 * 人气低于 MIN_ONLINE 的一律不要，见那个常量的注释。
 *
 * @returns {Promise<number[]>} 房间号，按人气从高到低
 */
export async function topRoomsOfArea(parentAreaId, count, options) {
  const data = await apiGet('/room/v1/Area/getRoomList', {
    platform: 'web',
    parent_area_id: parentAreaId,
    area_id: 0,
    sort_type: 'online',
    page: 1,
    // 多要一些再截断：未开播/异常的房间在后面 resolveRoom 时会被跳过，
    // 只要正好 count 个的话，跳掉几个就不够数了
    page_size: Math.min(count * 2, 50),
  }, options)
  return selectTopRooms(data, count, options?.minOnline)
}

/**
 * 热门榜原始条目 → 房间号数组。滤掉人气低于配置门槛的，再截到 count 个。
 *
 * 抽成纯函数是为了能被测试直接打：过滤那一行删掉之后**不会有任何东西变红**，
 * 只是播放列表里悄悄多出一堆「王者荣耀赛事第一视角7」这种同场比赛的小号机位。
 *
 * @param {Array} rawList 接口返回的 data
 * @param {number} count      上限（不是保证——够格的不足这么多就给这么多）
 * @param {number} minOnline  最低人气，0 表示不过滤
 */
export function selectTopRooms(rawList, count, minOnline = DEFAULT_MIN_ONLINE) {
  const list = Array.isArray(rawList) ? rawList : []
  const parsedMin = Number(minOnline)
  const threshold = Number.isFinite(parsedMin) ? Math.max(0, parsedMin) : DEFAULT_MIN_ONLINE
  return list
    .filter(room => Number(room?.online) >= threshold)
    .map(room => Number(room?.roomid))
    .filter(id => Number.isInteger(id) && id > 0)
    .slice(0, Math.max(0, Number(count) || 0))
}

export async function normalizeRoom(rawToken, { timeoutMs = 10000 } = {}) {
  const token = toHalfWidth(String(rawToken || '').trim())
  if (!token) throw new RoomError('空的房间标识')

  if (/^\d+$/.test(token)) return token

  const direct = token.match(/live\.bilibili\.com\/(?:h5\/)?(\d+)/)
  if (direct) return direct[1]

  if (token.includes('b23.tv/') || token.includes('bili2233.cn/')) {
    const url = token.startsWith('http') ? token : `https://${token}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let finalUrl
    try {
      // follow=默认跟随；node-fetch 的 res.url 给出最终地址，等价于 Python 的 geturl()
      const response = await fetch(url, {
        headers: { 'User-Agent': UA },
        redirect: 'follow',
        follow: 5,
        signal: controller.signal,
      })
      finalUrl = response.url
    } catch (error) {
      throw new RoomError(`短链跟随失败 ${token}: ${error.message}`)
    } finally {
      clearTimeout(timer)
    }
    const resolved = String(finalUrl || '').match(/live\.bilibili\.com\/(?:h5\/)?(\d+)/)
    if (resolved) return resolved[1]
    throw new RoomError(`${token} 不指向直播间 (-> ${finalUrl})`)
  }

  throw new RoomError(`不是房间号或直播间地址: ${token}`)
}

/** 全角数字/字母 → 半角。用户从手机复制过来常带全角。 */
function toHalfWidth(text) {
  return text.replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
}

/**
 * 房间基本信息。room_id 统一转成字符串——API 返回的是数字，而归一出来的是
 * 字符串，混用会让后面拿它当 Map key 或做 === 比较时踩到类型不一致。
 */
export async function roomInfo(roomId, options) {
  const data = await apiGet('/room/v1/Room/get_info', { room_id: roomId }, options)
  return {
    // 短号会解析到真实房间号，一律以 API 返回的为准
    roomId: String(data.room_id || roomId),
    uid: data.uid,
    title: (data.title || '').trim(),
    live: data.live_status === 1,
    area: (data.parent_area_name || data.area_name || '').trim(),
  }
}

/** 主播名与头像。纯装饰，失败不能连累整间房。 */
export async function anchorInfo(uid, options) {
  try {
    const data = await apiGet('/live_user/v1/Master/info', { uid }, options)
    const info = data.info || {}
    return { name: (info.uname || '').trim(), avatar: (info.face || '').trim() }
  } catch (error) {
    // 风控要往上抛：它不是「这条装饰信息拿不到」，而是整轮都会失败的信号
    if (error instanceof RiskControlError) throw error
    return { name: '', avatar: '', warning: `主播信息获取失败: ${error.message}` }
  }
}

/**
 * 从 protocol/format/codec 三层矩阵里挑一条能播的地址。
 *
 * 与 Python 版的差异：codec 层加了 avc 优先。请求里带的是 codec="0,1"，
 * 返回顺序由 B 站决定，Python 版直接取第一个，于是可能拿到一条部分播放器
 * （尤其电视盒子）解不了的 HEVC 流，而且取到哪个取决于当天的返回顺序——
 * 是不确定的行为。这里显式排序，默认 avc。
 */
export async function pickStream(roomId, { preferHls = true, preferAvc = true, ...options } = {}) {
  const data = await apiGet('/xlive/web-room/v2/index/getRoomPlayInfo', {
    room_id: roomId,
    protocol: '0,1',   // 0 = http_stream (flv), 1 = http_hls
    format: '0,1,2',   // flv / ts / fmp4
    codec: '0,1',      // avc / hevc
    qn: 10000,         // 原画；房间自己会封顶
    platform: 'web',
    ptype: 8,
  }, options)

  return selectFromPlayurl(data, { preferHls, preferAvc })
}

/**
 * 从 getRoomPlayInfo 的返回里挑地址。纯函数——抽出来是为了能单测选流偏好，
 * 这是整个模块里最容易静默选错、又最难在真实环境复现的一段。
 */
export function selectFromPlayurl(data, { preferHls = true, preferAvc = true } = {}) {
  const streams = data?.playurl_info?.playurl?.stream || []
  if (!streams.length) throw new RoomError('playurl 里没有 stream（未开播或地区限制）')

  const wantProtocol = preferHls ? 'http_hls' : 'http_stream'
  const wantCodec = preferAvc ? 'avc' : 'hevc'
  const byName = (want) => (a, b) =>
    (a === want ? 0 : 1) - (b === want ? 0 : 1)

  const sortedStreams = [...streams].sort((a, b) =>
    byName(wantProtocol)(a.protocol_name, b.protocol_name))

  for (const stream of sortedStreams) {
    for (const format of stream.format || []) {
      const codecs = [...(format.codec || [])].sort((a, b) =>
        byName(wantCodec)(a.codec_name, b.codec_name))
      for (const codec of codecs) {
        const base = codec.base_url || ''
        for (const hostInfo of codec.url_info || []) {
          const host = hostInfo.host || ''
          const extra = hostInfo.extra || ''
          // 必须是裸字符串相加：extra 里那段带 expires token 的 query
          // 一旦经过 new URL() 或 url.resolve() 就会被丢掉或重新编码，地址直接失效
          if (host && base) return { url: `${host}${base}${extra}`, qn: codec.current_qn }
        }
      }
    }
  }

  throw new RoomError('playurl 里没有可用的 host/base_url')
}

/**
 * 抓取时把一间房整理成一个频道对象。
 *
 * 返回的对象形状必须与 externalSources/builtInSources 的 getValidChannels()
 * 同构，才能被 channelMerger 原样吞下（见 utils/channelMerger.js 的合并逻辑）。
 *
 * 频道**不带播放地址**：B 站的签名地址实测只有 60 分钟有效（不是早先以为的约 2 小时），
 * 写进播放列表的话，播放器不重拉列表就只能拿到死链——多数电视端播放器几小时甚至
 * 一天才重拉一次，正在播的流也会在签名到期那一刻被 403 掐断（issue #120）。
 * 所以这里只落 deferredRef，播放请求到达时再由下面的 resolveRoom 现换地址，并由
 * 本机中继清单（relayHls），与虎牙 / 斗鱼同款。
 *
 * 仍然调一次 getRoomPlayInfo：一是拿实际给到的画质档写进频道名（也是判断
 * SESSDATA 有没有生效的唯一信号），二是把地区限制等没有可播流的房间在抓取时
 * 就剔掉，而不是留一条到播放时才失败的频道。请求量与直链时代持平。
 */
export async function fetchRoom(roomRef, options = {}) {
  const { cookie, preferAvc = true, timeoutMs, fetchImpl } = options
  const netOptions = { cookie, timeoutMs, fetchImpl }

  const roomId = await normalizeRoom(roomRef, netOptions)
  const info = await roomInfo(roomId, netOptions)
  if (!info.live) throw new RoomOfflineError('未开播')

  const { qn } = await pickStream(info.roomId, { preferHls: true, preferAvc, ...netOptions })
  const anchor = info.uid
    ? await anchorInfo(info.uid, netOptions)
    : { name: '', avatar: '' }

  const displayName = anchor.name || `房间 ${info.roomId}`
  const tier = QN_NAMES[qn] || (qn ? String(qn) : '?')
  const name = `[${tier}] ` + (info.title ? `${displayName} · ${info.title}` : displayName)

  return {
    channel: {
      name: sanitizeText(name),
      logo: anchor.avatar || '',
      deferredRef: refOf(info.roomId),
      // 防盗链请求头由本机中继清单时发送，不再靠 #EXTVLCOPT 下发给播放器：
      // 不认 EXTVLCOPT 的播放器（LunaTV 等）也能播，TXT / TVBox 订阅也不再整条跳过。
      // 实测 HLS 清单与分片本身不校验 UA / Referer，分片由播放器直连 CDN 没有问题。
      relayHls: true,
      groupTitle: BILIBILI_GROUP,
    },
    group: BILIBILI_GROUP,
    warning: anchor.warning,
    // 归一后的真实房间号。mergeRoomRefs 的去重键是用户填的字面量（URL / 短号 /
    // 短链各长各样），同一间房换个写法就绕过去了——外层要按这个再去一次重。
    roomId: String(info.roomId),
  }
}

// ---- 播放时解析 ----

// deferredRef 形如 bili-<房间号>。必须是单个路径段：写盘落成 ${replace}/relay/<ref>.m3u8，
// playlistConfig.buildChannelId 取它当频道主键，多段会失配、让「我的频道」配置作废。
const REF_RE = /^bili-(\d{1,16})$/

function refOf(roomId) {
  return `bili-${roomId}`
}

/** 播放请求靠它路由到本模块（见 registry.resolverFor）。 */
export function claimsRef(ref) {
  return REF_RE.test(String(ref || ''))
}

// 签名地址 60 分钟有效，但缓存只留 60 秒：播放器每几秒轮询一次清单，缓存挡住的是
// 这种密集轮询，而不是为了把一份地址用满一小时——主播重开播 / 切流后旧地址会失效，
// 缓存越长恢复越慢。与虎牙 / 斗鱼同款取值。
const RESOLVE_TTL_MS = 60 * 1000
// 失败也要短暂记住：播放器失败后是 100ms 级别的连环重试，逐次打到 B 站接口等于
// 主动招风控。风控（-352）本身记久一点，连续撞它只会延长被封的时间。
const RESOLVE_FAIL_TTL_MS = 15 * 1000
const RESOLVE_RISK_TTL_MS = 60 * 1000

const resolveCache = new Map()
const resolvePending = new Map()

async function resolveFresh(roomId, options) {
  const { url, qn } = await pickStream(roomId, { preferHls: true, ...options })
  const tier = QN_NAMES[qn] || (qn ? String(qn) : '?')
  return {
    url,
    desc: `B 站直播间 ${roomId}（${tier}）地址获取成功`,
    relayHls: true,
    upstreamHeaders: { Referer: REFERER, 'User-Agent': UA },
  }
}

/**
 * 播放时解析：deferredRef → 当前有效的签名地址。
 *
 * 模块契约要求**绝不抛异常**（app.js 的请求 handler 没有顶层 try）；失败一律返回
 * url 为空串 + 给客户端看的 desc。
 *
 * @param {string} ref  bili-<房间号>
 * @param {object} ctx  { config, now?, timeoutMs?, fetchImpl? }  config 是模块生效配置
 */
export async function resolveRoom(ref, ctx = {}) {
  try {
    const match = REF_RE.exec(String(ref || ''))
    if (!match) return { url: '', desc: 'B 站直播间引用格式错误' }
    const roomId = match[1]
    const config = ctx.config || {}
    const cookie = config.sessdata ? `SESSDATA=${config.sessdata}` : ''
    const preferAvc = config.preferAvc !== false
    const now = Number(ctx.now ?? Date.now())
    // 登录态与编码偏好都会改变 B 站给的地址，各自缓存。SESSDATA 换了值会经
    // updateModuleConfig → clearResolveCache 清掉，这里不必把凭据本身放进键里。
    const key = `${roomId}:${preferAvc ? 'avc' : 'hevc'}:${cookie ? 'login' : 'anon'}`

    const cached = resolveCache.get(key)
    if (cached && cached.expiresAt > now) return cached.value

    let pending = resolvePending.get(key)
    if (!pending) {
      pending = resolveFresh(roomId, { cookie, preferAvc, timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl })
        .then(
          value => {
            resolveCache.set(key, { value, expiresAt: now + RESOLVE_TTL_MS })
            return value
          },
          error => {
            const risk = error instanceof RiskControlError
            const value = {
              url: '',
              desc: risk ? error.message : `B 站直播间 ${roomId} 地址获取失败：${error?.message || error}`,
            }
            resolveCache.set(key, { value, expiresAt: now + (risk ? RESOLVE_RISK_TTL_MS : RESOLVE_FAIL_TTL_MS) })
            return value
          },
        )
        .finally(() => {
          if (resolvePending.get(key) === pending) resolvePending.delete(key)
        })
      resolvePending.set(key, pending)
    }
    return await pending
  } catch (error) {
    return { url: '', desc: error?.message || 'B 站播放地址获取失败' }
  }
}

/** 画质 / 登录态等配置变更后由 extractorManager 与 appUtils.clearUrlCache 触发。 */
export function clearResolveCache() {
  resolveCache.clear()
  resolvePending.clear()
}

/**
 * 频道名/分组名去掉换行与引号，英文逗号换全角。
 *
 * 引号换成单引号是因为 EXTINF 的属性值是双引号包裹的（见 updateData.js 的
 * tvg-id="${channelItem.name}"）——一个裸双引号会把整行语法撑坏，
 * 这与 utils/externalSources.js:11-18 处理 issue #84 时的顾虑是同一个。
 * 逗号同理：回读端按「第一个逗号」切频道名（playlistConfig.js 的 /,(.+)$/），
 * 主播标题里一个 ASCII 逗号（如 "Day2,小组赛"）会把 tvg 属性从中间切开、
 * 频道名变成带引号残渣的垃圾串。
 */
function sanitizeText(text) {
  return String(text || '').replace(/[\r\n]+/g, ' ').replace(/"/g, "'").replace(/,/g, '，').trim()
}

/**
 * 解析房间清单文本：一行一个，`#` 之后是注释。
 *
 * 与 Python 版差异：只有当这一行不像 URL 时才按 `#` 剥注释。Python 版无条件
 * 按 `#` 切，会把带 fragment 的地址截断；而 B 站分享链接确实可能带 `#`。
 */
export function parseRoomList(text) {
  const rooms = []
  for (const raw of String(text || '').split('\n')) {
    let line = raw.trim()
    if (!line || line.startsWith('#')) continue
    // 形如 `13   # 备注`：URL 之外的写法才剥行尾注释
    if (!/^https?:\/\//i.test(line)) {
      line = line.split('#')[0].trim()
    } else {
      // URL 后面跟注释的写法：`https://... # 备注`——按空白切，fragment 得以保留
      line = line.split(/\s+/)[0]
    }
    if (line) rooms.push(line)
  }
  return rooms
}

/**
 * 有上限的并发映射。
 *
 * 不用 Promise.all 全量并发：B 站对短时间大量请求会回 -352 风控，而外部源那边
 * 「串行 + 每个之间硬睡 2 秒」又太慢（房间一多就是分钟级）。折中成小并发。
 */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

export { QN_NAMES }
