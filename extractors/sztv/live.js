/**
 * 深圳 CDN 偶尔会永久截断某个 TS。VLC 遇到分片 HTTP 错误会停止取片，GAP 也不能救回。
 * 先缓存完整 TS，再追加到本地直播清单；坏片从未对外公布，跳过后用 DISCONTINUITY
 * 同时重置音视频时间线。已公布的序号、内容和 discontinuity sequence 永不改写。
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, writeFile, rm, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { fetchUpstreamResponse } from '../../utils/hlsProxy.js'
import { printYellow } from '../../utils/colorOut.js'
import { signStreamUrl } from './api.js'
import { createMediaFetcher, fetchMedia } from './media.js'

const CACHE_PREFIX = 'iptv-sztv-live-'
const keyOf = raw => {
  const url = new URL(raw)
  url.searchParams.delete('sign'); url.searchParams.delete('t')
  return url.href
}

export function parseLiveManifest(text, base) {
  if (text.length > 128 * 1024 || !text.trimStart().startsWith('#EXTM3U')
      || /#EXT-X-(?:ENDLIST|MAP|BYTERANGE|I-FRAMES-ONLY|STREAM-INF|MEDIA)(?::|\s|$)/m.test(text)
      || /#EXT-X-KEY:(?!METHOD=NONE(?:\s|,|$))/.test(text)) {
    throw new Error('深圳缓存仅支持未加密、音视频合并的实时 TS 清单')
  }
  const sequence = Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text)?.[1])
  const target = Number(/#EXT-X-TARGETDURATION:(\d+)/.exec(text)?.[1])
  if (!Number.isSafeInteger(sequence) || sequence < 0 || !Number.isInteger(target) || target < 1 || target > 60) {
    throw new Error('深圳直播清单缺少有效的序号或分片时长')
  }
  let discontinuity = Number(/#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)/.exec(text)?.[1] || 0)
  let duration, dateTime
  const segments = []
  for (const line of text.split(/\r?\n/).map(s => s.trim())) {
    if (line.startsWith('#EXTINF:')) duration = Number(line.slice(8).split(',')[0])
    else if (line === '#EXT-X-DISCONTINUITY') discontinuity++
    else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) dateTime = line.slice(25)
    else if (line && !line.startsWith('#')) {
      const url = new URL(line, base).href
      if (!Number.isFinite(duration) || duration <= 0 || duration > 60 || !new URL(url).pathname.endsWith('.ts')) {
        throw new Error('深圳直播清单含无效的 TS 分片')
      }
      segments.push({ url, key: keyOf(url), duration, dateTime, discontinuity, sourceSequence: sequence + segments.length })
      duration = undefined; dateTime = undefined
    }
  }
  if (!segments.length || segments.length > 24) throw new Error('深圳直播分片数量异常')
  return { target, sequence, segments }
}

export function validateTransportStream(bytes) {
  if (bytes.length < 188 * 5 || bytes.length % 188) throw new Error('深圳分片不是完整的 MPEG-TS 数据包')
  for (let offset = 0; offset < bytes.length; offset += 188) {
    if (bytes[offset] !== 0x47) throw new Error('深圳分片包含损坏的 MPEG-TS 同步包')
  }
}

function abortable(promise, signal) {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function response(body, url, init) {
  const result = new Response(body, init)
  Object.defineProperty(result, 'url', { value: url })
  return result
}

export function createLiveRelay({
  fetchPlaylist = fetchUpstreamResponse,
  fetchSegment = createMediaFetcher({ timeoutMs: 8000, attemptTimeoutMs: 4000 }),
  fallbackFetch = fetchMedia,
  signUrl = signStreamUrl,
  validateSegment = validateTransportStream,
  now = Date.now,
  cacheParent = tmpdir(),
  retentionMs = 120_000,
  idleMs = 45_000,
  sessionTtlMs = 180_000,
  maxCacheBytes = 512 * 1024 * 1024,
  maxDownloads = 3,
  coldSegmentTimeoutMs = 4000,
  playlistAttemptTimeoutMs,
  autoRefresh = true,
  log = printYellow,
} = {}) {
  const sessions = new Map()
  let directory, sweeping, bytesOnDisk = 0, active = 0, cursor = 0, closed = false
  const tasks = new Set()

  // 每个进程独有临时目录。只清理本模块一天前留下的目录，不碰其它缓存。
  async function cacheDirectory() {
    if (!directory) directory = (async () => {
      const entries = await readdir(cacheParent, { withFileTypes: true })
      await Promise.all(entries.filter(e => e.isDirectory() && e.name.startsWith(CACHE_PREFIX)).map(async e => {
        const path = join(cacheParent, e.name)
        const info = await stat(path).catch(() => null)
        if (info && Date.now() - info.mtimeMs > 24 * 60 * 60 * 1000) await rm(path, { recursive: true, force: true }).catch(() => {})
      }))
      return mkdtemp(join(cacheParent, `${CACHE_PREFIX}${process.pid}-`))
    })()
    return directory
  }

  const windowOf = state => {
    const result = []; let duration = 0
    for (let i = state.published.length - 1; i >= 0; i--) {
      const entry = state.published[i]
      if (entry.sequence < state.playbackFloor) break
      if (state.priming && !state.primingKeys?.has(entry.key)) continue
      result.unshift(entry); duration += entry.duration
      if (result.length >= 6 && duration >= state.target * 3) break
    }
    return result
  }

  function wake(state) {
    for (const done of state.waiters) done()
    state.waiters.clear()
  }

  function publish(state) {
    while (state.queue.length && ['good', 'bad'].includes(state.queue[0].status)) {
      const job = state.queue.shift()
      if (job.status === 'bad') {
        state.skippedCount++; state.skippedDuration += job.duration
        continue
      }
      const previous = state.published.at(-1)
      const discontinuity = !!previous && (job.epoch !== previous.epoch
        || job.sourceSequence !== previous.sourceSequence + 1
        || job.discontinuity !== previous.discontinuity)
      if (discontinuity) {
        state.discontinuities++
        const reason = state.skippedCount
          ? `跳过 ${state.skippedCount} 个坏分片（约 ${state.skippedDuration.toFixed(1)} 秒）后恢复`
          : '同步最新直播'
        log(`深圳直播 ${state.ref} ${reason}：${new URL(job.url).pathname}，音视频时间线已重置`)
      }
      state.skippedCount = 0; state.skippedDuration = 0
      const entry = { ...job, sequence: state.nextSequence++, boundary: discontinuity,
        discontinuityNumber: state.discontinuities, advertisedAt: now() }
      state.published.push(entry)
      state.cache.set(entry.key, entry)
    }
    wake(state)
  }

  async function performSweep() {
    const time = now()
    for (const [ref, state] of sessions) {
      if (time - state.activity > sessionTtlMs) {
        sessions.delete(ref); state.controller.abort(); clearTimeout(state.timer); wake(state)
        for (const entry of [...state.published, ...state.queue.filter(job => job.status === 'good')]) {
          bytesOnDisk -= entry.bytes
          await rm(entry.file, { force: true })
        }
        continue
      }
      const protectedKeys = new Set(windowOf(state).map(entry => entry.key))
      while (state.published.length) {
        const entry = state.published[0]
        if (protectedKeys.has(entry.key) || time - entry.advertisedAt < retentionMs) break
        state.published.shift(); state.cache.delete(entry.key); bytesOnDisk -= entry.bytes
        await rm(entry.file, { force: true })
      }
      // 上游长时间不更新时，当前窗口仍需去重，不能把同一段节目重新追加一次。
      const retainedKeys = new Set([...state.cache.keys(), ...state.queue.map(job => job.key)])
      for (const [key, seenAt] of state.seen) if (time - seenAt > 10 * 60_000 && !retainedKeys.has(key)) state.seen.delete(key)
    }
  }

  function sweep() {
    if (!sweeping) sweeping = performSweep().finally(() => { sweeping = null })
    return sweeping
  }

  async function download(state, job) {
    let reserved = false
    try {
      // 冷启动尚无播放缓冲，不能让一个坏片的两轮重试耗尽外层 10 秒清单期限。
      // 起播后仍保留正常重试预算；完整校验和缓存规则相同。
      const signal = state.priming
        ? AbortSignal.any([state.controller.signal, AbortSignal.timeout(coldSegmentTimeoutMs)])
        : state.controller.signal
      const fetched = await fetchSegment(signUrl(job.url), { ...state.options, signal })
      if (!fetched.ok) { await fetched.body?.cancel(); throw new Error(`HTTP ${fetched.status}`) }
      const data = Buffer.from(await fetched.arrayBuffer())
      validateSegment(data)
      signal.throwIfAborted()
      if (bytesOnDisk + data.length > maxCacheBytes) throw new Error('深圳完整分片缓存达到容量上限')
      bytesOnDisk += data.length; job.bytes = data.length; reserved = true
      const hash = createHash('sha256').update(`${state.ref}|${job.key}`).digest('hex')
      job.file = join(await cacheDirectory(), `${hash}.ts`)
      await writeFile(job.file, data)
      state.controller.signal.throwIfAborted()
      job.status = 'good'
    } catch (error) {
      if (reserved) bytesOnDisk -= job.bytes
      if (job.file) await rm(job.file, { force: true })
      job.status = 'bad'
      if (!state.controller.signal.aborted) log(`深圳直播 ${state.ref} 不发布坏分片：${new URL(job.url).pathname}（${error.message}）`)
    } finally {
      state.active--; active--
      if (!state.controller.signal.aborted) publish(state)
      pump()
    }
  }

  function pump() {
    if (closed) return
    const states = [...sessions.values()]
    while (active < maxDownloads && states.length) {
      let found = false
      for (let n = 0; n < states.length; n++) {
        const state = states[cursor++ % states.length]
        if (state.controller.signal.aborted || state.active >= 2) continue
        const job = state.queue.find(row => row.status === 'queued')
        if (!job) continue
        job.status = 'loading'; state.active++; active++; found = true
        const task = download(state, job)
        tasks.add(task); task.finally(() => tasks.delete(task))
        break
      }
      if (!found) break
    }
  }

  async function refresh(state) {
    if (state.refreshing) return state.refreshing
    clearTimeout(state.timer)
    state.error = null // 新请求要等待本次刷新，不能立即抛出上一次清单失败。
    state.refreshing = (async () => {
      try {
        let parsed
        for (let attempt = 0; attempt < 2; attempt++) {
          let fetched
          try {
            // 起播的清单两次尝试共最多 5 秒，给完整分片预取留下至少 4 秒。
            const timeout = playlistAttemptTimeoutMs ?? (state.priming ? 2500 : 3000)
            const signal = AbortSignal.any([state.controller.signal, AbortSignal.timeout(timeout)])
            fetched = await fetchPlaylist(state.url, { ...state.options, signal })
            if (!fetched.ok) throw new Error(`清单 HTTP ${fetched.status}`)
            parsed = parseLiveManifest(await fetched.text(), fetched.url || state.url)
            break
          } catch (error) {
            await fetched?.body?.cancel().catch(() => {})
            if (state.controller.signal.aborted || attempt === 1) throw error
            log(`深圳直播 ${state.ref} 清单取回失败，重试一次：${error.message}`)
          }
        }
        if (state.priming) state.primingKeys = new Set(parsed.segments.map(row => row.key))
        // TARGETDURATION 对同一个播放会话保持不变；深圳官网目前为 9 秒。
        if (!state.target) { state.target = parsed.target; state.nextSequence = parsed.sequence }
        if (parsed.segments.some(row => Math.round(row.duration) > state.target)) throw new Error('深圳分片时长超过本次直播的目标时长')
        const overlap = parsed.segments.some(row => state.seen.has(row.key))
        if (state.lastQueued != null && !overlap && parsed.segments.at(-1).sourceSequence <= state.lastQueued) {
          state.epoch++; state.lastQueued = null
        }
        for (const row of parsed.segments) {
          if (state.seen.has(row.key) || (state.lastQueued != null && row.sourceSequence <= state.lastQueued)) continue
          // 慢网下不无限累积未下载任务；下次清单仍会给出最新窗口。
          if (state.queue.length >= 24) break
          signUrl(row.url) // 入队前同样校验官网媒体域名和路径
          state.queue.push({ ...row, epoch: state.epoch, status: 'queued' })
          state.seen.set(row.key, now()); state.lastQueued = row.sourceSequence
        }
        state.error = null
        pump()
      } catch (error) {
        state.error = error
        if (!state.controller.signal.aborted && now() - state.lastErrorLog > 15_000) {
          log(`深圳直播 ${state.ref} 清单暂时失败，保留已缓存分片：${error.message}`)
          state.lastErrorLog = now()
        }
      } finally {
        state.refreshedAt = now(); state.refreshing = null; wake(state)
        if (autoRefresh && !closed && !state.controller.signal.aborted && now() - state.activity < idleMs) {
          state.timer = setTimeout(() => { void refresh(state) }, Math.min(3000, Math.max(500, state.target * 1000 / 3)))
          state.timer.unref?.()
        }
      }
    })()
    return state.refreshing
  }

  function playlist(state, url) {
    const entries = windowOf(state)
    const first = entries[0]
    let text = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:${state.target}\n#EXT-X-MEDIA-SEQUENCE:${first.sequence}\n#EXT-X-DISCONTINUITY-SEQUENCE:${first.discontinuityNumber - Number(first.boundary)}\n`
    for (const entry of entries) {
      entry.advertisedAt = now()
      if (entry.boundary) text += '#EXT-X-DISCONTINUITY\n'
      if (entry.dateTime) text += `#EXT-X-PROGRAM-DATE-TIME:${entry.dateTime}\n`
      text += `#EXTINF:${entry.duration.toFixed(3)},\n${entry.url}\n`
    }
    return response(text, url, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' } })
  }

  function cachedSegment(entry, url, options) {
    options.signal?.throwIfAborted()
    entry.advertisedAt = now()
    const headers = { 'Content-Type': 'video/mp2t', 'Content-Length': String(entry.bytes), 'Accept-Ranges': 'bytes' }
    const range = new Headers(options.headers).get('range')
    let start = 0, end = entry.bytes - 1, status = 200
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range)
      if (match && (match[1] || match[2])) {
        start = match[1] ? Number(match[1]) : Math.max(0, entry.bytes - Number(match[2]))
        end = match[1] && match[2] ? Math.min(end, Number(match[2])) : end
      } else start = entry.bytes
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= entry.bytes) {
        return response(null, url, { status: 416, headers: { 'Content-Range': `bytes */${entry.bytes}` } })
      }
      status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${entry.bytes}`
      headers['Content-Length'] = String(end - start + 1)
    }
    const body = options.method === 'HEAD' ? null : Readable.toWeb(createReadStream(entry.file, { start, end }))
    return response(body, url, { status, headers })
  }

  const cleanup = autoRefresh ? setInterval(() => { void sweep().catch(error => log(`深圳缓存清理失败：${error.message}`)) }, 30_000) : null
  cleanup?.unref?.()

  return {
    async fetch(ref, url, options = {}) {
      if (closed) throw new Error('深圳直播缓存已经关闭')
      options.signal?.throwIfAborted()
      let state = sessions.get(ref)
      const path = new URL(url).pathname
      if (!path.endsWith('.m3u8') || options.method === 'HEAD') {
        const entry = state?.cache.get(keyOf(url))
        if (entry) { state.activity = now(); return cachedSegment(entry, url, options) }
        return fallbackFetch(url, options)
      }
      if (!state) {
        if (sessions.size >= 7) throw new Error('深圳直播会话数量超过频道数')
        state = { ref, url, options: {}, activity: now(), target: 0, epoch: 0, nextSequence: 0, discontinuities: 0,
          active: 0, queue: [], published: [], cache: new Map(), seen: new Map(), waiters: new Set(),
          controller: new AbortController(), lastQueued: null, refreshedAt: 0, lastErrorLog: 0,
          priming: true, primingKeys: null, playbackFloor: 0, skippedCount: 0, skippedDuration: 0 }
        sessions.set(ref, state)
      } else if (now() - state.activity >= idleMs || now() - state.refreshedAt >= idleMs) {
        // 切台后回来，先核对官网当前窗口；不能先播几分钟前的缓存再突然跳到直播。
        state.priming = true; state.primingKeys = null
      }
      state.activity = now(); state.url = url
      // 会话共享下载，不能让某个客户端断开取消其它观众的缓存任务；每次等待仍尊重各自 signal。
      state.options = { upstreamHeaders: options.upstreamHeaders, upstreamFamily: options.upstreamFamily }
      if (!state.refreshing && (!state.published.length || (state.priming && !state.primingKeys)
        || now() - state.refreshedAt >= Math.min(3000, state.target * 1000 / 3))) void refresh(state)
      const waitSignal = AbortSignal.any([AbortSignal.timeout(9500), ...(options.signal ? [options.signal] : [])])
      while (!state.controller.signal.aborted) {
        const entries = windowOf(state)
        if (entries.reduce((sum, entry) => sum + entry.duration, 0) >= state.target * 3 && entries.length) {
          if (state.priming) {
            state.playbackFloor = entries[0].sequence
            state.priming = false; state.primingKeys = null
          }
          return playlist(state, url)
        }
        if (state.error && !state.queue.length) throw state.error
        let done
        const changed = new Promise(resolve => { done = resolve; state.waiters.add(resolve) })
        try { await abortable(changed, waitSignal) }
        catch (error) {
          if (waitSignal.aborted && !options.signal?.aborted) {
            const ready = windowOf(state)
            log(`深圳直播 ${ref} 起播等待超时：已缓存 ${ready.length} 片/${ready.reduce((sum, entry) => sum + entry.duration, 0).toFixed(1)} 秒，需要 ${state.target * 3} 秒`)
          }
          throw error
        } finally { state.waiters.delete(done) }
      }
      throw new Error('深圳直播会话已过期')
    },
    // 测试也通过与生产相同的刷新、缓存、序号分配路径，不另写模拟实现。
    async refresh(ref) { const state = sessions.get(ref); if (state) await refresh(state) },
    async drain() { while (tasks.size) await Promise.all([...tasks]) },
    sweep,
    inspect() { return { bytesOnDisk, active, sessions: [...sessions.values()].map(s => ({ ref: s.ref,
      published: s.published.map(e => ({ key: e.key, sequence: e.sequence, discontinuityNumber: e.discontinuityNumber, boundary: e.boundary })), queued: s.queue.length })) } },
    async close() {
      closed = true; clearInterval(cleanup)
      for (const state of sessions.values()) { clearTimeout(state.timer); state.controller.abort(); wake(state) }
      await Promise.allSettled([...tasks, sweeping, ...[...sessions.values()].map(s => s.refreshing)].filter(Boolean))
      if (directory) await rm(await directory, { recursive: true, force: true })
      sessions.clear(); bytesOnDisk = 0
    },
  }
}

export const liveRelay = createLiveRelay()
