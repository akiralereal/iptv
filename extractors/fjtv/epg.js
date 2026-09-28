/**
 * 福建官方节目单：省级频道走福建网络广播电视台云直播平台，厦门走看厦门接口。
 *
 * 省级（mapi-plus.fjtv.net/cloudlive-manage-mapi）：官网云直播 H5 的节目单组件先用
 * api/topic/business 换出平台 app_secret（company_id 468 加官网 getSigntrue 时间戳签名，
 * 匿名可取，所有频道同一个），再按 topic_id（就是取流用的省级频道 id）和日期
 * 「YYYY-M-D」取 api/topic/program/list。缺 app_secret 回「签名错误1」，错的回「客户信息不存在」，
 * HTTP 都是 200。star_time_timestamp / end_time_timestamp 是 unix 秒。过去的日子至少留一个月；
 * 次日的节目单前一天傍晚（约 18 点）才录入，之前、以及没有节目单的频道和不认识的 topic，
 * 都回 24 条整点「精彩节目」占位，一律丢掉。东南卫视一直只有占位，不列（见 channels.js）。
 * 讯飞 WAF 对「浏览器 UA + Node TLS 指纹」回 403，与取流一样用 Node 自己的 UA。
 *
 * 厦门（mapi1.kxm.xmtv.cn/api/v1/program.php）：与取流同一台接口机，不用签名。按 channel_id
 * 回一天的节目；日期参数不认，只认 zone=相对服务器今天的天数（-1 昨天、1 明天），往后排好了
 * 约一周。每条带 dates，拿它核对取到的正是所要那天。start_time 是 unix 秒；end_time 只有今天
 * 那天是对的（别的日子套用今天的日期），结束按 start_time + toff（秒）算。厦视三套只有占位，不列。
 *
 * 福州（app.zohi.tv/video/player/playbill?stream_id=<id>&site_id=10001）：福视悦动官网播放器
 * 自己用的节目单，不用签名、不挑来源头。只给今天（外加次日零点那一条），不认日期参数；
 * starttime / endtime 是 unix 秒。只列台里的自办栏目，中间大段空白：综合一天约 10 条、生活约 7 条，
 * 聊胜于无——现在没有内置外部源，不出就是什么都没有；少儿一天只有一条，不出。福州三路是直链频道，
 * 没有 ref，流水线按模块内频道名对上。
 *
 * 海博地市九路没有可用的官方节目单：里面全是占位。
 *
 * 省级数据是播出串联单的粒度（少儿频道一天上百条），宣传片、片头、不到一分钟的碎片按
 * fillerReason() 丢掉，留下的空档 XMLTV 允许。
 *
 * 和取流链路没有共享状态：只用 channels.js 的频道表和调用方注入的 fetch，
 * 不 import 项目里的其它模块——连同 channels.js 拿出去就能单独产出节目单。
 */
import { createHash } from 'node:crypto'
import { FUZHOU_CHANNELS, PROVINCE_CHANNELS, XIAMEN_CHANNELS } from './channels.js'

export const CLOUDLIVE_API = 'https://mapi-plus.fjtv.net/cloudlive-manage-mapi'
export const BUSINESS_URL = `${CLOUDLIVE_API}/api/topic/business`
export const PROVINCE_EPG_URL = `${CLOUDLIVE_API}/api/topic/program/list`
export const XIAMEN_EPG_URL = 'https://mapi1.kxm.xmtv.cn/api/v1/program.php'
export const FUZHOU_EPG_URL = 'https://app.zohi.tv/video/player/playbill'

const COMPANY_ID = '468'
const PROVINCE_UA = 'node'
const XIAMEN_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const XIAMEN_REFERER = 'https://www.xmtv.cn/'
// 省级少儿频道一天约 60 KB，厦门一天约 25 KB
const MAX_BYTES = 1024 * 1024
// app_secret 是平台对 company 的固定配置，一轮更新内复用；接口说它不对时换一次
const SECRET_TTL_MS = 60 * 60 * 1000
// 平台说 app_secret 不对的错误码：10001 签名错误、10002 客户信息不存在
const SECRET_REJECTED = new Set([10001, 10002])
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
// 实测往回至少一个月、往后约一周；直播只用得上今天、明天
const MAX_DAYS_BACK = 30
const MAX_DAYS_AHEAD = 7

const KEY_RE = /^(province):(\d{18})$|^(xiamen):(\d{1,4})$|^(fuzhou):(\d{1,6})$/
const FUZHOU_REFERER = 'https://www.zohi.tv/'

const PLACEHOLDER_TITLE = '精彩节目'
// 不到 1 分钟的不算节目：15 秒片头、30 秒总宣、零点切下的碎片
const MIN_PROGRAMME_MS = 60 * 1000
// 只在 10 分钟以内时丢：宣传片、总宣、宣广、片头片尾、预告、公益广告（与浙江的串联单规则一致）
const FILLER_SHORT = /宣传|总宣|宣广|片头|片尾|预告|公益/
const FILLER_SHORT_MAX_MS = 10 * 60 * 1000

/** 串联单里的非节目条目返回原因，正经节目返回空串。 */
export function fillerReason(title, durationMs) {
  if (title === PLACEHOLDER_TITLE) return 'placeholder'
  if (durationMs < MIN_PROGRAMME_MS) return 'short'
  if (durationMs <= FILLER_SHORT_MAX_MS && FILLER_SHORT.test(title)) return 'promo'
  return ''
}

const md5 = text => createHash('md5').update(text, 'utf8').digest('hex')

/**
 * 官网 getSigntrue：md5(company_id + 10 位秒级时间戳)，再把时间戳按两位一组
 * 依次盖到第 0、7、14、21、30 位上，长度仍是 32。
 */
export function companySignature(companyId = COMPANY_ID, now = Date.now()) {
  const timestamp = String(Math.round(Number(now) / 1000))
  if (!/^\d{10}$/.test(timestamp)) throw new Error('福建节目单签名时间无效')
  const chars = md5(`${companyId}${timestamp}`).split('')
  ;[0, 7, 14, 21, 30].forEach((at, index) => chars.splice(at, 2, timestamp[index * 2], timestamp[index * 2 + 1]))
  return chars.join('')
}

/** 上海日期 YYYYMMDD → { start, end, iso: 'YYYY-MM-DD', loose: 'YYYY-M-D' }；与运行机器的时区无关，非法日期返回 null。 */
export function shanghaiDay(day) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(day))
  if (!match) return null
  const [year, month, date] = match.slice(1).map(Number)
  const utc = Date.UTC(year, month - 1, date)
  const check = new Date(utc)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) return null
  const start = utc - SHANGHAI_OFFSET_MS
  return {
    start,
    end: start + DAY_MS,
    iso: `${match[1]}-${match[2]}-${match[3]}`,
    loose: `${year}-${month}-${date}`,
  }
}

/** 上海日期 YYYYMMDD 相对今天（上海）差几天；明天为 1、昨天为 -1。 */
function offsetFromToday(day, now) {
  const today = new Date(Number(now) + SHANGHAI_OFFSET_MS)
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  return Math.round((shanghaiDay(day).start + SHANGHAI_OFFSET_MS - todayUtc) / DAY_MS)
}

const cleanTitle = value => String(value ?? '').replace(/\s+/g, ' ').trim()

/** 只留开始时间落在那天的，丢占位与串联包装，按开始时间排好；同一时刻只留一条，叠进下一条的截到下一条开始。 */
function finish(items, range) {
  const kept = items
    .filter(item => item.title && Number.isSafeInteger(item.start) && Number.isSafeInteger(item.stop) && item.stop > item.start)
    .filter(item => item.start >= range.start && item.start < range.end)
    .filter(item => !fillerReason(item.title, item.stop - item.start))
    .sort((a, b) => a.start - b.start)
  const programmes = []
  for (const item of kept) {
    const previous = programmes.at(-1)
    if (previous?.start === item.start) continue
    if (previous && previous.stop > item.start) previous.stop = item.start
    programmes.push({ title: item.title, start: item.start, stop: item.stop })
  }
  return programmes
}

/** 省级 api/topic/program/list 的一天 → [{ title, start, stop }]（毫秒）。平台拒绝时抛带 code 的错。 */
export function parseProvinceProgrammes(payload, day) {
  const range = shanghaiDay(day)
  if (!range) throw new Error('福建节目单参数非法')
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('福建节目单返回结构不符合预期')
  if (Number(payload.error_code) !== 200) {
    const error = new Error(`福建节目单接口拒绝：${payload.error_message || payload.error_code}`)
    error.code = Number(payload.error_code)
    throw error
  }
  if (!Array.isArray(payload.result)) throw new Error('福建节目单返回结构不符合预期')
  const items = payload.result.map(row => ({
    title: cleanTitle(row?.title),
    start: Number(row?.star_time_timestamp ?? row?.start_time_timestamp) * 1000,
    stop: Number(row?.end_time_timestamp) * 1000,
  }))
  const real = items.filter(item => item.title && item.title !== PLACEHOLDER_TITLE)
  const programmes = finish(items, range)
  // 有真节目却一条时间都解不出来，多半是字段改了，报错比静默空着好查
  if (real.length && !real.some(item => Number.isSafeInteger(item.start) && Number.isSafeInteger(item.stop) && item.stop > item.start)) {
    throw new Error('福建节目单时间格式异常')
  }
  return programmes
}

/**
 * 厦门 program.php 的一天 → { programmes, dates }。dates 是响应里出现的日期，
 * 供调用方发现服务器的「今天」和本机算的不一致（零点前后）。
 */
export function parseXiamenProgrammes(payload, day) {
  const range = shanghaiDay(day)
  if (!range) throw new Error('厦门节目单参数非法')
  // 不认识的 channel_id 回空数组
  if (!Array.isArray(payload)) throw new Error('厦门节目单返回结构不符合预期')
  const dates = new Set(payload.map(row => String(row?.dates ?? '').trim()).filter(Boolean))
  const rows = payload.filter(row => String(row?.dates ?? '').trim() === range.iso)
  // end_time 只有今天是对的，别的日子沿用今天的日期；结束时间按开始加时长（toff，秒）算
  const items = rows.map(row => {
    const start = Number(row?.start_time) * 1000
    const duration = Number(row?.toff) * 1000
    return {
      title: cleanTitle(row?.theme),
      start,
      stop: duration > 0 && duration <= DAY_MS ? start + duration : NaN,
    }
  })
  const real = items.filter(item => item.title && item.title !== PLACEHOLDER_TITLE)
  const programmes = finish(items, range)
  if (real.length && !real.some(item => Number.isSafeInteger(item.start) && Number.isSafeInteger(item.stop) && item.stop > item.start)) {
    throw new Error('厦门节目单时间格式异常')
  }
  return { programmes, dates: [...dates] }
}

/** 福州 playbill → [{ title, start, stop }]（毫秒）；只留开始时间落在那天的，次日零点那条丢掉。 */
export function parseFuzhouProgrammes(payload, day) {
  const range = shanghaiDay(day)
  if (!range) throw new Error('福州节目单参数非法')
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('福州节目单返回结构不符合预期')
  if (payload.state !== true) throw new Error(`福州节目单接口拒绝：${payload.error || '未知原因'}`)
  if (!Array.isArray(payload.data)) throw new Error('福州节目单返回结构不符合预期')
  const items = payload.data
    .filter(row => String(row?.disable ?? '0') === '0')
    .map(row => ({
      title: cleanTitle(row?.name),
      start: Number(row?.starttime) * 1000,
      stop: Number(row?.endtime) * 1000,
    }))
  const programmes = finish(items, range)
  if (items.some(item => item.title) && !items.some(item => Number.isSafeInteger(item.start) && Number.isSafeInteger(item.stop) && item.stop > item.start)) {
    throw new Error('福州节目单时间格式异常')
  }
  return programmes
}

async function readCapped(response, label) {
  if (Number(response.headers?.get?.('content-length') || 0) > MAX_BYTES) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error(`${label}响应过大`)
  }
  const reader = response.body?.getReader?.()
  if (!reader) {
    const buf = Buffer.from(await response.arrayBuffer())
    if (buf.length > MAX_BYTES) throw new Error(`${label}响应过大`)
    return buf.toString('utf8')
  }
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => {})
      throw new Error(`${label}响应过大`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** GET 并读 JSON；非 2xx（含不跟随的跳转、WAF 的 403 页）直接抛。 */
async function fetchJson(fetchImpl, url, headers, timeoutMs, label) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { headers, redirect: 'manual', signal: controller.signal })
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {})
      throw new Error(`${label} HTTP ${response.status}`)
    }
    const text = await readCapped(response, label)
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`${label}返回的不是 JSON`)
    }
  } finally {
    clearTimeout(timer)
  }
}

const provinceHeaders = () => ({ 'User-Agent': PROVINCE_UA, Accept: 'application/json, text/plain, */*' })

let secretCache = null
let secretPending = null

/** 换平台 app_secret：同一时刻只换一次，并发的频道共用。 */
async function appSecret(topicId, { fetchImpl, timeoutMs, now }) {
  if (secretCache?.expiresAt > now) return secretCache.value
  secretPending ??= (async () => {
    const url = new URL(BUSINESS_URL)
    url.search = new URLSearchParams({
      topic_id: topicId, preview: '', company_id: COMPANY_ID, signature: companySignature(COMPANY_ID, now), debug: '1',
    })
    const payload = await fetchJson(fetchImpl, url.href, provinceHeaders(), timeoutMs, '福建节目单鉴权')
    const result = payload?.result
    if (Number(payload?.error_code) !== 200 || !result || Array.isArray(result)
        || !/^[0-9a-f]{32}$/i.test(String(result.app_secret || ''))) {
      throw new Error(`福建节目单鉴权返回异常：${payload?.error_message || '没有 app_secret'}`)
    }
    const value = {
      app_secret: String(result.app_secret),
      tenant_id: String(result.tenant_id ?? '0'),
      company_id: String(result.company_id || COMPANY_ID),
    }
    secretCache = { value, expiresAt: now + SECRET_TTL_MS }
    return value
  })().finally(() => { secretPending = null })
  return secretPending
}

async function provinceProgrammes(topicId, day, { fetchImpl, timeoutMs, now }) {
  const range = shanghaiDay(day)
  const get = async secret => {
    const url = new URL(PROVINCE_EPG_URL)
    url.search = new URLSearchParams({ topic_id: topicId, date: range.loose, ...secret })
    return parseProvinceProgrammes(await fetchJson(fetchImpl, url.href, provinceHeaders(), timeoutMs, '福建节目单'), day)
  }
  const secret = await appSecret(topicId, { fetchImpl, timeoutMs, now })
  try {
    return await get(secret)
  } catch (error) {
    if (!SECRET_REJECTED.has(error?.code)) throw error
    // 平台换了 app_secret：丢掉缓存重换一次（别清掉并发请求刚换来的新值）
    if (secretCache?.value === secret) secretCache = null
    return get(await appSecret(topicId, { fetchImpl, timeoutMs, now }))
  }
}

async function xiamenProgrammes(channelId, day, { fetchImpl, timeoutMs, now }) {
  const get = async zone => {
    const url = new URL(XIAMEN_EPG_URL)
    url.search = new URLSearchParams({ channel_id: channelId, zone: String(zone) })
    const headers = { 'User-Agent': XIAMEN_UA, Referer: XIAMEN_REFERER, Accept: 'application/json, text/plain, */*' }
    return parseXiamenProgrammes(await fetchJson(fetchImpl, url.href, headers, timeoutMs, '厦门节目单'), day)
  }
  const zone = offsetFromToday(day, now)
  const first = await get(zone)
  // 零点前后本机与服务器的「今天」差一天：响应整天都是另一天时按它校正一次
  if (first.programmes.length || first.dates.length !== 1) return first.programmes
  const served = shanghaiDay(first.dates[0].replaceAll('-', ''))
  if (!served) return []
  const drift = Math.round((shanghaiDay(day).start - served.start) / DAY_MS)
  if (!drift || Math.abs(drift) > 1) return []
  return (await get(zone + drift)).programmes
}

async function fuzhouProgrammes(streamId, day, { fetchImpl, timeoutMs, now }) {
  // 接口只给今天
  if (offsetFromToday(day, now) !== 0) return []
  const url = new URL(FUZHOU_EPG_URL)
  url.search = new URLSearchParams({ stream_id: streamId, site_id: '10001' })
  const headers = { 'User-Agent': XIAMEN_UA, Referer: FUZHOU_REFERER, Accept: 'application/json, text/plain, */*' }
  return parseFuzhouProgrammes(await fetchJson(fetchImpl, url.href, headers, timeoutMs, '福州节目单'), day)
}

export function clearCache() {
  secretCache = null
  secretPending = null
}

export default {
  id: 'fjtv',
  // 今天 + 明天：省级次日节目单前一天傍晚录入，厦门排好了约一周
  days: 2,

  /** 本模块哪些频道出节目单：频道 ref、显示名 → 平台 + 频道 id。 */
  channels() {
    return [
      ...PROVINCE_CHANNELS.filter(channel => channel.epg !== false)
        .map(channel => ({ ref: `fjtv-province-${channel.id}`, name: channel.name, key: `province:${channel.id}` })),
      ...XIAMEN_CHANNELS.filter(channel => channel.epg !== false)
        .map(channel => ({ ref: `fjtv-xiamen-${channel.id}`, name: channel.name, key: `xiamen:${channel.id}` })),
      // 福州是直链频道：ref 只作标识，流水线按名字对上
      ...FUZHOU_CHANNELS.filter(channel => channel.epg !== false)
        .map(channel => ({ ref: `fjtv-fuzhou-${channel.streamId}`, name: channel.name, key: `fuzhou:${channel.streamId}` })),
    ]
  },

  /** 取一个频道某一天（上海日期 YYYYMMDD）的节目，按开始时间升序；官方没发返回空数组。 */
  async programmes(key, day, { fetchImpl = fetch, timeoutMs = 10000, now = Date.now() } = {}) {
    const match = KEY_RE.exec(String(key))
    if (!match || !shanghaiDay(day)) throw new Error('福建节目单参数非法')
    const offset = offsetFromToday(String(day), now)
    if (offset < -MAX_DAYS_BACK || offset > MAX_DAYS_AHEAD) return []
    const options = { fetchImpl, timeoutMs, now: Number(now) }
    if (match[1]) return provinceProgrammes(match[2], String(day), options)
    if (match[3]) return xiamenProgrammes(match[4], String(day), options)
    return fuzhouProgrammes(match[6], String(day), options)
  },
}
