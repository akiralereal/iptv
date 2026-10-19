import { createHash } from 'node:crypto'

export const PAGE = 'https://www.ntjoy.com/ntw/broadcastTvs.html?menuCode=ntw005'
export const API = 'https://web.ntjoy.com/website/external/externalService'
export const APP_API = 'https://web.ntjoy.com/nmg/external/externalService'
export const CHANNELS = [
  { id: '1', ref: 'nantong-1', upstreamId: 'ff8081818bcbe7c2018bcc9bf4f20015', stream: '4f1', name: '南通新闻综合', rawName: '南通一套·新闻综合频道' },
  { id: '2', ref: 'nantong-2', upstreamId: 'ff8081818bcbe7c2018bcc9cb7390018', stream: '4f3', name: '南通社教', rawName: '南通二套·社教频道' },
  { id: '3', ref: 'nantong-3', upstreamId: 'ff8081818bcbe7c2018bcc9d12f0001b', stream: '4f5', name: '南通公共', rawName: '南通三套·公共频道' },
]
const md5 = s => createHash('md5').update(s).digest('hex')
// 官网公开的网页请求签名参数（js/httpInterfaceSign.js），不是用户凭据。
const PUBLIC_KEY = 'ae14eda544a85465bcf0ab8800efdc6e'
export function signRequest(url, service, params, now = Date.now()) {
  const values = { service, params: JSON.stringify(params), apiVersion: '1.0', terminalType: 'website' }
  const valid = Object.keys(values).sort().map(key => `${key.toLowerCase()}=${String(values[key]).replace(/[^a-z0-9A-Z\u4e00-\u9fa5]/g, '')}`).join('&')
  const digest = md5(`service=${new URL(url).pathname}&securitykey=${md5(PUBLIC_KEY)}&butelTst=${now}&param=${md5(encodeURIComponent(valid))}`)
  return { ...values, butelAppkey: 'website', butelTst: String(now), butelSign: digest }
}

export async function readBytes(url, { fetchImpl = fetch, maxBytes = 512 * 1024, signal, timeoutMs = 15000 } = {}) {
  const r = await fetchImpl(url, { redirect: 'manual', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) })
  if (!r.ok) { await r.body?.cancel(); throw new Error(`官方媒体 HTTP ${r.status}`) }
  const chunks = []; let bytes = 0
  for await (const chunk of r.body) {
    bytes += chunk.byteLength
    if (bytes > maxBytes) throw new Error('官方响应超过大小限制')
    chunks.push(Buffer.from(chunk))
  }
  return { body: Buffer.concat(chunks), status: r.status, type: r.headers.get('content-type') }
}

export async function request(service, params, { fetchImpl = fetch, app = false, timeoutMs = 15000 } = {}) {
  const url = app ? APP_API : API
  const r = await fetchImpl(url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Referer: PAGE },
    body: new URLSearchParams(signRequest(url, service, params)),
  })
  if (!r.ok) { await r.body?.cancel(); throw new Error(`南通官网 HTTP ${r.status}`) }
  const chunks = []; let size = 0
  for await (const chunk of r.body) {
    size += chunk.byteLength
    if (size > 512 * 1024) throw new Error('南通官网响应过大')
    chunks.push(Buffer.from(chunk))
  }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (data.state !== 1000) throw new Error('南通官网接口没有返回成功结果')
  return data
}

export function shanghaiTime(raw) {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})[ T]?(\d{2}):?(\d{2}):?(\d{2})$/.exec(String(raw || ''))
  return m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`) : NaN
}

export function mediaUrl(raw, channel, segment = false) {
  const u = new URL(raw)
  if (u.origin !== 'https://nt-hls.ntjoy.com' || u.username || u.password || u.hash
      || !(segment ? new RegExp(`^/live/${channel.stream}-\\d+\\.ts$`).test(u.pathname) : u.pathname === `/live/${channel.stream}.m3u8`)) {
    throw new Error('媒体地址不属于当前频道的官方 CDN')
  }
  const allowed = segment ? ['ctyun_app', 'ctyun_stream', 'ctyun_rate'] : ['t', 'k']
  if ([...u.searchParams.keys()].some(k => !allowed.includes(k))) throw new Error('官方媒体参数发生变化')
  if (segment && u.searchParams.get('ctyun_stream') !== channel.stream) throw new Error('媒体引用指向其他频道')
  return u.href
}

export function selectCurrent(payload, gasket, channel, localNow = Date.now()) {
  const now = shanghaiTime(payload.currTime)
  if (!Number.isFinite(now) || Math.abs(now - localNow) > 120000 || !Array.isArray(payload.data)) throw new Error('官网节目时间不可用')
  if (gasket.state !== 1000 || !Array.isArray(gasket.data?.rows)) throw new Error('官网播出垫片检查失败')
  // 暂不实现官网的图片/点播垫片播放；有配置就停止，不能回退到目录中的裸直播。
  if (gasket.data.rows.length) throw new Error('官网配置了播出垫片，当前暂不提供直播')
  const rows = payload.data.filter(row => Number(row.status) === 2
    && shanghaiTime(row.startTime) <= now && shanghaiTime(row.endTime) > now)
  if (rows.length !== 1) throw new Error('官网没有唯一的当前直播节目')
  const row = rows[0]
  if (shanghaiTime(row.endTime) <= localNow) throw new Error('当前节目已经结束，请刷新官网节目单')
  // 与官网 initProgramList 一致：录播、电视剧、动画和提示片都不能改用频道裸流。
  if (Number(row.isRecord) !== 1 || Number(row.programStatus) !== 2
      || ['电视剧', '动画城堡'].includes(String(row.programName).trim())) throw new Error('台方当前节目未开放网络直播')
  const candidate = String(row.playUrl || '').split(',').find(s => /^https:\/\//.test(s) && new URL(s).pathname.endsWith('.m3u8'))
  if (!candidate) throw new Error('官网当前节目没有提供 HLS 直播')
  const url = mediaUrl(candidate, channel)
  return { channel, url, programId: String(row.id), title: row.programName, endAt: shanghaiTime(row.endTime), serverAt: now }
}

export async function catalog(options = {}) {
  const data = await request('getMenuContentList', { menuId: 'ntw005', idx: 0, size: 16 }, options)
  if (!Array.isArray(data.data?.rows)) throw new Error('官方电视目录不可用')
  return CHANNELS.flatMap(c => {
    const row = data.data.rows.find(row => row.id === c.upstreamId && row.title === c.rawName && Number(row.contentType) === 7)
    return row ? [{ ...c, logo: new URL(row.channelLogo).href }] : []
  })
}

export async function snapshot(channel, options = {}) {
  const [programs, gasket] = await Promise.all([
    request('getBroadcastList', { id: channel.upstreamId }, options),
    request('getGasketList', { channelId: channel.upstreamId }, { ...options, app: true }),
  ])
  return selectCurrent(programs, gasket, channel)
}

export function parseManifest(body, lease) {
  const text = String(body)
  if (!text.startsWith('#EXTM3U') || !text.includes('#EXTINF:') || /#EXT-X-(?:KEY|MAP|STREAM-INF|ENDLIST)/.test(text)
      || /\bURI\s*=/i.test(text) || !/#EXT-X-MEDIA-SEQUENCE:\d+/.test(text)) throw new Error('不是预期的实时 TS 清单')
  const segments = text.split(/\r?\n/).filter(s => s && !s.startsWith('#'))
  if (!segments.length) throw new Error('直播清单没有媒体分片')
  for (const raw of segments) mediaUrl(new URL(raw, lease.url), lease.channel, true)
  return text
}
