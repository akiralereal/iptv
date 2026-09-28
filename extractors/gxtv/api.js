/**
 * 广西网络台的平台 API 与频道筛选。
 *
 * 官网接口会把正式频道、CETV 转播、购物频道、内部推流和专题矩阵号混在同一份 rows 里。
 * 这里用明确白名单，而不是把所有带 m3u8 的行直接暴露给用户：测试/矩阵流没有
 * 稳定性承诺，也可能与正式频道重复。
 */
import fetch from 'node-fetch'
import { CHANNELS } from './channels.js'
import { decryptGxtvTs } from './decrypt.js'

export const CHANNEL_LIST_URL = 'https://api2019.gxtv.cn/memberApi/channel/channelList'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const CHANNEL_BY_RAW_NAME = new Map(CHANNELS.map(channel => [channel.rawName, channel]))
const CHANNEL_BY_REF = new Map(CHANNELS.map(channel => [channel.ref, channel]))
// 官网可能在 URL 不变时轮换 encodingKey。播放中的代理会持续拉本地清单，因此
// 30 分钟到期后第一轮清单请求即可更新整张频道表；接口抖动时保留旧值并一分钟后重试。
const STREAM_CACHE_TTL_MS = 30 * 60 * 1000
const STREAM_RETRY_MS = 60 * 1000
const streamCache = new Map()
let streamRefreshPromise = null

/** 只接受 HTTP(S) HLS，接口里的空串、FLV 和 Java 对象字符串都不能进播放列表。 */
export function streamUrlOf(row) {
  const candidates = [
    row?.encodeM3u8,
    row?.decodeM3u8,
    row?.source0M3u8,
    row?.channelM3u8,
    row?.subjectM3u8,
  ]
  for (const candidate of candidates) {
    const text = String(candidate || '').trim()
    if (!/^https?:\/\//i.test(text)) continue
    try {
      const url = new URL(text)
      if (/\.m3u8(?:$|[?#])/i.test(url.href)) return url.href
    } catch { /* 换下一个字段 */ }
  }
  return ''
}

/**
 * rows → 官网正式频道。按白名单顺序输出，因此 API 调整 displayOrder 不会让用户
 * 的播放列表每次刷新都乱序；同名重复行只取第一条有可播地址的。
 */
export function buildChannelGroups(rows) {
  const candidates = new Map()

  for (const row of Array.isArray(rows) ? rows : []) {
    const definition = CHANNEL_BY_RAW_NAME.get(String(row?.name || '').trim())
    if (!definition || Number(row?.state) !== 1 || Number(row?.showChannel) !== 1) continue
    const url = streamUrlOf(row)
    if (!url || candidates.has(definition.rawName)) continue
    candidates.set(definition.rawName, {
      name: definition.name,
      deferredRef: definition.ref,
      // 广西 CDN 在部分浏览器/电视端会被客户端网络层拦截；让写盘层生成
      // /proxy/<ref>.m3u8，清单与分片都经本机现有 HLS 全代理转发。
      proxyHls: true,
      logo: String(row?.logo || '').trim(),
    })
  }

  const main = []
  for (const definition of CHANNELS) {
    const channel = candidates.get(definition.rawName)
    if (!channel) continue
    main.push(channel)
  }

  return main.length ? [{ name: '广西电视台', dataList: main }] : []
}

/** 把本轮频道接口里的正式流地址放进播放解析缓存。 */
export function primeStreamCache(rows, now = Date.now()) {
  const found = new Set()
  for (const row of Array.isArray(rows) ? rows : []) {
    const definition = CHANNEL_BY_RAW_NAME.get(String(row?.name || '').trim())
    if (!definition || found.has(definition.ref)) continue
    if (Number(row?.state) !== 1 || Number(row?.showChannel) !== 1) continue
    const url = streamUrlOf(row)
    if (!url) continue
    found.add(definition.ref)
    streamCache.set(definition.ref, {
      url,
      customId: String(row?.encodingId || '').trim(),
      contentId: String(row?.encodingKey || '').trim(),
      expiresAt: Number(now) + STREAM_CACHE_TTL_MS,
      retryAt: 0,
    })
  }
}

export function clearStreamCache() {
  streamCache.clear()
  streamRefreshPromise = null
}

async function refreshStreamCache(ctx, now) {
  if (!streamRefreshPromise) {
    streamRefreshPromise = fetchChannelRows({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl })
      .then(rows => {
        primeStreamCache(rows, now)
        return rows
      })
      .finally(() => { streamRefreshPromise = null })
  }
  return streamRefreshPromise
}

/** 播放入口只返回上游地址；本地 HLS 全代理由 app.js 的通用代理链完成。 */
export async function resolveChannel(ref, ctx = {}) {
  try {
    const key = String(ref || '')
    if (!CHANNEL_BY_REF.has(key)) return { url: '', desc: '广西网络台频道引用格式错误' }
    const now = Number(ctx.now ?? Date.now())
    let cached = streamCache.get(key)
    let staleFallback = false
    if (!cached || cached.expiresAt <= now) {
      if (!cached || !cached.retryAt || cached.retryAt <= now) {
        try {
          await refreshStreamCache(ctx, now)
        } catch (error) {
          if (!cached) throw error
          cached.retryAt = now + STREAM_RETRY_MS
          staleFallback = true
        }
        cached = streamCache.get(key) || cached
        // 接口本身成功但这一轮临时漏了当前频道，也不能把旧频道打掉，更不能让
        // 播放器每几秒轮询清单时每次都重打 API。
        if (cached?.expiresAt <= now) {
          cached.retryAt = now + STREAM_RETRY_MS
          staleFallback = true
        }
      } else {
        staleFallback = true
      }
    }
    if (!cached?.url) return { url: '', desc: `广西网络台频道 ${key} 当前没有可用流` }
    const segmentTransform = cached.customId && cached.contentId
      ? buffer => {
          decryptGxtvTs(buffer, cached.customId, cached.contentId)
          return buffer
        }
      : undefined
    return {
      url: cached.url,
      desc: staleFallback ? '广西网络台刷新暂时失败，沿用上一份可用地址' : '广西网络台地址获取成功',
      segmentTransform,
    }
  } catch (error) {
    return { url: '', desc: `广西网络台链接请求失败：${error?.message || String(error)}` }
  }
}

export async function fetchChannelRows({ timeoutMs = 10000, fetchImpl = fetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(CHANNEL_LIST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA,
        Referer: 'https://tv.gxtv.cn/',
        Accept: 'application/json',
      },
      body: new URLSearchParams({ pageNo: '1', pageSize: '1000', liveMethod: '0' }).toString(),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = await response.json()
    if (Number(payload?.code) !== 0 || !Array.isArray(payload?.data?.rows)) {
      throw new Error(payload?.message || '返回结构不符合预期')
    }
    return payload.data.rows
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : (error?.message || String(error))
    throw new Error(`广西网络台频道接口请求失败：${reason}`)
  } finally {
    clearTimeout(timer)
  }
}
