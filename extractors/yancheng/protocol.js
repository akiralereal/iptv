/** 盐城网电视直播页公开接口；app_secret 是页面发布的客户端标识，无用户凭据。 */
export const PAGE = 'https://www.0515yc.cn/folder147/folder148/folder156/folder245/'
export const API = 'https://frontendyc.0515yc.cn/cloudlive-manage-mapi/api/topic/'
const APP_SECRET = 'f3dc7c3fd7023212d427a2dab65b6931'
export const HEADERS = Object.freeze({ Referer: 'https://www.0515yc.cn/', Origin: 'https://www.0515yc.cn', 'User-Agent': 'Mozilla/5.0' })
export const CHANNELS = Object.freeze([
  { id: '593799805264744448', ref: 'yancheng-1', name: '盐城电视一套', streamId: '593798174489993216', path: 'sd/sd', segment: 'sd_sd', logo: 'https://filestorageyc.0515yc.cn/file/storage1-cloudlivemanage/cloudlivemanage/2023/1046/46d026cd9c9c62f3.png' },
  { id: '593800300318445568', ref: 'yancheng-2', name: '盐城电视二套', streamId: '593799344231047168', path: 'hd/sd', segment: 'hd_sd', logo: 'https://filestorageyc.0515yc.cn/file/storage1-cloudlivemanage/cloudlivemanage/2023/1046/e053f971239b41c3.png' },
])
export const shanghaiDay = (now = Date.now()) => new Date(now + 28800000).toISOString().slice(0, 10)

export function dateRange(day) {
  if (!/^\d{8}$/.test(String(day))) throw new Error('盐城节目单日期无效')
  const date = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}`
  const start = Date.parse(`${date}T00:00:00+08:00`)
  if (!Number.isFinite(start) || shanghaiDay(start) !== date) throw new Error('盐城节目单日期无效')
  return { date, start, end: start + 86400000 }
}

export async function readText(url, { fetchImpl = globalThis.fetch, timeoutMs = 12000, headers = {}, limit = 512 * 1024 } = {}) {
  const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers })
  if (!response.ok || response.status >= 300) {
    await response.body?.cancel()
    throw new Error(`盐城上游 HTTP ${response.status}`)
  }
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel()
    throw new Error('盐城上游响应过大')
  }
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > limit) throw new Error('盐城上游响应过大')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function request(route, params, options) {
  const query = new URLSearchParams({ app_secret: APP_SECRET, ...params })
  return JSON.parse(await readText(`${API}${route}?${query}`, options))
}

export async function catalog(options) {
  const rows = await request('list', { sort_id: '592759959624634368', time_status: '', offset: '0', count: '6' }, options)
  if (!Array.isArray(rows)) throw new Error('盐城官方电视目录无效')
  return CHANNELS.map(channel => {
    const row = rows.find(r => r.id === channel.id && r.title === channel.name && Number(r.status) === 1 && Number(r.if_show) === 1 && Number(r.del) === 0 && r.topic_type?.sign === 'tv')
    if (!row) throw new Error('盐城官方电视目录不完整')
    // 只接受官方文件服务的图片；不采用节目海报或未知媒体域名。
    const logo = new URL(row.indexpic)
    if (logo.origin !== 'https://filestorageyc.0515yc.cn' || logo.username || logo.password || logo.hash || !/\.(?:png|jpg|jpeg)$/i.test(logo.pathname)) throw new Error('盐城官方台标地址无效')
    return { ...channel, logo: logo.href }
  })
}

export async function programList(channel, day, options) {
  const range = dateRange(day)
  const data = await request('program/list', { topic_id: channel.id, date: range.date }, options)
  if (data?.error_code !== 200 || !Array.isArray(data.result)) throw new Error('盐城官方节目单不可用')
  return data.result
}

export function mediaUrl(raw, channel, { segment = false, base } = {}) {
  let url
  try { url = new URL(raw, base) } catch { throw new Error('盐城媒体地址无效') }
  const pattern = segment ? new RegExp(`^/${channel.segment}/\\d+/\\d+\\.ts$`) : new RegExp(`^/${channel.path}/live\\.m3u8$`)
  if (url.origin !== 'https://live1yc.0515yc.cn' || url.username || url.password || url.hash || !pattern.test(url.pathname)
      || !/^[a-f0-9]{8}\d{10}$/.test(url.searchParams.get('_upt') || '')
      || [...url.searchParams.keys()].length !== 1) throw new Error('盐城媒体不在指定官方频道路径')
  return url.href
}

export function validateManifest(text, url, channel) {
  mediaUrl(url, channel)
  if (!text.startsWith('#EXTM3U') || !/#EXT-X-MEDIA-SEQUENCE:\d+/.test(text) || !text.includes('#EXTINF:')
      || /#EXT-X-(?:KEY|MAP|STREAM-INF|ENDLIST)|URI\s*=/i.test(text)) throw new Error('盐城实时 HLS 结构已变化')
  const segments = text.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'))
  if (!segments.length) throw new Error('盐城清单没有媒体分片')
  segments.forEach(s => mediaUrl(s, channel, { segment: true, base: url }))
  return text
}
