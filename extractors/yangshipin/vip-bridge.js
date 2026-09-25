import { BROWSER_UA, LoginRequiredError, YSP_HOME } from './browser-auth.js'

const KEEP_SEGMENTS = 12
const IDLE_TTL = 45_000
const MAX_ACTIVE_CHANNELS = 3
const MAX_SEGMENT_BYTES = 16 * 1024 * 1024
const MAX_TRACK_BYTES = 64 * 1024 * 1024
const QUIESCE_TIMEOUT_MS = 2_000

function findBox(body, type) {
  const at = body.indexOf(type)
  return at >= 4 ? at : -1
}

export function inspectInitSegment(body) {
  const mdhd = findBox(body, 'mdhd')
  if (mdhd < 0) throw new Error('fMP4 init 缺少 mdhd')
  const version = body[mdhd + 4]
  const timescale = body.readUInt32BE(mdhd + (version ? 24 : 16))
  if (!timescale) throw new Error('fMP4 timescale 无效')
  return { timescale }
}

export function inspectMediaFragment(body, timescale) {
  const mfhd = findBox(body, 'mfhd')
  const trun = findBox(body, 'trun')
  if (mfhd < 0 || trun < 0) throw new Error('fMP4 media 缺少 mfhd/trun')
  const sequence = body.readUInt32BE(mfhd + 8)
  const flags = body.readUIntBE(trun + 5, 3)
  const count = body.readUInt32BE(trun + 8)
  let offset = trun + 12
  if (flags & 0x001) offset += 4
  if (flags & 0x004) offset += 4
  let units = 0
  for (let i = 0; i < count; i++) {
    if (flags & 0x100) { units += body.readUInt32BE(offset); offset += 4 }
    if (flags & 0x200) offset += 4
    if (flags & 0x400) offset += 4
    if (flags & 0x800) offset += 4
  }
  const duration = units / timescale
  if (!(duration > 0 && duration < 30)) throw new Error('fMP4 duration 无效')
  return { sequence, duration }
}

export function createTrackState() {
  return {
    init: null,
    timescale: 0,
    segments: new Map(),
    segmentBytes: 0,
    lastChunkAt: 0,
    epoch: 0,
    lastSourceSequence: null,
    nextSequence: null,
    markNextDiscontinuity: false,
  }
}

function positiveLimit(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback
}

function advanceTrackEpoch(track, { keepInit = true } = {}) {
  track.epoch = (Number(track.epoch) || 0) + 1
  track.segments.clear()
  track.segmentBytes = 0
  track.lastSourceSequence = null
  track.markNextDiscontinuity = true
  if (!keepInit) {
    track.init = null
    track.timescale = 0
  }
}

function prefixPath(accessPrefix, path) {
  const prefix = String(accessPrefix || '').replace(/\/$/, '')
  return `${prefix}${path}`
}

// 在页面里把捕获的 fMP4 块转成 base64 交给 Node。
// 必须用 FileReader 这种原生编码：之前的 String.fromCharCode(...bytes.subarray(i, i + 32768))
// 一次把 32768 个字节当参数压栈，Mac 上默认 1MB 栈没事，Docker 镜像里 Alpine Chromium 被压到
// --stack-size=96 后直接 RangeError「Maximum call stack size exceeded」，会员频道在 NAS 上一播就挂。
function base64DrainScript() {
  const chunks = window.__yspMseChunks.splice(0)
  return Promise.all(chunks.map(chunk => new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      resolve({ mime: chunk.mime, base64: result.slice(result.indexOf(',') + 1) })
    }
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'))
    reader.readAsDataURL(new Blob([chunk.data]))
  })))
}

/**
 * 官网给 VIP HLS 的视频负载不是播放器可直接解码的 H.264。这里在官方页面的
 * SourceBuffer 边界取得官网已经解扰的 fMP4，再组成本机 HLS（独立音/视频轨）。
 */
export class VipMseBridge {
  constructor(browserSession, {
    logger = () => {},
    maxActiveChannels = MAX_ACTIVE_CHANNELS,
    maxSegmentBytes = MAX_SEGMENT_BYTES,
    maxTrackBytes = MAX_TRACK_BYTES,
    quiesceTimeoutMs = QUIESCE_TIMEOUT_MS,
  } = {}) {
    this.browserSession = browserSession
    this.logger = logger
    this.maxActiveChannels = Math.max(1, Number(maxActiveChannels) || MAX_ACTIVE_CHANNELS)
    this.maxSegmentBytes = positiveLimit(maxSegmentBytes, MAX_SEGMENT_BYTES)
    this.maxTrackBytes = Math.max(this.maxSegmentBytes, positiveLimit(maxTrackBytes, MAX_TRACK_BYTES))
    this.quiesceTimeoutMs = positiveLimit(quiesceTimeoutMs, QUIESCE_TIMEOUT_MS)
    this.streams = new Map()
    this.starts = new Map()
    this.pages = new Set()
    this.inFlight = new Set()
    this.warming = null
    this.startQueue = Promise.resolve()
    this.streamSerial = 0
    this.generation = 0
    this.suspended = false
    this.lastActivity = Date.now()
    this.cleanupTimer = setInterval(() => this.cleanup(), 10_000)
    this.cleanupTimer.unref()
  }

  isIdle() {
    return this.streams.size === 0 && this.starts.size === 0 && !this.warming && this.inFlight.size === 0
  }

  /** 该频道的解扰桥已在跑或正在启动：再给它请求不会多开浏览器页。 */
  isActive(channelId) {
    if (this.starts.has(channelId)) return true
    const state = this.streams.get(channelId)
    return Boolean(state && !state.page?.isClosed?.())
  }

  trackTask(task) {
    const promise = Promise.resolve(task)
    this.inFlight.add(promise)
    promise.then(
      () => this.inFlight.delete(promise),
      () => this.inFlight.delete(promise),
    )
    return promise
  }

  assertAvailable(generation = this.generation) {
    if (this.suspended || generation !== this.generation) {
      throw new Error('央视频正在关联登录，请完成后重试')
    }
  }

  async warm() {
    this.lastActivity = Date.now()
    const generation = this.generation
    this.assertAvailable(generation)
    if (this.warming) return this.warming
    const task = this.trackTask((async () => {
      await this.browserSession.ensureBrowser({ visible: false })
      this.assertAvailable(generation)
      const status = await this.browserSession.readAccount()
      if (!status.authenticated) throw new LoginRequiredError()
      if (!status.account?.vip) throw new LoginRequiredError('央视频账号已登录，但未识别到有效 VIP 权益')
      return this.browserSession.browser
    })())
    this.warming = task
    try { return await task }
    finally { if (this.warming === task) this.warming = null }
  }

  master(channel, accessPrefix = '') {
    const audio = prefixPath(accessPrefix, `/ysp-vip/${channel.id}/audio.m3u8`)
    const video = prefixPath(accessPrefix, `/ysp-vip/${channel.id}/video.m3u8`)
    return `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="中文",DEFAULT=YES,AUTOSELECT=YES,URI="${audio}"
#EXT-X-STREAM-INF:BANDWIDTH=6000000,AVERAGE-BANDWIDTH=4500000,RESOLUTION=1920x1080,FRAME-RATE=25.000,CODECS="avc1.640029,mp4a.40.2",AUDIO="audio"
${video}
`
  }

  async ensure(channel) {
    this.lastActivity = Date.now()
    this.assertAvailable()
    let state = this.streams.get(channel.id)
    if (state?.page?.isClosed()) {
      this.streams.delete(channel.id)
      state = null
    }
    if (!state) {
      let starting = this.starts.get(channel.id)
      if (!starting) {
        starting = this.start(channel)
        this.starts.set(channel.id, starting)
        starting.finally(() => {
          if (this.starts.get(channel.id) === starting) this.starts.delete(channel.id)
        }).catch(() => {})
      }
      state = await starting
    } else if (state.ready) {
      await state.ready
    }
    this.assertAvailable()
    state.touched = Date.now()
    await this.drain(state)
    return state
  }

  start(channel) {
    // 在“请求入队”这一刻绑定代际；登录切换会递增 generation，使排队中的旧
    // 请求也失效，不能等它真正开跑时才读取新代际并误当成登录后的新请求。
    const generation = this.generation
    const job = this.trackTask(this.startQueue.then(() => this.startNow(channel, generation)))
    this.startQueue = job.catch(() => {})
    return job
  }

  async startNow(channel, generation) {
    const existing = this.streams.get(channel.id)
    if (existing && !existing.page.isClosed()) return existing

    this.assertAvailable(generation)
    while (this.streams.size >= this.maxActiveChannels) {
      const oldest = [...this.streams.entries()].sort((a, b) => a[1].touched - b[1].touched)[0]
      if (!oldest) break
      this.logger(`央视频会员桥达到 ${this.maxActiveChannels} 路上限，释放最久未使用的 ${oldest[1].channel.name}`)
      await this.stop(oldest[0], oldest[1])
    }

    const browser = await this.warm()
    this.assertAvailable(generation)
    let page
    try {
      page = await browser.newPage()
      this.pages.add(page)
      await page.setUserAgent(BROWSER_UA)
      await page.evaluateOnNewDocument(() => {
        window.__yspMseChunks = []
        const nativeAdd = MediaSource.prototype.addSourceBuffer
        MediaSource.prototype.addSourceBuffer = function (mime) {
          const source = nativeAdd.call(this, mime)
          source.__yspMime = mime
          return source
        }
        const nativeAppend = SourceBuffer.prototype.appendBuffer
        SourceBuffer.prototype.appendBuffer = function (data) {
          try {
            const bytes = data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            window.__yspMseChunks.push({ mime: this.__yspMime || '', data: bytes.slice().buffer })
            if (window.__yspMseChunks.length > 24) window.__yspMseChunks.shift()
          } catch { /* 仍让官网播放器继续 */ }
          return nativeAppend.call(this, data)
        }
      })
      await page.goto(YSP_HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForFunction(
        () => document.querySelectorAll('.tv-main-con-r-list-left-imga').length >= 40,
        { timeout: 30_000 },
      )
      this.assertAvailable(generation)

      const state = {
        channel, page, streamId: ++this.streamSerial,
        audio: createTrackState(), video: createTrackState(),
        touched: Date.now(), draining: null, ready: null,
      }
      this.streams.set(channel.id, state)
      this.logger(`${channel.name} 启动官网解扰兼容桥`)
      state.ready = (async () => {
        await page.evaluate(() => { window.__yspMseChunks.splice(0) })
        const clicked = await page.evaluate(name => {
          const target = [...document.querySelectorAll('.tv-main-con-r-list-left-imga')]
            .find(node => String(node.innerText || '').includes(name))
          target?.click()
          return Boolean(target)
        }, channel.siteName)
        if (!clicked) throw new Error(`官网频道列表中没有找到 ${channel.siteName}`)
        const deadline = Date.now() + 25_000
        while (Date.now() < deadline) {
          await new Promise(resolvePromise => setTimeout(resolvePromise, 350))
          this.assertAvailable(generation)
          await this.drain(state)
          if (state.audio.init && state.video.init && state.audio.segments.size && state.video.segments.size) return
        }
        throw new Error(`${channel.name} 等待官网解扰片段超时`)
      })()
      try {
        await state.ready
        this.assertAvailable(generation)
        return state
      } catch (error) {
        await this.stop(channel.id, state)
        throw error
      }
    } catch (error) {
      if (page) this.pages.delete(page)
      if (page && !page.isClosed()) try { await page.close() } catch { /* browser 可能已关闭 */ }
      throw error
    }
  }

  async drain(state) {
    if (state.draining) return state.draining
    state.draining = this.trackTask((async () => {
      const chunks = await state.page.evaluate(base64DrainScript)
      this.ingestChunks(state, chunks)
    })()).finally(() => { state.draining = null })
    return state.draining
  }

  /** 把一次页面 drain 归入当前轨道 epoch；单独成方法便于覆盖重连/续票边界。 */
  ingestChunks(state, chunks) {
    for (const chunk of chunks || []) {
      const track = chunk.mime.startsWith('video/') ? state.video
        : chunk.mime.startsWith('audio/') ? state.audio : null
      if (!track) continue
      const body = Buffer.from(chunk.base64, 'base64')
      if (body.length > this.maxSegmentBytes) {
        this.logger(`${state.channel.name} 丢弃异常大的 ${chunk.mime || '媒体'} 块（${body.length} bytes）`)
        continue
      }
      if (findBox(body, 'ftyp') >= 0) {
        // 官网续票/重连可能在同一页面重新 append init。旧媒体绝不能配新 init；
        // 同时保留 nextSequence，使 HLS 媒体序号跨 epoch 继续单调递增。
        if (track.init) advanceTrackEpoch(track, { keepInit: false })
        track.init = body
        track.timescale = inspectInitSegment(body).timescale
        track.lastChunkAt = Date.now()
        continue
      }
      if (!track.timescale || findBox(body, 'moof') < 0) continue
      const info = inspectMediaFragment(body, track.timescale)
      if (track.lastSourceSequence != null && info.sequence === track.lastSourceSequence) continue
      if (track.lastSourceSequence != null && info.sequence < track.lastSourceSequence) {
        advanceTrackEpoch(track)
      }
      const sequence = track.nextSequence == null ? info.sequence : track.nextSequence
      track.nextSequence = sequence + 1
      track.lastSourceSequence = info.sequence
      const segment = {
        ...info,
        sourceSequence: info.sequence,
        sequence,
        epoch: track.epoch,
        discontinuity: track.markNextDiscontinuity,
        body,
      }
      track.markNextDiscontinuity = false
      track.segments.set(sequence, segment)
      track.segmentBytes += body.length
      track.lastChunkAt = Date.now()
      const ordered = [...track.segments.keys()].sort((a, b) => a - b)
      while (ordered.length > KEEP_SEGMENTS || track.segmentBytes > this.maxTrackBytes) {
        const oldest = ordered.shift()
        const removed = track.segments.get(oldest)
        track.segments.delete(oldest)
        if (removed) track.segmentBytes -= removed.body.length
      }
    }
  }

  async playlist(channel, kind, accessPrefix = '') {
    const state = await this.ensure(channel)
    const track = state[kind]
    const segments = [...track.segments.values()].sort((a, b) => a.sequence - b.sequence)
    if (!track.init || !segments.length) throw new Error(`${channel.name} ${kind} 轨尚未就绪`)
    if (Date.now() - track.lastChunkAt > 20_000) {
      await this.stop(channel.id, state)
      throw new Error(`${channel.name} 官网播放器已停止产出媒体，请检查登录与 VIP 权益后重试`)
    }
    const target = Math.max(1, Math.ceil(Math.max(...segments.map(item => item.duration))))
    const base = prefixPath(accessPrefix, `/ysp-vip/${channel.id}/${kind}`)
    const lines = [
      '#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${target}`,
      `#EXT-X-MEDIA-SEQUENCE:${segments[0].sequence}`,
      '#EXT-X-INDEPENDENT-SEGMENTS',
      `#EXT-X-MAP:URI="${base}/init.mp4?v=${state.streamId ?? 0}-${track.epoch ?? 0}"`,
    ]
    for (const segment of segments) {
      if (segment.discontinuity) lines.push('#EXT-X-DISCONTINUITY')
      lines.push(
        `#EXTINF:${segment.duration.toFixed(6)},`,
        `${base}/${segment.sequence}.m4s?v=${state.streamId ?? 0}-${segment.epoch ?? 0}`,
      )
    }
    return `${lines.join('\n')}\n`
  }

  asset(channel, kind, token, { touch = true } = {}) {
    const state = this.streams.get(channel.id)
    if (!state) return null
    if (touch) {
      state.touched = Date.now()
      this.lastActivity = state.touched
    }
    const track = state[kind]
    if (token === 'init') return track.init
    return track.segments.get(Number(token))?.body || null
  }

  async stop(id, state = this.streams.get(id)) {
    if (!state) return
    if (this.streams.get(id) === state) this.streams.delete(id)
    this.pages.delete(state.page)
    try { await state.page.close() } catch { /* browser 可能已关闭 */ }
  }

  async waitForInFlight() {
    const pending = [...this.inFlight]
    if (!pending.length) return
    let timer
    await Promise.race([
      Promise.allSettled(pending),
      new Promise(resolvePromise => { timer = setTimeout(resolvePromise, this.quiesceTimeoutMs) }),
    ])
    if (timer) clearTimeout(timer)
  }

  async releasePages() {
    this.generation++
    this.starts.clear()
    this.warming = null
    this.startQueue = Promise.resolve()
    await this.waitForInFlight()
    const pages = new Set([
      ...this.pages,
      ...[...this.streams.values()].map(state => state.page),
    ])
    this.streams.clear()
    this.pages.clear()
    await Promise.allSettled([...pages].map(page => Promise.resolve().then(() => page.close())))
  }

  async suspend() {
    this.suspended = true
    await this.releasePages()
  }

  async resume() {
    this.suspended = false
    this.lastActivity = Date.now()
  }

  cleanup() {
    const now = Date.now()
    for (const [id, state] of this.streams) {
      if (now - state.touched > IDLE_TTL) this.stop(id, state).catch(() => {})
    }
    // 没有会员播放器页后，账号基页也不常驻占用全局 BrowserPool。下次播放会
    // 用同一 profile 按需恢复，登录态不会因此丢失。
    if (!this.suspended && this.isIdle() && this.browserSession.running
        && !this.browserSession.visible && now - this.lastActivity > IDLE_TTL) {
      this.browserSession.close().catch(() => {})
    }
  }

  async close() {
    clearInterval(this.cleanupTimer)
    this.suspended = true
    await this.releasePages()
  }
}
