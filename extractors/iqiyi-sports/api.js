import { fetch, ProxyAgent } from 'undici'
export const CONFIG_URL = 'https://sports.iqiyi.com/resource/json/pc/config/iqiyiPcConfig.json'
export const GROUP_NAME = '爱奇艺体育'
const dispatcher = process.env.IQIYI_HTTP_PROXY ? new ProxyAgent(process.env.IQIYI_HTTP_PROXY) : undefined
export const officialFetch = (url, options = {}) => fetch(url, { ...options, dispatcher })
export const claimsRef = ref => /^iqiyi-sports-(?:vod-)?[1-9]\d{0,19}$/.test(String(ref || ''))
export const eventName = event => {
  const label = event.kind === 'replay' ? '回放' : event.kind === 'highlight' ? '集锦' : '直播'
  const date = event.kind && event.date ? `${event.date.slice(5).replace('-', '月')}日 ` : ''
  const access = event.accessLabel ? `[${event.accessLabel}] ` : ''
  return `[${label}] ${access}${date}${event.title}`
}
export const eventRef = event => `iqiyi-sports-${event.id}`
// These are purchase/entitlement options from the official catalog, not the
// account's purchase history. Several options may apply to the same program.
export function entitlementOptions(pay = {}) {
  const labels = []
  if (String(pay.isPublicRight) === '1' || String(pay.isPublic2Right) === '1') labels.push('会员')
  if (String(pay.isSingleRight) === '1') labels.push('单场付费')
  if (String(pay.isSpecificRight) === '1') labels.push('专项权益')
  return labels
}
export function accessLabel(event, anonymous = false) {
  if (anonymous) return '免费免登录'
  const options = ['会员', '单场付费', '专项权益'].filter(label => event.entitlementOptions?.includes(label))
  return options.length ? options.join(' / ') : '权益已授权'
}
export function normalizeVods(body) {
  if (String(body?.resCode) !== '200' || !body.retData || typeof body.retData !== 'object') throw new Error('爱奇艺官方点播目录格式变化')
  const found = new Map()
  function add(row, jump, kind, title, date, free, pay = {}) {
    const qipuId = String(jump?.qipuid || row.commonBaseInfo?.qipuid || '')
    const officialPage = jump?.iqiyiPC
    if (!/^[1-9]\d{0,19}$/.test(qipuId) || !/^https:\/\/sports\.iqiyi\.com\/resource\/pcw\/play\/[a-z0-9]+$/.test(officialPage || '')
        || !title || /宗教|佛教|基督|福音|讲经/.test(title)) return
    const item = { id: `vod-${qipuId}`, qipuId, kind, officialPage, title: title.replace(/[\r\n]/g, ' ').replace(/^[【\[](?:回放|集锦)[】\]]\s*/, ''),
      date: /^\d{4}-\d{2}-\d{2}/.test(date || '') ? date.slice(0, 10) : '',
      publishedAt: String(date || ''), free, entitlementOptions: entitlementOptions(pay) }
    const prior = found.get(item.id)
    if (!prior) found.set(item.id, item)
    else found.set(item.id, { ...(!prior.date && item.date ? item : prior),
      entitlementOptions: [...new Set([...prior.entitlementOptions, ...item.entitlementOptions])] })
  }
  walk(body.retData, row => {
    if (!row || typeof row !== 'object') return
    const base = row.commonBaseInfo, special = row.specialBaseInfo, match = row.matchBaseInfo
    // Finished match cards explicitly link separate videos, not the old live room.
    if (String(match?.status) === '2') {
      const date = match.matchRoomStartTime || special?.publishTime
      add(row, row.jumpInfoLived, 'replay', match.title, date, false)
      add(row, row.jumpInfoHighlight, 'highlight', match.title, date, true)
    }
    if (base?.type !== 'V') return
    const title = special?.title, marker = base.customerMakerName || special?.tagName || ''
    const kind = /回放|全场/.test(marker) || /^[【\[][^】\]]*回放/.test(title || '') ? 'replay'
      : /集锦/.test(marker) || /^[【\[]集锦/.test(title || '') ? 'highlight' : ''
    if (kind) add(row, row.jumpInfo, kind, title, special?.publishTime, String(base.payInfo?.isFree) === '1', base.payInfo)
  })
  return [...found.values()]
}
export function sortVods(vods) {
  return [...vods].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
}
// Topic schedules nest rows inside leftModules/rightModules/list/resContentJA.
function walk(value, visit) {
  const pending = [value]
  let count = 0
  while (pending.length) {
    const item = pending.pop()
    if (++count > 100000) throw new Error('爱奇艺目录结构超出扫描上限，覆盖检查未完成')
    visit(item)
    if (item && typeof item === 'object') pending.push(...Object.values(item).reverse())
  }
}
export function normalizeEvents(body) {
  if (String(body?.resCode) !== '200' || !body.retData || typeof body.retData !== 'object') throw new Error('爱奇艺官方赛事目录格式变化')
  const result = [], seen = new Set()
  walk(body.retData, row => {
    const match = row?.matchBaseInfo, page = row?.jumpInfo?.iqiyiPC
    if (String(match?.status) !== '1' || !/^[1-9]\d{0,19}$/.test(String(match.matchId))
        || !/^https:\/\/sports\.iqiyi\.com\/resource\/pcw\/live\/[a-z0-9]+$/.test(page || '')
        || !match.title || /宗教|佛教|基督|福音|讲经/.test(match.title) || seen.has(String(match.matchId))) return
    seen.add(String(match.matchId))
    result.push({ id: String(match.matchId), title: String(match.title).replace(/[\r\n]/g, ' '), officialPage: page,
      qipuId: String(match.qipuid || ''), free: String(match.isFree) === '1', startTime: match.matchRoomStartTime, entitlementOptions: entitlementOptions(row.commonBaseInfo?.payInfo) })
  })
  return result
}
function discoverSources(body) {
  const sources = new Set(), legacy = new Set()
  walk(body, value => {
    if (typeof value !== 'string') return
    if (/^https:\/\/sports\.iqiyi\.com\/resource\/json\/pc\/channel\/menu_\d+\.json$/.test(value)) sources.add(value)
    const topic = value.match(/^https:\/\/sports\.iqiyi\.com\/resource\/pc\/index_pc\.html#\/specialProgramNew\/(\d+)$/)
    if (topic) sources.add(`https://sports.iqiyi.com/resource/json/pc/specialProgram_new/new/special_p_${topic[1]}_0.json`)
    // The official frontend's euroJsonData uses the older path without /new/.
    const oldTopic = value.match(/^https:\/\/sports\.iqiyi\.com\/(?:sport|resource\/pc)\/index_pc\.html#\/specialProgram\/(\d+)$/)
    if (oldTopic) {
      legacy.add(value)
      sources.add(`https://sports.iqiyi.com/resource/json/pc/specialProgram_new/special_p_${oldTopic[1]}_0.json`)
    }
    if (/^https:\/\/sports\.iqiyi\.com\/resource\/json\/pc\/(?:specialProgram_new\/(?:new\/)?special_p_\d+_0|specialProgram\/specials\/special_\d+)\.json$/.test(value)) sources.add(value)
  })
  return { sources, legacy }
}
export function createCatalog({ fetchImpl = officialFetch, now = Date.now } = {}) {
  let cache, task
  const sourceCache = new Map()
  async function json(url) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(10000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.json()
  }
  function refresh() {
    task ||= scan().finally(() => { task = undefined })
    return task
  }
  async function scan() {
    const config = await json(CONFIG_URL)
    const initial = discoverSources(config)
    if (!initial.sources.size) throw new Error('爱奇艺官方菜单配置为空')
    const seen = new Set(), legacy = initial.legacy, warnings = [], byId = new Map(), vodById = new Map()
    let pending = [...initial.sources], succeeded = 0, failed = 0
    while (pending.length) {
      const batch = pending.splice(0, 4).filter(url => !seen.has(url))
      for (const url of batch) seen.add(url)
      if (seen.size > 64) throw new Error('爱奇艺目录入口超出扫描上限，保留上次频道')
      const responses = await Promise.allSettled(batch.map(async url => {
        const body = await json(url)
        const events = normalizeEvents(body), vods = normalizeVods(body), links = discoverSources(body)
        return { events, vods, links }
      }))
      for (let i = 0; i < responses.length; i++) {
        const response = responses[i], url = batch[i]
        let data
        if (response.status === 'fulfilled') {
          succeeded++; data = response.value; sourceCache.set(url, data)
        } else {
          failed++; warnings.push(`爱奇艺目录覆盖不完整：${url}（${response.reason.message}）`)
          data = sourceCache.get(url)
        }
        if (!data) continue
        for (const vod of data.vods) {
          const prior = vodById.get(vod.id)
          if (!prior) vodById.set(vod.id, vod)
          else vodById.set(vod.id, { ...(!prior.date && vod.date ? vod : prior),
            entitlementOptions: [...new Set([...prior.entitlementOptions, ...vod.entitlementOptions])] })
        }
        for (const event of data.events) if (!byId.has(event.id)) byId.set(event.id, event)
        for (const link of data.links.sources) if (!seen.has(link) && !pending.includes(link)) pending.push(link)
        for (const link of data.links.legacy) legacy.add(link)
      }
    }
    if (!succeeded) throw new Error('爱奇艺赛事目录全部读取失败，保留上次频道')
    const candidates = [...byId.values()], events = []
    let verifiedLive = 0
    // Topic status may be stale. The official playback page loads this event detail API.
    for (let offset = 0; offset < candidates.length; offset += 4) {
      const batch = candidates.slice(offset, offset + 4)
      const details = await Promise.allSettled(batch.map(async event => {
        if (!/^[1-9]\d{0,19}$/.test(event.qipuId)) throw new Error('缺少有效 qipuId')
        const body = await json(`https://sports.iqiyi.com/resource/json/matchinfo_new/qipuid/matchinfo_${event.qipuId}.json`)
        const match = body?.retData?.matchBaseInfo
        if (String(body?.resCode) !== '200' || String(match?.matchId) !== event.id || String(match?.qipuid) !== event.qipuId
            || !['0', '1', '2'].includes(String(match?.status))) throw new Error('官方赛事详情格式或身份不匹配')
        return String(match.status) === '1' ? { ...event, free: String(match.isFree) === '1',
          entitlementOptions: [...new Set([...event.entitlementOptions, ...entitlementOptions(body.retData.commonBaseInfo?.payInfo)])] } : null
      }))
      for (let i = 0; i < details.length; i++) {
        const detail = details[i], event = batch[i]
        if (detail.status === 'fulfilled') { if (detail.value) { events.push(detail.value); verifiedLive++ } }
        else {
          warnings.push(`爱奇艺在播状态未确认：${event.title}（${detail.reason.message}）`)
          const previous = cache?.events.find(e => e.id === event.id)
          if (previous) events.push(previous)
        }
      }
    }
    cache = { at: now(), events, vods: sortVods([...vodById.values()]), warnings, coverage: { sources: seen.size, succeeded, failed, legacyTopics: legacy.size,
      candidates: candidates.length, verifiedLive, complete: warnings.length === 0 } }
    return cache
  }
  return {
    // allowStale: playback answers from a cache up to ten minutes old while a scan
    // (about 18 requests, several seconds) runs in the background.
    async discover({ allowStale = false } = {}) {
      const age = cache ? now() - cache.at : Infinity
      if (age < 60000) return cache
      if (allowStale && age < 600000) { refresh().catch(() => {}); return cache }
      return refresh()
    },
    clear() { cache = undefined; sourceCache.clear() },
  }
}
export function selectAuthorizedStream(data, hasLogin) {
  const preview = data?.bossRet
  if (preview?.data?.prv === '1' || Number(preview?.previewTime) > 0) {
    throw Object.assign(new Error('此赛事仅获试看授权，请登录或确认本人体育会员/赛事权益'), { credential: true })
  }
  const member = hasLogin && preview?.code === 'A00000' && preview?.data?.prv === '0'
  if (!member && Number(data?.boss) !== 0) throw Object.assign(new Error('此赛事没有完整播放授权，请检查本人账号及赛事权益'), { credential: true })
  if (data?.program?.liveDrmInfo?.drm) throw new Error('此赛事需要官方 DRM 播放器，普通 M3U 无法播放')
  const stream = data?.streams?.filter(s => s.formatType === 'TS' && s.codeFormat === 2 && s.url)
    .sort((a, b) => Number(b.bitrate) - Number(a.bitrate))[0]
  if (!stream) throw new Error('官方未提供可用的 H.264 HLS')
  validateMediaUrl(stream.url)
  return { url: stream.url, size: stream.screenSize, bid: stream.bid, member }
}
// Use only the clear, complete HLS actually returned to the official player.
// drmType=1 also appears on clear TS (verified with ffprobe/ffmpeg); encryption
// is checked from the HLS, while other DRM formats are left to the official player.
export function selectVodStream(captured, event) {
  const data = captured.data
  if (captured.code !== 'A00000' || !data?.program?.video?.length) throw new Error('官方未返回此点播的播放授权，请在官网确认登录及赛事权益')
  if (String(data.tvid) !== event.qipuId) throw new Error('官方点播视频与目录不一致')
  const videos = data.program.video.filter(v => v.m3u8 && v.ff === 'ts' && Number(v.code) === 2)
    .sort((a, b) => Number(b.bid) - Number(a.bid))
  let incomplete
  for (const video of videos) {
    if (Number(video.isPreview) === 1 || Number(video.ptt) > 0) continue
    if (video.drmType != null && ![0, 1].includes(Number(video.drmType))) continue
    const text = checkManifest(video.m3u8)
    if (!/^#EXT-X-ENDLIST\s*$/m.test(text)) continue
    const duration = [...text.matchAll(/^#EXTINF:([\d.]+)/gm)].reduce((sum, m) => sum + Number(m[1]), 0)
    const expected = Number(video.duration)
    if (!(expected > 0 && duration > 0 && duration >= expected - 5 && duration <= expected + 10)) {
      if (duration > 0 && expected > duration + 10) incomplete = { duration, expected }
      continue
    }
    const urls = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    if (!urls.length) continue
    for (const url of urls) validateMediaUrl(url)
    return { url: event.officialPage, manifestText: text.includes('#EXT-X-PLAYLIST-TYPE:') ? text : text.replace('#EXTM3U', '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD'), size: video.scrsz || '', bid: video.bid, duration,
      member: captured.hasLogin && !event.free }
  }
  if (incomplete) throw Object.assign(new Error(`此回放仅返回 ${Math.round(incomplete.duration)} 秒片段（全长 ${Math.round(incomplete.expected)} 秒），未获得完整观看权益；请在官网确认单场或专项权益`), { credential: true })
  throw Object.assign(new Error('官方未提供完整、未加密的 H.264 点播 HLS；试看或 DRM 内容请使用官方播放器'), { credential: videos.some(v => Number(v.isPreview) === 1 || Number(v.ptt) > 0) })
}
export const selectAuthorizedMedia = (captured, event) => event.kind ? selectVodStream(captured, event) : selectAuthorizedStream(captured.data, captured.hasLogin)
export function validateMediaUrl(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port
      || !/(^|\.)(iqiyi\.com|71edge\.com)$/.test(url.hostname)) throw new Error('媒体地址不在已验证的爱奇艺官方 CDN 内')
  return url.href
}
export function checkManifest(text) {
  if (!text.trimStart().startsWith('#EXTM3U') || text.length > 2 * 1024 * 1024) throw new Error('官方未返回有效 HLS 清单')
  if ([...text.matchAll(/#EXT-X-(?:SESSION-)?KEY:METHOD=([^,\r\n]+)/g)].some(m => m[1] !== 'NONE')) throw new Error('此赛事 HLS 加密，请使用官方播放器')
  return text
}
