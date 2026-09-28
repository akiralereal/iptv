/**
 * 青海：青海藏语网络广播电视台官网的安多卫视（ཨ་མདོ་བརྙན་འཕྲིན།）。
 *
 * 链路——官网电视直播页 www.qhtb.cn/zy/onlin/onlin_tv/ 是「云直播」平台（cloudlive-manage，
 *   与福建省级同一套）的前端：页面脚本里写着频道专题 id（current_channel）和站点 app_secret，
 *   播放器拿这两样调 mapi.qhbtv.com.cn 的 api/topic/detail，取 topic_camera[].streams[].hls——
 *   live.qhbtv.com.cn 上带 timestamp/encrypt 的清单地址。
 *
 * 签名——接口每次现签一条，timestamp 写的是「当前 + 7200 秒」（unix 秒）。CDN 并不在那一刻拒绝：
 *   同一条签名发出 2 小时 13 分（已过 timestamp 13 分钟）时清单与分片仍是 200，真正的上限没测到；
 *   这里仍把 timestamp 当到期处理，宁可早换。不带签名、改动 encrypt 一位都是 403。
 *   清单里的每个分片各自带上游签好的 timestamp/encrypt（签发时刻，上海时间），去掉或改动同样 403；
 *   分片签名与清单签名无关，同一时刻用两条不同签名取清单，分片行逐字相同，所以换签名不打断播放。
 *   地址因此不能写进播放列表，播放时才取；30 分钟换一次、离 timestamp 至少还有 10 分钟时就换，
 *   接口故障时沿用上次成功的地址，直到离 timestamp 只剩 2 分钟。
 *
 * 请求头——CDN 不看来源头，也不挑播放器标识：不带 UA、Lavf、okhttp、浏览器 UA，
 *   不带 Referer 或带外站 Referer，清单与分片都是 200 / 206。分片可以由播放器直连，
 *   所以走 relay：本机每次轮询用缓存的签名地址中继清单，签名换新在服务端完成，
 *   `?relay=2` 仍可升级为全代理。
 *
 * 页面参数——专题 id 与 app_secret 都是页面里写死的常量，不是按访问下发的令牌。页面约 20 KB，
 *   只在换签名时顺带看一眼、一天最多读一次，读不到沿用上次读到的、十分钟后再试；从没读到过、
 *   或读到的参数取不出这一路（页面默认频道换成了别的专题），就用频道表里的内置值。
 *
 * 地域——官网页面、接口与 CDN 只对大陆网络开放：Globalping 香港、东京、新加坡、洛杉矶、
 *   法兰克福探针全部连接超时，北京探针正常。
 */
import { proxyAwareFetch } from '../../utils/systemProxy.js'
import { CHANNELS, QHTB_TV_PAGE, SITE_APP_SECRET } from './channels.js'

export const QHTB_ORIGIN = 'https://www.qhtb.cn'
export const TOPIC_DETAIL_API = 'https://mapi.qhbtv.com.cn/cloudlive-manage-mapi/api/topic/detail'

const MEDIA_HOST = 'live.qhbtv.com.cn'
const PAGE_REFRESH_MS = 24 * 60 * 60 * 1000
const PAGE_RETRY_MS = 10 * 60 * 1000
const PAGE_TIMEOUT_MS = 8000
// 签名标称两小时：半小时一换，给接口故障留出一个半小时的余量
const STREAM_REFRESH_MS = 30 * 60 * 1000
const STREAM_RENEW_BEFORE_MS = 10 * 60 * 1000
const STREAM_MIN_REFRESH_MS = 60 * 1000
const STREAM_RETRY_MS = 30 * 1000
// 到期前两分钟就不再发出去：播放器拿到后还要轮询一阵
const SIGNATURE_MARGIN_MS = 2 * 60 * 1000
const MAX_SIGNATURE_MS = 24 * 60 * 60 * 1000
// 读不出过期时刻（参数改了、或本机钟偏了两小时以上）时的保守窗口
const FALLBACK_REFRESH_MS = 5 * 60 * 1000
const FALLBACK_USABLE_MS = 10 * 60 * 1000
// 页面约 20 KB、接口约 6 KB
const MAX_RESPONSE_BYTES = 1024 * 1024
const TOPIC_ID_RE = /^\d{10,24}$/
const APP_SECRET_RE = /^[0-9a-f]{32}$/
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

export { CHANNELS }

const CHANNEL_BY_REF = new Map(CHANNELS.map(channel => [channel.ref, channel]))
const STREAM_NAMES = new Set(CHANNELS.map(channel => channel.stream))

function safeUrl(raw, label) {
  try {
    return new URL(String(raw || '').trim())
  } catch {
    throw new Error(`青海藏语台返回了无效${label}地址`)
  }
}

/** 媒体主机上的直播清单 /<流名>/<档位>/live.m3u8 或分片 /<流名>_<档位>/<数字>/<数字>.ts → 流名；别的一律拒绝。 */
function mediaStreamName(url) {
  const ok = url.protocol === 'https:' && url.hostname === MEDIA_HOST
    && !url.username && !url.password && ['', '443'].includes(url.port) && !url.hash
  const match = ok && (/^\/([a-z0-9]{1,32})\/[a-z0-9]{1,16}\/live\.m3u8$/.exec(url.pathname)
    || /^\/([a-z0-9]{1,32})_[a-z0-9]{1,16}\/\d{1,16}\/\d{1,16}\.ts$/.exec(url.pathname))
  if (!match) throw new Error('青海藏语台返回了非官方媒体地址')
  return match[1]
}

/**
 * 频道表里这几路的直播清单与分片。relay 下分片由播放器直连，用不到这里；
 * `?relay=2` 升级成全代理时，代理层登记每条子清单/分片前经它过一遍。
 */
export function officialAssetUrl(raw) {
  const url = safeUrl(raw, '媒体')
  if (!STREAM_NAMES.has(mediaStreamName(url))) throw new Error('青海藏语台返回了频道表以外的媒体地址')
  return url.href
}

/** 官网直播页脚本 → { topicId, appSecret }；页面改版取不到时抛错。 */
export function parsePlayerPage(html) {
  const text = String(html || '')
  const topicId = /\bcurrent_channel\s*=\s*['"](\d{10,24})['"]/.exec(text)?.[1]
  const appSecret = /\bapp_secret\s*:\s*['"]([0-9a-f]{32})['"]/.exec(text)?.[1]
  if (!topicId || !appSecret) throw new Error('青海藏语台官网直播页里没有找到播放器参数')
  return { topicId, appSecret }
}

export function buildDetailUrl({ topicId, appSecret }) {
  if (!TOPIC_ID_RE.test(String(topicId)) || !APP_SECRET_RE.test(String(appSecret))) {
    throw new Error('青海藏语台频道参数格式无效')
  }
  const url = new URL(TOPIC_DETAIL_API)
  url.searchParams.set('id', topicId)
  url.searchParams.set('tenant_id', '0')
  url.searchParams.set('app_secret', appSecret)
  return url.href
}

function parseJson(payload, label) {
  if (typeof payload !== 'string') return payload
  try {
    return JSON.parse(payload.trim())
  } catch {
    throw new Error(`青海藏语台${label}没有返回有效 JSON`)
  }
}

/**
 * 频道详情 → 这一路的签名清单地址。只认本频道流名下带齐签名的直播清单：
 * 页面默认频道若换成了广播，接口给的是另一个流名，在这里就被拒掉。
 */
export function parseDetail(payload, channel) {
  const data = parseJson(payload, '频道接口')
  // 出错时 HTTP 仍是 200，正文 { error_code, error_message, result: [] }；成功时没有 error_code
  if (data?.error_code != null && Number(data.error_code) !== 200) {
    throw new Error(`青海藏语台频道接口拒绝：${data.error_message || data.error_code}`)
  }
  const streams = (Array.isArray(data?.topic_camera) ? data.topic_camera : [])
    .flatMap(camera => (Array.isArray(camera?.streams) ? camera.streams : []))
  const hls = streams.map(stream => stream?.hls).filter(value => typeof value === 'string')
  if (!hls.length) throw new Error(`青海藏语台没有返回${channel.name}的直播地址`)
  const official = hls.flatMap(value => {
    try {
      const url = new URL(value)
      return mediaStreamName(url) && url.pathname.endsWith('.m3u8') ? [url] : []
    } catch {
      return []
    }
  })
  if (!official.length) throw new Error('青海藏语台返回了非官方媒体地址')
  const own = official.find(url => mediaStreamName(url) === channel.stream)
  if (!own) throw new Error(`青海藏语台返回的不是${channel.name}的直播流`)
  if (!/^[0-9a-f]{32}$/i.test(own.searchParams.get('encrypt') || '')
      || !/^\d{9,11}$/.test(own.searchParams.get('timestamp') || '')) {
    throw new Error(`${channel.name}播放地址缺少有效签名`)
  }
  return own.href
}

/** 按签名里标称的过期时刻排换新时间；读不出、或与本机钟对不上时走保守窗口。 */
export function signatureWindow(url, now) {
  const expiresAt = Number(new URL(url).searchParams.get('timestamp')) * 1000
  const left = expiresAt - now
  if (!(left > SIGNATURE_MARGIN_MS && left <= MAX_SIGNATURE_MS)) {
    return { refreshAt: now + FALLBACK_REFRESH_MS, usableUntil: now + FALLBACK_USABLE_MS }
  }
  return {
    refreshAt: now + Math.max(STREAM_MIN_REFRESH_MS, Math.min(STREAM_REFRESH_MS, left - STREAM_RENEW_BEFORE_MS)),
    usableUntil: expiresAt - SIGNATURE_MARGIN_MS,
  }
}

async function readText(response, label) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error(`青海藏语台${label}响应过大`)
  }
  const text = await response.text()
  if (text.length > MAX_RESPONSE_BYTES) throw new Error(`青海藏语台${label}响应过大`)
  if (!response.ok) throw new Error(`青海藏语台${label} HTTP ${response.status}`)
  return text
}

async function requestText(url, label, { timeoutMs = 15000, fetchImpl = proxyAwareFetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      redirect: 'manual',
      signal: controller.signal,
      // 页面和接口实测都不校验来源头与 UA；照官网页面的样子带上，不给它们多一个拒绝的理由
      headers: {
        Accept: 'application/json, text/html, */*',
        Referer: QHTB_TV_PAGE,
        Origin: QHTB_ORIGIN,
        'User-Agent': UA,
      },
    })
    return await readText(response, label)
  } finally {
    clearTimeout(timer)
  }
}

// 页面参数：{ value: 最近一次读到的参数或 null, refreshAt }
let page = { value: null, refreshAt: 0 }
let pagePending = null

/** 一天读一次页面；读不到沿用上次的值（可能是 null），十分钟后再试。从不抛错。 */
function playerParams(options, now) {
  if (page.refreshAt > now) return Promise.resolve(page.value)
  if (!pagePending) {
    const pageOptions = { ...options, timeoutMs: Math.min(options.timeoutMs, PAGE_TIMEOUT_MS) }
    const promise = requestText(QHTB_TV_PAGE, '官网直播页', pageOptions)
      .then(parsePlayerPage)
      .then(
        value => { page = { value, refreshAt: now + PAGE_REFRESH_MS }; return value },
        () => { page = { value: page.value, refreshAt: now + PAGE_RETRY_MS }; return page.value },
      )
      .finally(() => { if (pagePending === promise) pagePending = null })
    pagePending = promise
  }
  return pagePending
}

async function loadStream(channel, options, now) {
  const builtin = { topicId: channel.topicId, appSecret: SITE_APP_SECRET }
  const fromPage = await playerParams(options, now)
  const candidates = [fromPage, builtin].filter((params, index, list) => params && list.findIndex(other => (
    other && other.topicId === params.topicId && other.appSecret === params.appSecret
  )) === index)
  let lastError
  for (const params of candidates) {
    try {
      return parseDetail(await requestText(buildDetailUrl(params), '频道接口', options), channel)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

// 频道 ref → { url, refreshAt, usableUntil, retryAt }
const streams = new Map()
const pending = new Map()

/** 到期才重取；重取失败时在签名到期前沿用最近一次成功地址并退避，到期了照实报错。 */
async function currentStream(channel, options, now) {
  const hit = streams.get(channel.ref)
  if (hit && hit.usableUntil > now && (hit.refreshAt > now || hit.retryAt > now)) return hit.url

  let active = pending.get(channel.ref)
  if (!active) {
    const promise = loadStream(channel, options, now)
      .then(url => {
        streams.set(channel.ref, { url, ...signatureWindow(url, now), retryAt: 0 })
        return url
      })
      .finally(() => {
        if (pending.get(channel.ref) === promise) pending.delete(channel.ref)
      })
    active = promise
    pending.set(channel.ref, promise)
  }

  try {
    return await active
  } catch (error) {
    if (!hit || hit.usableUntil <= now) throw error
    hit.retryAt = now + STREAM_RETRY_MS
    return hit.url
  }
}

export function buildChannels() {
  return CHANNELS.map(channel => ({
    name: channel.name,
    deferredRef: channel.ref,
    logo: channel.logo,
    groupTitle: '青海',
    opts: ['network-caching=3000'],
    catchup: 'none',
  }))
}

export function claimsRef(ref) {
  return CHANNEL_BY_REF.has(String(ref || ''))
}

export async function resolveChannel(ref, ctx = {}) {
  const channel = CHANNEL_BY_REF.get(String(ref || ''))
  if (!channel) return { url: '', desc: '青海频道引用格式错误' }
  const options = { timeoutMs: ctx.timeoutMs || 15000, fetchImpl: ctx.fetchImpl || proxyAwareFetch }
  try {
    const url = await currentStream(channel, options, Number(ctx.now ?? Date.now()))
    return {
      url,
      desc: `${channel.name}当前直播地址获取成功`,
      // 旧的无后缀入口也直出清单：302 出去的签名地址到了播放器手里就不再续期
      relayHls: true,
      upstreamUrlTransform: officialAssetUrl,
    }
  } catch (error) {
    const reason = error?.name === 'AbortError'
      ? `超时 ${options.timeoutMs}ms`
      : (error?.message || String(error))
    return { url: '', desc: `青海藏语台链接请求失败：${reason}` }
  }
}

export function clearCache() {
  streams.clear()
  pending.clear()
  page = { value: null, refreshAt: 0 }
  pagePending = null
}
