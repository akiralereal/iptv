/**
 * 山西广播电视台：官网直播页的六套省级频道 + 官网聚合的十套地市频道。
 *
 * 两条链路合在一个模块里，是因为它们同出一个官网直播页、同落一个分组：
 *
 * 省级（livehhhttps.sxrtv.com）——播放地址是 /lsdream/<频道码>/<码率>/<当日键>.m3u8。
 *   当日键由官网 tidePlayer.js 按「频道码 + 上海时区当天零点」算出，不带签名、
 *   也不用问接口，但只认当天：昨天和明天的键实测都是 400，零点一过旧地址即失效，
 *   所以不能写进播放列表，只能每次播放请求时按当前时间重算。
 *   码率档与主机取自带官网 MD5 参数的 info.json，五分钟复用一次。
 *
 * 地市（citymlive.sxrtv.com）——播放前向官网 huawei_live_secret.jsp 按 itemId 换一条
 *   带 hwSecret/hwTime 的地址；清单里每个分片也各自带上游签好的签名。
 *
 * 两家 CDN 都不看来源头、也不挑播放器标识（Lavf、okhttp 裸请求清单与分片均 200），
 * 分片可以由播放器直连，所以走 relay：本机每次轮询重新解析并中继清单，省级跨零点
 * 换键、地市换签都在服务端完成，播放器只管按清单往下播。
 */
import { createHash } from 'node:crypto'
import { proxyAwareFetch } from '../../utils/systemProxy.js'

export const SXRTV_PAGE = 'https://www.sxrtv.com/tv/index.shtml'
export const SXRTV_ORIGIN = 'https://www.sxrtv.com'
export const PROVINCE_INFO_ORIGIN = 'https://livehhhttps.sxrtv.com'
export const PROVINCE_INFO_PATH = '/lsdream/336E7E6818120C00FA7E8129A9999A10/info.json'
export const CITY_SECRET_API = 'https://dyhhplus.sxrtv.com/tapi/custom/huawei_live_secret.jsp'

const PROVINCE_HOST = 'livehhhttps.sxrtv.com'
const CITY_HOST = 'citymlive.sxrtv.com'
// info.json 只决定码率档和主机，两样几乎不变：五分钟重读，接口故障时沿用一天
const INFO_POLICY = Object.freeze({ refreshMs: 5 * 60 * 1000, retryMs: 10 * 1000, hardTtlMs: 24 * 60 * 60 * 1000 })
// 实测签名 10 分钟后清单与分片仍可用；30 秒重换是为了挡住播放器 2 秒一次的轮询，不是怕过期
const CITY_POLICY = Object.freeze({ refreshMs: 30 * 1000, retryMs: 5 * 1000, hardTtlMs: 5 * 60 * 1000 })
// 官网 CDN 换键的时刻和本机钟对不齐：实测本机零点过 1.6 秒按新键取清单仍是 400，
// 官网两三秒后才换过来。零点前后这段时间把相邻那天的键也试一遍
const MIDNIGHT_SKEW_MS = 5 * 60 * 1000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const CHANNEL_CODE_RE = /^[A-Za-z0-9]{7}$/
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const LOGO_BASE = 'https://imagehhsitehttps.sxrtv.com/images/'

const province = (ref, name, channelCode, logo = '') => Object.freeze({ ref, name, kind: 'province', channelCode, logo })
const city = (ref, name, itemId, logo = '') => Object.freeze({ ref, name, kind: 'city', itemId, logo })

// 台名照官网直播页原样收：地市几路台标上打的就是「太原1」「吕梁-1」这种编号，不另起名。
// 公共台标库收了的留空按台名匹配（省级五套与晋中综合），其余用官网直播页下发的台标。
export const CHANNELS = Object.freeze([
  province('shanxi-satellite', '山西卫视', 'q8RVWgs'),
  province('shanxi-huanghe', '黄河电视台', 'lce1mC4', `${LOGO_BASE}2023/4/27/20234271682583913963_33_s.png`),
  province('shanxi-economy-tech', '山西经济与科技', '4j01KWX'),
  province('shanxi-film', '山西影视', 'Md571Kv'),
  province('shanxi-society-law', '山西社会与法治', 'p4y5do9'),
  province('shanxi-culture-sports-life', '山西文体生活', 'agmpyEk'),
  city('shanxi-taiyuan-1', '太原-1', 11, `${LOGO_BASE}2024/12/31/202412311735638644669_600.jpg`),
  city('shanxi-shuozhou-1', '朔州-1', 6, `${LOGO_BASE}2024/12/31/202412311735638665329_600.jpg`),
  city('shanxi-xinzhou-general', '忻州综合', 3, `${LOGO_BASE}2024/12/31/202412311735638682362_600.jpg`),
  city('shanxi-yangquan-news', '阳泉新闻综合', 9, `${LOGO_BASE}2024/12/31/202412311735638693017_600.jpg`),
  city('shanxi-lvliang-1', '吕梁-1', 1, `${LOGO_BASE}2024/12/31/202412311735638703220_600.jpg`),
  city('shanxi-jinzhong-general', '晋中综合', 5),
  city('shanxi-changzhi-1', '长治-1', 8, `${LOGO_BASE}2024/12/31/202412311735638720104_600.jpg`),
  city('shanxi-jincheng-news', '晋城新闻综合', 7, `${LOGO_BASE}2024/12/31/202412311735637570027_601.jpg`),
  city('shanxi-linfen-1', '临汾-1', 2, `${LOGO_BASE}2024/12/31/202412311735638731479_600.jpg`),
  city('shanxi-yuncheng-1', '运城-1', 4, `${LOGO_BASE}2024/12/31/202412311735638742704_600.jpg`),
])

const CHANNEL_BY_REF = new Map(CHANNELS.map(channel => [channel.ref, channel]))

function safeUrl(raw, label) {
  try {
    return new URL(String(raw || '').trim())
  } catch {
    throw new Error(`山西广电返回了无效${label}地址`)
  }
}

/**
 * 两家媒体主机各自的目录。relay 下分片由播放器直连，用不到这里；
 * `?relay=2` 升级成全代理时，代理层登记每条子清单/分片前经它过一遍。
 */
export function officialAssetUrl(raw) {
  const url = safeUrl(raw, '媒体')
  const ok = url.protocol === 'https:' && !url.username && !url.password
    && ['', '443'].includes(url.port) && !url.hash
    && !/%2f|%5c/i.test(url.pathname)
    && (url.hostname === PROVINCE_HOST
      ? /^\/lsdream\/[A-Za-z0-9]{7}\/\d{1,5}\/(?:(?:[A-Za-z0-9]{7}|live)\.m3u8|\d{13}\/[A-Za-z0-9]{1,32}\.ts)$/.test(url.pathname)
      : url.hostname === CITY_HOST && /^\/live\/[A-Za-z0-9_]{1,96}\.(?:m3u8|ts)$/.test(url.pathname))
  if (!ok) throw new Error('山西广电返回了非官方媒体地址')
  return url.href
}

function shanghaiDate(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(now)).map(part => [part.type, part.value]))
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) }
}

const reverse = value => [...value].reverse().join('')

/** 官网 tidePlayer.js 的当日路径键，逐步照搬；日期一律按上海时区算，与服务器所在时区无关。 */
export function provinceDailyKey(channelCode, now = Date.now()) {
  const code = String(channelCode)
  if (!CHANNEL_CODE_RE.test(code)) throw new Error('山西省级频道代码格式无效')
  const { year, month, day } = shanghaiDate(now)
  const midnight = Date.UTC(year, month - 1, day) - 8 * 60 * 60 * 1000
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()

  let sum = 0
  let previous = -1
  let delta = 0
  for (const char of code) {
    const current = char.charCodeAt(0)
    sum += current
    if (previous !== -1) delta += previous - current
    previous = current
  }
  sum += delta

  let dateCode = midnight.toString(36)
  let dateCodeSum = 0
  for (const char of dateCode) dateCodeSum += char.charCodeAt(0)
  dateCode = dateCode.slice(5) + dateCode.slice(0, 5)

  const checksum = Math.abs(dateCodeSum - sum)
  const mixed = reverse(sum.toString(36)) + dateCode
  const head = mixed.slice(0, 4)
  const tail = mixed.slice(4)
  const parity = weekday % 2
  const result = []
  for (let index = 0; index < code.length; index++) {
    if (index % 2 === parity) {
      result.push(mixed.charAt(index % mixed.length))
      continue
    }
    const prior = code.charAt(index - 1)
    if (!prior) {
      result.push(head.charAt(index))
    } else {
      const position = head.indexOf(prior)
      result.push(position === -1 ? prior : tail.charAt(position))
    }
  }
  return (reverse(checksum.toString(36)) + result.join('')).slice(0, code.length)
}

/** info.json 要带官网播放器同款参数：t 为毫秒时间戳的十六进制，token 为 md5(时间戳+路径+"Dream")。 */
export function provinceInfoUrl(now = Date.now()) {
  const timestamp = Number(now)
  const url = new URL(PROVINCE_INFO_PATH, PROVINCE_INFO_ORIGIN)
  url.searchParams.set('t', timestamp.toString(16))
  url.searchParams.set('token', createHash('md5').update(`${timestamp}${PROVINCE_INFO_PATH}Dream`).digest('hex'))
  return url.href
}

function parseJson(payload, label) {
  if (typeof payload !== 'string') return payload
  try {
    return JSON.parse(payload.trim())
  } catch {
    throw new Error(`山西广电${label}没有返回有效 JSON`)
  }
}

/** 每套频道取最高码率档；主机只认省级媒体主机，别处一律跳过。 */
export function parseProvinceInfo(payload) {
  const data = parseJson(payload, '省级频道配置')
  if (!Array.isArray(data?.channels) || !data.channels.length) throw new Error('山西省级频道配置格式异常')
  const channels = new Map()
  for (const item of data.channels) {
    if (!CHANNEL_CODE_RE.test(String(item?.i || ''))) continue
    const rates = Array.isArray(item.r) ? item.r.map(rate => Number(rate?.n)).filter(Number.isInteger) : []
    if (!rates.length) continue
    let host
    try {
      host = new URL(item.l || PROVINCE_INFO_ORIGIN)
    } catch {
      continue
    }
    if (host.protocol !== 'https:' || host.hostname !== PROVINCE_HOST || host.port || host.username || host.password) continue
    channels.set(item.i, { rate: Math.max(...rates), origin: host.origin })
  }
  if (!channels.size) throw new Error('山西省级频道配置中没有有效频道')
  return { channels, dynamicPath: Boolean(data.play?.dl) }
}

export function provinceStreamUrl(channel, info, now = Date.now()) {
  const current = info.channels.get(channel.channelCode)
  if (!current) throw new Error(`山西省级频道配置中没有${channel.name}`)
  const key = info.dynamicPath ? provinceDailyKey(channel.channelCode, now) : 'live'
  return officialAssetUrl(`${current.origin}/lsdream/${channel.channelCode}/${current.rate}/${key}.m3u8`)
}

/** 地市签名接口：地址必须落在地市媒体主机的直播目录，且带齐 hwSecret/hwTime。 */
export function parseCityResponse(payload, channel) {
  const data = parseJson(payload, '地市签名接口')
  if (data?.code !== 200 || typeof data?.data?.address !== 'string') {
    throw new Error(`${channel.name}签名接口没有返回播放地址`)
  }
  const url = new URL(officialAssetUrl(data.data.address))
  if (url.hostname !== CITY_HOST || !url.pathname.endsWith('.m3u8')) {
    throw new Error(`${channel.name}签名接口返回了异常媒体路径`)
  }
  if (!/^[a-f0-9]{64}$/i.test(url.searchParams.get('hwSecret') || '')
      || !/^[a-f0-9]{1,16}$/i.test(url.searchParams.get('hwTime') || '')) {
    throw new Error(`${channel.name}播放地址缺少有效签名`)
  }
  return url.href
}

export function buildCitySecretUrl(channel) {
  const url = new URL(CITY_SECRET_API)
  url.searchParams.set('itemId', String(channel.itemId))
  return url.href
}

async function readText(response, label) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error(`山西广电${label}响应过大`)
  }
  const text = await response.text()
  if (text.length > MAX_RESPONSE_BYTES) throw new Error(`山西广电${label}响应过大`)
  if (!response.ok) throw new Error(`山西广电${label} HTTP ${response.status}`)
  return text
}

async function requestText(url, label, { timeoutMs = 15000, fetchImpl = proxyAwareFetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      redirect: 'manual',
      signal: controller.signal,
      // 两个接口实测都不校验来源头；照官网页面的样子带上，不给它们多一个拒绝的理由
      headers: {
        Accept: 'application/json, text/plain, */*',
        Referer: SXRTV_PAGE,
        Origin: SXRTV_ORIGIN,
        'User-Agent': UA,
      },
    })
    return await readText(response, label)
  } finally {
    clearTimeout(timer)
  }
}

const cache = new Map()
const pending = new Map()

/** 到期才重取；重取失败时在硬期限内沿用最近一次成功值并退避，硬期限过了照实报错。 */
async function cached(key, policy, load, now) {
  const hit = cache.get(key)
  if (hit?.refreshAt > now || (hit?.retryAt > now && hit?.hardExpiresAt > now)) return hit.value

  let active = pending.get(key)
  if (!active) {
    const promise = load()
      .then(value => {
        cache.set(key, { value, refreshAt: now + policy.refreshMs, hardExpiresAt: now + policy.hardTtlMs, retryAt: 0 })
        return value
      })
      .finally(() => {
        if (pending.get(key) === promise) pending.delete(key)
      })
    active = promise
    pending.set(key, promise)
  }

  try {
    return await active
  } catch (error) {
    if (!hit || hit.hardExpiresAt <= now) throw error
    hit.retryAt = now + policy.retryMs
    return hit.value
  }
}

async function requestManifest(url, { timeoutMs = 15000, fetchImpl = proxyAwareFetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': UA },
    })
    const text = await readText(response, '直播清单')
    if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('山西广电直播清单不是 HLS')
    return text
  } finally {
    clearTimeout(timer)
  }
}

async function provinceStream(channel, options, now) {
  const info = await cached('province-info', INFO_POLICY, async () => (
    parseProvinceInfo(await requestText(provinceInfoUrl(now), '省级频道配置', options))
  ), now)
  // 当日键不缓存：每次按当前时间算，零点后的第一次轮询就换到新路径
  const candidates = [...new Set([now, now - MIDNIGHT_SKEW_MS, now + MIDNIGHT_SKEW_MS]
    .map(time => provinceStreamUrl(channel, info, time)))]
  if (candidates.length === 1) return { url: candidates[0] }

  // 零点前后：先试按本机时间算的键，不通再试相邻那天的，取到的清单直接交给代理层，
  // 免得它自己按 400 的地址去取、退回 302 把播放器也带进 400
  for (const url of candidates) {
    try {
      return { url, manifestText: await requestManifest(url, options), manifestUrl: url }
    } catch {}
  }
  return { url: candidates[0] }
}

async function streamFor(channel, options, now) {
  if (channel.kind === 'province') return provinceStream(channel, options, now)
  const url = await cached(channel.ref, CITY_POLICY, async () => (
    parseCityResponse(await requestText(buildCitySecretUrl(channel), '地市签名接口', options), channel)
  ), now)
  return { url }
}

export function buildChannels() {
  return CHANNELS.map(channel => ({
    name: channel.name,
    deferredRef: channel.ref,
    logo: channel.logo,
    groupTitle: '山西',
    opts: ['network-caching=3000'],
    catchup: 'none',
  }))
}

export function claimsRef(ref) {
  return CHANNEL_BY_REF.has(String(ref || ''))
}

export async function resolveChannel(ref, ctx = {}) {
  const channel = CHANNEL_BY_REF.get(String(ref || ''))
  if (!channel) return { url: '', desc: '山西频道引用格式错误' }
  const options = { timeoutMs: ctx.timeoutMs || 15000, fetchImpl: ctx.fetchImpl || proxyAwareFetch }
  try {
    const stream = await streamFor(channel, options, Number(ctx.now ?? Date.now()))
    return {
      ...stream,
      desc: `${channel.name}当前直播地址获取成功`,
      // 旧的无后缀入口也直出清单：省级零点换键，302 给出去的地址过了零点就是 400
      relayHls: true,
      upstreamUrlTransform: officialAssetUrl,
    }
  } catch (error) {
    const reason = error?.name === 'AbortError'
      ? `超时 ${options.timeoutMs}ms`
      : (error?.message || String(error))
    return { url: '', desc: `山西广电链接请求失败：${reason}` }
  }
}

export function clearCache() {
  cache.clear()
  pending.clear()
}
