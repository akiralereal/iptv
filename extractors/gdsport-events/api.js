import { createHmac } from 'node:crypto'

export const OFFICIAL_PAGE = 'https://gdsport-m.itouchtv.cn/liveChannel'
export const GROUP_NAME = '广东'
export const eventChannelName = event => `广东体育 · ${event.name}`
export const HEADERS = {
  'User-Agent': 'Mozilla/5.0', Origin: 'https://gdsport-m.itouchtv.cn',
  Referer: 'https://gdsport-m.itouchtv.cn/',
}
const PUBLISHERS = new Map([[35062, '广东体育频道plus'], [49058, '广东体育频道']])
const STREAM_HOST = 'gdsport-live6.itouchtv.cn'
const SITE_HOSTS = new Set(['gdsport-m.itouchtv.cn', 'sitecdn.itouchtv.cn', 'img2-cloud.itouchtv.cn', 'api.itouchtv.cn'])

export async function readBytes(url, { fetchImpl = fetch, headers = HEADERS, limit = 20 * 1024 * 1024, signal } = {}) {
  const target = new URL(url)
  if (target.protocol !== 'https:' || target.username || target.password || target.port
      || (!SITE_HOSTS.has(target.hostname) && target.hostname !== STREAM_HOST)) throw new Error('来源不在已验证的官方域名内')
  const response = await fetchImpl(target.href, {
    headers, redirect: 'manual', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
  })
  if (!response.ok) { await response.body?.cancel(); throw new Error(`官方请求返回 HTTP ${response.status}`) }
  const reader = response.body.getReader()
  let total = 0
  const chunks = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > limit) throw new Error('官方响应超过大小限制')
      chunks.push(Buffer.from(value))
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error }
  finally { reader.releaseLock() }
  return Buffer.concat(chunks, total)
}

/**
 * 赛事标题会原样写进 EXTINF 的 tvg-id / tvg-name 和逗号后的频道名：英文双引号会截断属性
 * （官方历史标题里真有「"我是小球王"足球邀请赛」这种，截断后 tvg-id 只剩「广东体育 · 」，
 * 归一后正好对上广东体育电视频道、套错节目单），英文逗号会让回读端按第一个逗号切错频道名。
 * 与 B 站、抖音模块同一处理：引号换单引号、逗号换全角。
 */
function cleanTitle(value) {
  return String(value || '').replace(/[\x00-\x1f]+/g, ' ').replace(/"/g, "'").replace(/,/g, '，').replace(/\s+/g, ' ').trim()
}

export function normalizeEvent(row) {
  if (!row || row.objectType !== 1 || row.status !== 1 || row.unfree !== 0 || row.needPassword !== false
      || PUBLISHERS.get(row.mediaId) !== row.mediaName || !Number.isSafeInteger(row.objectPk) || row.objectPk <= 0) return null
  return {
    id: String(row.objectPk), name: cleanTitle(row.title),
    publisher: row.mediaName, beginAt: row.beginAt, officialUrl: `https://gdsport-m.itouchtv.cn/live/${row.objectPk}`,
    kind: 'event',
  }
}

export function validateStreamUrl(raw) {
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.hostname !== STREAM_HOST || url.port || url.username || url.password
      || !/^\/live\/[a-f\d]{24}\.m3u8$/.test(url.pathname) || url.search || url.hash) throw new Error('赛事播放来源已变化，需要重新验证')
  return url.href
}

export function validateSegmentUrl(raw, streamUrl) {
  const stream = new URL(validateStreamUrl(streamUrl)), url = new URL(raw, stream)
  const prefix = stream.pathname.slice(0, -5)
  if (url.origin !== stream.origin || url.username || url.password || url.hash
      || !url.pathname.startsWith(prefix + '-') || !/^\d+\.ts$/.test(url.pathname.slice(prefix.length + 1))
      || [...url.searchParams.keys()].some(k => !['txspiseq', 'txSecret', 'txTime'].includes(k))) throw new Error('分片不属于这场官方赛事')
  return url.href
}

export function parsePlaylist(text, streamUrl) {
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('未返回 HLS 清单')
  if (/#EXT-X-(?:ENDLIST|STREAM-INF|MAP|BYTERANGE|KEY)/.test(text)) throw new Error('当前清单不是已验证的实时 TS 直播形式')
  const sequence = Number(text.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m)?.[1])
  const targetDuration = Number(text.match(/^#EXT-X-TARGETDURATION:(\d+)/m)?.[1])
  if (!Number.isSafeInteger(sequence) || !(targetDuration > 0 && targetDuration <= 30)) throw new Error('缺少有效的直播序号或分片时长')
  const segments = []
  let duration = null
  for (const line of text.split(/\r?\n/).map(x => x.trim())) {
    if (line.startsWith('#EXTINF:')) duration = Number(line.slice(8).split(',')[0])
    else if (line && !line.startsWith('#')) {
      if (!(duration > 0 && duration <= 60)) throw new Error('媒体分片时长无效')
      segments.push({ url: validateSegmentUrl(line, streamUrl), duration }); duration = null
    }
  }
  if (!segments.length) throw new Error('清单没有视频分片')
  return { sequence, targetDuration, segments }
}

export function verifySegment(bytes) {
  if (bytes.length < 188 * 6 || ![0, 188, 376, 564, 752, 940].every(i => bytes[i] === 0x47)) throw new Error('未返回 MPEG-TS 视频分片')
  return bytes
}

// 播放器约 4 秒刷新一次清单，每次都会调 resolve。赛事状态和播放地址按场缓存这么久，期间只重取清单；
// 官网自己也是进页面查一次详情、之后 10 秒查一次状态，不会每次刷新都带统计参数请求详情。
export const DETAIL_TTL_MS = 30 * 1000
// 详情接口一时失败（超时、5xx）时沿用上次确认过的地址的最长时间：比赛结束靠清单 ENDLIST / CDN 404 也能发现
export const DETAIL_GRACE_MS = 3 * 60 * 1000

/** 官方明确说这场不在播（不是接口失败）：不能沿用旧地址。 */
class EventEndedError extends Error {}

/** 公开 H5 的匿名请求签名；只解析官网文本，不执行下载的脚本。 */
export function createProvider({ fetchImpl = fetch, now = Date.now } = {}) {
  let signer, signerUntil = 0, signingPending
  const confirmed = new Map()  // 赛事 id → { event, url, at }：上次确认在播的状态与地址
  const read = (url, options = {}) => readBytes(url, { fetchImpl, ...options })
  async function publicSigner() {
    if (signer && Date.now() < signerUntil) return signer
    if (!signingPending) signingPending = (async () => {
      const html = (await read('https://gdsport-m.itouchtv.cn/index.m.html', { limit: 512 * 1024 })).toString()
      const script = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map(x => x[1]).find(x => /\/m-mj\/prod\/js\/app\.[a-f\d]+\.js(?:\?|$)/.test(x))
      if (!script) throw new Error('官网客户端脚本已改版')
      const source = (await read(script, { limit: 8 * 1024 * 1024 })).toString()
      const keyAt = source.indexOf('"X-ITOUCHTV-Ca-Key"')
      const snippet = source.slice(Math.max(0, keyAt - 800), keyAt + 200)
      const key = snippet.match(/"X-ITOUCHTV-Ca-Key":"([a-zA-Z0-9]+)"/)?.[1]
      const secret = snippet.match(/\(d,"([a-zA-Z0-9]+)"\)/)?.[1]
      if (!key || !secret) throw new Error('官网匿名签名方式已改版')
      signer = { key, secret }; signerUntil = Date.now() + 30 * 60 * 1000
      return signer
    })().finally(() => { signingPending = null })
    return signingPending
  }
  async function api(path) {
    const url = 'https://api.itouchtv.cn' + path
    const { key, secret } = await publicSigner(), time = String(Date.now())
    const body = (await read(url, { limit: 4 * 1024 * 1024, headers: {
      ...HEADERS, 'Content-Type': 'application/json', 'X-ITOUCHTV-CLIENT': 'ITOUCHTV_WEB_M',
      'X-ITOUCHTV-BRANCH': 'mj40', 'X-ITOUCHTV-Ca-Timestamp': time, 'X-ITOUCHTV-Ca-Key': key,
      'X-ITOUCHTV-Ca-Signature': createHmac('sha256', secret).update(`GET\n${url}\n${time}\n`).digest('base64'),
      'X-ITOUCHTV-APP-VERSION': '1.0.1', 'X-ITOUCHTV-BRANCH-VERSION': '1.0.1',
    } })).toString()
    try { return JSON.parse(body) } catch { throw new Error('官方接口未返回 JSON') }
  }
  return {
    async discover() {
      // 直播分类 ID 由官网返回，不能把资讯频道 ID 当成直播分类 ID。
      const categories = await api('/liveservice/v3/channels')
      const category = categories.list?.find(x => x.channelName === '直播' && x.kind === 0)
      if (!category || !Number.isSafeInteger(category.channelId)) throw new Error('官网直播分类已变化')
      const data = await api(`/liveservice/v12/channelLives?channelId=${category.channelId}&pageSize=20&pageNum=1`)
      if (!Array.isArray(data.mediaLiveList)) throw new Error('官网直播目录已变化')
      return data.mediaLiveList.map(normalizeEvent).filter(x => x?.name)
    },
    async resolve(id) {
      if (!/^[1-9]\d{0,9}$/.test(String(id))) throw new Error('未知的赛事引用')
      const key = String(id)
      let entry = confirmed.get(key)
      if (!entry || now() - entry.at >= DETAIL_TTL_MS) {
        try {
          // 只复核状态、取地址，不带 isStat（那是官网进页面时记一次观看的统计参数）
          const data = await api(`/liveservice/v8/mediaLiveDetail?mediaLiveId=${key}&isStat=false&isH5Share=true`)
          const event = normalizeEvent(data.mediaLive)
          if (!event || event.id !== key) throw new EventEndedError('这场官方赛事当前未直播，或不是公开直播')
          entry = { event, url: validateStreamUrl(data.mediaLive.allPlayUrl?.hls || data.mediaLive.playUrl), at: now() }
          for (const [other, value] of confirmed) if (now() - value.at > DETAIL_GRACE_MS) confirmed.delete(other)
          confirmed.set(key, entry)
        } catch (error) {
          if (error instanceof EventEndedError || !entry || now() - entry.at > DETAIL_GRACE_MS) {
            confirmed.delete(key)
            throw error
          }
          // 接口一时失败：接着用上次确认过的地址取清单，下一次刷新再复核
        }
      }
      const text = (await read(entry.url, { limit: 1024 * 1024 })).toString()
      return { event: entry.event, url: entry.url, text, playlist: parsePlaylist(text, entry.url) }
    },
    read,
  }
}
