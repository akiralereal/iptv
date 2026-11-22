import path from 'node:path';
import { mkdir, mkdtemp, rm, readdir, stat, readFile, writeFile, chmod } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError } from '../common.mjs';
import { inspectMedia } from '../media.mjs';
import { MobileModels } from './model.mjs';
import { SourceBridge, MAX_SOURCE } from './source-bridge.mjs';
import { byteVC2Unsupported } from './bytevc2.mjs';
const run = promisify(execFile);
const MAX_CACHE = 500_000_000, TTL = 15 * 60_000;
const FOREGROUND_WAIT_MS = 12_000;
const STALL_MS = 60_000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const failure = () => new AppError('APP_MEDIA_DECODE_FAILED', '媒体处理中断，请重新选择此集');
const cancelled = () => new AppError('PLAY_CANCELLED', '已取消本次播放', 499);

export function parsePlaylist(text) {
  const segments = [];
  for (const match of text.matchAll(/#EXTINF:([\d.]+),[^\n]*\n(part-\d{5}\.m4s)/g)) segments.push({ duration: Number(match[1]), name: match[2] });
  return { segments, duration: segments.reduce((sum, row) => sum + row.duration, 0), ended: text.includes('#EXT-X-ENDLIST') };
}
export function withoutIndex(segment) {
  const kept = [];
  for (let offset = 0; offset < segment.length;) {
    const size = offset + 8 <= segment.length ? segment.readUInt32BE(offset) : 0;
    if (size < 8 || offset + size > segment.length) return segment;
    if (!['styp', 'sidx'].includes(segment.toString('latin1', offset + 4, offset + 8))) kept.push(segment.subarray(offset, offset + size));
    offset += size;
  }
  return Buffer.concat(kept);
}
export class MobilePlayback {
  entries = new Map(); jobs = new Set(); sources = new Map(); sourceRequests = new Map();
  worker = null; foregroundRequests = 0;
  get idle() { return !this.closed && !this.worker && !this.foregroundRequests; }
  constructor(root, { models, bridge } = {}) {
    this.base = path.join(root, '.runtime', 'media'); this.models = models || new MobileModels(root); this.bridge = bridge || new SourceBridge();
    this.timer = setInterval(() => this.prune().catch(() => {}), 60_000); this.timer.unref();
  }
  async initialize() {
    if (!this.init) this.init = (async () => {
      await mkdir(this.base, { recursive: true, mode: 0o700 });
      for (const item of await readdir(this.base, { withFileTypes: true })) {
        if (!item.isDirectory() || !/^session-[\w-]+$/.test(item.name)) continue;
        const target = path.join(this.base, item.name);
        if ((await stat(target)).mtimeMs < Date.now() - 24 * 60 * 60_000) await rm(target, { recursive: true, force: true });
      }
      this.directory = await mkdtemp(path.join(this.base, 'session-'));
    })();
    return this.init;
  }
  available(job) { return !!job && this.jobs.has(job) && !job.error && job.expiresAt > Date.now(); }
  // 转到一半失败的任务（partial）不再给新请求复用，但已转好的分段留给正在看的播放器播完
  readable(job) { return !!job && this.jobs.has(job) && (!job.error || job.partial) && job.expiresAt > Date.now(); }
  renew(job) {
    // Only extend the lifetime of the existing local files.
    if (this.available(job)) job.expiresAt = Date.now() + TTL;
    return job.expiresAt;
  }
  async prune({ reserve = false } = {}) {
    let bytes = [...this.jobs].filter(job => job.complete || job.error).reduce((sum, job) => sum + job.diskBytes, 0);
    for (const job of this.jobs) {
      if (!job.complete && (!job.error || job === this.worker?.job)) continue;
      for (const [client, expires] of job.leases) if (expires <= Date.now()) job.leases.delete(client);
      if ((job.complete || job.partial) && job.leases.size) continue;
      if (job.complete && job.expiresAt > Date.now() && bytes <= MAX_CACHE && this.jobs.size <= (reserve ? 11 : 12)) continue;
      this.jobs.delete(job); if (this.entries.get(job.cacheKey) === job) this.entries.delete(job.cacheKey);
      bytes -= job.diskBytes; await rm(job.directory, { recursive: true, force: true });
    }
    for (const [id, source] of this.sources) if (source.expiresAt <= Date.now()) { source.contentKey?.fill(0); this.sources.delete(id); }
  }
  promote(videoId) {
    if (this.worker?.cacheKey === `${videoId}:0.000` && !this.worker.controller.signal.aborted) this.worker.priority = true;
  }
  async prepare(videoId, { refresh = false, signal, offset = 0, priority = false, requestKey = '' } = {}) {
    if (!Number.isFinite(offset) || offset < 0) throw new AppError('INVALID_POSITION', '播放位置无效', 400);
    const cacheKey = `${videoId}:${offset.toFixed(3)}${requestKey ? ':' + requestKey : ''}`;
    const until = Date.now() + FOREGROUND_WAIT_MS;
    if (priority) this.foregroundRequests++;
    try {
      while (true) {
        if (this.closed) throw failure();
        if (signal?.aborted) throw cancelled();
        const current = this.worker;
        const existing = this.entries.get(cacheKey);
        const sameWorker = current?.cacheKey === cacheKey && !current.controller.signal.aborted;
        if (sameWorker && priority) current.priority = true;
        if ((!refresh || !existing?.complete) && this.available(existing) && existing.expiresAt > Date.now() + 60_000) {
          return await this.waitReady(existing, signal);
        }
        if (sameWorker && !current.job?.error) return await this.waitReady(await current.ready, signal);
        if (!current && (priority || !this.foregroundRequests)) {
          return await this.waitReady(await this.startWorker(videoId, offset, cacheKey, priority, signal), signal);
        }
        if (!priority || Date.now() >= until) throw new AppError('APP_BUSY', '正在准备其他剧集，请稍后再试', 429);
        if (!current.priority) {
          current.controller.abort();
          if (!current.job?.complete && !current.job?.error) current.job?.cancel(cancelled());
        } else if (current.job?.claimed && !current.job.waiters) {
          this.cancelUnleased(current.job);
        }
        await delay(20);
      }
    } finally { if (priority) this.foregroundRequests--; }
  }
  startWorker(videoId, offset, cacheKey, priority, signal) {
    const controller = new AbortController();
    const worker = { cacheKey, priority, controller, job: null };
    this.worker = worker;
    const startupSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    worker.ready = (async () => {
      await this.prune({ reserve: true });
      if (startupSignal.aborted) throw cancelled();
      if (this.jobs.size >= 12 || [...this.jobs].filter(job => job.complete).reduce((sum, job) => sum + job.diskBytes, 0) > MAX_CACHE) throw new AppError('APP_BUSY', '当前播放缓存正在使用，请先关闭其他播放页面', 429);
      const job = await this.create(videoId, offset, cacheKey, startupSignal);
      worker.job = job;
      if (controller.signal.aborted && !job.complete) job.cancel(cancelled());
      return job;
    })();
    // Keep the sole slot occupied until FFmpeg and its cleanup have exited.
    worker.done = worker.ready.then(job => job.done).finally(() => { this.worker = null; });
    worker.done.catch(() => {});
    return worker.ready;
  }
  async waitReady(job, signal) {
    job.waiters++;
    let listener;
    try {
      if (signal?.aborted) throw cancelled();
      const abort = new Promise((resolve, reject) => { listener = () => reject(cancelled()); signal?.addEventListener('abort', listener, { once: true }); });
      const result = await Promise.race([job.ready, abort]); job.claimed = true; return result;
    } finally {
      signal?.removeEventListener('abort', listener); job.waiters--;
      if (!job.waiters && !job.claimed && signal?.aborted) job.cancel();
    }
  }
  async source(videoId) {
    let source = this.sources.get(videoId);
    if (!source || source.expiresAt <= Date.now() + 30_000) {
      if (!this.sourceRequests.has(videoId)) {
        const work = this.models.resolve(videoId).then(result => {
          this.sources.get(videoId)?.contentKey?.fill(0);
          result.expiresAt = Math.min(result.expiresAt || Date.now() + 600_000, Date.now() + 600_000);
          this.sources.set(videoId, result); return result;
        }).finally(() => this.sourceRequests.delete(videoId));
        this.sourceRequests.set(videoId, work);
      }
      source = await this.sourceRequests.get(videoId);
    }
    return { ...source, contentKey: source.contentKey ? Buffer.from(source.contentKey) : null };
  }
  async sourceMetadata(videoId) {
    const source = await this.source(videoId);
    source.contentKey?.fill(0);
    return { expectedDuration: source.expectedDuration };
  }
  cancelUnleased(job, { preloadOnly = false } = {}) {
    if (!job || job.complete || job.error) return false;
    if (preloadOnly && (this.worker?.job !== job || this.worker.priority)) return false;
    for (const [client, expires] of job.leases) if (expires <= Date.now()) job.leases.delete(client);
    if (job.leases.size) return false;
    job.cancel();
    return true;
  }
  async covering(videoId, position) {
    const candidates = [...this.jobs].filter(job => job.videoId === videoId && job.offset <= position && this.available(job) && job.claimed);
    for (const job of candidates.sort((a, b) => a.offset - b.offset)) {
      const available = job.complete ? job.duration : job.availableDuration || 0;
      if (job.complete || position - job.offset < available - 0.5) return job;
    }
    return null;
  }
  async create(videoId, offset, cacheKey, signal) {
    const started = performance.now(); await this.initialize();
    if (this.closed || signal?.aborted) throw cancelled();
    const source = await this.source(videoId);
    if (this.closed || signal?.aborted || offset >= source.expectedDuration) { source.contentKey?.fill(0); throw cancelled(); }
    const directory = await mkdtemp(path.join(this.directory, 'episode-'));
    const job = { videoId, cacheKey, offset, sourceDuration: source.expectedDuration, availableDuration: 0, directory, file: path.join(directory, 'complete.mp4'), playlist: path.join(directory, 'index.m3u8'),
      expectedDuration: source.expectedDuration - offset, duration: source.expectedDuration - offset, provider: source.provider, identityVerified: source.identityVerified,
      sourceCodec: source.codec, expiresAt: Date.now() + TTL, diskBytes: 0, size: 0, waiters: 0, claimed: false, complete: false, leases: new Map(),
      timing: { modelMs: Math.round(performance.now() - started) }, started };
    let readyResolve, readyReject;
    job.ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; }); job.ready.catch(() => {});
    job.cancel = (reason = failure()) => { job.error ||= reason; job.process?.kill('SIGTERM'); };
    this.jobs.add(job); this.entries.set(cacheKey, job);
    job.done = this.process(job, source, readyResolve, signal).catch(error => {
      job.error ||= error instanceof AppError ? error : failure();
      // 已经出过分段的失败不连带作废前面的内容：正在看的播放器照常播到断点（网页播放器会从断点重新接上）
      job.partial = !!job.timing.firstSegmentMs && !this.closed && job.error.code !== 'PLAY_CANCELLED';
      readyReject(job.error); throw job.error;
    });
    job.done.catch(() => {}); return job;
  }
  async process(job, source, readyResolve, signal) {
    let input, watchdog, killTimer;
    try {
      const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
      if (source.codec === 'bytevc2') {
        this.vvcDecoder ??= run(ffmpeg, ['-hide_banner', '-decoders'], { timeout: 5000, maxBuffer: 500_000 })
          .then(({ stdout }) => /^\s*V\S*\s+vvc\s/m.test(stdout), () => false);
        if (!await this.vvcDecoder) throw byteVC2Unsupported();
      }
      input = await this.bridge.register(source, signal);
      if (job.error || signal?.aborted) throw job.error || cancelled();
      // 取源断流（家宽抖动、CDN 掐连接、15 秒读不到数据）时 FFmpeg 从断开的位置带 Range 重连，转码不中断；
      // 中继对上游 4xx（地址过期等）回 403，不在这里白白重试
      const child = spawn(ffmpeg, ['-v', 'error', '-nostdin', '-xerror', '-rw_timeout', '15000000',
        '-reconnect', '1', '-reconnect_on_network_error', '1', '-reconnect_on_http_error', '5xx', '-reconnect_delay_max', '4',
        ...(source.contentKey ? ['-decryption_key', source.contentKey.toString('hex')] : []), ...(job.offset ? ['-ss', String(job.offset)] : []),
        ...(source.codec === 'bytevc2' ? ['-threads', '4'] : []), '-i', input.url,
        '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-threads', '4',
        '-pix_fmt', 'yuv420p', '-force_key_frames', 'expr:gte(t,n_forced*2)', ...(job.offset ? ['-c:a', 'aac', '-b:a', '128k'] : ['-c:a', 'copy']),
        '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_segment_type', 'fmp4',
        '-hls_flags', 'independent_segments+temp_file', '-hls_segment_filename', path.join(job.directory, 'part-%05d.m4s'), job.playlist],
      { stdio: ['ignore', 'ignore', 'pipe'] });
      job.process = child; let exited = false, exitCode = null, stderrBytes = 0, stderrText = '';
      // Never expose FFmpeg arguments/errors: they can contain media keys or URLs.
      child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 100_000) job.cancel(); else stderrText += chunk; });
      const exit = new Promise(resolve => { child.once('error', () => { job.error ||= failure(); }); child.once('close', code => { exited = true; job.processClosed = true; exitCode = code; resolve(); }); });
      job.cancel = (reason = failure()) => { job.error ||= reason; child.kill('SIGTERM'); killTimer ||= setTimeout(() => child.kill('SIGKILL'), 2000); killTimer.unref(); };
      // 看进展不看总时长：低配 NAS 上转一集可能要好几分钟，只要还在读源、还在写分段就不掐断；
      // 连续 60 秒既没读进数据也没写出文件才算卡住。另留 30 分钟总上限兜底。
      watchdog = setTimeout(job.cancel, 30 * 60_000); watchdog.unref();
      let first = false, lastSizeCheck = 0, lastProgress = performance.now(), progressMark = '';
      while (true) {
        if (!first) {
          let playlist; try { playlist = parsePlaylist(await readFile(job.playlist, 'utf8')); } catch {}
          if (playlist?.segments.length) {
            job.availableDuration = playlist.duration;
            const firstFile = path.join(job.directory, 'first.mp4');
            await writeFile(firstFile, Buffer.concat([await readFile(path.join(job.directory, 'init.mp4')), await readFile(path.join(job.directory, playlist.segments[0].name))]), { mode: 0o600 });
            const metadata = await inspectMedia(firstFile, { local: true }); await rm(firstFile, { force: true });
            Object.assign(job, { width: metadata.width, height: metadata.height, video: metadata.video, audio: metadata.audio });
            if (job.error) throw job.error;
            job.timing.firstSegmentMs = Math.round(performance.now() - job.started);
            job.timing.inputBytesAtFirstSegment = input.record.bytes; job.timing.sourceBytes = input.record.size;
            job.timing.maxInputRangeStart = input.record.maxRangeStart;
            first = true; readyResolve(job);
          }
        }
        if (performance.now() - lastSizeCheck > 1000) {
          lastSizeCheck = performance.now(); job.diskBytes = await this.diskSize(job.directory);
          try { job.availableDuration = parsePlaylist(await readFile(job.playlist, 'utf8')).duration; } catch {}
          if (job.diskBytes > MAX_SOURCE) job.cancel();
          const mark = `${input.record.bytes}:${job.diskBytes}`;
          if (mark !== progressMark) { progressMark = mark; lastProgress = performance.now(); }
          else if (performance.now() - lastProgress > STALL_MS) job.cancel();
        }
        if (exited) break;
        await delay(25);
      }
      await exit;
      // 断流重连时 http 层会报「Stream ends prematurely」等，重连接上了不算错；
      // 没接上的话 FFmpeg 会非零退出，或者分段时长和官方整集对不上，下面照样判失败
      const decodeErrors = stderrText.split('\n').some(line => line.trim() && !/^\[(?:https?|tcp|tls) @ [^\]]+\] /.test(line) && !/^\s*Last message repeated/.test(line));
      if (job.error || exitCode !== 0 || decodeErrors) throw job.error || failure();
      if (!first) throw failure();
      const playlist = parsePlaylist(await readFile(job.playlist, 'utf8'));
      // 分段已经全部出完：后面即使时长核对或封装 MP4 失败，HLS 也照常播到结尾，不算中途断开
      job.hlsEnded = playlist.ended;
      if (!playlist.ended || Math.abs(playlist.duration - job.expectedDuration) > Math.max(1, job.expectedDuration * 0.01)) throw new AppError('APP_DURATION_MISMATCH', '媒体长度与官方整集时长不符');
      // A compact MP4 remains available for full decoding and conventional Range
      // clients. Remuxing starts after HLS playback is already available.
      await run(ffmpeg, ['-v', 'error', '-nostdin', '-xerror', '-i', job.playlist,
        '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-movflags', '+faststart', job.file], { timeout: 120_000, maxBuffer: 100_000 });
      if (job.error) throw job.error;
      const media = await inspectMedia(job.file, { local: true });
      if (media.size > MAX_SOURCE || Math.abs(media.duration - job.expectedDuration) > Math.max(1, job.expectedDuration * 0.01)) throw new AppError('APP_DURATION_MISMATCH', '媒体长度与官方整集时长不符');
      Object.assign(job, media); job.diskBytes = await this.diskSize(job.directory);
      for (const name of await readdir(job.directory)) await chmod(path.join(job.directory, name), 0o600);
      if (job.error) throw job.error;
      job.complete = true; job.availableDuration = job.duration; job.timing.completeMs = Math.round(performance.now() - job.started); job.timing.inputBytes = input.record.bytes;
      await this.prune(); return job;
    } finally {
      clearTimeout(watchdog); clearTimeout(killTimer); input?.release(); source.contentKey?.fill(0);
      // 上游拒绝了这个源地址：丢掉缓存（否则 10 分钟内重选此集还是同一个坏地址）
      if (input?.record.rejected) { this.sources.get(job.videoId)?.contentKey?.fill(0); this.sources.delete(job.videoId); }
      if (job.process && !job.processClosed) { job.process.kill('SIGKILL'); await new Promise(resolve => job.process.once('close', resolve)); }
      job.process = null;
      // 失败时把最后几个分段也算进可播范围（循环里每秒才刷新一次）
      if (!job.complete) try { job.availableDuration = parsePlaylist(await readFile(job.playlist, 'utf8')).duration; } catch {}
    }
  }
  async diskSize(directory) {
    let bytes = 0; for (const name of await readdir(directory)) { try { bytes += (await stat(path.join(directory, name))).size; } catch (e) { if (e.code !== 'ENOENT') throw e; } } return bytes;
  }
  // 还没转完时给 MP4 直放客户端的顺序流：init 加各分段首尾相接就是一份能从头播的分片 MP4。
  // 分段里的 sidx 只覆盖本段 2 秒，留着会让 ExoPlayer 把整集当成 2 秒长，所以和 styp 一起去掉
  async *progressive(job, { signal } = {}) {
    let sent = 0;
    yield await readFile((await this.asset(job, 'init.mp4')).file);
    while (!signal?.aborted) {
      const { segments, ended } = parsePlaylist(await this.playlist(job));
      for (; sent < segments.length && !signal?.aborted; sent++) yield withoutIndex(await readFile((await this.asset(job, segments[sent].name)).file));
      if (ended) return;
      if (job.error) throw job.error;
      await delay(250);
    }
  }
  // FFmpeg 读源出错退出时也会写 ENDLIST：确认正常转完（hlsEnded）之前不对外给片尾标记，
  // 免得播放器把断点当成片尾、悄悄跳到下一集
  async playlist(job) {
    const text = await readFile((await this.asset(job, 'index.m3u8')).file, 'utf8');
    return job.hlsEnded ? text : text.replace(/^#EXT-X-ENDLIST[ \t]*\r?\n?/m, '');
  }
  async asset(job, name) {
    if (!this.readable(job)) throw job?.error || new AppError('SESSION_EXPIRED', '媒体会话已过期，请重新选集', 410);
    if (!/^(?:index\.m3u8|init\.mp4|part-\d{5}\.m4s)$/.test(name)) throw new AppError('NOT_FOUND', '媒体分段不存在', 404);
    const file = path.join(job.directory, name);
    try { return { file, size: (await stat(file)).size }; } catch { throw new AppError('NOT_FOUND', '媒体分段尚未就绪', 404); }
  }
  async close() {
    this.closed = true; clearInterval(this.timer);
    this.worker?.controller.abort();
    for (const job of this.jobs) if (!job.complete) job.cancel();
    await this.worker?.done.catch(() => {}); await this.bridge.close();
    for (const source of this.sources.values()) source.contentKey?.fill(0); this.sources.clear();
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}
