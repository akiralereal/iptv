import path from 'node:path';
import { mkdir, mkdtemp, rm, readdir, stat, readFile, writeFile, chmod } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError } from '../common.mjs';
import { inspectMedia } from '../media.mjs';
import { MobileModels } from './model.mjs';
import { SourceBridge, MAX_SOURCE } from './source-bridge.mjs';
const run = promisify(execFile);
const MAX_CACHE = 500_000_000, TTL = 15 * 60_000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const failure = () => new AppError('APP_MEDIA_DECODE_FAILED', '媒体处理中断，请重新选择此集');

export function parsePlaylist(text) {
  const segments = [];
  for (const match of text.matchAll(/#EXTINF:([\d.]+),[^\n]*\n(part-\d{5}\.m4s)/g)) segments.push({ duration: Number(match[1]), name: match[2] });
  return { segments, duration: segments.reduce((sum, row) => sum + row.duration, 0), ended: text.includes('#EXT-X-ENDLIST') };
}
export class MobilePlayback {
  entries = new Map(); pending = new Map(); jobs = new Set(); workers = 0; sources = new Map(); sourceRequests = new Map();
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
  async prune({ reserve = false } = {}) {
    let bytes = [...this.jobs].filter(job => job.complete || job.error).reduce((sum, job) => sum + job.diskBytes, 0);
    for (const job of this.jobs) {
      if (!job.complete && !job.error) continue;
      for (const [client, expires] of job.leases) if (expires <= Date.now()) job.leases.delete(client);
      if (!job.error && job.leases.size) continue;
      if (!job.error && job.expiresAt > Date.now() && bytes <= MAX_CACHE && this.jobs.size <= (reserve ? 11 : 12)) continue;
      this.jobs.delete(job); if (this.entries.get(job.cacheKey) === job) this.entries.delete(job.cacheKey);
      bytes -= job.diskBytes; await rm(job.directory, { recursive: true, force: true });
    }
    for (const [id, source] of this.sources) if (source.expiresAt <= Date.now()) { source.contentKey?.fill(0); this.sources.delete(id); }
  }
  async prepare(videoId, { refresh = false, signal, offset = 0, priority = false, requestKey = '' } = {}) {
    if (this.closed) throw failure();
    if (!Number.isFinite(offset) || offset < 0) throw new AppError('INVALID_POSITION', '播放位置无效', 400);
    const cacheKey = `${videoId}:${offset.toFixed(3)}${requestKey ? ':' + requestKey : ''}`;
    const existing = this.entries.get(cacheKey);
    if ((!refresh || !existing?.complete) && this.available(existing) && existing.expiresAt > Date.now() + 60_000) return this.waitReady(existing, signal);
    let work = this.pending.get(cacheKey);
    if (!work) {
      const until = Date.now() + 3000;
      while (priority && this.workers >= 2 && Date.now() < until && !signal?.aborted) await delay(20);
      if (signal?.aborted) throw new AppError('PLAY_CANCELLED', '已取消本次播放', 499);
      if (this.pending.has(cacheKey)) return this.waitReady(await this.pending.get(cacheKey), signal);
      if (this.workers >= 2) throw new AppError('APP_BUSY', '正在准备其他剧集，请稍后再试', 429);
      this.workers++;
      work = (async () => {
        try {
          await this.prune({ reserve: true });
          if (this.jobs.size >= 12 || [...this.jobs].filter(job => job.complete).reduce((sum, job) => sum + job.diskBytes, 0) > MAX_CACHE) throw new AppError('APP_BUSY', '当前播放缓存正在使用，请先关闭其他播放页面', 429);
          const job = await this.create(videoId, offset, cacheKey, signal);
          job.done.finally(() => this.workers--).catch(() => {}); return job;
        } catch (error) { this.workers--; throw error; }
      })().finally(() => this.pending.delete(cacheKey)); this.pending.set(cacheKey, work);
    }
    return this.waitReady(await work, signal);
  }
  async waitReady(job, signal) {
    job.waiters++;
    const aborted = () => new AppError('PLAY_CANCELLED', '已取消本次播放', 499);
    let listener;
    try {
      if (signal?.aborted) throw aborted();
      const cancelled = new Promise((resolve, reject) => { listener = () => reject(aborted()); signal?.addEventListener('abort', listener, { once: true }); });
      const result = await Promise.race([job.ready, cancelled]); job.claimed = true; return result;
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
  cancelUnleased(job) {
    if (!job || job.complete || job.error) return;
    for (const [client, expires] of job.leases) if (expires <= Date.now()) job.leases.delete(client);
    if (!job.leases.size) job.cancel();
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
    const source = await this.source(videoId);
    if (this.closed || signal?.aborted || offset >= source.expectedDuration) { source.contentKey?.fill(0); throw new AppError('PLAY_CANCELLED', '已取消本次播放', 499); }
    const directory = await mkdtemp(path.join(this.directory, 'episode-'));
    const job = { videoId, cacheKey, offset, sourceDuration: source.expectedDuration, availableDuration: 0, directory, file: path.join(directory, 'complete.mp4'), playlist: path.join(directory, 'index.m3u8'),
      expectedDuration: source.expectedDuration - offset, duration: source.expectedDuration - offset, provider: source.provider, identityVerified: source.identityVerified,
      sourceCodec: source.codec, expiresAt: Date.now() + TTL, diskBytes: 0, size: 0, waiters: 0, claimed: false, complete: false, leases: new Map(),
      timing: { modelMs: Math.round(performance.now() - started) }, started };
    let readyResolve, readyReject;
    job.ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; }); job.ready.catch(() => {});
    job.cancel = () => { job.error ||= failure(); job.process?.kill('SIGTERM'); };
    this.jobs.add(job); this.entries.set(cacheKey, job);
    job.done = this.process(job, source, readyResolve).catch(error => {
      job.error = error instanceof AppError ? error : failure(); readyReject(job.error); throw job.error;
    });
    job.done.catch(() => {}); return job;
  }
  async process(job, source, readyResolve) {
    let input, watchdog, killTimer;
    try {
      input = await this.bridge.register(source);
      if (job.error) throw job.error;
      const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-nostdin', '-xerror', '-rw_timeout', '15000000',
        ...(source.contentKey ? ['-decryption_key', source.contentKey.toString('hex')] : []), ...(job.offset ? ['-ss', String(job.offset)] : []), '-i', input.url,
        '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-threads', '4',
        '-pix_fmt', 'yuv420p', '-force_key_frames', 'expr:gte(t,n_forced*2)', ...(job.offset ? ['-c:a', 'aac', '-b:a', '128k'] : ['-c:a', 'copy']),
        '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_segment_type', 'fmp4',
        '-hls_flags', 'independent_segments+temp_file', '-hls_segment_filename', path.join(job.directory, 'part-%05d.m4s'), job.playlist],
      { stdio: ['ignore', 'ignore', 'pipe'] });
      job.process = child; let exited = false, exitCode = null, stderrBytes = 0;
      // Never expose FFmpeg arguments/errors: they can contain media keys or URLs.
      child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 100_000) job.cancel(); });
      const exit = new Promise(resolve => { child.once('error', () => { job.error = failure(); }); child.once('close', code => { exited = true; job.processClosed = true; exitCode = code; resolve(); }); });
      job.cancel = () => { job.error ||= failure(); child.kill('SIGTERM'); killTimer ||= setTimeout(() => child.kill('SIGKILL'), 2000); killTimer.unref(); };
      watchdog = setTimeout(job.cancel, 180_000); watchdog.unref();
      let first = false, lastSizeCheck = 0;
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
        }
        if (exited) break;
        await delay(25);
      }
      await exit;
      if (job.error || exitCode !== 0 || stderrBytes) throw job.error || failure();
      if (!first) throw failure();
      const playlist = parsePlaylist(await readFile(job.playlist, 'utf8'));
      if (!playlist.ended || Math.abs(playlist.duration - job.expectedDuration) > Math.max(1, job.expectedDuration * 0.01)) throw new AppError('APP_DURATION_MISMATCH', '媒体长度与官方整集时长不符');
      // A compact MP4 remains available for full decoding and conventional Range
      // clients. Remuxing starts after HLS playback is already available.
      await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-nostdin', '-xerror', '-i', job.playlist,
        '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-movflags', '+faststart', job.file], { timeout: 30_000, maxBuffer: 100_000 });
      const media = await inspectMedia(job.file, { local: true });
      if (media.size > MAX_SOURCE || Math.abs(media.duration - job.expectedDuration) > Math.max(1, job.expectedDuration * 0.01)) throw new AppError('APP_DURATION_MISMATCH', '媒体长度与官方整集时长不符');
      Object.assign(job, media); job.diskBytes = await this.diskSize(job.directory);
      for (const name of await readdir(job.directory)) await chmod(path.join(job.directory, name), 0o600);
      job.complete = true; job.availableDuration = job.duration; job.timing.completeMs = Math.round(performance.now() - job.started); job.timing.inputBytes = input.record.bytes;
      await this.prune(); return job;
    } finally {
      clearTimeout(watchdog); clearTimeout(killTimer); input?.release(); source.contentKey?.fill(0);
      if (job.process && !job.processClosed) { job.process.kill('SIGKILL'); await new Promise(resolve => job.process.once('close', resolve)); }
      job.process = null;
    }
  }
  async diskSize(directory) {
    let bytes = 0; for (const name of await readdir(directory)) { try { bytes += (await stat(path.join(directory, name))).size; } catch (e) { if (e.code !== 'ENOENT') throw e; } } return bytes;
  }
  async asset(job, name) {
    if (!this.available(job)) throw job?.error || new AppError('SESSION_EXPIRED', '媒体会话已过期，请重新选集', 410);
    if (!/^(?:index\.m3u8|init\.mp4|part-\d{5}\.m4s)$/.test(name)) throw new AppError('NOT_FOUND', '媒体分段不存在', 404);
    const file = path.join(job.directory, name);
    try { return { file, size: (await stat(file)).size }; } catch { throw new AppError('NOT_FOUND', '媒体分段尚未就绪', 404); }
  }
  async close() {
    this.closed = true; clearInterval(this.timer);
    await Promise.allSettled([...this.pending.values()]);
    for (const job of this.jobs) if (!job.complete) job.cancel();
    await Promise.allSettled([...this.jobs].map(job => job.done)); await this.bridge.close();
    for (const source of this.sources.values()) source.contentKey?.fill(0); this.sources.clear();
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}
