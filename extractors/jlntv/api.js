/** 吉林广播电视台「吉祥新闻网」电视与慢直播接口。 */
import { createHash } from 'node:crypto'

import { proxyAwareFetch } from '../../utils/systemProxy.js'

export const API_ORIGIN = 'https://clientapi.jlntv.cn'
export const TV_PAGE = 'https://www.jlntv.cn/tv?id=104'

const XXTEA_KEY = '5b28bae827e651b3'
const DYNAMIC_MEDIA_HOST = 'hls.avap.jilintv.cn'
const MEDIA_HOSTS = new Set([
  DYNAMIC_MEDIA_HOST,
  'stream2.jlntv.cn',
  'live-master.jlntv.cn',
  'lsfb.avap.jilintv.cn',
  // 慢直播「看敦化」主画面：不带签名的固定清单，分片同主机（2026-11-08 实测）
  'plus-live.jlntv.cn',
])
const IMAGE_HOST = 'cdn.jlntv.cn'
const BROADCAST_LIST_PATH = '/broadcast/list?page=1&size=10000&type=1'
const MAX_RESPONSE_SIZE = 2 * 1024 * 1024
const MIN_TOKEN_LIFETIME_MS = 60 * 1000
const API_CACHE_MS = 45 * 1000
const DELTA = 0x9E3779B9
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const apiCache = new Map()
const apiPending = new Map()

function slowPage(contentId) {
  return `https://www.jlntv.cn/streamDetail?contentId=${contentId}&type=stream&id=102`
}

function toUint32Array(bytes, includeLength) {
  const length = Math.ceil(bytes.length / 4)
  const result = new Uint32Array(length + (includeLength ? 1 : 0))
  for (let index = 0; index < bytes.length; index++) {
    result[index >>> 2] |= bytes[index] << ((index & 3) << 3)
  }
  if (includeLength) result[length] = bytes.length
  return result
}

function toBytes(values, includeLength) {
  let length = values.length * 4
  if (includeLength) {
    const declared = values.at(-1)
    length -= 4
    if (declared < length - 3 || declared > length) throw new Error('吉林广电接口解密长度无效')
    length = declared
  }
  const result = new Uint8Array(length)
  for (let index = 0; index < length; index++) {
    result[index] = values[index >>> 2] >>> ((index & 3) << 3)
  }
  return result
}

function mx(sum, y, z, position, e, key) {
  return (((z >>> 5 ^ y << 2) + (y >>> 3 ^ z << 4))
    ^ ((sum ^ y) + (key[position & 3 ^ e] ^ z))) >>> 0
}

function decryptXXTEA(ciphertext) {
  if (typeof ciphertext !== 'string' || !ciphertext || !/^[A-Za-z\d+/]+={0,2}$/.test(ciphertext)) {
    throw new Error('吉林广电接口没有返回有效密文')
  }
  const cipherBytes = Buffer.from(ciphertext, 'base64')
  if (!cipherBytes.length || cipherBytes.length % 4 !== 0) throw new Error('吉林广电接口密文长度无效')
  const values = toUint32Array(cipherBytes, false)
  const rawKey = new TextEncoder().encode(XXTEA_KEY)
  const paddedKey = new Uint8Array(Math.max(16, rawKey.length))
  paddedKey.set(rawKey)
  const key = toUint32Array(paddedKey, false)
  const last = values.length - 1
  let y = values[0]
  let sum = (Math.floor(6 + 52 / values.length) * DELTA) >>> 0
  while (sum !== 0) {
    const e = sum >>> 2 & 3
    for (let position = last; position > 0; position--) {
      const z = values[position - 1]
      y = values[position] = (values[position] - mx(sum, y, z, position, e, key)) >>> 0
    }
    const z = values[last]
    y = values[0] = (values[0] - mx(sum, y, z, 0, e, key)) >>> 0
    sum = (sum - DELTA) >>> 0
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(toBytes(values, true))
}

/** 官网返回 JSON 包裹的 XXTEA 密文；只解包为数据，不执行响应内容。 */
export function decryptJlntvResponse(text) {
  let envelope
  try {
    envelope = JSON.parse(text)
  } catch {
    throw new Error('吉林广电接口返回了无效 JSON')
  }
  const ciphertext = envelope && typeof envelope === 'object' && !Array.isArray(envelope)
    ? envelope.data
    : envelope
  let payload
  try {
    payload = JSON.parse(decryptXXTEA(ciphertext))
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) throw new Error('吉林广电接口解密失败')
    throw error
  }
  if (!payload || typeof payload !== 'object' || payload.code !== 0) {
    throw new Error(`吉林广电接口请求失败${payload?.message ? `：${payload.message}` : ''}`)
  }
  return payload
}

/** 全代理登记清单、密钥和分片前执行，拒绝任意外部回源。 */
export function officialAssetUrl(raw) {
  const url = new URL(String(raw || '').trim())
  if (url.protocol !== 'https:' || url.username || url.password || !['', '443'].includes(url.port)
      || !MEDIA_HOSTS.has(url.hostname)) {
    throw new Error('吉林广电返回了非官方媒体地址')
  }
  return url.href
}

export function officialHlsUrl(raw) {
  const url = new URL(officialAssetUrl(raw))
  if (!url.pathname.toLowerCase().endsWith('.m3u8')) throw new Error('吉林广电返回的不是 HLS 地址')
  return url.href
}

export function validateDynamicStreamUrl(raw, now = Date.now()) {
  const url = new URL(officialHlsUrl(raw))
  if (url.hostname !== DYNAMIC_MEDIA_HOST || url.hash
      || !/^\/zqvk7vpj\/channel\/[a-z\d]+\/index\.m3u8$/i.test(url.pathname)) {
    throw new Error('吉林广电返回了非官方动态媒体地址')
  }
  const keys = [...url.searchParams.keys()]
  const secrets = url.searchParams.getAll('txSecret')
  const times = url.searchParams.getAll('txTime')
  if (keys.some(key => !['txSecret', 'txTime'].includes(key))
      || secrets.length !== 1 || times.length !== 1
      || !/^[a-f\d]{32}$/i.test(secrets[0]) || !/^[a-f\d]{8,16}$/i.test(times[0])) {
    throw new Error('吉林广电没有返回完整的 CDN 鉴权参数')
  }
  const expiresAt = Number.parseInt(times[0], 16) * 1000
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Number(now) + MIN_TOKEN_LIFETIME_MS) {
    throw new Error('吉林广电返回的 CDN 鉴权已经过期')
  }
  return url.href
}

export function selectBroadcast(payload, expected, options = {}) {
  if (!Array.isArray(payload?.data)) throw new Error('吉林广电没有返回频道列表')
  const item = payload.data.find(value => value
    && String(value.id) === String(expected.broadcastId) && value.contentType === 'tv')
  if (!item || item.title !== expected.rawName
      || String(item.data?.indexId) !== String(expected.broadcastId)) {
    throw new Error('吉林广电没有返回指定电视频道')
  }
  return validateDynamicStreamUrl(item.data?.streamUrl, options.now)
}

export function parseBroadcast(text, expected, options = {}) {
  return selectBroadcast(decryptJlntvResponse(text), expected, options)
}

/**
 * 频道图标：电视频道列表每项的 image 就是官网电视页的频道图标（省级六套各有一张，地方台是各台台标）。
 * 图床带 CDN 鉴权，sign 每次请求都重签、去掉就 403，所以只能原样用接口当下给的地址，不能写死。
 */
export function officialLogoUrl(raw) {
  try {
    const url = new URL(String(raw || '').trim())
    return url.protocol === 'https:' && url.hostname === IMAGE_HOST
      && !url.username && !url.password && !url.port
      && /^\/saas\/image\/[\w./-]+\.(?:png|jpe?g|webp)$/i.test(url.pathname)
      ? url.href
      : ''
  } catch {
    return ''
  }
}

/** 按列表 ID 与原名同时认，返回 broadcastId → 台标；认不到的不给。 */
export function selectLogos(payload) {
  const logos = new Map()
  const items = Array.isArray(payload?.data) ? payload.data : []
  for (const channel of BROADCAST_CHANNELS) {
    const item = items.find(value => value && value.contentType === 'tv'
      && String(value.id) === channel.broadcastId && value.title === channel.rawName)
    const logo = officialLogoUrl(item?.image || item?.data?.image)
    if (logo) logos.set(channel.broadcastId, logo)
  }
  return logos
}

/** 官网专题里已经没有这个机位（官网按季节换慢直播机位）：是明确下线，不是网络问题。 */
export class ScenicGoneError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ScenicGoneError'
  }
}

export function selectStreamDetail(payload, expected, options = {}) {
  const item = payload?.data
  if (!item || String(item.id) !== String(expected.contentId) || item.contentType !== 'stream') {
    throw new ScenicGoneError('吉林广电没有返回指定慢直播专题')
  }
  const detail = item.data
  if (!detail || typeof detail !== 'object') throw new Error('吉林广电慢直播详情无效')
  // 官网换季时会把机位在主画面和多线路之间挪，按名字在两处都找
  const selected = [detail, ...(Array.isArray(detail.subStreams) ? detail.subStreams : [])]
    .find(value => value?.name === expected.streamName)
  if (!selected) throw new ScenicGoneError('吉林广电没有返回指定慢直播机位')
  return validateTopicStreamUrl(selected.playUrl, options.now)
}

async function requestApi(path, { timeoutMs = 15000, fetchImpl = proxyAwareFetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(new URL(path, API_ORIGIN).href, {
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Client-Type': 'web',
        'User-Agent': UA,
      },
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`吉林广电接口 HTTP ${response.status}`)
    if (text.length > MAX_RESPONSE_SIZE) throw new Error('吉林广电接口响应过大')
    return text
  } finally {
    clearTimeout(timer)
  }
}

async function cachedApi(path, options = {}) {
  const now = Number(options.now ?? Date.now())
  const fetchImpl = options.fetchImpl || proxyAwareFetch
  const cached = apiCache.get(path)
  if (cached?.expiresAt > now && cached.fetchImpl === fetchImpl) return cached.text
  let active = apiPending.get(path)
  if (!active || active.fetchImpl !== fetchImpl) {
    const promise = requestApi(path, { ...options, fetchImpl })
      .then(text => {
        apiCache.set(path, { text, fetchImpl, expiresAt: now + API_CACHE_MS })
        return text
      })
      .finally(() => {
        if (apiPending.get(path)?.promise === promise) apiPending.delete(path)
      })
    active = { promise, fetchImpl }
    apiPending.set(path, active)
  }
  return active.promise
}

// 地方台也在同一份电视频道列表里（ID 与原名如下），但播放走固定直链；这里的 ID 只用来认台标。
export const BROADCAST_CHANNELS = Object.freeze([
  { ref: 'jlntv-satellite', broadcastId: '1531', rawName: '吉林卫视', name: '吉林卫视', dynamic: 'broadcast' },
  { ref: 'jlntv-city', broadcastId: '1532', rawName: '都市频道', name: '吉林都市', dynamic: 'broadcast' },
  { ref: 'jlntv-life', broadcastId: '1534', rawName: '生活频道', name: '吉林生活', dynamic: 'broadcast' },
  { ref: 'jlntv-movies', broadcastId: '1535', rawName: '影视频道', name: '吉林影视', dynamic: 'broadcast' },
  { ref: 'jlntv-rural', broadcastId: '1536', rawName: '乡村频道', name: '吉林乡村', dynamic: 'broadcast' },
  { ref: 'jlntv-variety-culture', broadcastId: '1538', rawName: '综艺·文化频道', name: '吉林综艺文化', dynamic: 'broadcast' },
  { ref: 'jlntv-changchun', broadcastId: '812402', rawName: '长春综合', name: '长春综合', url: 'https://stream2.jlntv.cn/jlcc/sd/live.m3u8' },
  { ref: 'jlntv-jilin-city', broadcastId: '812373', rawName: '吉林新闻综合', name: '吉林新闻综合', url: 'https://stream2.jlntv.cn/jilin1/sd/live.m3u8' },
  { ref: 'jlntv-siping', broadcastId: '812374', rawName: '四平新闻综合', name: '四平新闻综合', url: 'https://stream2.jlntv.cn/sptv/sd/live.m3u8' },
  { ref: 'jlntv-liaoyuan', broadcastId: '812376', rawName: '辽源新闻综合', name: '辽源新闻综合', url: 'https://stream2.jlntv.cn/liaoyuan1/sd/live.m3u8' },
  { ref: 'jlntv-tonghua', broadcastId: '812379', rawName: '通化新闻综合', name: '通化新闻综合', url: 'https://live-master.jlntv.cn/thhd/sd/live.m3u8' },
  { ref: 'jlntv-baishan', broadcastId: '812383', rawName: '白山新闻综合', name: '白山新闻综合', url: 'https://stream2.jlntv.cn/baishan1/sd/live.m3u8' },
  { ref: 'jlntv-baicheng', broadcastId: '812380', rawName: '白城新闻综合', name: '白城新闻综合', url: 'https://stream2.jlntv.cn/baicheng1/sd/live.m3u8' },
  { ref: 'jlntv-songyuan', broadcastId: '812382', rawName: '松原新闻综合', name: '松原新闻综合', url: 'https://stream2.jlntv.cn/sytv/sd/live.m3u8' },
  { ref: 'jlntv-yanbian', broadcastId: '812244', rawName: '延边卫视', name: '延边卫视', url: 'https://stream2.jlntv.cn/jlyb/sd/live.m3u8' },
])

export const SCENIC_CHANNELS = Object.freeze([
  { ref: 'jlntv-slow-xinmin-square', name: '长春市·新民广场', contentId: '659599', streamName: '长春市·新民广场', main: true, dynamic: 'slow' },
  { ref: 'jlntv-slow-shuangyang', name: '长春市·双阳区', contentId: '659599', streamName: '长春市·双阳区', dynamic: 'slow' },
  { ref: 'jlntv-slow-jiangxin-island', name: '临江市·江心岛', contentId: '659599', streamName: '临江市·江心岛', dynamic: 'slow' },
  { ref: 'jlntv-slow-nanhu-park', name: '长春市·南湖公园', contentId: '659599', streamName: '长春市·南湖公园', dynamic: 'slow' },
  { ref: 'jlntv-slow-hunjiang', name: '通化市·浑江', contentId: '659599', streamName: '通化市·浑江', dynamic: 'slow' },
  { ref: 'jlntv-slow-sihai-longwan', name: '靖宇县·四海龙湾玛珥湖', contentId: '986656', streamName: '靖宇县·四海龙湾玛珥湖', main: true, dynamic: 'slow' },
  { ref: 'jlntv-slow-jingyu-tower', name: '长春市·碧松净月塔楼', contentId: '1020462', streamName: '长春市·碧松净月塔楼', main: true, dynamic: 'slow' },
  { ref: 'jlntv-slow-renyi', name: '靖宇县·松花江仁义风景区', contentId: '1020462', streamName: '靖宇县·松花江仁义风景区', dynamic: 'slow' },
  { ref: 'jlntv-slow-chagan-lake', name: '松原市·查干湖', contentId: '1020462', streamName: '松原市·查干湖', dynamic: 'slow' },
  { ref: 'jlntv-slow-jiangjunding', name: '长白山·万达滑雪场将军顶', contentId: '1020462', url: 'https://lsfb.avap.jilintv.cn/zqvk7vpj/channel/9y446edd82554fa0a4ff95104be92e83/index.m3u8' },
  { ref: 'jlntv-slow-red-man-green-woman', name: '《红男绿女》慢直播', contentId: '1008906', url: 'https://lsfb.avap.jilintv.cn/zqvk7vpj/channel/1ceb537a60664ac49649b639e823678c/index.m3u8' },
  { ref: 'jlntv-slow-wanda-ski', name: '长白山·万达滑雪场', contentId: '986256', url: 'https://lsfb.avap.jilintv.cn/zqvk7vpj/channel/7a91db469e6d47a7803fcf304bd5e682/index.m3u8' },
  { ref: 'jlntv-slow-china-memory', name: '让吉林影像写入中国记忆', contentId: '750660', url: 'https://lsfb.avap.jilintv.cn/zqvk7vpj/channel/da805d8d77a24db8aaa62328eb6d874e/index.m3u8' },
])

const ALL_CHANNELS = [...BROADCAST_CHANNELS, ...SCENIC_CHANNELS]
const CHANNEL_BY_REF = new Map(ALL_CHANNELS.map(channel => [channel.ref, channel]))
const BROADCAST_REFS = new Set(BROADCAST_CHANNELS.map(channel => channel.ref))
const SCENIC_REFS = new Set(SCENIC_CHANNELS.map(channel => channel.ref))

function buildChannel(channel, logo = '') {
  return {
    name: channel.name,
    deferredRef: channel.ref,
    logo,
    opts: ['network-caching=3000'],
    catchup: 'none',
  }
}

/** 频道表固定；电视频道的台标来自 selectLogos。 */
export function buildGroups(logos = new Map()) {
  return [
    { name: '吉林', dataList: BROADCAST_CHANNELS.map(channel => buildChannel(channel, logos.get(channel.broadcastId))) },
  ]
}

/** 慢直播（「吉林风景」模块）：景观机位不是电视台，不给台标。 */
export function buildScenicGroups(channels = SCENIC_CHANNELS) {
  return channels.length
    ? [{ name: '吉林风景', dataList: channels.map(channel => buildChannel(channel)) }]
    : []
}

const offline = reason => ({ status: 'offline', reason })
const unknown = reason => ({ status: 'unknown', reason })

/** 取一次清单看还在不在播：404、403 这类 4xx、不是 HLS、已结束、没有分片算下线；超时、5xx、限流说不准。 */
async function scenicManifestStatus(url, page, options = {}) {
  const fetchImpl = options.fetchImpl || proxyAwareFetch
  let target = url
  // 固定地址给的是主清单，往下跟一层到媒体清单
  for (let hop = 0; hop < 2; hop++) {
    let response
    let text
    try {
      response = await fetchImpl(target, {
        signal: AbortSignal.timeout(options.timeoutMs || 10000),
        headers: { Origin: 'https://www.jlntv.cn', Referer: page, 'User-Agent': UA },
      })
      text = String(await response.text()).slice(0, MAX_RESPONSE_SIZE)
    } catch (error) {
      return unknown(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? '清单请求超时' : (error?.message || String(error)))
    }
    // 限流（429）、请求超时（408）这类说明不了停没停播，和 5xx 一样照旧保留
    if (response.status >= 500 || [408, 425, 429].includes(response.status)) return unknown(`清单 HTTP ${response.status}`)
    if (!response.ok) return offline(`清单 HTTP ${response.status}`)
    if (!text.trimStart().startsWith('#EXTM3U')) return offline('返回的不是 HLS 清单')
    if (/#EXT-X-STREAM-INF/.test(text)) {
      const variant = text.split(/\r?\n/).map(line => line.trim()).find(line => line && !line.startsWith('#'))
      if (!variant) return offline('主清单里没有码率')
      try {
        target = officialHlsUrl(new URL(variant, target).href)
      } catch (error) {
        return unknown(error?.message || String(error))
      }
      continue
    }
    if (/#EXT-X-ENDLIST/.test(text)) return offline('直播已结束')
    if (!/#EXTINF/.test(text)) return offline('清单里没有分片')
    return { status: 'live' }
  }
  return unknown('清单嵌套过深')
}

// ---- 「吉林风景」按官网当前慢直播专题动态收机位（作者 2026-11-08 要求：失效的不显示、新换上的自动收） ----

const STREAM_LIST_PATH = '/content/list?page=1&pageSize=50&contentType=stream&addRecommend=1'
// 官网直播目录里同时有发布会、晚会这类活动；只收标题像慢直播的，加上频道表里本来就有的专题
const SLOW_TITLE_RE = /慢直播|慢时光/
const KNOWN_TOPIC_IDS = new Set(SCENIC_CHANNELS.map(channel => String(channel.contentId)))
const LEGACY_FIXED = SCENIC_CHANNELS.filter(channel => channel.url)
const LEGACY_DYNAMIC = SCENIC_CHANNELS.filter(channel => !channel.url)
// 新机位的引用只看信号，不带专题号：官网换季撤掉专题、或新专题排到前面也挂着这一路时，引用不变
// （引用就是频道 ID，变了用户的隐藏、改名、排序都会失效）
const DYNAMIC_SCENIC_REF_RE = /^jlntv-slow-([a-f\d]{10})$/
// 上一轮刷新时每个慢直播频道挂在哪个专题：播放时先问它，省得逐个专题找。只是提示，重启后为空也照样找得到
const scenicTopicHints = new Map()

/** 同一路信号在不同主机、不同专题里的统一标识：腾讯云直播看频道号（固定地址与签名地址共用），其余看主机 + 路径。 */
export function scenicStreamKey(raw) {
  const url = new URL(raw)
  const channel = /^\/zqvk7vpj\/channel\/([a-z\d]+)\/index\.m3u8$/i.exec(url.pathname)
  return channel ? `channel:${channel[1].toLowerCase()}` : `${url.hostname}${url.pathname}`
}

const streamHash = key => createHash('sha1').update(key).digest('hex').slice(0, 10)

/** 专题里的一路：腾讯云签名地址要校验鉴权，官网其它直播主机（如看敦化的 plus-live）是不带签名的固定清单。 */
export function validateTopicStreamUrl(raw, now = Date.now()) {
  // 老专题（红男绿女、中国记忆）给的是 http://，同一主机走 https 正常（固定地址一直这么用）
  const url = new URL(officialHlsUrl(String(raw || '').trim().replace(/^http:\/\//i, 'https://')))
  return url.hostname === DYNAMIC_MEDIA_HOST ? validateDynamicStreamUrl(url.href, now) : url.href
}

/** 官网播放器的做法：主画面排第一（名字空着用专题标题），后面是多线路。 */
export function topicStreams(payload) {
  const item = payload?.data
  const detail = item?.data
  if (!detail || typeof detail !== 'object') return []
  const main = { name: String(detail.name || '').trim() || String(item.title || '').trim(), playUrl: detail.playUrl }
  const subs = Array.isArray(detail.subStreams) ? detail.subStreams : []
  return [main, ...subs.map(value => ({ name: String(value?.name || '').trim(), playUrl: value?.playUrl }))]
    .filter(stream => stream.name && stream.playUrl)
}

/** 当前在播的慢直播专题，按官网目录顺序。 */
export function selectSlowTopics(payload) {
  if (!Array.isArray(payload?.data)) throw new Error('吉林广电没有返回直播目录')
  return payload.data
    .filter(item => item && item.contentType === 'stream' && Number(item.state) === 1 && /^\d{1,12}$/.test(String(item.id))
      && (SLOW_TITLE_RE.test(String(item.title || '')) || KNOWN_TOPIC_IDS.has(String(item.id))))
    .map(item => ({ id: String(item.id), title: String(item.title || '').trim() }))
}

/**
 * 把各专题的机位排成频道表（纯函数，方便测试）。同一路信号可能挂在好几个专题里（看敦化挂了三个），只出一次、
 * 位置按第一次出现；原来频道表里有的沿用原来的引用和名字（用户做过的隐藏、改名、排序照旧生效），新机位的引用
 * 只用信号标识摘要。名字重复但信号不同的（白山市·松岭有两路）后一路加序号。
 * 行上的 topic 是这一路这次挂在哪个专题，只给播放时当提示。
 */
export function discoverScenicChannels(topics, options = {}) {
  const found = []
  const invalid = []
  for (const { id, title, payload } of topics) {
    for (const stream of topicStreams(payload)) {
      try {
        const url = validateTopicStreamUrl(stream.playUrl, options.now)
        found.push({ topic: id, name: stream.name, url, key: scenicStreamKey(url) })
      } catch (error) {
        invalid.push({ name: stream.name, reason: error?.message || String(error), topic: title })
      }
    }
  }
  // 原来频道表里按名字记的机位：先在记下的专题里认，官网把它挪到别的专题也按名字认回；一路信号只认一个
  const legacyByKey = new Map()
  const claimed = new Set()
  const claim = matches => {
    for (const channel of LEGACY_DYNAMIC) {
      if (claimed.has(channel.ref)) continue
      const hit = found.find(item => !legacyByKey.has(item.key) && matches(channel, item))
      if (!hit) continue
      legacyByKey.set(hit.key, { channel, topic: hit.topic })
      claimed.add(channel.ref)
    }
  }
  claim((channel, item) => String(channel.contentId) === item.topic && channel.streamName === item.name)
  claim((channel, item) => channel.streamName === item.name)

  const rows = []
  const byKey = new Map()
  for (const item of found) {
    if (byKey.has(item.key)) continue
    const fixedLegacy = LEGACY_FIXED.find(channel => scenicStreamKey(channel.url) === item.key)
    const dynamicLegacy = legacyByKey.get(item.key)
    const legacy = fixedLegacy || dynamicLegacy?.channel
    const row = legacy
      ? { ref: legacy.ref, name: legacy.name, url: legacy.url ? officialHlsUrl(legacy.url) : item.url, page: slowPage(legacy.contentId), topic: dynamicLegacy?.topic || item.topic, legacy: true }
      : { ref: `jlntv-slow-${streamHash(item.key)}`, name: item.name, url: item.url, page: slowPage(item.topic), topic: item.topic, legacy: false }
    byKey.set(item.key, row)
    rows.push(row)
  }
  const seen = new Map()
  for (const row of rows) {
    const count = (seen.get(row.name) || 0) + 1
    seen.set(row.name, count)
    if (count > 1 && !row.legacy) row.name = `${row.name} ${count}`
  }
  return { rows, invalid }
}

/**
 * 只输出官网当前挂着、并且清单在播的机位。官网按季节换机位：撤下的这一轮不出现，新换上的自动加进来，
 * 恢复了下一轮自动回来。直播目录或专题详情取不到、或者一路都没确认成（网络问题），整轮算失败，沿用上一轮；
 * 单路清单超时、5xx 这类说不准的照旧输出，免得一次抖动把频道藏一整轮。
 */
export async function fetchScenicGroups(ctx = {}) {
  const options = { timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl, now: ctx.now }
  const topics = selectSlowTopics(decryptJlntvResponse(await cachedApi(STREAM_LIST_PATH, options)))
  const withDetails = await Promise.all(topics.map(async topic => ({
    ...topic,
    payload: decryptJlntvResponse(await cachedApi(`/detail/stream/${topic.id}?backend=true`, options)),
  })))
  const { rows, invalid } = discoverScenicChannels(withDetails, options)
  for (const row of rows) scenicTopicHints.set(row.ref, row.topic)
  // 官网目录里已经不挂、但固定地址还在推流的（长白山两路），照旧试一次
  for (const channel of LEGACY_FIXED) {
    if (!rows.some(row => row.ref === channel.ref)) {
      rows.push({ ref: channel.ref, name: channel.name, url: officialHlsUrl(channel.url), page: slowPage(channel.contentId), legacy: true })
    }
  }
  const verdicts = await Promise.all(rows.map(row => scenicManifestStatus(row.url, row.page, options)))
  const live = rows.filter((_, index) => verdicts[index].status === 'live')
  const unsure = rows.map((row, index) => ({ row, ...verdicts[index] })).filter(item => item.status === 'unknown')
  if (!live.length && unsure.length) {
    throw new Error(`吉林风景这一轮没能确认任何机位（${unsure[0].reason}），沿用上一轮`)
  }
  const kept = rows.filter((_, index) => verdicts[index].status !== 'offline')
  const skipped = [
    ...rows.map((row, index) => ({ name: row.name, ...verdicts[index] })).filter(item => item.status === 'offline')
      .map(({ name, reason }) => ({ name, reason })),
    // 原来频道表里有、官网专题里已经撤下的
    ...LEGACY_DYNAMIC.filter(channel => !rows.some(row => row.ref === channel.ref))
      .map(channel => ({ name: channel.name, reason: '官网专题里已撤下这个机位' })),
    ...invalid.map(({ name, reason }) => ({ name, reason })),
  ]
  return {
    groups: buildScenicGroups(kept),
    skipped,
    warnings: unsure.length
      ? [`${unsure.map(item => item.row.name).join('、')} 这一轮没查成（${unsure[0].reason}），照旧保留`]
      : [],
  }
}

/**
 * 慢直播机位播放时取址：先问提示的专题（上一轮刷新时挂在哪、频道表里记的专题），没有就在官网当前在播的
 * 慢直播专题里按目录顺序找。提示的专题官网撤了、取不到都不算失败，接着找；目录也取不到才报错。
 */
async function findScenicStream(matches, preferred, options) {
  const findIn = async id => {
    const payload = decryptJlntvResponse(await cachedApi(`/detail/stream/${id}?backend=true`, options))
    for (const stream of topicStreams(payload)) {
      try {
        const url = validateTopicStreamUrl(stream.playUrl, options.now)
        if (matches(stream, url)) return { url, page: slowPage(id), name: stream.name }
      } catch {
        // 这一路地址不合规，跳过
      }
    }
    return null
  }
  const tried = new Set()
  for (const id of preferred) {
    if (!id || tried.has(id)) continue
    tried.add(id)
    try {
      const found = await findIn(id)
      if (found) return found
    } catch {
      // 提示的专题官网已撤下或这次没取到，到目录里接着找
    }
  }
  const topics = selectSlowTopics(decryptJlntvResponse(await cachedApi(STREAM_LIST_PATH, options)))
  for (const topic of topics) {
    if (tried.has(topic.id)) continue
    tried.add(topic.id)
    const found = await findIn(topic.id)
    if (found) return found
  }
  throw new ScenicGoneError('吉林广电官网已撤下这个慢直播机位')
}

/**
 * 更新时取一次电视频道列表只为拿台标（签名地址见 officialLogoUrl）；取流仍在播放时做。
 * 列表取不到就让这一轮失败：上一轮的频道和台标原样沿用、几分钟后重试。照常出频道反而会把
 * 已有台标清空一整天——开机时网络还没通就是这样。
 */
export async function fetchGroups(ctx = {}) {
  let text
  try {
    text = await cachedApi(BROADCAST_LIST_PATH, {
      timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl, now: ctx.now,
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`吉林广电接口超时 ${ctx.timeoutMs || 15000}ms`)
    throw error
  }
  const logos = selectLogos(decryptJlntvResponse(text))
  const missing = BROADCAST_CHANNELS.length - logos.size
  const warnings = missing
    ? [`官网电视频道列表里有 ${missing} 路没认到台标（官网可能改了频道 ID、台名或图床）`]
    : []
  return { groups: buildGroups(logos), warnings }
}

/** 电视（「吉林」模块）与慢直播（「吉林风景」模块）各认各的；取流共用 resolveChannel。 */
export function claimsRef(ref) {
  return BROADCAST_REFS.has(String(ref || ''))
}

export function claimsScenicRef(ref) {
  const value = String(ref || '')
  return SCENIC_REFS.has(value) || DYNAMIC_SCENIC_REF_RE.test(value)
}

function headersFor(page) {
  return raw => {
    officialAssetUrl(raw)
    return { Origin: 'https://www.jlntv.cn', Referer: page }
  }
}

export async function resolveChannel(ref, ctx = {}) {
  const discovered = DYNAMIC_SCENIC_REF_RE.exec(String(ref || ''))
  if (discovered) {
    try {
      const options = { timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl, now: ctx.now }
      const hash = discovered[1]
      const found = await findScenicStream(
        (_stream, url) => streamHash(scenicStreamKey(url)) === hash,
        [scenicTopicHints.get(String(ref))],
        options,
      )
      return {
        url: found.url,
        desc: `${found.name}官方直播地址获取成功`,
        upstreamHeaders: headersFor(found.page),
        upstreamUrlTransform: officialAssetUrl,
      }
    } catch (error) {
      return { url: '', desc: `吉林广电链接请求失败：${error?.message || String(error)}` }
    }
  }
  const channel = CHANNEL_BY_REF.get(String(ref || ''))
  if (!channel) return { url: '', desc: '吉林频道引用格式错误' }
  try {
    const options = { timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl, now: ctx.now }
    let url
    let page = TV_PAGE
    if (channel.url) {
      url = officialHlsUrl(channel.url)
      if (SCENIC_CHANNELS.includes(channel)) page = slowPage(channel.contentId)
    } else if (channel.dynamic === 'broadcast') {
      const text = await cachedApi(BROADCAST_LIST_PATH, options)
      url = parseBroadcast(text, channel, options)
    } else {
      if (!/^\d+$/.test(String(channel.contentId))) throw new Error('慢直播内容 ID 无效')
      // 按名字找：官网换季会把机位挪进别的专题（仁义同时挂在两个专题里），频道表里记的专题撤了也要找得到
      const found = await findScenicStream(
        stream => stream.name === channel.streamName,
        [scenicTopicHints.get(channel.ref), String(channel.contentId)],
        options,
      )
      url = found.url
      page = found.page
    }
    return {
      url,
      desc: `${channel.name}官方直播地址获取成功`,
      upstreamHeaders: headersFor(page),
      upstreamUrlTransform: officialAssetUrl,
    }
  } catch (error) {
    return { url: '', desc: `吉林广电链接请求失败：${error?.message || String(error)}` }
  }
}

export function clearCache() {
  apiCache.clear()
  apiPending.clear()
  scenicTopicHints.clear()
}
