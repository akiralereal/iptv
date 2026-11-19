/** 上海松江客户端「松江融媒慢直播」公开场景清单。 */
import fetch from 'node-fetch'

export const SCENE_URL = 'https://media.sjmedia.net/json/live/1964/scene.json'
export const STREAM_HOST = 'xhmm-new-live.media.xinhuamm.net'

const SITE_ID = '570a50fba2c146ca9efa552ed8300ec4'
const SCENE_TTL_MS = 10 * 60 * 1000
const SCENE_RETRY_MS = 60 * 1000
const MIN_AUTH_REMAINING_MS = 60 * 1000
const USER_AGENT = 'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'

export const UPSTREAM_HEADERS = {
  Referer: 'https://media.sjmedia.net/statics/xhmm-live-h5/index.html#/?liveId=1964'
    + `&siteId=${SITE_ID}`,
  'User-Agent': USER_AGENT,
}

let sceneCache = null
let scenePending = null

function officialImage(raw) {
  try {
    const url = new URL(String(raw || '').trim().replace(/^http:\/\//i, 'https://'))
    return url.protocol === 'https:' && url.hostname === 'media.sjmedia.net'
      && /^\/live\/default\/image\/[A-Za-z0-9/_.-]+$/i.test(url.pathname)
      ? url.href : ''
  } catch {
    return ''
  }
}

export function isOfficialStreamUrl(raw, now = Date.now()) {
  try {
    const url = new URL(String(raw || '').trim())
    const auth = /^(\d{10})-[a-f0-9]{32}-0-[a-f0-9]{32}$/i.exec(url.searchParams.get('auth_key') || '')
    return url.protocol === 'https:'
      && url.hostname === STREAM_HOST
      && new RegExp(`^/liveExtendRecord/${SITE_ID}_[a-f0-9]{32}\\.m3u8$`, 'i').test(url.pathname)
      && auth
      && Number(auth[1]) * 1000 > Number(now) + MIN_AUTH_REMAINING_MS
  } catch {
    return false
  }
}

/** 只保留官方页面中标题明确的主慢直播，排除同一直播间里的内部测试场景。 */
export function normalizeScene(payload, now = Date.now()) {
  for (const item of Array.isArray(payload?.data) ? payload.data : []) {
    const resource = item?.resource
    if (String(item?.liveId) !== '1964' || String(item?.title || '').trim() !== '松江慢直播'
      || Number(item?.displayState) !== 1 || Number(item?.streamType) !== 3
      || String(resource?.liveId) !== '1964' || String(resource?.siteId || '') !== SITE_ID
      || Number(resource?.type) !== 3 || Number(resource?.useState) !== 1
      || !isOfficialStreamUrl(resource?.hlsUrl, now)) continue
    return {
      id: String(item.id || '2023'),
      name: '松江融媒慢直播',
      url: new URL(resource.hlsUrl).href,
      logo: officialImage(item.coverImg),
    }
  }
  return null
}

export async function fetchScene(options = {}) {
  const controller = new AbortController()
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 10000))
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await (options.fetchImpl || fetch)(SCENE_URL, {
      headers: { ...UPSTREAM_HEADERS, Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`场景清单 HTTP ${response.status}`)
    const row = normalizeScene(await response.json(), options.now ?? Date.now())
    if (!row) throw new Error('场景清单没有可用的主慢直播 HLS')
    return row
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : (error?.message || String(error))
    throw new Error(reason)
  } finally {
    clearTimeout(timer)
  }
}

export async function cachedScene(options = {}) {
  const now = Number(options.now ?? Date.now())
  if (sceneCache?.expiresAt > now || sceneCache?.retryAt > now) return sceneCache.row
  if (!scenePending) {
    scenePending = fetchScene(options)
      .then(row => {
        sceneCache = { row, expiresAt: now + SCENE_TTL_MS, retryAt: 0 }
        return row
      })
      .finally(() => { scenePending = null })
  }
  try {
    return await scenePending
  } catch (error) {
    if (!sceneCache || !isOfficialStreamUrl(sceneCache.row.url, now)) throw error
    sceneCache.retryAt = now + SCENE_RETRY_MS
    return sceneCache.row
  }
}

export function primeSceneCache(row, now = Date.now()) {
  if (!row || !isOfficialStreamUrl(row.url, now)) return
  sceneCache = { row, expiresAt: Number(now) + SCENE_TTL_MS, retryAt: 0 }
}

export function clearCache() {
  sceneCache = null
  scenePending = null
}

export function buildChannels(row) {
  return row ? [{
    name: row.name,
    deferredRef: 'songjiang-slow-live',
    relayHls: true,
    catchup: 'none',
    logo: row.logo || '',
    opts: ['network-caching=3000'],
  }] : []
}

export async function resolveChannel(ref, ctx = {}) {
  if (String(ref || '') !== 'songjiang-slow-live') {
    return { url: '', desc: '上海松江慢直播频道引用格式错误' }
  }
  try {
    const row = await cachedScene({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl, now: ctx.now })
    if (!isOfficialStreamUrl(row.url, ctx.now ?? Date.now())) {
      return { url: '', desc: '上海松江官方场景清单中的播放地址已过期' }
    }
    return {
      url: row.url,
      desc: `${row.name}播放地址获取成功`,
      relayHls: true,
      upstreamHeaders: UPSTREAM_HEADERS,
    }
  } catch (error) {
    return { url: '', desc: `上海松江慢直播链接请求失败：${error?.message || String(error)}` }
  }
}
