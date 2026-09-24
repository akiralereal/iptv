/**
 * 云南广播电视台：云视网四套省级频道 + 七彩云端三套地方频道。
 *
 * 两条链路的取流方式完全不同，合在一个模块里是因为它们同属一家台、同落一个分组：
 *
 * 省级（tvlive.yntv.cn）——官网 getRq 接口按频道返回「当前这档节目」的 DVR 窗口
 *   路径 chunks_dvr_range-<起点>-<时长>.m3u8 外加一对 wsSecret/wsTime。签名是按路径
 *   签的：拿本轮签名去请求下一档节目的路径直接 403，所以不能预取、也不能把地址写死，
 *   只能每次播放请求前重新问一次接口。节目切换时下一次解析自然拿到新窗口。
 *   官网播放器自己反倒不换——它的换台代码是注释掉的，一档节目放完就停在那儿。
 *
 * 地方（hwapi.yntv.cn）——七彩云端 queryLivePage 目录按房间名下发当前机位地址，
 *   不带签名。目录里还有十几个其它地方台名字，但它们当前全部复用同一条 HLS，
 *   实验台核过，因此只收这三个互不重复的。
 *
 * 回源请求头也不同：省级两跳（清单与分片）都必须带官网 Referer，缺了连接直接被断；
 * 地方那条裸请求就能取。upstreamHeaders 用函数形态按目标主机分别给，别把一家的
 * 来源头发给另一家。
 */
import { proxyAwareFetch } from '../../utils/systemProxy.js'
import { CHANNELS } from './channels.js'

export const YNTV_PAGE = 'https://www.yntv.cn/live.html'
export const YNTV_ORIGIN = 'https://www.yntv.cn'
export const YNTV_PROGRAMME_API = 'https://yntv-api.yntv.cn/index/jmd/getRq'
export const QICAI_CATALOG_API = 'https://cloudxyapi.yntv.cn/api/xy/toc/v1/queryLivePage'
export const YNTV_MEDIA_ORIGIN = 'https://tvlive.yntv.cn'

const PROVINCIAL_HOST = 'tvlive.yntv.cn'
const LOCAL_HOST = 'hwapi.yntv.cn'
// 实测本轮签名五分钟后仍可用；30 秒刷新是为了跟住节目窗口切换，不是怕签名过期
const STREAM_REFRESH_MS = 30 * 1000
const STREAM_RETRY_MS = 5 * 1000
const STREAM_HARD_TTL_MS = 5 * 60 * 1000
const CATALOG_REFRESH_MS = 60 * 1000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const WEB_NAME_RE = /^[a-z]{1,32}$/
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

// 频道表在 channels.js，与节目单（epg.js）共用；这里照旧导出
export { CHANNELS }

const CHANNEL_BY_REF = new Map(CHANNELS.map(channel => [channel.ref, channel]))

function safeUrl(raw, label) {
  try {
    return new URL(String(raw || '').trim())
  } catch {
    throw new Error(`云南广电返回了无效${label}地址`)
  }
}

/** 全代理登记清单与分片前统一校验：两家媒体主机各自的目录，其余一律拒绝。 */
export function officialAssetUrl(raw) {
  const url = safeUrl(raw, '媒体')
  const ok = url.protocol === 'https:' && !url.username && !url.password
    && ['', '443'].includes(url.port) && !url.hash
    && !/%2f|%5c/i.test(url.pathname)
    && /\.(m3u8|ts)$/i.test(url.pathname)
    && (url.hostname === PROVINCIAL_HOST
      ? /^\/live\/[a-z]{1,32}\/[A-Za-z0-9_.-]{1,128}$/.test(url.pathname)
      : url.hostname === LOCAL_HOST
        && /^\/[A-Za-z0-9]{1,32}\/[A-Za-z0-9_.-]{1,128}$/.test(url.pathname))
  if (!ok) throw new Error('云南广电返回了非官方媒体地址')
  return url.href
}

/**
 * 按目标主机给回源请求头。
 *
 * 省级 CDN 缺 Referer 时不是回 403 而是把连接晾着（实测五次全部连接超时），
 * 所以这一跳必须带；地方那条不需要，也不该把云视网的来源头发过去。
 * User-Agent 交给代理层统一改写，函数形态里也不声明。
 */
export function upstreamHeadersFor(raw) {
  const url = new URL(officialAssetUrl(raw))
  return url.hostname === PROVINCIAL_HOST ? { Referer: YNTV_PAGE, Origin: YNTV_ORIGIN } : {}
}

async function readText(response, label) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error(`云南广电${label}响应过大`)
  }
  const text = await response.text()
  if (text.length > MAX_RESPONSE_BYTES) throw new Error(`云南广电${label}响应过大`)
  if (!response.ok) throw new Error(`云南广电${label} HTTP ${response.status}`)
  return text
}

function parseJson(text, label) {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`云南广电${label}没有返回有效 JSON`)
  }
}

/**
 * 省级频道：接口给的是「当前节目」的 DVR 窗口路径加一对签名，拼出来就是播放地址。
 * 路径必须落在本频道自己的目录下——否则一个频道的签名就能被引去另一个频道。
 */
export function parseProgrammeResponse(payload, channel) {
  const data = typeof payload === 'string' ? parseJson(payload, '节目接口') : payload
  const path = data?.url
  if (typeof path !== 'string'
      || !new RegExp(`^/live/${channel.webName}/chunks_dvr_range-\\d{1,12}-\\d{1,6}\\.m3u8$`).test(path)) {
    throw new Error(`云视网${channel.name}没有返回当前节目直播路径`)
  }
  if (!/^[a-f0-9]{32}$/i.test(data?.string || '')) throw new Error(`云视网${channel.name}没有返回有效播放签名`)
  const time = Number(data?.time)
  if (!Number.isFinite(time) || time <= 0) throw new Error(`云视网${channel.name}没有返回有效签名时间`)
  const url = new URL(path, YNTV_MEDIA_ORIGIN)
  url.searchParams.set('wsSecret', data.string)
  url.searchParams.set('wsTime', String(Math.trunc(time)))
  return officialAssetUrl(url.href)
}

/** 七彩云端目录：按房间名挑当前在播、且有 HLS 机位的那一条。 */
export function parseCatalogResponse(payload, channel) {
  const data = typeof payload === 'string' ? parseJson(payload, '地方台目录') : payload
  const results = data?.data?.results
  if (data?.code !== 0 || !Array.isArray(results)) {
    throw new Error(data?.message || '七彩云端目录格式异常')
  }
  const room = results.find(item => item?.roomName === channel.room && item?.liveStatus === 'live')
  const live = room?.lives?.find(item => item?.isShow !== false && item?.cameraPositionStatus === 'live' && item?.stream)
    || room?.lives?.find(item => item?.isShow !== false && item?.stream)
  if (!live?.stream) throw new Error(`${channel.name}当前没有在线机位`)
  return officialAssetUrl(live.stream)
}

export function buildCatalogUrl() {
  const url = new URL(QICAI_CATALOG_API)
  for (const [name, value] of Object.entries({
    appCode: 'FABU_YUNSHI',
    companyId: 'ysxw',
    userId: 'anonymous',
    productId: '7F9A1B14E41B4259A34223A7D744C0DB',
    serviceCode: 'NEWUGC_YUNSHI',
    labelName: '地方台',
    currentPage: '1',
    pageNum: '100',
  })) url.searchParams.set(name, value)
  return url.href
}

async function requestProgramme(channel, { timeoutMs = 15000, fetchImpl = proxyAwareFetch } = {}) {
  if (!WEB_NAME_RE.test(channel.webName || '')) throw new Error('云视网频道标识非法')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${YNTV_PROGRAMME_API}?name=${channel.webName}`, {
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01',
        Referer: YNTV_PAGE,
        Origin: YNTV_ORIGIN,
        'User-Agent': UA,
      },
    })
    return parseProgrammeResponse(await readText(response, '节目接口'), channel)
  } finally {
    clearTimeout(timer)
  }
}

let catalogCache = { text: '', refreshAt: 0 }

async function requestCatalogText({ timeoutMs = 15000, fetchImpl = proxyAwareFetch, now = Date.now() } = {}) {
  if (catalogCache.text && catalogCache.refreshAt > now) return catalogCache.text
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(buildCatalogUrl(), {
      redirect: 'manual',
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': UA },
    })
    const text = await readText(response, '地方台目录')
    catalogCache = { text, refreshAt: now + CATALOG_REFRESH_MS }
    return text
  } finally {
    clearTimeout(timer)
  }
}

const streamCache = new Map()
const streamPending = new Map()

async function requestStream(channel, options) {
  return channel.kind === 'yntv'
    ? requestProgramme(channel, options)
    : parseCatalogResponse(await requestCatalogText(options), channel)
}

async function cachedStream(channel, options = {}) {
  const now = Number(options.now ?? Date.now())
  const cached = streamCache.get(channel.ref)
  if (cached?.refreshAt > now || (cached?.retryAt > now && cached?.hardExpiresAt > now)) return cached.url

  let pending = streamPending.get(channel.ref)
  if (!pending) {
    const promise = requestStream(channel, { ...options, now })
      .then(url => {
        streamCache.set(channel.ref, {
          url,
          refreshAt: now + STREAM_REFRESH_MS,
          hardExpiresAt: now + STREAM_HARD_TTL_MS,
          retryAt: 0,
        })
        return url
      })
      .finally(() => {
        if (streamPending.get(channel.ref) === promise) streamPending.delete(channel.ref)
      })
    pending = promise
    streamPending.set(channel.ref, promise)
  }

  try {
    return await pending
  } catch (error) {
    // 接口抖动时沿用最近一次成功地址并退避重试；硬过期后照实报错
    if (!cached || cached.hardExpiresAt <= now) throw error
    cached.retryAt = now + STREAM_RETRY_MS
    return cached.url
  }
}

export function buildChannels() {
  return CHANNELS.map(channel => ({
    name: channel.name,
    deferredRef: channel.ref,
    logo: channel.logo,
    groupTitle: '云南',
    opts: ['network-caching=3000'],
    catchup: 'none',
  }))
}

export function claimsRef(ref) {
  return CHANNEL_BY_REF.has(String(ref || ''))
}

export async function resolveChannel(ref, ctx = {}) {
  const channel = CHANNEL_BY_REF.get(String(ref || ''))
  if (!channel) return { url: '', desc: '云南频道引用格式错误' }
  try {
    const url = await cachedStream(channel, {
      timeoutMs: ctx.timeoutMs,
      fetchImpl: ctx.fetchImpl,
      now: ctx.now,
    })
    return {
      url,
      desc: `${channel.name}当前直播地址获取成功`,
      upstreamHeaders: upstreamHeadersFor,
      upstreamUrlTransform: officialAssetUrl,
    }
  } catch (error) {
    streamCache.delete(channel.ref)
    const reason = error?.name === 'AbortError'
      ? `超时 ${ctx.timeoutMs || 15000}ms`
      : (error?.message || String(error))
    return { url: '', desc: `云南广电链接请求失败：${reason}` }
  }
}

export function clearCache() {
  streamCache.clear()
  streamPending.clear()
  catalogCache = { text: '', refreshAt: 0 }
}
