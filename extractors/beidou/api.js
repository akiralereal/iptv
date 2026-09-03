/** 辽宁「北斗融媒」省、市台目录与阿里云 HLS 短签名。 */
import { createHash } from 'node:crypto'
import fetch from 'node-fetch'
import { createOauthSign, decodeOauth } from './auth.js'

const UA = 'okhttp/4.12.0'
const CATALOG_TTL_MS = 10 * 60 * 1000
const CATALOG_RETRY_MS = 60 * 1000
const STREAM_TTL_SECONDS = 30 * 60
const AUTH_TTL_MS = 10 * 60 * 1000
const AUTH_RETRY_MS = 5000

// CDN Referer 会轮换，必须从 getOauth 动态取得，不能把某次解析结果固定在这里。
export const TENANTS = [
  {
    id: 'liaoning', label: '辽宁省台', group: '辽宁', host: 'bdrm.bdy.lnyun.com.cn', tabId: 3,
    streamHost: 'bdrmtvzb.lnyun.com.cn',
  },
  {
    id: 'shenyang', label: '沈阳台', group: '辽宁', host: 'sygbdst.bdy.lnyun.com.cn', tabId: 2,
    streamHost: 'sygbdsttvzb.lnyun.com.cn',
  },
]

const TENANT_BY_ID = new Map(TENANTS.map(tenant => [tenant.id, tenant]))

// 只收录官方「看电视」页当前声明的正式频道。白名单避免专题直播间混入常驻频道。
const CHANNEL_NAMES = new Map(Object.entries({
  c077b260424404846285cba1e1759280: '辽宁卫视',
  '10d3de0d03c62e85a1a281bbde8b6952': '辽宁都市',
  '918510749a0f319ec12ff695b1c95230': '辽宁影视剧',
  '854e7044de9fef5163ae36fabb72de56': '辽宁教育青少',
  '078ce87dcf5384d51e4655cb962fda18': '辽宁生活',
  e0bb9a7fd9afa954658bc50d0681cd49: '辽宁体育休闲',
  '8e95535378bd3e5f7494bc23ab1cb117': '辽宁北方',
  '7ff8ce0d226f2eb92e332be0cb13b406': '新动漫',
  fb3cf5af7cd3bcbde56c280cad2e64cb: '辽宁移动电视',
  '7e29bde4f41ca08642b7fc3ce4eb1ae4': '家庭理财',
  d447fcc472f14c7f14872d4e26b12d8f: '沈阳新闻综合',
  eaecc3f39a6e94f2ac6197c229b4cd6b: '沈阳经济',
  acb1a5713531ac7feb7836b1b4db442c: '沈阳公共',
}))

let catalogCache = new Map()
const catalogPending = new Map()
let authCache = new Map()
let authPending = new Map()

function apiHeaders(tenant) {
  return { 'User-Agent': UA, backos: 'phone', Referer: `https://${tenant.host}`, Accept: 'application/json' }
}

async function requestJson(url, tenant, { timeoutMs = 10000, fetchImpl = fetch, method = 'GET' } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { method, headers: apiHeaders(tenant), signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = await response.json()
    if (Number(payload?.code) !== 200) throw new Error(payload?.msg || `接口状态 ${payload?.code}`)
    return payload
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : (error?.message || String(error))
    throw new Error(reason)
  } finally {
    clearTimeout(timer)
  }
}

async function cachedTenantAuth(tenant, channelId, options) {
  const now = Number(options.now ?? Date.now())
  // 同一 CDN 的频道共享鉴权；局部引用避免清缓存时旧请求写回新缓存。
  const cache = authCache
  const pending = authPending
  const cached = cache.get(tenant.id)
  if (cached?.expiresAt > now) return cached.auth
  if (cached?.retryAt > now) throw new Error(cached.error)
  if (!pending.has(tenant.id)) {
    const params = new URLSearchParams({ domainId: channelId, version: '5', sign: createOauthSign(channelId, now) })
    const request = requestJson(`https://${tenant.host}/cloud/apis/live/api/domain/getOauth?${params}`, tenant, {
      ...options, method: 'POST',
    }).then(payload => {
      const auth = decodeOauth(payload, tenant.streamHost)
      // referTimeOut 为剩余秒数。提前 30 秒刷新，并至多缓存 10 分钟。
      const ttl = Math.max(0, Math.min(AUTH_TTL_MS, auth.remainingSeconds * 1000 - 30000))
      cache.set(tenant.id, { auth, expiresAt: now + ttl })
      return auth
    }).catch(error => {
      // 失败重试短暂退避，过期 Referer 不再回退使用。
      cache.set(tenant.id, { retryAt: Number(options.now ?? Date.now()) + AUTH_RETRY_MS, error: error.message })
      throw error
    }).finally(() => pending.delete(tenant.id))
    pending.set(tenant.id, request)
  }
  return pending.get(tenant.id)
}

function parsePageConfig(raw) {
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw }
  catch { return null }
}

/** 从一个 tab 响应中提取正式电视节目，供生产代码和单测共用。 */
export function normalizePrograms(payload, tenantId) {
  const tenant = TENANT_BY_ID.get(String(tenantId || ''))
  if (!tenant) return []
  const rows = []
  const seen = new Set()
  for (const page of Array.isArray(payload?.data) ? payload.data : []) {
    if (Number(page?.type) !== 22) continue
    const programs = parsePageConfig(page?.config)?.programs
    for (const program of Array.isArray(programs) ? programs : []) {
      const id = String(program?.id || '').trim()
      const name = CHANNEL_NAMES.get(id)
      if (!name || seen.has(id)) continue
      seen.add(id)
      rows.push({
        id,
        tenantId: tenant.id,
        name,
        logo: String(program?.cover || '').trim().replace(/^http:\/\//i, 'https://'),
      })
    }
  }
  return rows
}

/** 官方当前播放接口：只接受 playableType=live 及对应租户 CDN 上的 HTTPS HLS。 */
export function playableStreamOf(payload, tenantId) {
  const tenant = TENANT_BY_ID.get(String(tenantId || ''))
  const type = String(payload?.data?.playableType || '').trim()
  const programName = String(payload?.data?.programName || '').trim()
  if (!tenant || Number(payload?.code) !== 200 || type !== 'live') {
    return { url: '', type, programName }
  }
  const playable = parsePageConfig(payload?.data?.playableUrl)
  const raw = String(playable?.m3u8 || '').trim()
  try {
    const url = new URL(raw)
    return {
      url: url.protocol === 'https:' && url.hostname === tenant.streamHost && /\.m3u8$/i.test(url.pathname)
        ? url.href : '',
      type,
      programName,
    }
  } catch { return { url: '', type, programName } }
}

async function mapLimit(items, limit, worker) {
  const output = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      output[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return output
}

export async function fetchTenantRows(tenantId, options = {}) {
  const tenant = TENANT_BY_ID.get(String(tenantId || ''))
  if (!tenant) throw new Error(`未知北斗融媒租户：${tenantId}`)
  const base = `https://${tenant.host}/cloud/apis`
  const page = await requestJson(`${base}/facade/app/tab/page?tabId=${tenant.tabId}`, tenant, options)
  const programs = normalizePrograms(page, tenant.id)
  if (!programs.length) throw new Error(`${tenant.label}“看电视”页没有匹配到正式频道`)

  const rows = await mapLimit(programs, 4, async program => {
    try {
      const playable = await requestJson(`${base}/live/api/program/getPlayableUrl?domainId=${program.id}`, tenant, options)
      return { ...program, ...playableStreamOf(playable, tenant.id), error: '' }
    } catch (error) {
      // 单个停播/下线频道不应拖掉同一租户的其余频道。
      return { ...program, url: '', type: '', programName: '', error: error?.message || String(error) }
    }
  })
  const usable = rows.filter(row => row.url)
  const skipped = rows.filter(row => !row.url).map(row => ({
    name: row.name,
    reason: row.type === 'replay'
      ? `官方当前仅提供回看${row.programName ? `（${row.programName}）` : ''}`
      : (row.error || '官方当前没有返回 live HLS'),
  }))
  return { rows: usable, skipped }
}

function cacheRows(tenantId, rows, now) {
  catalogCache.set(tenantId, { rows, expiresAt: Number(now) + CATALOG_TTL_MS, retryAt: 0 })
}

async function cachedTenantRows(tenantId, options = {}) {
  const now = Number(options.now ?? Date.now())
  const cached = catalogCache.get(tenantId)
  if (cached?.expiresAt > now || cached?.retryAt > now) return cached.rows
  let pending = catalogPending.get(tenantId)
  if (!pending) {
    pending = fetchTenantRows(tenantId, options)
      .then(result => { cacheRows(tenantId, result.rows, now); return result.rows })
      .finally(() => catalogPending.delete(tenantId))
    catalogPending.set(tenantId, pending)
  }
  try { return await pending }
  catch (error) {
    if (!cached) throw error
    cached.retryAt = now + CATALOG_RETRY_MS
    return cached.rows
  }
}

export async function fetchChannelRows(tenantIds, options = {}) {
  const ids = [...new Set(Array.isArray(tenantIds) ? tenantIds : [])].filter(id => TENANT_BY_ID.has(id))
  const settled = await Promise.allSettled(ids.map(id => fetchTenantRows(id, options)))
  const now = Number(options.now ?? Date.now())
  const rows = []
  const skipped = []
  const warnings = []
  settled.forEach((result, index) => {
    const tenant = TENANT_BY_ID.get(ids[index])
    if (result.status === 'fulfilled') {
      cacheRows(ids[index], result.value.rows, now)
      rows.push(...result.value.rows)
      skipped.push(...result.value.skipped)
    } else {
      warnings.push(`${tenant.label}获取失败：${result.reason?.message || String(result.reason)}`)
    }
  })
  if (!rows.length && warnings.length) throw new Error(warnings.join('；'))
  return { rows, skipped, warnings }
}

export function buildChannelGroups(rows) {
  const groups = new Map()
  for (const tenant of TENANTS) {
    const dataList = (Array.isArray(rows) ? rows : [])
      .filter(row => row.tenantId === tenant.id)
      .map(row => ({
        name: row.name,
        deferredRef: `beidou-${tenant.id}-${row.id}`,
        proxyHls: true,
        logo: row.logo || '',
        opts: ['network-caching=3000'],
      }))
    if (!dataList.length) continue
    if (!groups.has(tenant.group)) groups.set(tenant.group, { name: tenant.group, dataList: [] })
    groups.get(tenant.group).dataList.push(...dataList)
  }
  return [...groups.values()]
}

/** auth_key = expiry-0-0-md5(path-expiry-0-0-pullKey)。 */
export function signStreamUrl(rawUrl, tenantId, pullKey, now = Date.now()) {
  const tenant = TENANT_BY_ID.get(String(tenantId || ''))
  if (!tenant) throw new Error('未知北斗融媒租户')
  const url = new URL(rawUrl)
  if (url.protocol !== 'https:' || url.hostname !== tenant.streamHost || !/\.m3u8$/i.test(url.pathname)) {
    throw new Error('播放地址不是该北斗融媒租户的 HTTPS HLS')
  }
  if (typeof pullKey !== 'string' || !pullKey) throw new Error('北斗融媒拉流密钥为空')
  const expires = Math.floor(Number(now) / 1000) + STREAM_TTL_SECONDS
  if (!Number.isSafeInteger(expires) || expires < 1) throw new Error('签名时间无效')
  const digest = createHash('md5')
    .update(`${url.pathname}-${expires}-0-0-${pullKey}`)
    .digest('hex')
  url.searchParams.set('auth_key', `${expires}-0-0-${digest}`)
  return url.href
}

export async function resolveChannel(ref, ctx = {}) {
  try {
    const match = /^beidou-(liaoning|shenyang)-([a-f0-9]{32})$/.exec(String(ref || ''))
    if (!match) return { url: '', desc: '北斗融媒频道引用格式错误' }
    const [, tenantId, channelId] = match
    const tenant = TENANT_BY_ID.get(tenantId)
    const rows = await cachedTenantRows(tenantId, {
      timeoutMs: ctx.timeoutMs,
      fetchImpl: ctx.fetchImpl,
      now: ctx.now,
    })
    const row = rows.find(item => item.id === channelId)
    if (!row) return { url: '', desc: `${tenant.label}频道当前不在官方电视列表中` }
    const auth = await cachedTenantAuth(tenant, channelId, ctx)
    return {
      url: signStreamUrl(row.url, tenantId, auth.pullKey, ctx.now ?? Date.now()),
      desc: `${row.name}短效播放地址生成成功`,
      upstreamHeaders: { Referer: auth.referer },
    }
  } catch (error) {
    return { url: '', desc: `辽宁北斗融媒链接请求失败：${error?.message || String(error)}` }
  }
}

export function clearCache() {
  catalogCache = new Map()
  catalogPending.clear()
  authCache = new Map()
  authPending = new Map()
}
