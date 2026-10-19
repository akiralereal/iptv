import { createHash } from 'node:crypto'

export const PAGE = 'http://www.jmtv.cn/live/jm_live_h5.shtml?pid=1'
export const ORIGIN = 'http://tideweblive.jmtv.cn'
export const INFO_PATH = '/lsdream/336E7E6818120C00FA7E8129A9999A10/info.json'
export const EPG_URL = 'http://db.jmtv.cn/epg/4x3T0dO.json'
export const CHANNEL = { id: '1', ref: 'jiangmen-1', upstreamId: '4x3T0dO', name: '江门综合', rawName: '江门综合频道', group: '广东', logo: 'http://www.jmtv.cn/images/pc/ic_logo.png' }
export const HEADERS = { Referer: PAGE, Origin: 'http://www.jmtv.cn', 'User-Agent': 'Mozilla/5.0' }
const OFFSET = 8 * 3600000
export const shanghaiDay = now => new Date(now + OFFSET).toISOString().slice(0, 10)
const reverse = s => s.split('').reverse().join('')

// 官网 tidePlayer2021.js 的公开日切路径规则；固定上海时区，避免部署机器时区改变结果。
export function dailyKey(cid, now = Date.now()) {
  const midnight = Date.parse(`${shanghaiDay(now)}T00:00:00+08:00`)
  let sum = 0, previous = -1, delta = 0
  for (const char of cid) {
    const n = char.charCodeAt(0)
    sum += n
    if (previous !== -1) delta += previous - n
    previous = n
  }
  sum += delta
  let seed = midnight.toString(36), total = 0
  for (const char of seed) total += char.charCodeAt(0)
  const difference = Math.abs(total - sum)
  seed = reverse(sum.toString(36)) + seed.slice(5) + seed.slice(0, 5)
  const head = seed.slice(0, 4), tail = seed.slice(4)
  const parity = new Date(now + OFFSET).getUTCDay() % 2, chars = []
  for (let i = 0; i < cid.length; i++) {
    if (i % 2 === parity) chars.push(seed.charAt(i % seed.length))
    else {
      const prior = cid.charAt(i - 1), index = head.indexOf(prior)
      chars.push(prior ? index === -1 ? prior : tail.charAt(index) : head.charAt(i))
    }
  }
  return (reverse(difference.toString(36)) + chars.join('')).slice(0, cid.length)
}

export function infoUrl(now = Date.now()) {
  const url = new URL(INFO_PATH, ORIGIN)
  url.search = new URLSearchParams({ t: now.toString(16),
    token: createHash('md5').update(`${now}${INFO_PATH}Dream`).digest('hex') })
  return url.href
}

export async function readOfficial(url, { fetchImpl = fetch, maxBytes = 1024 * 1024, signal, timeoutMs = 15000 } = {}) {
  const r = await fetchImpl(url, { headers: HEADERS, redirect: 'manual',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) })
  if (r.status !== 200) { await r.body?.cancel(); throw new Error(`江门官方响应 HTTP ${r.status}`) }
  const chunks = []; let size = 0
  for await (const chunk of r.body) {
    size += chunk.byteLength
    if (size > maxBytes) throw new Error('江门官方响应超过大小限制')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

export function selectChannel(info) {
  if (!Array.isArray(info.channels)) throw new Error('江门官方频道目录不可用')
  // 页面正式电视栏目只列出此 ID；不收内部送流口或两套广播。
  const rows = info.channels.filter(c => c.i === CHANNEL.upstreamId && c.n === CHANNEL.rawName && String(c.t) === '1')
  if (rows.length !== 1 || ![0, 1].includes(info.play?.dl)) throw new Error('江门官方电视配置已变化')
  const row = rows[0]
  if (String(row.l).replace(/\/$/, '') !== ORIGIN || !Array.isArray(row.r)
      || !row.r.some(rate => Number(rate.n) === 993)) throw new Error('江门官方媒体配置已变化')
  return { rate: 993, daily: info.play.dl === 1 }
}

export function manifestUrl(meta, now = Date.now()) {
  const name = meta.daily ? dailyKey(CHANNEL.upstreamId, now) : 'live'
  return `${ORIGIN}/lsdream/${CHANNEL.upstreamId}/${meta.rate}/${name}.m3u8`
}

export function segmentUrl(raw, manifest) {
  const url = new URL(raw, manifest)
  const expected = `/lsdream/${CHANNEL.upstreamId}/993/`
  if (url.origin !== ORIGIN || url.username || url.password || url.search || url.hash
      || !url.pathname.startsWith(expected) || !/^\d{13}\/[0-9A-F]+D\d+\.ts$/.test(url.pathname.slice(expected.length))) {
    throw new Error('媒体分片不属于已验证的江门频道路径')
  }
  return url.href
}

export function parseManifest(body, manifest) {
  const text = String(body).trim()
  if (!text.startsWith('#EXTM3U') || !/#EXT-X-MEDIA-SEQUENCE:\d+/.test(text) || !text.includes('#EXTINF:')
      || /#EXT-X-(?:KEY|MAP|STREAM-INF|ENDLIST)/.test(text) || /\bURI\s*=/i.test(text)) throw new Error('不是预期的江门实时 TS 清单')
  const segments = text.split(/\r?\n/).filter(s => s && !s.startsWith('#'))
  if (!segments.length) throw new Error('江门直播清单没有媒体分片')
  for (const raw of segments) segmentUrl(raw, manifest)
  return text + '\n'
}


export function createCache(loader, { ttl, now = Date.now } = {}) {
  let cached, pending, until = 0, day
  return async () => {
    const current = now()
    if (cached && current < until && day === shanghaiDay(current)) return cached
    if (pending) return pending
    pending = loader().then(value => {
      const finished = now()
      cached = value; day = shanghaiDay(finished); until = finished + ttl
      return value
    }).catch(error => { cached = undefined; throw error }).finally(() => { pending = undefined })
    return pending
  }
}
