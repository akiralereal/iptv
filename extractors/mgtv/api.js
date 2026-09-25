/** 芒果 TV 官方电视直播频道、播放签名与短期地址缓存。 */
import { createHash, randomUUID } from 'node:crypto'
import fetch from 'node-fetch'

export const CHANNEL_LIST_URL = 'https://mpplive.api.mgtv.com/v1/epg/turnplay/getLiveAssetCategoryList'
export const LIVE_SOURCE_URL = 'https://pwlp.bz.mgtv.com/v1/live/source'

// 官网播放器公开携带的请求签名盐。它不是用户凭据，但属于易变的平台实现细节。
const SIGN_SECRET = 'LMFwh1k1m@pvt#Pt'
const SOURCE_REFRESH_MS = 60 * 60 * 1000
const SOURCE_RETRY_MS = 60 * 1000
const SOURCE_EXPIRY_SKEW_MS = 30 * 1000
const DEVICE_ID = randomUUID()
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export const UPSTREAM_HEADERS = {
  Origin: 'https://www.mgtv.com',
  Referer: 'https://www.mgtv.com/',
}

// 只收录官网“电视台”栏目里的固定频道。快乐购是购物频道，固定排除。
// 台标取频道表的 channel_image；芒果给快乐垂钓和长沙两台的是空的。长沙两台改用长沙广电官网
// 「旗下媒体」列表（prd-csgd-service.zhcs.csbtv.com …/info/queryInfoList?infoClass=10）的频道图标，
// 优先于芒果的图。快乐垂钓留空：芒果频道表与频道详情都没有图，原官网 happyfishing.com.cn 已改挂影视站。
const CHANNELS = [
  { id: '287', name: '金鹰卡通' },
  { id: '280', name: '湖南经视' },
  { id: '344', name: '湖南娱乐' },
  { id: '221', name: '湖南电影' },
  { id: '346', name: '湖南都市' },
  { id: '484', name: '湖南电视剧' },
  { id: '316', name: '金鹰纪实' },
  { id: '261', name: '湖南爱晚' },
  { id: '229', name: '湖南国际' },
  { id: '218', name: '快乐垂钓' },
  { id: '269', name: '长沙新闻综合', logo: 'https://cdn-fuse-oss.csbtv.com/images/65f7ea404b8c490001598c61.png' },
  { id: '254', name: '长沙政法', logo: 'https://cdn-oss.zhcs.csbtv.com/zhcs-prd/images/776123021898420224.png' },
]

const CHANNEL_BY_ID = new Map(CHANNELS.map(channel => [channel.id, channel]))
const sourceCache = new Map()
const sourcePending = new Map()

function normalizeLogo(raw) {
  return String(raw || '').trim().replace(/^http:\/\//i, 'https://')
}

function validChannelId(raw) {
  const id = String(raw || '').trim()
  return /^\d{1,8}$/.test(id) ? id : ''
}

function officialStreamUrl(raw) {
  try {
    const url = new URL(String(raw || '').trim())
    const officialHost = url.hostname === 'mgtv.com'
      || url.hostname.endsWith('.mgtv.com')
      || url.hostname === 'hitv.com'
      || url.hostname.endsWith('.hitv.com')
      || url.hostname === 'imgo.tv'
      || url.hostname.endsWith('.imgo.tv')
    return url.protocol === 'https:' && officialHost && /\.m3u8$/i.test(url.pathname)
      ? url.href
      : ''
  } catch {
    return ''
  }
}

/** 官网分类里频道会重复出现；固定按白名单顺序输出并排除购物频道。 */
export function buildChannels(rows) {
  const found = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = validChannelId(row?.id)
    if (!CHANNEL_BY_ID.has(id) || found.has(id)) continue
    found.set(id, row)
  }
  return CHANNELS.flatMap(definition => {
    const row = found.get(definition.id)
    if (!row) return []
    return [{
      name: definition.name,
      deferredRef: `mgtv-${definition.id}`,
      // 官网 CDN 对清单和分片都校验 Origin/Referer，必须经本机全代理。
      proxyHls: true,
      logo: definition.logo || normalizeLogo(row?.channel_image),
    }]
  })
}

async function requestJson(url, { timeoutMs = 10000, fetchImpl = fetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      headers: {
        ...UPSTREAM_HEADERS,
        'User-Agent': UA,
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
  const query = new URLSearchParams({
    version: 'PCweb_1.0',
    platform: '4',
    media_asset_id: 'TVStationAll',
    buss_id: '2000001',
    _support: '10000000',
  })
  const payload = await requestJson(`${CHANNEL_LIST_URL}?${query}`, options)
  const categories = payload?.data?.category
  if (String(payload?.errno) !== '0' || !Array.isArray(categories)) {
    throw new Error(`频道接口返回异常：${payload?.msg || payload?.errno || '结构不符合预期'}`)
  }
  return categories.flatMap(category => Array.isArray(category?.channels) ? category.channels : [])
}

/** 官网签名：MD5(secret + 按 key 排序的 key/value 串 + secret)，结果转大写。 */
export function signSourceParams(params) {
  const flattened = Object.keys(params || {})
    .filter(key => params[key] != null)
    .sort()
    .map(key => `${key}${params[key]}`)
    .join('')
  return createHash('md5').update(`${SIGN_SECRET}${flattened}${SIGN_SECRET}`).digest('hex').toUpperCase()
}

export function buildSourceRequest(channelId, { now = Date.now(), deviceId = DEVICE_ID } = {}) {
  const id = validChannelId(channelId)
  if (!id || !CHANNEL_BY_ID.has(id)) throw new Error('频道 ID 无效')
  const did = String(deviceId || DEVICE_ID)
  const params = {
    cameraId: id,
    activityId: '',
    platform: '4',
    appVersion: 'imgotv-pch5-1.2.3',
    clientKey: 'pcweb',
    auth_mode: '1',
    local_definition: '',
    init_definition: '2',
    did,
    uid: '',
    token: '',
    _t: String(Math.trunc(Number(now))),
    deviceId: did,
    hdts: 'h265,h264',
    lls: 1,
    supportFlv: 1,
  }
  const query = new URLSearchParams({
    ...params,
    _support: '10000000',
    sign: signSourceParams(params),
  })
  return `${LIVE_SOURCE_URL}?${query}`
}

/** 固定选官网返回的最高 definition；同档优先兼容性更好的 H.264。 */
export function selectHighestSource(data) {
  return (Array.isArray(data?.sources) ? data.sources : [])
    .map(source => ({ ...source, url: officialStreamUrl(source?.url) }))
    .filter(source => source.url && String(source?.format || '').toLowerCase() === '.m3u8')
    .sort((a, b) => {
      const byDefinition = Number(b?.definition || 0) - Number(a?.definition || 0)
      if (byDefinition) return byDefinition
      const aH264 = /h264|avc/i.test(String(a?.videoFormat || '')) ? 1 : 0
      const bH264 = /h264|avc/i.test(String(b?.videoFormat || '')) ? 1 : 0
      return bH264 - aH264
    })[0] || null
}

export async function fetchLiveSource(channelId, options = {}) {
  const payload = await requestJson(buildSourceRequest(channelId, options), options)
  if (Number(payload?.code) !== 0 || !payload?.data) {
    throw new Error(`播放接口返回异常：${payload?.msg || payload?.code || '没有播放信息'}`)
  }
  const source = selectHighestSource(payload.data)
  if (!source) throw new Error(`频道 ${channelId} 当前没有可用的 HLS 视频流`)
  return { source, name: String(payload.data.activityName || payload.data.cameraName || '') }
}

async function cachedLiveSource(channelId, options = {}) {
  const now = Number(options.now ?? Date.now())
  const cached = sourceCache.get(channelId)
  if (cached?.refreshAt > now) return { ...cached, staleFallback: false }
  if (cached?.retryAt > now && cached?.hardExpiresAt > now) return { ...cached, staleFallback: true }

  let pending = sourcePending.get(channelId)
  if (!pending) {
    pending = fetchLiveSource(channelId, options)
      .then(result => {
        const durationMs = Math.max(5 * 60 * 1000, Math.min(24 * 60 * 60 * 1000,
          Number(result.source.urlExpireDuration || 0) * 1000 || 8 * 60 * 60 * 1000))
        const hardExpiresAt = now + Math.max(60 * 1000, durationMs - SOURCE_EXPIRY_SKEW_MS)
        const entry = {
          ...result,
          refreshAt: now + Math.min(SOURCE_REFRESH_MS, Math.max(60 * 1000, durationMs / 2)),
          hardExpiresAt,
          retryAt: 0,
        }
        sourceCache.set(channelId, entry)
        return entry
      })
      .finally(() => {
        if (sourcePending.get(channelId) === pending) sourcePending.delete(channelId)
      })
    sourcePending.set(channelId, pending)
  }

  try {
    return { ...await pending, staleFallback: false }
  } catch (error) {
    if (!cached || cached.hardExpiresAt <= now) throw error
    cached.retryAt = now + SOURCE_RETRY_MS
    return { ...cached, staleFallback: true }
  }
}

export async function resolveChannel(ref, ctx = {}) {
  try {
    const match = /^mgtv-(\d{1,8})$/.exec(String(ref || ''))
    if (!match || !CHANNEL_BY_ID.has(match[1])) return { url: '', desc: '芒果 TV 频道引用格式错误' }
    const cached = await cachedLiveSource(match[1], {
      timeoutMs: ctx.timeoutMs,
      fetchImpl: ctx.fetchImpl,
      now: ctx.now,
      deviceId: ctx.deviceId,
    })
    return {
      url: cached.source.url,
      desc: cached.staleFallback
        ? `${cached.name || match[1]}播放地址刷新暂时失败，沿用上一份可用地址`
        : `${cached.name || match[1]}${cached.source.name || '最高画质'}播放地址获取成功`,
      upstreamHeaders: UPSTREAM_HEADERS,
    }
  } catch (error) {
    return { url: '', desc: `芒果 TV 链接请求失败：${error?.message || String(error)}` }
  }
}

export function clearCache() {
  sourceCache.clear()
  sourcePending.clear()
}
