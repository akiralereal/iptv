import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { createTransport, safeUrl, HOME, API, API_HOSTS, redact } from './transport.js'
import { attrs, highestPlaylist, variantsIn, mediaInfo } from './hls.js'
import { eligible, exclusionReason, FAMILY_NAMES } from './policy.js'
import { Store } from './store.js'

const execute = promisify(execFile)
export const INTERVALS = { update: 24 * 3600000, check: 6 * 3600000 }
export const claimsRef = ref => /^xumo-\d{6,12}$/.test(String(ref || ''))
export const refFor = id => { if (!/^\d{6,12}$/.test(String(id))) throw new Error('无效的 Xumo 频道 ID'); return `xumo-${id}` }
export const logoFor = id => `https://image.xumo.com/v1/channels/channel/${id}/168x168.png?type=color_onBlack`
export function parseCatalog(text) {
  const match = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(text)
  if (!match) throw new Error('Xumo 官方目录结构发生变化')
  const data = JSON.parse(match[1])
  if (data.runtimeConfig?.XUMO_API_URL !== new URL(API).hostname) throw new Error('Xumo 官方接口配置变化')
  const page = data.props?.pageProps?.page, genres = new Map((page?.genres || []).map(g => [g.id, g.name]))
  if (!Array.isArray(page?.channels) || !page.channels.length) throw new Error('Xumo 官方目录为空')
  const seen = new Set()
  return page.channels.map(c => {
    if (!/^\d{6,12}$/.test(String(c.id)) || seen.has(c.id) || !c.name?.trim() || !/^[a-z0-9-]+$/.test(c.slug) || !genres.has(c.genre)) throw new Error('Xumo 官方目录频道信息不完整')
    seen.add(c.id)
    return { id: c.id, name: c.name.trim(), slug: c.slug, description: c.description || '', genreId: c.genre,
      genre: FAMILY_NAMES[c.id] ? 'Family Movies' : genres.get(c.genre), logo: logoFor(c.id) }
  })
}
export function cleanEntry(raw) {
  const url = new URL(raw)
  for (const [key, rawValue] of [...url.searchParams]) {
    const value = rawValue.replaceAll('[PLATFORM]', 'web')
    if (!value || /\[[A-Za-z_]+\]/.test(value)) url.searchParams.delete(key)
    else url.searchParams.set(key, value)
  }
  return safeUrl(url)
}
export async function decodeSample(blob, { signal } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'iptv-xumo-')), file = join(dir, 'sample.ts')
  try {
    await writeFile(file, blob)
    const options = { timeout: 25000, signal, maxBuffer: 1024 * 1024 }
    const probe = await execute(process.env.FFPROBE_BIN || 'ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'json', file], options)
    const streams = JSON.parse(probe.stdout).streams || []
    if (!streams.some(s => ['video', 'audio'].includes(s.codec_type))) throw new Error('样本没有音视频轨')
    const result = await execute(process.env.FFMPEG_BIN || 'ffmpeg', ['-nostdin', '-v', 'error', '-threads', '1', '-filter_threads', '1', '-i', file,
      '-map', '0:v:0?', '-map', '0:a:0?', '-t', '2', '-progress', 'pipe:1', '-f', 'null', '-'], options)
    if (![...result.stdout.matchAll(/out_time_us=(\d+)/g)].some(m => Number(m[1]) > 0)) throw new Error('音视频样本未能解码')
    return streams
  } finally { await rm(dir, { recursive: true, force: true }) }
}
export class Provider {
  constructor({ store = new Store(), now = Date.now, workers = 8, isEnabled = () => true, decode = decodeSample, ...options } = {}) {
    this.store = store; this.now = now; this.workers = workers; this.isEnabled = isEnabled; this.decode = decode
    this.state = store.load(); this.runtime = store.runtime(); this.controller = new AbortController()
    this.io = createTransport({ ...options, signal: this.controller.signal, canRun: () => this.enabled() })
    this.inFlight = null; this.plays = new Map(); this.playCache = new Map()
    for (const kind of Object.keys(INTERVALS)) this.runtime.jobs[kind] ||= { nextRunAt: 0, failureStreak: 0 }
  }
  enabled() { return !this.controller.signal.aborted && this.isEnabled() }
  assertEnabled() { if (!this.enabled()) throw new Error('Xumo 模块已关闭') }
  channels() { return Object.fromEntries(Object.entries(eligible(this.state.channels)).filter(([id]) => !this.runtime.excluded[id])) }
  async catalog() { return parseCatalog((await this.io.text(HOME, { hosts: API_HOSTS })).text) }
  async entries(channel) {
    if (exclusionReason(channel)) throw new Error('宗教频道已排除')
    const hour = new Date(this.now()).getUTCHours()
    const data = await this.io.json(`${API}/v2/channels/channel/${channel.id}/broadcast.json?hour=${hour}`)
    const found = [], protectedPaths = new Set((data.ssaiStreamUrls || []).filter(s => s.drm).map(s => new URL(s.url).pathname))
    for (const s of data.ssaiStreamUrls || []) if (!s.drm && /mpegurl/i.test(s.mimeType || '') && !protectedPaths.has(new URL(s.url).pathname)) found.push(s.url)
    if (data.ssaiStreamUrl && !protectedPaths.has(new URL(data.ssaiStreamUrl).pathname) && !new URL(data.ssaiStreamUrl).pathname.endsWith('.mpd')) found.push(data.ssaiStreamUrl)
    if (!found.length && protectedPaths.size) throw new Error('DRM 频道请使用官方播放器')
    if (!found.length) for (const a of data.assets || []) {
      if (a.live !== true || !/^[A-Za-z0-9]+$/.test(a.id)) continue
      const asset = await this.io.json(`${API}/v2/assets/asset/${a.id}.json?f=providers&f=title`)
      if (asset.contentType !== 'SIMULCAST') continue
      for (const p of asset.providers || []) for (const s of p.sources || []) if (!s.drm && /mpegurl/i.test(s.produces || '')) found.push(s.uri)
    }
    const result = []
    for (let entry of new Set(found)) {
      if (new URL(entry).hostname === 'ottcms.weathergroup.com') entry = await this.io.json(entry)
      result.push(cleanEntry(entry))
    }
    if (!result.length) throw new Error('官方没有独立的直播 HLS 入口')
    return result
  }
  async highest(entry) {
    const root = await this.io.hls(entry)
    return { ...highestPlaylist(root.text, root.url, safeUrl), url: root.url }
  }
  async check(entry, deep = false) {
    const master = await this.highest(entry), selected = variantsIn(master.text)[0]
    const media = selected ? await this.io.hls(selected.uri) : master
    const info = mediaInfo(media.text, media.url)
    const audios = master.text.split(/\r?\n/).filter(l => l.startsWith('#EXT-X-MEDIA:')).map(attrs).filter(a => a.TYPE === 'AUDIO' && a.URI)
    const audio = audios.find(a => a.DEFAULT === 'YES') || audios[0]
    let external
    if (audio) { external = await this.io.hls(audio.URI); mediaInfo(external.text, external.url) }
    if (deep) {
      await this.sample(media)
      if (external) await this.sample(external)
      let advanced = false
      for (let attempt = 0; attempt < 3; attempt++) {
        const later = await this.io.hls(media.url), next = mediaInfo(later.text, later.url)
        if (next.sequence > info.sequence || next.segments.at(-1) !== info.segments.at(-1)) { advanced = true; break }
        if (attempt < 2) await delay(Math.min(12000, Math.max(3000, (info.duration + 1) * 1000)), undefined, { signal: this.controller.signal })
      }
      if (!advanced) throw new Error('直播清单未推进')
    }
    return { at: new Date(this.now()).toISOString(), resolution: master.selected?.RESOLUTION,
      level: deep ? 'segment-decode-and-live-advance' : 'master-and-media-playlists' }
  }
  async sample(media) {
    const info = mediaInfo(media.text, media.url), chunks = []
    if (/^#EXT-X-KEY:(?![^\r\n]*METHOD=NONE(?:,|$))/m.test(media.text)) throw new Error('新加密源尚未完成样本验证，保留上一有效地址')
    const mapLine = media.text.split(/\r?\n/).find(l => l.startsWith('#EXT-X-MAP:'))
    if (mapLine) chunks.push(await this.io.bytes(new URL(attrs(mapLine).URI, media.url)))
    const samples = info.segments.length > 1 ? info.segments.slice(-3, -1) : info.segments
    for (const url of samples) chunks.push(await this.io.bytes(url))
    this.assertEnabled()
    await this.decode(Buffer.concat(chunks), { signal: this.controller.signal })
  }
  async resolveCheck(channel, previous) {
    const errors = []
    for (const entry of await this.entries(channel)) {
      try { return { entry, evidence: await this.check(entry, !previous || previous.entry !== entry) } }
      catch (error) { errors.push(redact(error)) }
    }
    throw new Error(errors.join('; ') || '无可用直播入口')
  }
  async run(kind) {
    if (this.inFlight) return this.inFlight
    this.assertEnabled()
    this.active = kind; this.progress = { done: 0, total: 0 }
    this.inFlight = this.maintain(kind).then(() => true, error => {
      if (this.enabled()) {
        const job = this.runtime.jobs[kind]; job.failureStreak = (job.failureStreak || 0) + 1
        job.error = redact(error); job.nextRunAt = this.now() + Math.min(INTERVALS[kind], 1800000 * 2 ** Math.min(6, job.failureStreak - 1))
        try { this.store.saveRuntime(this.runtime) } catch { /* 保留有效快照，下一轮重试 */ }
      }
      return false
    }).finally(() => { this.active = null; this.inFlight = null })
    return this.inFlight
  }
  async maintain(kind) {
    if (!INTERVALS[kind]) throw new Error('未知 Xumo 维护任务')
    const old = this.state, metadata = kind === 'update' ? await this.catalog() : Object.values(this.channels())
    if (kind === 'update' && metadata.length < old.catalogCount * 0.7) throw new Error('官方目录异常缩减，保留上一清单')
    if (kind === 'update') {
      this.runtime.excluded = Object.fromEntries(metadata.filter(exclusionReason).map(c => [c.id, exclusionReason(c)]))
      this.store.saveRuntime(this.runtime)
    }
    const channels = metadata.filter(c => !exclusionReason(c)), results = new Map(); let cursor = 0
    this.progress.total = channels.length
    const batches = await Promise.allSettled(Array.from({ length: Math.min(this.workers, channels.length) }, async () => {
      while (cursor < channels.length) {
        this.assertEnabled()
        const c = channels[cursor++]
        try {
          let result
          if (kind === 'check') {
            try { result = { entry: c.entry, evidence: await this.check(c.entry) } }
            catch { result = await this.resolveCheck(c) }
          } else result = await this.resolveCheck(c, old.channels[c.id])
          results.set(String(c.id), { ok: true, ...result })
        } catch (error) { results.set(String(c.id), { ok: false, error: redact(error) }) }
        this.progress.done++
      }
    }))
    const failed = batches.find(result => result.status === 'rejected')
    if (failed) throw failed.reason
    this.assertEnabled()
    const existing = channels.filter(c => old.channels[c.id]), passed = existing.filter(c => results.get(String(c.id))?.ok).length
    if (passed < Math.max(1, Math.ceil(existing.length * 0.7))) throw new Error('多数已有频道验证失败，保留上一清单')
    const next = structuredClone(old), seen = new Set(channels.map(c => String(c.id))), at = this.now()
    next.channels = this.channels()
    for (const c of channels) {
      const id = String(c.id), result = results.get(id)
      if (result.ok) next.channels[id] = { ...old.channels[id], ...c, entry: result.entry, missingCount: 0, missingSince: 0,
        verifiedAt: result.evidence.at, validation: result.evidence.level }
      this.runtime.channelHealth[id] = { status: result.ok ? 'available' : old.channels[id] ? 'retained' : 'unavailable', at, error: result.error }
    }
    if (kind === 'update') for (const [id, c] of Object.entries(next.channels)) if (!seen.has(id)) {
      if (c.missingSince && at - c.missingSince >= INTERVALS.update) delete next.channels[id]
      else { c.missingSince ||= at; c.missingCount = (c.missingCount || 0) + 1 }
    }
    if (kind === 'update') next.catalogCount = metadata.length
    next.generation++; next.publishedAt = new Date(at).toISOString()
    this.store.publish(next); this.state = next
    Object.assign(this.runtime.jobs[kind], { nextRunAt: at + INTERVALS[kind], lastSuccessAt: at, failureStreak: 0, error: '',
      checked: channels.length, passed: [...results.values()].filter(r => r.ok).length, failed: [...results.values()].filter(r => !r.ok).length })
    if (kind === 'update') this.runtime.jobs.check.nextRunAt = at + INTERVALS.check
    this.store.saveRuntime(this.runtime)
  }
  poll() {
    if (!this.inFlight && this.enabled()) {
      const kind = ['update', 'check'].find(k => this.runtime.jobs[k].nextRunAt <= this.now())
      if (kind) void this.run(kind)
    }
    return { channels: Object.values(this.channels()), warnings: [this.store.warning,
      ...Object.values(this.runtime.jobs).map(j => j.error ? `保留上次有效清单：${j.error}` : ''),
      this.active ? `后台${this.active === 'update' ? '更新目录' : '检查可用性'}：${this.progress.done}/${this.progress.total}；当前使用已验证清单` : ''].filter(Boolean) }
  }
  async resolve(ref) {
    this.assertEnabled()
    if (!claimsRef(ref)) throw new Error('无效的 Xumo 频道引用')
    const id = ref.slice(5), c = this.channels()[id]
    if (!c) throw new Error('未知或已排除的 Xumo 频道')
    const cached = this.playCache.get(id)
    if (cached && cached.until > this.now() && cached.generation === this.state.generation) return cached.result
    if (this.plays.has(id)) return this.plays.get(id)
    const promise = (async () => {
      let master
      try { master = await this.highest(c.entry) }
      catch { const repaired = await this.resolveCheck(c, c); master = await this.highest(repaired.entry) }
      this.assertEnabled()
      if (!this.channels()[id]) throw new Error('频道已被排除')
      const result = { url: master.url, manifestUrl: master.url, manifestText: master.text, proxyHls: true, upstreamUrlTransform: safeUrl }
      this.playCache.set(id, { result, generation: this.state.generation, until: this.now() + 5000 })
      return result
    })().finally(() => this.plays.delete(id))
    this.plays.set(id, promise)
    return promise
  }
  async shutdown() { this.controller.abort(); await this.inFlight }
}
