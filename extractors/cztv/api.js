/** 浙江新蓝网的平台 API、选流与 auth_key 签名。 */
import { createHash } from 'node:crypto'
import fetch from 'node-fetch'

export const CHANNEL_LIST_URL = 'https://p.cztv.com/api/paas/channel/tv'
export const PLAY_INFO_URL = 'https://zlive-das.cztv.com/zapp/live/tv/channel/playInfo'

// 当前官网播放器使用的公开前端签名盐。它不是用户凭据，但属于易变的平台实现细节。
const AUTH_SALT = 'CHWr9VybUeBZE1VB'
const PLAY_INFO_TTL_MS = 5 * 60 * 1000
const PLAY_INFO_RETRY_MS = 60 * 1000
const STREAM_CHOICE_TTL_MS = 15 * 1000
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const NAME_OVERRIDES = {
  浙江卫视: '浙江卫视',
  钱江都市: '钱江都市',
  经济生活: '浙江经济生活',
  教科影视: '浙江教科影视',
  民生休闲: '浙江民生休闲',
  新闻: '浙江新闻',
  少儿频道: '浙江少儿',
  浙江国际: '浙江国际',
  好易购: '好易购',
  之江纪录: '之江纪录',
}

const playInfoCache = new Map()
const playInfoPending = new Map()
const streamChoiceCache = new Map()

function normalizeLogo(raw) {
  return String(raw || '').trim().replace(/^http:\/\//i, 'https://')
}

function validChannelId(raw) {
  const id = String(raw || '').trim()
  return /^\d{1,8}$/.test(id) ? id : ''
}

export function buildChannels(rows) {
  const seen = new Set()
  const channels = []
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = validChannelId(row?.station_code)
    const rawName = String(row?.name || '').trim()
    const name = NAME_OVERRIDES[rawName]
    if (!id || !name || seen.has(id)) continue
    // 购物频道固定排除，不再向用户暴露开关。
    if (rawName === '好易购') continue
    seen.add(id)
    channels.push({
      name,
      deferredRef: `cztv-${id}`,
      // 清单由本机转发、分片仍由播放器直连 CDN。这样播放过程中每次刷新清单
      // 都能重新签名并在多个官方 CDN 节点之间故障切换。
      relayHls: true,
      catchup: 'none',
      logo: normalizeLogo(row?.logo || row?.tvLogo),
    })
  }
  return channels
}

/** 按用户画质偏好选一条视频 HLS；没有目标档时回落到其它视频档，不回落音频。 */
export function streamCandidates(playInfo, preferredQuality = '1080P') {
  const streams = Array.isArray(playInfo?.multiBitrateStreamList)
    ? playInfo.multiBitrateStreamList
    : []
  const wanted = preferredQuality === '720P' ? ['720P', '1080P'] : ['1080P', '720P']
  const byCode = new Map(streams.map(stream => [String(stream?.bitrateCode || '').toUpperCase(), stream]))
  const ordered = [
    ...wanted.map(code => byCode.get(code)).filter(Boolean),
    ...streams.filter(stream => {
      const code = String(stream?.bitrateCode || '').toUpperCase()
      return code !== 'AUDIO' && !wanted.includes(code)
    }),
  ]
  const candidates = []
  const seen = new Set()
  for (const stream of ordered) {
    for (const rawUrl of Array.isArray(stream?.urlList) ? stream.urlList : []) {
      const url = String(rawUrl || '').trim()
      if (!/^https?:\/\/.*\.m3u8(?:$|[?#])/i.test(url) || seen.has(url)) continue
      seen.add(url)
      candidates.push({ url, bitrate: String(stream?.bitrateCode || '') })
    }
  }
  return candidates
}

export function selectStream(playInfo, preferredQuality = '1080P') {
  return streamCandidates(playInfo, preferredQuality)[0] || null
}

/**
 * 官网当前签名：auth_key = timestamp-0-0-md5(path-timestamp-0-0-salt)。
 * timestamp 使用毫秒，与网页 Date.now() 保持一致。
 */
export function signStreamUrl(rawUrl, now = Date.now()) {
  const url = new URL(rawUrl)
  if (!/^https?:$/.test(url.protocol) || !/\.m3u8$/i.test(url.pathname)) {
    throw new Error('播放地址不是 HTTP(S) HLS')
  }
  const timestamp = String(Math.trunc(Number(now)))
  if (!/^\d{10,16}$/.test(timestamp)) throw new Error('签名时间无效')
  const digest = createHash('md5')
    .update(`${url.pathname}-${timestamp}-0-0-${AUTH_SALT}`)
    .digest('hex')
  url.searchParams.set('auth_key', `${timestamp}-0-0-${digest}`)
  return url.href
}

async function requestJson(url, { timeoutMs = 10000, fetchImpl = fetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      headers: {
        'User-Agent': UA,
        Referer: 'https://www.cztv.com/',
        Accept: 'application/json',
      },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : (error?.message || String(error))
    throw new Error(reason)
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchChannelList(options = {}) {
  const payload = await requestJson(CHANNEL_LIST_URL, options)
  const rows = payload?.content?.list
  if (Number(payload?.state) !== 0 || !Array.isArray(rows)) {
    throw new Error(`浙江新蓝网频道接口返回异常：${payload?.alertMessage || payload?.message || '结构不符合预期'}`)
  }
  return rows
}

export async function fetchPlayInfo(channelId, options = {}) {
  const id = validChannelId(channelId)
  if (!id) throw new Error('频道 ID 无效')
  const url = `${PLAY_INFO_URL}?${new URLSearchParams({ channelId: id, platform: 'WEB' })}`
  const payload = await requestJson(url, options)
  if (payload?.success !== true || Number(payload?.code) !== 200 || !payload?.data) {
    throw new Error(`播放信息接口返回异常：${payload?.msg || payload?.message || payload?.code || '未知错误'}`)
  }
  return payload.data
}

async function cachedPlayInfo(channelId, options = {}) {
  const now = Number(options.now ?? Date.now())
  const cached = playInfoCache.get(channelId)
  if (cached && cached.expiresAt > now) return cached.data
  if (cached?.retryAt > now) return cached.data

  let pending = playInfoPending.get(channelId)
  if (!pending) {
    pending = fetchPlayInfo(channelId, options)
      .then(data => {
        if (!selectStream(data, '1080P')) {
          throw new Error(`浙江新蓝网频道 ${channelId} 本轮没有可用的视频流`)
        }
        playInfoCache.set(channelId, { data, expiresAt: now + PLAY_INFO_TTL_MS, retryAt: 0 })
        return data
      })
      .finally(() => {
        if (playInfoPending.get(channelId) === pending) playInfoPending.delete(channelId)
      })
    playInfoPending.set(channelId, pending)
  }

  try {
    return await pending
  } catch (error) {
    if (!cached) throw error
    cached.retryAt = now + PLAY_INFO_RETRY_MS
    return cached.data
  }
}

export function clearPlayInfoCache() {
  playInfoCache.clear()
  playInfoPending.clear()
  streamChoiceCache.clear()
}

async function probeSignedManifest(url, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': UA, Referer: 'https://www.cztv.com/', Accept: 'application/vnd.apple.mpegurl' },
      signal: controller.signal,
    })
    if (!response.ok) return false
    return (await response.text()).trimStart().startsWith('#EXTM3U')
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function selectReachableStream(channelId, data, preferredQuality, ctx, now) {
  const candidates = streamCandidates(data, preferredQuality)
  if (!candidates.length) return null

  // 单测注入的 fetchImpl 默认只模拟 JSON API；只有显式 probeFetchImpl，或生产环境
  // 使用真实 fetch 时才做 CDN 探测。
  const probeFetchImpl = ctx.probeFetchImpl || (ctx.fetchImpl ? null : fetch)
  if (!probeFetchImpl) return candidates[0]

  const cacheKey = `${channelId}:${preferredQuality || '1080P'}`
  const cached = streamChoiceCache.get(cacheKey)
  const cachedCandidate = cached && candidates.find(item => item.url === cached.url)
  if (cachedCandidate && cached.expiresAt > now) return cachedCandidate

  const ordered = cachedCandidate
    ? [cachedCandidate, ...candidates.filter(item => item.url !== cachedCandidate.url)]
    : candidates
  for (const candidate of ordered) {
    const signed = signStreamUrl(candidate.url, now)
    if (await probeSignedManifest(signed, { fetchImpl: probeFetchImpl, timeoutMs: ctx.timeoutMs })) {
      streamChoiceCache.set(cacheKey, { url: candidate.url, expiresAt: now + STREAM_CHOICE_TTL_MS })
      return candidate
    }
  }

  // 所有节点同时探测失败更可能是短暂网络抖动；若有上一条成功节点，仍把它交给
  // 中继层尝试，避免一次探测故障直接把播放入口变成空地址。
  return cachedCandidate || null
}

export async function resolveChannel(ref, ctx = {}) {
  try {
    const match = /^cztv-(\d{1,8})$/.exec(String(ref || ''))
    if (!match) return { url: '', desc: '浙江新蓝网频道引用格式错误' }
    const data = await cachedPlayInfo(match[1], {
      timeoutMs: ctx.timeoutMs,
      fetchImpl: ctx.fetchImpl,
      now: ctx.now,
    })
    const now = Number(ctx.now ?? Date.now())
    // 固定优先官网提供的最高视频档；1080P 缺失时仍自动回落到其它视频档。
    const selected = await selectReachableStream(match[1], data, '1080P', ctx, now)
    if (!selected) return { url: '', desc: `浙江新蓝网频道 ${match[1]} 当前没有可用的视频流` }
    return {
      url: signStreamUrl(selected.url, now),
      desc: `浙江新蓝网 ${selected.bitrate || '直播'}地址获取成功`,
      // 旧入口 /cztv-<id> 也应持续由本机刷新清单，不能只在启动时 302 到
      // 某一个 CDN 后就失去故障切换能力。
      relayHls: true,
    }
  } catch (error) {
    return { url: '', desc: `浙江新蓝网链接请求失败：${error?.message || String(error)}` }
  }
}
