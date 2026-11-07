// 官方网页匿名会话、频道集合与 Live Now；不保存票据，不固定地区。
import { outboundFetch } from '../../utils/outboundProxy.js'
import { topVariantFirst } from '../../utils/hlsTopFirst.js'
import { liveWindow } from './hls.js'

export const HOME = 'https://www.redbull.tv/en_US'
export const MEDIA_HOSTS = ['play.redbull.com', 'freqsyndlin.redbull.com', 'rbmn-live.akamaized.net', 'cs.liiift.io']
export const API_HOSTS = ['www.redbull.tv', 'redbull.tv', 'tv-api.redbull.com', 'play.redbull.com']
export const TOPICS = { 'World of Red Bull': '红牛综合', Padel: '红牛板式网球', Bike: '红牛自行车', Adventure: '红牛户外探险',
  Motorsports: '红牛赛车', Surfing: '红牛冲浪', Skateboarding: '红牛滑板', Winter: '红牛冬季运动', 'Action Reel': '红牛极限精选' }
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const ID_RE = new RegExp(`^rrn:content:(video-channels|live-videos):(${UUID})$`)
const REF_RE = new RegExp(`^redbull-(channel|event)-(${UUID})$`)
export const claimsRef = ref => REF_RE.test(String(ref || ''))
export function refFor(id) {
  const match = ID_RE.exec(String(id))
  if (!match) throw new Error('无效的红牛节目 ID')
  return `redbull-${match[1] === 'video-channels' ? 'channel' : 'event'}-${match[2]}`
}
export function idFor(ref) {
  const match = REF_RE.exec(String(ref))
  if (!match) throw new Error('未知的红牛播放引用')
  return `rrn:content:${match[1] === 'channel' ? 'video-channels' : 'live-videos'}:${match[2]}`
}
export function safeUrl(raw, hosts = MEDIA_HOSTS) {
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !hosts.includes(url.hostname))
    throw new Error('上游地址不在已确认的红牛官方链路中')
  return url.href
}
export function redact(error) {
  return String(error?.message || error).replace(/https?:\/\/[^\s"'<>]+/g, '[上游地址]').replace(/eyJ[\w.-]{50,}/g, '[票据]')
}
async function readLimited(response, limit = 8 * 1024 * 1024) {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('官方响应过大') }
  let size = 0; const parts = []
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > limit) throw new Error('官方响应过大')
    parts.push(Buffer.from(chunk))
  }
  return Buffer.concat(parts).toString('utf8')
}
export function checkManifest(text, { live = false } = {}) {
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('官方未返回有效 HLS 清单')
  if (/^#EXT-X-(?:SESSION-)?KEY:(?![^\r\n]*METHOD=NONE(?:,|$))/m.test(text)) throw new Error('此节目使用加密播放，请使用官方播放器')
  if (live && /^#EXT-X-ENDLIST/m.test(text)) throw new Error('赛事直播已经结束')
  return text
}
export function validateManifest(text, base) {
  checkManifest(text)
  for (const line of text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
    if (!line.startsWith('#')) safeUrl(new URL(line, base))
    else for (const match of line.matchAll(/URI="([^"]+)"/g)) safeUrl(new URL(match[1], base))
  }
  return text
}
export function createTransport({ fetchImpl = outboundFetch, timeoutMs = 25000 } = {}) {
  async function request(raw, { hosts = API_HOSTS, ...options } = {}) {
    let url = safeUrl(raw, hosts)
    const signal = options.signal || AbortSignal.timeout(timeoutMs)
    for (let hop = 0; hop < 6; hop++) {
      const extra = typeof options.upstreamHeaders === 'function' ? options.upstreamHeaders(url) : options.upstreamHeaders
      const response = await fetchImpl(url, { method: options.method || 'GET', headers: { 'User-Agent': 'Mozilla/5.0', ...extra, ...options.headers }, signal, redirect: 'manual' })
      if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url }
      const next = response.headers.get('location'); await response.body?.cancel()
      if (!next) throw new Error('官方重定向缺少地址')
      url = safeUrl(new URL(next, url), hosts)
    }
    throw new Error('官方重定向过多')
  }
  async function text(raw, options) {
    const { response, url } = await request(raw, options)
    if (!response.ok) { await response.body?.cancel(); throw new Error(`红牛官方返回 HTTP ${response.status}`) }
    return { text: await readLimited(response), url }
  }
  async function media(raw, options = {}) {
    const { response, url } = await request(raw, { ...options, hosts: MEDIA_HOSTS })
    if (options.method === 'HEAD' || !response.ok || !(new URL(url).pathname.endsWith('.m3u8') || /mpegurl/i.test(response.headers.get('content-type') || ''))) return response
    const body = liveWindow(validateManifest(await readLimited(response, 2 * 1024 * 1024), url))
    const headers = new Headers(response.headers)
    headers.delete('content-encoding'); headers.delete('content-length')
    const checked = new Response(body, { status: response.status, headers })
    Object.defineProperty(checked, 'url', { value: url })
    return checked
  }
  return { text, json: async url => JSON.parse((await text(url)).text), media }
}
export function readJsonAt(text, offset) {
  const start = text.indexOf('{', offset); if (start < 0) return null;
  let depth = 0, string = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (string) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') string = false; }
    else if (char === '"') string = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  return null;
}
export function parseBootstrap(html) {
  const flight = [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)/g)]
    .map(match => JSON.parse(match[1])).join('');
  const sessionAt = flight.indexOf('"session":');
  const session = sessionAt >= 0 ? readJsonAt(flight, sessionAt + 10) : null;
  if (!session || !['country_code', 'locale', 'category', 'os_family', 'device_group'].every(key => typeof session[key] === 'string')) {
    throw new Error('无法读取官网的匿名地区会话');
  }
  const idsAt = flight.indexOf('"api_ids":');
  const ids = idsAt >= 0 ? readJsonAt(flight, idsAt + 10) : null;
  const rails = new Map([...flight.matchAll(/"id":"([^"]+)","label":"([^"]+)"/g)].map(match => [match[2], match[1]]));
  if (!ids?.epg_product || !rails.get('Live Now')) throw new Error('官网目录结构已变化，需要重新确认');
  return { session: Object.fromEntries(['country_code', 'locale', 'category', 'os_family', 'device_group'].map(key => [key, session[key]])),
    ids, liveRail: rails.get('Live Now'), replayRail: rails.get('Replays'), namespace: 'rbtv' };
}
const badges = item => new Set((item.badges || []).filter(x => x && typeof x === 'object').map(x => x.type));
export function classify(item, now = Date.now()) {
  if (item.content_type === 'video_channel') return 'linear';
  const tags = badges(item), start = Date.parse(item.start_time);
  if (start > now || tags.has('upcoming')) return 'upcoming';
  if (tags.has('replay_available')) return 'replay';
  if (tags.has('live')) return item.content_type === 'live_program' ? 'live' : 'event';
  return 'ended';
}

export function isPublicLive(item, now = Date.now()) {
  const kind = classify(item, now)
  return ID_RE.test(String(item.id)) && ['linear', 'live'].includes(kind) && item.playable === true
    && !(item.content_entitlements || []).length
    && !(item.links || []).some(link => link.action === 'play' && link.content_entitlements?.length)
}
async function mapLimit(items, task) {
  let next = 0; const result = new Array(items.length)
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (next < items.length) { const index = next++; result[index] = await task(items[index]) }
  }))
  return result
}
export class Provider {
  constructor({ fetchImpl = outboundFetch, now = Date.now, timeoutMs } = {}) {
    this.io = createTransport({ fetchImpl, timeoutMs }); this.now = now
    this.metadata = new Map(); this.playback = new Map(); this.pending = new Map()
  }
  async bootstrap() {
    if (this.context && this.now() - this.context.at < 3600000) return this.context
    this.booting ||= this.io.text(HOME).then(({ text }) => {
      this.context = { ...parseBootstrap(text), at: this.now() }; return this.context
    }).finally(() => { this.booting = null })
    return this.booting
  }
  api(type, id, version = 'v5.3') {
    const { namespace, session: s } = this.context
    return `https://tv-api.redbull.com/${type}/${version}/${namespace}/${s.locale}/${s.country_code}/${encodeURIComponent(id)}`
  }
  async product(id) {
    const cached = this.metadata.get(id)
    if (cached && this.now() - cached.at < 300000) return cached.value
    const value = await this.io.json(this.api('products', id))
    // 长期运行只留下近期元数据；任意旧订阅仍可按稳定 ID 在播放时重新取。
    for (const [key, entry] of this.metadata) if (this.now() - entry.at >= 300000) this.metadata.delete(key)
    this.metadata.set(id, { value, at: this.now() }); return value
  }
  async collection(id) {
    const cards = [], seen = new Set(); let url = this.api('collections', id)
    for (let page = 0; page < 30; page++) {
      const data = await this.io.json(url)
      if (!Array.isArray(data.cards)) throw new Error('官方目录未返回有效节目列表')
      cards.push(...data.cards)
      const next = data.meta?.next
      if (next == null || next === '' || next === false) {
        if (Number(data.meta?.total || 0) > cards.length) throw new Error('官方目录分页不完整')
        return [...new Map(cards.map(card => [card.id, card])).values()]
      }
      if ((typeof next !== 'string' && typeof next !== 'number') || seen.has(String(next))) throw new Error('官方目录分页异常')
      seen.add(String(next))
      const target = /^\d+$/.test(String(next)) ? new URL(this.api('collections', id) + `?offset=${next}`) : new URL(next, 'https://tv-api.redbull.com')
      if (target.origin !== 'https://tv-api.redbull.com' || !target.pathname.startsWith('/collections/')) throw new Error('官方目录分页目标无效')
      url = target.href
    }
    throw new Error('官方目录超过分页上限')
  }
  async discover() {
    const context = await this.bootstrap()
    if (!this.channels || this.now() - this.channels.at >= 3600000) {
      const epg = await this.product(context.ids.epg_product)
      const cards = (await Promise.all((epg.collections || []).map(c => this.collection(c.id)))).flat()
      const values = [...new Map(cards.filter(c => c.content_type === 'video_channel').map(c => [c.id, c])).values()]
      if (!values.length) throw new Error('官方目录没有返回轮播频道')
      this.channels = { at: this.now(), values }
    }
    // Live Now 是官方在播集合；活动卡展开其官方场次列表，支持多个场地，不扫描回放库。
    const live = await this.collection(context.liveRail)
    const entries = new Map(this.channels.values.map(c => [c.id, c])), warnings = []
    const liveEvents = live.filter(c => classify(c, this.now()) === 'event')
    await mapLimit(liveEvents, async event => {
      try {
        const product = await this.product(event.id)
        const schedules = (await Promise.all((product.collections || []).filter(c => /:live_programs$/.test(c.id)).map(c => this.collection(c.id)))).flat()
        for (const item of schedules) entries.set(item.id, { ...item, eventTitle: event.title })
      } catch (error) { warnings.push(`${event.title || '赛事'}：${redact(error)}`) }
    })
    for (const item of live) if (item.content_type === 'live_program') entries.set(item.id, item)
    const candidates = [...entries.values()].filter(c => c.content_type === 'live_program')
    // 集合可能短暂滞后；每轮以动态状态复核，结束/预告/受限的不能继续输出直播。
    await mapLimit(candidates, async item => {
      try { entries.set(item.id, { ...item, ...await this.io.json(this.api('products/dynamic', item.id, 'v5.2')) }) }
      catch (error) { entries.delete(item.id); warnings.push(`${item.title || '赛事'}状态核验失败：${redact(error)}`) }
    })
    return { items: [...entries.values()].filter(item => isPublicLive(item, this.now())), warnings, region: context.session.country_code }
  }
  async resolve(ref) {
    const id = idFor(ref)
    const hit = this.playback.get(id)
    if (hit && this.now() - hit.at < 15000) return hit.value
    if (this.pending.has(id)) return this.pending.get(id)
    const task = this.resolveFresh(id).finally(() => this.pending.delete(id))
    this.pending.set(id, task); return task
  }
  async resolveFresh(id) {
    await this.bootstrap()
    const [product, dynamic] = await Promise.all([this.product(id), this.io.json(this.api('products/dynamic', id, 'v5.2'))])
    const item = { ...product, ...dynamic, id }
    if ((product.content_entitlements || []).length || !isPublicLive(item, this.now())) throw new Error('节目尚未开播、已结束或当前地区无公开播放权限，请查看红牛官方页面')
    const { session: s, namespace } = this.context
    const init = await this.io.json(`https://play.redbull.com/init/v1/${namespace}/${s.locale}/${s.country_code}/${s.category}/${s.os_family}/${encodeURIComponent(id)}?device_group=${encodeURIComponent(s.device_group)}`)
    if (init.manifest_type !== 'hls' || !init.manifest_url) throw new Error('官方未提供公开 HLS 播放入口')
    const master = await this.io.text(safeUrl(init.manifest_url), { hosts: MEDIA_HOSTS })
    const manifestText = topVariantFirst(liveWindow(validateManifest(checkManifest(master.text, { live: true }), master.url)))
    // 即使动态状态还写着 live，也不能把已经封口的录像当直播。取最高档子清单复核。
    if (item.content_type === 'live_program') {
      let media = { text: manifestText, url: master.url }
      for (let depth = 0; depth < 4; depth++) {
        checkManifest(media.text, { live: true })
        const child = media.text.match(/^#EXT-X-STREAM-INF:[^\r\n]*\r?\n([^#\r\n]+)/m)?.[1]
        if (!child) break
        if (depth === 3) throw new Error('官方 HLS 嵌套过深')
        media = await this.io.text(safeUrl(new URL(child.trim(), media.url)), { hosts: MEDIA_HOSTS })
      }
    }
    const value = { url: master.url, manifestUrl: master.url, manifestText, desc: TOPICS[item.title] || item.title,
      proxyHls: true }
    // safeUrl 的第二参数是域名白名单；包装后避免主项目传入额外参数改变校验。
    value.upstreamUrlTransform = url => safeUrl(url)
    for (const [key, entry] of this.playback) if (this.now() - entry.at >= 15000) this.playback.delete(key)
    this.playback.set(id, { at: this.now(), value }); return value
  }
}
