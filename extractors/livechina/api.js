/** 央视网「直播中国」公开景观目录。 */
import fetch from 'node-fetch'

export const CATALOG_URL = 'https://api.cntv.cn/newList/getMicroLiveChinaList'
export const PAGE_SIZE = 100

const CATALOG_TTL_MS = 4 * 60 * 60 * 1000
const CATALOG_RETRY_MS = 60 * 1000
const MAX_PAGES = 10
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export const UPSTREAM_HEADERS = {
  Referer: 'https://livechina.cctv.com/',
  Origin: 'https://livechina.cctv.com',
  'User-Agent': USER_AGENT,
}

let catalogCache = null
let catalogPending = null

export function catalogPageUrl(page = 1) {
  const url = new URL(CATALOG_URL)
  url.searchParams.set('region', '')
  url.searchParams.set('serviceId', 'livechina')
  url.searchParams.set('p', String(page))
  url.searchParams.set('n', String(PAGE_SIZE))
  url.searchParams.set('t', 'json')
  return url.href
}

function normalizeImage(raw) {
  try {
    const url = new URL(String(raw || '').trim().replace(/^http:\/\//i, 'https://'))
    return url.protocol === 'https:' && /(^|\.)img\.cctvpic\.com$/i.test(url.hostname) ? url.href : ''
  } catch {
    return ''
  }
}

function normalizePageUrl(raw, channelId) {
  try {
    const url = new URL(String(raw || '').trim())
    const pageMatch = /^\/live_zb\/LIVE(\d{1,8})\.html$/i.exec(url.pathname)
    if (url.protocol !== 'https:' || url.hostname !== 'livechina.cctv.com' || !pageMatch
      || url.searchParams.get('pageid') !== pageMatch[1]
      || url.searchParams.get('tag') !== 'MicroLiveType'
      || url.searchParams.get('isPlaying') !== channelId) return ''
    return url.href
  } catch {
    return ''
  }
}

/** 历史页面仍在目录中，但下线页面的 signalList 为空；只保留官网当前公开信号。 */
export function normalizeCatalog(payloads) {
  const rows = []
  const seen = new Set()
  for (const payload of Array.isArray(payloads) ? payloads : [payloads]) {
    if (Number(payload?.code) !== 200 || !Array.isArray(payload?.data)) continue
    for (const item of payload.data) {
      const region = String(item?.region || '').trim()
      for (const signal of Array.isArray(item?.signalList) ? item.signalList : []) {
        const id = String(signal?.channelId || '').trim()
        const name = String(signal?.name || item?.title || '').trim()
        const pageUrl = normalizePageUrl(signal?.livePublishUrl, id)
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !region || !name || !pageUrl || seen.has(id)) continue
        seen.add(id)
        rows.push({
          id,
          name,
          region,
          pageUrl,
          logo: normalizeImage(signal?.showImage || item?.liveChinaPcListCover),
        })
      }
    }
  }
  return rows
}

async function requestPage(page, options = {}) {
  const controller = new AbortController()
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 10000))
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await (options.fetchImpl || fetch)(catalogPageUrl(page), {
      headers: { ...UPSTREAM_HEADERS, Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`目录第 ${page} 页 HTTP ${response.status}`)
    const payload = await response.json()
    if (Number(payload?.code) !== 200 || !Array.isArray(payload?.data)) {
      throw new Error(`目录第 ${page} 页返回异常：${payload?.msg || '字段不完整'}`)
    }
    return payload
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : (error?.message || String(error))
    throw new Error(reason)
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchCatalog(options = {}) {
  const first = await requestPage(1, options)
  const total = Math.max(0, Number(first.total) || 0)
  const pageCount = Math.min(MAX_PAGES, Math.max(1, Math.ceil(total / PAGE_SIZE)))
  const rest = await Promise.allSettled(
    Array.from({ length: pageCount - 1 }, (_, index) => requestPage(index + 2, options)),
  )
  const payloads = [first]
  const warnings = []
  rest.forEach((result, index) => {
    if (result.status === 'fulfilled') payloads.push(result.value)
    else warnings.push(`央视景观目录第 ${index + 2} 页不可用：${result.reason?.message || result.reason}`)
  })
  const rows = normalizeCatalog(payloads)
  if (!rows.length) throw new Error('央视直播中国目录没有当前可播放的景观信号')
  return { rows, warnings, total }
}

export async function cachedCatalog(options = {}) {
  const now = Number(options.now ?? Date.now())
  if (catalogCache?.expiresAt > now || catalogCache?.retryAt > now) return catalogCache.rows
  if (!catalogPending) {
    catalogPending = fetchCatalog(options)
      .then(result => {
        catalogCache = { rows: result.rows, expiresAt: now + CATALOG_TTL_MS, retryAt: 0 }
        return result.rows
      })
      .finally(() => { catalogPending = null })
  }
  try {
    return await catalogPending
  } catch (error) {
    if (!catalogCache) throw error
    catalogCache.retryAt = now + CATALOG_RETRY_MS
    return catalogCache.rows
  }
}

export function primeCatalogCache(rows, now = Date.now()) {
  if (!Array.isArray(rows) || !rows.length) return
  catalogCache = { rows, expiresAt: Number(now) + CATALOG_TTL_MS, retryAt: 0 }
}

export function clearCatalogCache() {
  catalogCache = null
  catalogPending = null
}

export function buildChannels(rows) {
  return (Array.isArray(rows) ? rows : []).map(row => ({
    name: `${row.region}｜${row.name}`,
    deferredRef: `livechina-${row.id}`,
    // 央视 CDN 对媒体分片同样校验 Referer / Origin，播放器直连会收到 403；
    // 必须让清单和分片都经过本机，由代理补齐 UPSTREAM_HEADERS。
    proxyHls: true,
    catchup: 'none',
    logo: row.logo || '',
    opts: ['network-caching=3000'],
  }))
}
