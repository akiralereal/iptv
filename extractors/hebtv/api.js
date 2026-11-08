/** 河北广播电视台「冀时」官网频道表与 HLS 到期签名。 */
import { createHash } from 'node:crypto'
import fetch from 'node-fetch'

export const CHANNEL_LIST_URL = 'https://api.cmc.hebrts.cn/cmsback/api/com/article/getArticleList?catalogId=32557&siteId=1'
export const SCENIC_LIST_URL = 'https://api.cmc.hebrts.cn/cmsback/api/article/findPage?catalogId=33666&status=30&pageSize=100&pageNumber=1'
export const SCENIC_DETAIL_URL = 'https://api.cmc.hebrts.cn/cms/api/micro/live/seat/live'
export const STREAM_HOST = 'tv.pull.hebtv.com'
export const SCENIC_STREAM_HOST = 'live.pull.hebtv.com'

const CHANNEL_TTL_MS = 4 * 60 * 60 * 1000
const CHANNEL_RETRY_MS = 60 * 1000
const STREAM_TTL_SECONDS = 2 * 60 * 60
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const TENANT_ID = '0d91d6cfb98f5b206ac1e752757fc5a9'

export const UPSTREAM_HEADERS = {
  Referer: 'https://www.hebrts.cn/19/19js/st/xdszb/index.shtml',
  Origin: 'https://www.hebrts.cn',
  'User-Agent': UA,
}

// 只接官网当前电视直播栏目中的正式新闻/综合频道；购物及未知稿件固定排除。
const NAME_OVERRIDES = {
  河北卫视: '河北卫视',
  经济生活: '河北经济生活',
  河北都市: '河北都市',
  文旅体育: '河北文旅体育',
  少儿科教: '河北少儿科教',
  三农频道: '河北三农',
}

// 官网隐藏的「24 小时慢直播」栏目仍持续维护；只接城市 / 区县稿件，排除
// 「秘境精灵」等非城市专题。详情接口会再校验稿件标题、状态、主机和签名字段。
const SCENIC_NAME_OVERRIDES = {
  '慢直播丨石家庄': '石家庄',
  '慢直播丨承德': '承德',
  '慢直播丨冬奥之城张家口': '张家口',
  '慢直播丨秦皇岛': '秦皇岛',
  '慢直播丨唐山': '唐山',
  '慢直播丨廊坊': '廊坊',
  '慢直播丨保定': '保定',
  '慢直播丨沧州': '沧州',
  '慢直播丨衡水': '衡水',
  '慢直播丨邢台': '邢台',
  '慢直播丨邯郸': '邯郸',
  '慢直播｜雄安新区': '雄安新区',
  '慢直播丨定州': '定州',
  '慢直播丨平山': '平山',
}

const md5 = value => createHash('md5').update(value).digest('hex')

function movieParams(row) {
  return row?.appCustomParams?.movie || row?.appCustomParams1?.movie || {}
}

function streamUrlOf(row) {
  for (const device of Array.isArray(row?.liveVideo) ? row.liveVideo : []) {
    for (const format of Array.isArray(device?.formats) ? device.formats : []) {
      const value = String(format?.url || format?.liveStream || '').trim()
      if (value) return value
    }
  }
  return ''
}

function parseCustomParams(value) {
  if (value && typeof value === 'object') return value
  try { return JSON.parse(String(value || '')) } catch { return {} }
}

/** 把 CMS 的直播稿件收窄成播放解析所需字段。 */
export function normalizeRows(payload) {
  const rows = []
  const seen = new Set()
  for (const item of Array.isArray(payload) ? payload : []) {
    const id = String(item?.id || item?.articleId || '').trim()
    const name = NAME_OVERRIDES[String(item?.title || '').trim()]
    const params = movieParams(item)
    const liveUri = String(params?.liveUri || '').trim()
    const liveKey = String(params?.liveKey || '').trim()
    const rawUrl = streamUrlOf(item)
    let stream
    try { stream = new URL(rawUrl) } catch { continue }
    if (!/^\d{1,12}$/.test(id) || !name || seen.has(id)
      || !/^\/[A-Za-z0-9][A-Za-z0-9/_.-]*\.m3u8$/i.test(liveUri)
      || !/^[A-Za-z0-9]{3,64}$/.test(liveKey)
      || stream.protocol !== 'https:' || stream.hostname !== STREAM_HOST
      || stream.pathname !== liveUri) continue
    seen.add(id)
    rows.push({
      id,
      name,
      liveUri,
      liveKey,
      url: stream.href,
      logo: String(item?.logo || '').trim().replace(/^http:\/\//i, 'https://'),
    })
  }
  return rows
}

/** 把慢直播栏目收窄成允许请求详情的官方城市稿件。 */
export function normalizeScenicArticles(payload) {
  const rows = []
  const seen = new Set()
  for (const item of Array.isArray(payload) ? payload : []) {
    const id = String(item?.id || item?.articleId || '').trim()
    const title = String(item?.title || '').trim()
    const name = SCENIC_NAME_OVERRIDES[title]
    if (!/^\d{1,12}$/.test(id) || !name || seen.has(id) || String(item?.type) !== '15') continue
    const params = parseCustomParams(item?.appCustomParams)
    if (String(params?.movie?.liveStatus) !== '1') continue
    const logo = String(params?.customStyle?.imgPath?.[0] || item?.logo || '').trim()
      .replace(/^http:\/\//i, 'https://')
    seen.add(id)
    rows.push({ id, title, name, logo })
  }
  return rows
}

/** 校验单个慢直播详情，并规范成与电视稿件相同的签名字段。 */
export function normalizeScenicDetail(payload, article) {
  const row = payload?.data || payload
  const id = String(row?.articleId || '').trim()
  const title = String(row?.title || '').trim()
  const liveUri = String(row?.cdnUri || '').trim()
  const liveKey = String(row?.cdnKey || '').trim()
  let stream
  try { stream = new URL(String(row?.livePath || '').trim()) } catch { return null }
  if (!article || id !== article.id || title !== article.title || String(row?.status) !== '1'
    || !/^\/[A-Za-z0-9][A-Za-z0-9/_.-]*\.m3u8$/i.test(liveUri)
    || !/^[A-Za-z0-9]{3,64}$/.test(liveKey)
    || stream.protocol !== 'https:' || stream.hostname !== SCENIC_STREAM_HOST
    || stream.pathname !== liveUri) return null
  return {
    id,
    name: article.name,
    liveUri,
    liveKey,
    url: stream.href,
    logo: article.logo || String(row?.imagepath || '').trim().replace(/^http:\/\//i, 'https://'),
    scenic: true,
  }
}

async function requestWithTimeout(url, options = {}) {
  const controller = new AbortController()
  const timeoutMs = options.timeoutMs || 10000
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await (options.fetchImpl || fetch)(url, {
      method: options.method || 'POST',
      headers: { ...UPSTREAM_HEADERS, Accept: 'application/json', ...(options.headers || {}) },
      signal: controller.signal,
    })
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : (error?.message || String(error))
    throw new Error(reason)
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchChannelList(options = {}) {
  const response = await requestWithTimeout(CHANNEL_LIST_URL, options)
  if (!response.ok) throw new Error(`频道接口 HTTP ${response.status}`)
  const payload = await response.json()
  const rows = normalizeRows(payload?.returnData?.news)
  if (payload?.returnCode !== '0000' || !rows.length) {
    throw new Error(`频道接口返回异常：${payload?.returnDesc || payload?.message || '没有可用频道'}`)
  }
  return rows
}

export async function fetchScenicRows(options = {}) {
  const listResponse = await requestWithTimeout(SCENIC_LIST_URL, {
    ...options,
    method: 'GET',
    headers: { tenantId: TENANT_ID },
  })
  if (!listResponse.ok) throw new Error(`景观栏目接口 HTTP ${listResponse.status}`)
  const listPayload = await listResponse.json()
  const articles = normalizeScenicArticles(listPayload?.data?.pageRecords)
  if (!articles.length) throw new Error('景观栏目没有可用城市直播稿件')

  const details = await Promise.allSettled(articles.map(async article => {
    const url = new URL(SCENIC_DETAIL_URL)
    url.searchParams.set('tenantId', TENANT_ID)
    url.searchParams.set('api_version', '3.7.0')
    url.searchParams.set('app_version', '4.0.1')
    url.searchParams.set('client', 'android')
    url.searchParams.set('cms_app_id', '29')
    url.searchParams.set('app_id', '2')
    url.searchParams.set('articleId', article.id)
    const response = await requestWithTimeout(url.href, {
      ...options,
      method: 'GET',
      headers: { tenantId: TENANT_ID },
    })
    if (!response.ok) throw new Error(`${article.name}详情 HTTP ${response.status}`)
    const payload = await response.json()
    const row = normalizeScenicDetail(payload, article)
    if (!row) throw new Error(`${article.name}详情字段异常`)
    return row
  }))

  const rows = []
  const warnings = []
  const seenPaths = new Set()
  details.forEach(result => {
    if (result.status === 'rejected') {
      warnings.push(result.reason?.message || String(result.reason))
      return
    }
    if (seenPaths.has(result.value.liveUri)) {
      warnings.push(`${result.value.name}与已有景观共用直播流，已去重`)
      return
    }
    seenPaths.add(result.value.liveUri)
    rows.push(result.value)
  })
  if (!rows.length) throw new Error(`景观详情没有可用直播：${warnings.join('；')}`)
  return { rows, warnings }
}

/**
 * 电视（「河北」模块）和美丽河北景观（「河北景观」模块）是两套接口、两份缓存：
 * 关掉景观的人播电视时不会顺带去拉景观栏目和十几个详情。
 */
function createRowsCache(load) {
  let cache = null
  let pending = null
  return {
    async get(options = {}) {
      const now = Number(options.now ?? Date.now())
      if (cache?.expiresAt > now || cache?.retryAt > now) return cache.rows
      if (!pending) {
        pending = load(options)
          .then(rows => {
            cache = { rows, expiresAt: now + CHANNEL_TTL_MS, retryAt: 0 }
            return rows
          })
          .finally(() => { pending = null })
      }
      try {
        return await pending
      } catch (error) {
        if (!cache) throw error
        cache.retryAt = now + CHANNEL_RETRY_MS
        return cache.rows
      }
    },
    prime(rows, now = Date.now()) {
      if (!Array.isArray(rows) || !rows.length) return
      cache = { rows, expiresAt: Number(now) + CHANNEL_TTL_MS, retryAt: 0 }
    },
    peek: () => cache?.rows || [],
    clear() {
      cache = null
      pending = null
    },
  }
}

const tvRowsCache = createRowsCache(fetchChannelList)
const scenicRowsCache = createRowsCache(options => fetchScenicRows(options).then(result => result.rows))

export const primeChannelCache = (rows, now) => tvRowsCache.prime(rows, now)
export const primeScenicCache = (rows, now) => scenicRowsCache.prime(rows, now)

/**
 * 两个模块的频道引用同一种写法（hebtv-<稿件号>），稿件号看不出是电视还是景观：
 * 上一轮景观表里有它就先问景观，否则先问电视。一边接口挂了不耽误另一边。
 */
async function findRow(id, options) {
  const order = scenicRowsCache.peek().some(row => row.id === id)
    ? [scenicRowsCache, tvRowsCache]
    : [tvRowsCache, scenicRowsCache]
  let failure = null
  for (const cache of order) {
    try {
      const row = (await cache.get(options)).find(item => item.id === id)
      if (row) return row
    } catch (error) {
      failure ||= error
    }
  }
  if (failure) throw failure
  return null
}

export function buildChannels(rows) {
  return (Array.isArray(rows) ? rows : []).map(row => ({
    name: row.name,
    deferredRef: `hebtv-${row.id}`,
    // 顶层清单持续续签，清单内带独立参数的 TS 分片仍由播放器直连 CDN。
    relayHls: true,
    logo: row.logo || '',
  }))
}

/** 官网播放器算法：k = MD5(liveUri + liveKey + t)，t 为当前秒 + 2 小时。 */
export function signStreamUrl(rawUrl, liveUri, liveKey, now = Date.now()) {
  const url = new URL(rawUrl)
  if (url.protocol !== 'https:' || ![STREAM_HOST, SCENIC_STREAM_HOST].includes(url.hostname) || url.pathname !== liveUri
    || !/^\/[A-Za-z0-9][A-Za-z0-9/_.-]*\.m3u8$/i.test(liveUri)
    || !/^[A-Za-z0-9]{3,64}$/.test(String(liveKey || ''))) {
    throw new Error('播放地址不是河北广电 HTTPS 直播路径')
  }
  const seconds = Math.floor(Number(now) / 1000)
  if (!Number.isSafeInteger(seconds) || seconds < 1) throw new Error('签名时间无效')
  const expires = seconds + STREAM_TTL_SECONDS
  url.searchParams.set('t', String(expires))
  url.searchParams.set('k', md5(`${liveUri}${liveKey}${expires}`))
  return url.href
}

export async function resolveChannel(ref, ctx = {}) {
  try {
    const match = /^hebtv-(\d{1,12})$/.exec(String(ref || ''))
    if (!match) return { url: '', desc: '河北冀时频道引用格式错误' }
    const row = await findRow(match[1], { timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl, now: ctx.now })
    if (!row) return { url: '', desc: `河北冀时频道 ${match[1]} 当前不在官网列表中` }
    return {
      url: signStreamUrl(row.url, row.liveUri, row.liveKey, ctx.now ?? Date.now()),
      desc: `${row.name}短效播放地址生成成功`,
      relayHls: true,
      upstreamHeaders: UPSTREAM_HEADERS,
    }
  } catch (error) {
    return { url: '', desc: `河北冀时链接请求失败：${error?.message || String(error)}` }
  }
}

export function clearCache() {
  tvRowsCache.clear()
  scenicRowsCache.clear()
}
