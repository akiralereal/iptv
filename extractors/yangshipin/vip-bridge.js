import { BROWSER_UA, LoginRequiredError, YSP_HOME } from './browser-auth.js'

const KEEP_SEGMENTS = 12
// 页面空闲回收：播放器停止请求后多久关掉该频道的官网页面。原 45 秒，换台再切回来就得从头
// 起桥（开页、点台、等片，NAS 上实测 8 秒起步）；放宽到 3 分钟，换台或暂停一会儿再回来直接续播。
const STREAM_IDLE_TTL = 180_000
// 没有任何会员页后，账号基页再等多久关掉 Chromium；空闲期间其他模块要用浏览器池仍可让出。
const BROWSER_IDLE_TTL = 180_000
// 就绪门槛：音视频各攒到 READY_MIN_SEGMENTS 片、且视频轨累计不少于 READY_MIN_MEDIA_S 秒，才把
// 清单交给播放器。上游 CDN 一片做完才发布，长片（实测最长 9 秒）前面会有 12 秒左右不出新片，播放器
// 又要等自己下一次刷新清单（按 TARGETDURATION，5～9 秒）才拿得到；三片（13～16 秒）顶不住这两段
// 相加，开播十几秒必卡一下。18 秒能盖住（四片 5 秒的正好 20 秒，三片 6 秒的 18 秒，都不用再等）。
// 首片到手就催官网播放器重拉清单，第 4 片一发布就能到；
// 但 CDN 正在做一片长片时第 4 片要 10 秒后才有，所以三片到手后最多再等 READY_MEDIA_WAIT_MS：
// 等过这几秒，就算只拿着三片开播，第 4 片也会在播放器吃完老本之前到（空档已经被等掉一截）。
// 首片后总共最多等 READY_TOP_UP_MS，凑不够也交出去，别让播放器等到超时。
const READY_MIN_SEGMENTS = 3
const READY_MIN_MEDIA_S = 18
const READY_MEDIA_WAIT_MS = 4_000
const READY_TOP_UP_MS = 10_000
// 普通视图（AVPlayer 等）媒体清单里的 EXT-X-START：让播放器从直播边缘往回 25 秒起播（不够就从
// 清单开头起），中途加入时缓冲从 3 倍 TARGETDURATION 提到 25 秒左右。libVLC 对直播清单不认这个
// 标签（只在清单有总时长时生效），它另走 libvlcPlaylist() 视图。
const START_BEHIND_LIVE_S = 25
// libVLC（Ceau Player、VLC 等）专用清单视图。用 Ceau Player 自带的 libVLC 4.0 复现并对照源码
// （modules/demux/adaptive）确认了两条规则：
//   1. 直播清单里它正在读的分片一旦是最后一片，就停止解复用（SegmentTracker::bufferingAvailable），
//      而解完一个单片段的 fMP4 又要先读到下一片——所以清单最后那一整片（5～9 秒）它永远用不上；
//   2. 它按 TARGETDURATION 的间隔刷新清单（HLSRepresentation::needsUpdate）。
// 上游又是整片整片地出（长片前面会有 10 秒左右不出新片），起播时手里只有三四片，扣掉压着不用的最后
// 一片、再等一个刷新周期，开播几秒就会见底；每卡一次它把自己的延迟调大一点，卡一两次后才顺。
// 对策只给它：每片拆成「主体 + 最后约半秒的尾巴」两项（它压着不用的只剩这半秒），TARGETDURATION
// 报 1 秒让它每秒刷一次。它不校验 EXTINF 是否超过 TARGETDURATION。AVPlayer、FFmpeg 系客户端
// 不受这两条影响，照旧拿整片清单。EXT-X-START 它对直播清单不认（只在有总时长时生效），这里不加。
// 它的直播延迟写死 15 秒、pts_delay 写死 1 秒（adaptive 模块），按声明时长从清单末尾倒推 15 秒
// 选起播点，冷起时还固定跳过清单头两项——结果正好和官网播放器站在同一位置，而官网播放器在新片
// 到来前手里常只剩五六秒，上游一出 9 秒的长片就不够撑。所以再加两条：声明时长按 6 成少报，它的
// 「15 秒」实际退到约 25 秒；冷起时在最早一片前垫两个占位项，让它跳过占位、从最早一片开始放。
// 播放时它用分片里的真实时间戳，声明时长只影响选起播点和刷新判断；占位项它不会请求（请求了回 404）。
// 其余每一秒延迟也省掉：半秒尾巴、1 秒刷新、1.5 秒催上游。
const LIBVLC_UA = /(?:^|\s)(?:VLC|LibVLC)\//i
const LIBVLC_TARGET_DURATION_S = 1
const LIBVLC_TAIL_S = 0.5
const LIBVLC_MIN_HEAD_S = 1.5
const LIBVLC_DURATION_SCALE = 0.6
const LIBVLC_PAD_ITEMS = 2
const LIBVLC_PAD_EXTINF_S = 0.1
const READY_TIMEOUT_MS = 25_000
// 官网播放器按上游 TARGETDURATION（5～9 秒）定时重拉清单，新片最多要晚一个周期才到我们手里；
// 上游只给 3 片的窗口，播放器的缓冲本来就薄，再叠这一个周期就会见底。桥就绪后每隔这么久看一眼：
// 官网播放器这段时间没拉过清单就催它拉一次，把「新片到手」的延迟压到 1.5 秒左右（一个清单只有几 KB）。
const UPSTREAM_KICK_INTERVAL_MS = 1_500
const UPSTREAM_KICK_STALE_MS = 1_000
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

function readBoxList(body, start, end) {
  const boxes = []
  let at = start
  while (at + 8 <= end) {
    const size = body.readUInt32BE(at)
    if (size < 8 || at + size > end) return null
    boxes.push({ type: body.toString('latin1', at + 4, at + 8), at, size })
    at += size
  }
  return at === end ? boxes : null
}

/**
 * 解析官网 MSE 拿到的单片段 fMP4（moof[mfhd, traf[tfhd, tfdt, trun, sdtp?]] + mdat），给 libVLC 视图切片用。
 * 只认这一种规整结构，别的一律返回 null，调用方就整片交出去，不冒险改写。
 */
export function parseSimpleFragment(body) {
  const top = readBoxList(body, 0, body.length)
  if (!top || top.length !== 2 || top[0].type !== 'moof' || top[1].type !== 'mdat') return null
  const [moof, mdat] = top
  const moofChildren = readBoxList(body, moof.at + 8, moof.at + moof.size)
  if (!moofChildren || moofChildren.length !== 2 || moofChildren[0].type !== 'mfhd' || moofChildren[1].type !== 'traf') return null
  const traf = moofChildren[1]
  const children = readBoxList(body, traf.at + 8, traf.at + traf.size)
  if (!children) return null
  const pick = type => children.filter(box => box.type === type)
  if (children.some(box => !['tfhd', 'tfdt', 'trun', 'sdtp'].includes(box.type))) return null
  const [tfhd] = pick('tfhd')
  const [tfdt] = pick('tfdt')
  const truns = pick('trun')
  const [sdtp] = pick('sdtp')
  if (!tfhd || !tfdt || truns.length !== 1 || pick('tfhd').length !== 1 || pick('tfdt').length !== 1 || pick('sdtp').length > 1) return null
  const trun = truns[0]
  // tfhd 只接受「数据偏移以 moof 起点为基准、不带默认值」这两种写法
  const tfhdFlags = body.readUIntBE(tfhd.at + 9, 3)
  if ((tfhdFlags & ~0x020000) !== 0) return null
  const tfdtVersion = body[tfdt.at + 8]
  const baseTime = tfdtVersion === 1 ? Number(body.readBigUInt64BE(tfdt.at + 12)) : body.readUInt32BE(tfdt.at + 12)
  const trunVersion = body[trun.at + 8]
  const trunFlags = body.readUIntBE(trun.at + 9, 3)
  if ((trunFlags & ~(0x001 | 0x004 | 0x100 | 0x200 | 0x400 | 0x800)) !== 0) return null
  if (!(trunFlags & 0x001) || !(trunFlags & 0x100) || !(trunFlags & 0x200)) return null
  const count = body.readUInt32BE(trun.at + 12)
  let at = trun.at + 16
  const dataOffset = body.readInt32BE(at)
  at += 4
  const firstSampleFlags = trunFlags & 0x004 ? body.readUInt32BE(at) : null
  if (trunFlags & 0x004) at += 4
  const entrySize = 4 * [0x100, 0x200, 0x400, 0x800].filter(bit => trunFlags & bit).length
  const entriesAt = at
  if (entriesAt + count * entrySize !== trun.at + trun.size) return null
  const durations = []
  const sizes = []
  for (let i = 0; i < count; i++) {
    const entry = entriesAt + i * entrySize
    durations.push(body.readUInt32BE(entry))
    sizes.push(body.readUInt32BE(entry + 4))
  }
  const dataStart = moof.at + dataOffset
  const dataLength = sizes.reduce((sum, value) => sum + value, 0)
  if (dataStart !== mdat.at + 8 || dataStart + dataLength > mdat.at + mdat.size) return null
  if (sdtp && sdtp.size !== 12 + count) return null
  return {
    tfhd, sdtp, trunVersion, trunFlags, firstSampleFlags, count, entrySize, entriesAt,
    durations, sizes, dataStart, baseTime,
  }
}

function boxHeader(size, type) {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(size, 0)
  header.write(type, 4, 'latin1')
  return header
}

/** 取 [from, to) 这几个样本单独组成一个 fMP4 片段（新 moof + mdat），样本字节与时间戳原样保留。 */
export function buildFragmentPart(body, parsed, from, to, sequenceNumber) {
  const n = to - from
  const keepFirstFlags = from === 0 && parsed.firstSampleFlags != null
  const trunFlags = keepFirstFlags ? parsed.trunFlags : parsed.trunFlags & ~0x004
  const entries = body.subarray(parsed.entriesAt + from * parsed.entrySize, parsed.entriesAt + to * parsed.entrySize)
  const skipped = parsed.durations.slice(0, from).reduce((sum, value) => sum + value, 0)
  const dataFrom = parsed.dataStart + parsed.sizes.slice(0, from).reduce((sum, value) => sum + value, 0)
  const dataTo = dataFrom + parsed.sizes.slice(from, to).reduce((sum, value) => sum + value, 0)

  const mfhd = Buffer.concat([boxHeader(16, 'mfhd'), Buffer.alloc(8)])
  mfhd.writeUInt32BE(sequenceNumber >>> 0, 12)
  const tfhd = body.subarray(parsed.tfhd.at, parsed.tfhd.at + parsed.tfhd.size)
  const tfdt = Buffer.concat([boxHeader(20, 'tfdt'), Buffer.alloc(12)])
  tfdt.writeUInt32BE(0x01000000, 8)
  tfdt.writeBigUInt64BE(BigInt(parsed.baseTime + skipped), 12)
  const trunHead = Buffer.alloc(8 + 12 + (keepFirstFlags ? 4 : 0))
  const trunSize = trunHead.length + entries.length
  trunHead.writeUInt32BE(trunSize, 0)
  trunHead.write('trun', 4, 'latin1')
  trunHead.writeUInt32BE(((parsed.trunVersion & 0xff) << 24 | trunFlags) >>> 0, 8)
  trunHead.writeUInt32BE(n, 12)
  if (keepFirstFlags) trunHead.writeUInt32BE(parsed.firstSampleFlags >>> 0, 20)
  const sdtp = parsed.sdtp
    ? Buffer.concat([
        boxHeader(12 + n, 'sdtp'),
        body.subarray(parsed.sdtp.at + 8, parsed.sdtp.at + 12),
        body.subarray(parsed.sdtp.at + 12 + from, parsed.sdtp.at + 12 + to),
      ])
    : Buffer.alloc(0)
  const trafSize = 8 + tfhd.length + tfdt.length + trunSize + sdtp.length
  const moofSize = 8 + mfhd.length + trafSize
  trunHead.writeInt32BE(moofSize + 8, 16)
  return Buffer.concat([
    boxHeader(moofSize, 'moof'), mfhd, boxHeader(trafSize, 'traf'), tfhd, tfdt, trunHead, entries, sdtp,
    boxHeader(8 + dataTo - dataFrom, 'mdat'), body.subarray(dataFrom, dataTo),
  ])
}

/**
 * 给 libVLC 视图排一个分片的清单项：能拆就拆成「主体 + 尾巴」，拆不了就整片一项。序号在入库时一次
 * 分好、之后不变（HLS 同一序号的内容不能变），跨 epoch 也继续递增。
 */
function planLibvlcItems(track, body, timescale) {
  const parsed = parseSimpleFragment(body)
  const whole = () => [{ sequence: track.nextLibvlcSequence++, from: 0, to: null, duration: null }]
  if (!parsed || !timescale) return { parsed: null, items: whole() }
  let tailUnits = 0
  let index = parsed.count
  while (index > 1 && tailUnits < LIBVLC_TAIL_S * timescale) tailUnits += parsed.durations[--index]
  const total = parsed.durations.reduce((sum, value) => sum + value, 0)
  const headUnits = total - tailUnits
  if (index <= 0 || index >= parsed.count || headUnits < LIBVLC_MIN_HEAD_S * timescale) {
    return { parsed, items: [{ sequence: track.nextLibvlcSequence++, from: 0, to: parsed.count, duration: total / timescale }] }
  }
  return {
    parsed,
    items: [
      { sequence: track.nextLibvlcSequence++, from: 0, to: index, duration: headUnits / timescale },
      { sequence: track.nextLibvlcSequence++, from: index, to: parsed.count, duration: tailUnits / timescale },
    ],
  }
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
    nextLibvlcSequence: LIBVLC_PAD_ITEMS,
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
    streamIdleTtlMs = STREAM_IDLE_TTL,
    browserIdleTtlMs = BROWSER_IDLE_TTL,
    readyMinSegments = READY_MIN_SEGMENTS,
    readyMinMediaS = READY_MIN_MEDIA_S,
    readyMediaWaitMs = READY_MEDIA_WAIT_MS,
    readyTopUpMs = READY_TOP_UP_MS,
    readyTimeoutMs = READY_TIMEOUT_MS,
    traceNetwork = false,
  } = {}) {
    this.browserSession = browserSession
    this.logger = logger
    this.traceNetwork = Boolean(traceNetwork)
    this.maxActiveChannels = Math.max(1, Number(maxActiveChannels) || MAX_ACTIVE_CHANNELS)
    this.maxSegmentBytes = positiveLimit(maxSegmentBytes, MAX_SEGMENT_BYTES)
    this.maxTrackBytes = Math.max(this.maxSegmentBytes, positiveLimit(maxTrackBytes, MAX_TRACK_BYTES))
    this.quiesceTimeoutMs = positiveLimit(quiesceTimeoutMs, QUIESCE_TIMEOUT_MS)
    this.streamIdleTtlMs = positiveLimit(streamIdleTtlMs, STREAM_IDLE_TTL)
    this.browserIdleTtlMs = positiveLimit(browserIdleTtlMs, BROWSER_IDLE_TTL)
    this.readyMinSegments = positiveLimit(readyMinSegments, READY_MIN_SEGMENTS)
    this.readyMinMediaS = positiveLimit(readyMinMediaS, READY_MIN_MEDIA_S)
    this.readyMediaWaitMs = positiveLimit(readyMediaWaitMs, READY_MEDIA_WAIT_MS)
    this.readyTopUpMs = positiveLimit(readyTopUpMs, READY_TOP_UP_MS)
    this.readyTimeoutMs = positiveLimit(readyTimeoutMs, READY_TIMEOUT_MS)
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
    const queuedAt = Date.now()
    const job = this.trackTask(this.startQueue.then(() => this.startNow(channel, generation, queuedAt)))
    this.startQueue = job.catch(() => {})
    return job
  }

  async startNow(channel, generation, queuedAt = Date.now()) {
    const startedAt = Date.now()
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
      const upstream = { lastPlaylistAt: 0 }
      this.watchUpstreamPlaylist(page, channel, upstream)
      await page.setUserAgent(BROWSER_UA)
      await page.evaluateOnNewDocument(() => {
        window.__yspMseChunks = []
        // 官网播放器是 hls.js 的定制版，以 window.Hls 挂出；这里截获这次赋值，把它 new 出来的
        // 实例记下来，就绪时才能催它立刻刷新上游清单（见 kickPlaylistReload）。
        window.__yspHlsInstances = []
        let realHls
        Object.defineProperty(window, 'Hls', {
          configurable: true,
          enumerable: true,
          get() { return realHls },
          set(value) {
            if (typeof value !== 'function') { realHls = value; return }
            const Wrapped = function (...args) {
              const instance = new value(...args)
              window.__yspHlsInstances.push(instance)
              return instance
            }
            Object.setPrototypeOf(Wrapped, value)
            Wrapped.prototype = value.prototype
            realHls = Wrapped
          },
        })
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
      const pageReadyAt = Date.now()

      const state = {
        channel, page, streamId: ++this.streamSerial,
        audio: createTrackState(), video: createTrackState(),
        touched: Date.now(), draining: null, ready: null,
        upstream, kickTimer: null,
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
        const deadline = Date.now() + this.readyTimeoutMs
        let firstAt = 0
        let threeAt = 0
        let kicked = null
        for (;;) {
          await new Promise(resolvePromise => setTimeout(resolvePromise, 350))
          this.assertAvailable(generation)
          await this.drain(state)
          const audio = state.audio.segments.size
          const video = state.video.segments.size
          const primed = Boolean(state.audio.init && state.video.init && audio && video)
          if (!primed) {
            if (Date.now() >= deadline) throw new Error(`${channel.name} 等待官网解扰片段超时`)
            continue
          }
          if (!firstAt) {
            // 首片一到就催官网播放器重拉清单并开始看门狗，后面几片才能尽快到手
            firstAt = Date.now()
            kicked = await this.kickPlaylistReload(state)
            this.startUpstreamKicks(state)
          }
          const seconds = [...state.video.segments.values()].reduce((sum, item) => sum + item.duration, 0)
          const enoughSegments = audio >= this.readyMinSegments && video >= this.readyMinSegments
          if (enoughSegments && !threeAt) threeAt = Date.now()
          const filled = enoughSegments && (seconds >= this.readyMinMediaS || Date.now() - threeAt >= this.readyMediaWaitMs)
          if (filled || Date.now() - firstAt >= this.readyTopUpMs) {
            const media = await this.mediaState(state)
            this.logReady(state, { queuedAt, startedAt, pageReadyAt, firstAt, filled, media, kicked, seconds })
            return
          }
        }
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

  /**
   * 记录官网播放器每次拉到上游清单的时刻（催刷新用）；mdebug=1 时再读正文打一行摘要
   * （TARGETDURATION、序号、片数），用来对照它续拉分片的节奏。不记媒体分片本身。
   */
  watchUpstreamPlaylist(page, channel, upstream) {
    page.on('response', response => {
      const url = response.url()
      if (!/\.m3u8(?:[?#]|$)/i.test(url)) return
      upstream.lastPlaylistAt = Date.now()
      if (!this.traceNetwork) return
      response.text().then(text => {
        const target = (text.match(/#EXT-X-TARGETDURATION:(\d+)/) || [])[1]
        const sequence = (text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/) || [])[1]
        const durations = [...text.matchAll(/#EXTINF:([\d.]+)/g)].map(match => Number(match[1]))
        const total = durations.reduce((sum, value) => sum + value, 0)
        this.logger(`${channel.name} 官网拉清单 ${response.status()} TD=${target ?? '-'} 序号起 ${sequence ?? '-'} 共 ${durations.length} 片 ${total.toFixed(1)}s`
          + `${durations.length ? `（末片 ${durations.at(-1)}s）` : ''} ${url.replace(/^https?:\/\//, '').replace(/\?.*$/, '').slice(0, 90)}`)
      }).catch(() => {})
    })
  }

  /**
   * 催官网播放器立刻重拉上游清单。上游清单只有 3 片的滑动窗口，官网播放器起播先把这 3 片下完，
   * 之后按上游 TARGETDURATION（5～9 秒）定时重拉，第一次更要等 9～18 秒；而我们的播放器和它从同一片
   * 放起，这十几秒里只能吃这 3 片的老本，分片短一点就卡。它是 hls.js 1.6 定制版：levelController.
   * loadingPlaylist(level) 会立刻发起清单请求（loadPlaylist 只是按它自己的排期再定个时器，催不动）。
   * 页面上可能有不止一个实例（实测两个），都催。找不到实例或方法时什么都不做，只是回到原来的节奏。
   */
  async kickPlaylistReload(state) {
    try {
      return await state.page.evaluate(() => {
        const instances = (window.__yspHlsInstances || []).filter(Boolean)
        if (!instances.length) return '未找到 hls 实例'
        let kicked = 0
        for (const instance of instances) {
          const controller = instance.levelController
          const level = controller?.currentLevel
          if (!controller || typeof controller.loadingPlaylist !== 'function' || !level?.details?.live) continue
          try { controller.clearTimer?.() } catch { /* 没有也无妨 */ }
          controller.loadingPlaylist(level)
          kicked++
        }
        return kicked ? `已催官网播放器重拉清单（${kicked}/${instances.length} 个实例）` : 'hls 实例没有可催的直播清单'
      })
    } catch (error) {
      return `催重拉清单失败：${String(error?.message || error).split('\n')[0]}`
    }
  }

  /** 就绪后定时催：官网播放器最近一个周期没拉过清单就催一次（见 UPSTREAM_KICK_INTERVAL_MS）。 */
  startUpstreamKicks(state) {
    this.stopUpstreamKicks(state)
    state.kickTimer = setInterval(() => {
      if (state.page?.isClosed?.() || this.streams.get(state.channel.id) !== state) return this.stopUpstreamKicks(state)
      const sinceUpstream = Date.now() - (state.upstream?.lastPlaylistAt || 0)
      if (sinceUpstream < UPSTREAM_KICK_STALE_MS) return
      this.kickPlaylistReload(state).then(result => {
        if (this.traceNetwork) this.logger(`${state.channel.name} 看门狗（距上次上游清单 ${(sinceUpstream / 1000).toFixed(1)}s）：${result}`)
      }).catch(() => {})
    }, UPSTREAM_KICK_INTERVAL_MS)
    state.kickTimer.unref?.()
  }

  stopUpstreamKicks(state) {
    if (state?.kickTimer) clearInterval(state.kickTimer)
    if (state) state.kickTimer = null
  }

  /** 官网播放器 <video> 的播放位置与缓冲末尾（秒）；拿不到时为 null。 */
  async mediaState(state) {
    try {
      return await state.page.evaluate(() => {
        const video = document.querySelector('video')
        if (!video) return null
        const ranges = video.buffered
        const end = ranges.length ? ranges.end(ranges.length - 1) : 0
        return {
          currentTime: Number(video.currentTime.toFixed(1)),
          bufferedEnd: Number(end.toFixed(1)),
          ahead: Number((end - video.currentTime).toFixed(1)),
          paused: video.paused,
          readyState: video.readyState,
        }
      })
    } catch { return null }
  }

  describeMedia(media) {
    if (!media) return '官网播放器状态未知'
    return `官网播放器 位置 ${media.currentTime}s / 缓冲至 ${media.bufferedEnd}s（超前 ${media.ahead}s${media.paused ? '，已暂停' : ''}）`
  }

  /** 就绪一行日志：各阶段耗时与到手分片数，排查「刚打开卡」时不用再猜起桥花在哪。 */
  logReady(state, { queuedAt, startedAt, pageReadyAt, firstAt, filled, media, kicked, seconds: mediaSeconds = 0 }) {
    const now = Date.now()
    const seconds = ms => (Math.max(0, ms) / 1000).toFixed(1)
    const longest = Math.max(0, ...[...state.video.segments.values()].map(item => item.duration))
    this.logger(
      `${state.channel.name} 解扰桥就绪：共 ${seconds(now - queuedAt)} 秒`
      + `（排队 ${seconds(startedAt - queuedAt)} · 浏览器与页面 ${seconds(pageReadyAt - startedAt)}`
      + ` · 首片 ${seconds(firstAt - pageReadyAt)} · 补片 ${seconds(now - firstAt)}）`
      + `，音 ${state.audio.segments.size} 片 / 视 ${state.video.segments.size} 片共 ${mediaSeconds.toFixed(1)} 秒`
      + `${filled ? '' : '（未凑够，先交清单）'}，分片约 ${longest.toFixed(1)} 秒；${kicked || '未催重拉'}；${this.describeMedia(media)}`,
    )
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
      const libvlc = planLibvlcItems(track, body, track.timescale)
      const segment = {
        ...info,
        sourceSequence: info.sequence,
        sequence,
        epoch: track.epoch,
        discontinuity: track.markNextDiscontinuity,
        body,
        libvlcParsed: libvlc.parsed,
        libvlcItems: libvlc.items.map(item => ({ ...item, duration: item.duration ?? info.duration })),
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

  async playlist(channel, kind, accessPrefix = '', { userAgent = '' } = {}) {
    const state = await this.ensure(channel)
    const track = state[kind]
    const segments = [...track.segments.values()].sort((a, b) => a.sequence - b.sequence)
    if (!track.init || !segments.length) throw new Error(`${channel.name} ${kind} 轨尚未就绪`)
    if (Date.now() - track.lastChunkAt > 20_000) {
      await this.stop(channel.id, state)
      throw new Error(`${channel.name} 官网播放器已停止产出媒体，请检查登录与 VIP 权益后重试`)
    }
    // TARGETDURATION 按当前清单里最长的分片算（官网分片 4～9 秒浮动，值会跟着变）。试过固定成 10：
    // 播放器都按 TARGETDURATION 的周期刷清单，libVLC（Ceau Player 等）还拿它算直播延迟目标，10 秒
    // 让它刷得慢、起播那三片撑不到下一次刷新，开头必卡；改回真实值后它 5 秒左右刷一次。
    const base = prefixPath(accessPrefix, `/ysp-vip/${channel.id}/${kind}`)
    if (LIBVLC_UA.test(String(userAgent))) return this.libvlcPlaylist(state, track, segments, base)
    const target = Math.max(1, Math.ceil(Math.max(...segments.map(item => item.duration))))
    const lines = [
      '#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${target}`,
      `#EXT-X-MEDIA-SEQUENCE:${segments[0].sequence}`,
      `#EXT-X-START:TIME-OFFSET=-${START_BEHIND_LIVE_S},PRECISE=NO`,
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

  /** libVLC 视图的媒体清单：主体 + 尾巴、1 秒刷新、时长少报、冷起垫占位（原因见 LIBVLC_UA 注释）。 */
  libvlcPlaylist(state, track, segments, base) {
    const items = segments.flatMap(segment => (segment.libvlcItems || []).map((item, index) => ({ segment, item, index })))
    const pads = items[0].item.sequence === LIBVLC_PAD_ITEMS ? LIBVLC_PAD_ITEMS : 0
    const lines = [
      '#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${LIBVLC_TARGET_DURATION_S}`,
      `#EXT-X-MEDIA-SEQUENCE:${items[0].item.sequence - pads}`,
      `#EXT-X-MAP:URI="${base}/init.mp4?v=${state.streamId ?? 0}-${track.epoch ?? 0}"`,
    ]
    for (let i = 0; i < pads; i++) {
      lines.push(`#EXTINF:${LIBVLC_PAD_EXTINF_S.toFixed(6)},`, `${base}/vpad${i}.m4s?v=${state.streamId ?? 0}-${track.epoch ?? 0}`)
    }
    for (const { segment, item, index } of items) {
      if (segment.discontinuity && index === 0) lines.push('#EXT-X-DISCONTINUITY')
      lines.push(
        `#EXTINF:${(item.duration * LIBVLC_DURATION_SCALE).toFixed(6)},`,
        `${base}/v${item.sequence}.m4s?v=${state.streamId ?? 0}-${segment.epoch ?? 0}`,
      )
    }
    return `${lines.join('\n')}\n`
  }

  /** libVLC 视图的一项：整片就直接给原片，拆开的每次请求现拼（主体几乎是整片，缓存等于多存一份视频）。 */
  libvlcAsset(track, sequence) {
    for (const segment of track.segments.values()) {
      const item = segment.libvlcItems?.find(candidate => candidate.sequence === sequence)
      if (!item) continue
      if (!segment.libvlcParsed || item.to == null) return segment.body
      if (item.from === 0 && item.to === segment.libvlcParsed.count) return segment.body
      return buildFragmentPart(segment.body, segment.libvlcParsed, item.from, item.to, item.sequence + 1)
    }
    return null
  }

  /** 该轨当前最新分片序号；没有在跑的桥时为 null。给请求跟踪日志算「距最新几片」用。 */
  edge(channel, kind) {
    const track = this.streams.get(channel.id)?.[kind]
    if (!track?.segments?.size) return null
    return Math.max(...track.segments.keys())
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
    if (/^v\d+$/.test(token)) return this.libvlcAsset(track, Number(token.slice(1)))
    return track.segments.get(Number(token))?.body || null
  }

  async stop(id, state = this.streams.get(id)) {
    if (!state) return
    this.stopUpstreamKicks(state)
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
    for (const state of this.streams.values()) this.stopUpstreamKicks(state)
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
      if (now - state.touched > this.streamIdleTtlMs) this.stop(id, state).catch(() => {})
    }
    // 没有会员播放器页后，账号基页也不常驻占用全局 BrowserPool。下次播放会
    // 用同一 profile 按需恢复，登录态不会因此丢失。
    if (!this.suspended && this.isIdle() && this.browserSession.running
        && !this.browserSession.visible && now - this.lastActivity > this.browserIdleTtlMs) {
      this.browserSession.close().catch(() => {})
    }
  }

  async close() {
    clearInterval(this.cleanupTimer)
    this.suspended = true
    await this.releasePages()
  }
}
