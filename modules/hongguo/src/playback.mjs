import { randomBytes } from 'node:crypto';
import { AppError, USER_AGENT, ORIGIN, mediaURL, episodeNumber, boundedText, officialPage } from './common.mjs';
import { playerMetadata } from './browser.mjs';
import { inspectMedia, decodeMedia } from './media.mjs';
import { MobilePlayback } from './mobile/playback.mjs';
import { seekPosition, validClient, superseded } from './seek.mjs';
export { assessCompleteness } from './media.mjs';

export class Playback {
  entries = new Map(); pending = new Map(); tokens = new Map(); sessions = new Map(); preloadFailures = new Map();
  constructor(catalog, browser, root) { this.catalog = catalog; this.browser = browser; this.mobile = new MobilePlayback(root); }
  async resolve(seriesId, value, { refresh = false, preload = false } = {}) {
    const detail = await this.catalog.detail(seriesId); const number = episodeNumber(value, detail.total);
    const videoId = detail.episodes[number - 1].id; const key = `${seriesId}:${number}`;
    if (!preload) this.mobile.promote(videoId);
    const existing = this.entries.get(key);
    if (!refresh && existing?.expiresAt > Date.now() + 60000 && (!existing.appRetryAt || existing.appRetryAt > Date.now()) && (!existing.job || this.mobile.available(existing.job))) return existing;
    const pending = this.pending.get(key);
    if (pending) {
      if (preload || !pending.preload) return pending.work;
      try { return await pending.work; }
      catch { return this.resolve(seriesId, value, { refresh }); }
    }
    const work = (async () => {
      let source, appError;
      try {
        const job = await this.mobile.prepare(videoId, { refresh, priority: !preload });
        source = { job, duration: job.duration, expectedDuration: job.expectedDuration, width: job.width, height: job.height,
          video: job.video, audio: job.audio, provider: job.provider, identityVerified: job.identityVerified, expiresAt: job.expiresAt };
      } catch (error) { if (preload || error.code === 'APP_BUSY' || error.code === 'PLAY_CANCELLED') throw error; appError = error; }
      if (!source) {
        // The public endpoint is observed from the official website. No external parser or signing service is used.
        const response = await fetch(ORIGIN + '/api/video/protected/fallback-play-info?aid=8662', {
          method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT, origin: ORIGIN, referer: `${ORIGIN}/player/${seriesId}/${videoId}` },
          body: JSON.stringify({ item_id: videoId }), redirect: 'error', signal: AbortSignal.timeout(20000),
        }).catch(() => null);
        if (response?.ok) {
          const data = JSON.parse(await boundedText(response, 200000));
          if (data.base_resp?.StatusCode === 0 && data.main_url) source = { url: mediaURL(data.main_url), expiresAt: Number(data.url_expire) * 1000, expectedDuration: null, identityVerified: true, provider: 'official_public_endpoint' };
        } else { await response?.body?.cancel(); }
        // A normal official browser session may have different playback rights; its requested and returned episode IDs must agree.
        if (!source) { try { source = await this.browser.resolve(seriesId, videoId); } catch { throw appError; } }
        if (!source.expectedDuration && source.provider === 'official_public_endpoint') {
          const meta = playerMetadata(await officialPage(`/player/${seriesId}/${videoId}`), seriesId, videoId);
          source.expectedDuration = meta.duration;
        }
      }
      if (!Number.isFinite(source.expiresAt) || source.expiresAt <= Date.now() + 30000) throw new AppError('EXPIRED', '官网地址有效期不足，请重试');
      if (!source.job && appError) Object.assign(source, { appIssue: appError.code || 'APP_UNAVAILABLE', appRetryAt: Date.now() + 30000 });
      const media = source.job ? source : await inspectMedia(source.url);
      for (const [k, v] of this.entries) if (v.expiresAt < Date.now()) this.entries.delete(k);
      while (this.entries.size >= 60 && !this.entries.has(key)) this.entries.delete(this.entries.keys().next().value);
      const entry = { ...source, ...media, key, seriesId, videoId, number, title: detail.title, total: detail.total,
        token: existing && (!source.job || source.job === existing.job) ? existing.token : randomBytes(24).toString('hex'), checkedAt: new Date().toISOString(), verification: 'not_checked' };
      for (const [token, old] of this.tokens) if (old.expiresAt < Date.now() || (old.job && !this.mobile.available(old.job))) this.tokens.delete(token);
      this.entries.set(key, entry); this.tokens.set(entry.token, entry); return entry;
    })().catch(error => { this.entries.delete(key); throw error; }).finally(() => this.pending.delete(key));
    this.pending.set(key, { work, preload }); return work;
  }
  warmNext(seriesId, number) {
    // Emby 客户端约每 10 秒上报一次进度、每次都会走到这里：下一集预加载失败过（锁集、格式不支持、转码中断等）
    // 就 5 分钟内不再试，免得反复请求官方接口、反复重转一遍
    const key = `${seriesId}:${number}`;
    if (!this.mobile.idle || this.preloadFailures.get(key) > Date.now()) return;
    void this.resolve(seriesId, number, { preload: true }).catch(error => {
      if (['APP_BUSY', 'PLAY_CANCELLED'].includes(error?.code)) return;
      this.preloadFailures.set(key, Date.now() + 5 * 60_000);
      while (this.preloadFailures.size > 200) this.preloadFailures.delete(this.preloadFailures.keys().next().value);
    });
  }
  async resolveResumeHLS(seriesId, number, offset) {
    const detail = await this.catalog.detail(seriesId);
    const videoId = detail.episodes[episodeNumber(number, detail.total) - 1].id;
    const { expectedDuration } = await this.mobile.sourceMetadata(videoId);
    // A tail shorter than one segment is better served by the full file.
    if (offset <= 0 || offset > expectedDuration - 2) return null;
    const job = await this.mobile.prepare(videoId, { offset, priority: true });
    let entry = [...this.tokens.values()].find(value => value.job === job);
    if (!entry) {
      entry = { seriesId, number, job, token: randomBytes(24).toString('hex'),
        expectedDuration, width: job.width, height: job.height, video: job.video, audio: job.audio,
        expiresAt: job.expiresAt };
      for (const [token, value] of this.tokens) {
        if (value.expiresAt < Date.now() || (value.job && !this.mobile.available(value.job))) this.tokens.delete(token);
      }
      this.tokens.set(entry.token, entry);
    }
    return entry;
  }
  episodeDuration(seriesId, number) {
    const entry = this.entries.get(`${seriesId}:${number}`)
      || [...this.tokens.values()].find(value => value.seriesId === seriesId && value.number === number);
    return entry?.expectedDuration || entry?.duration || 0;
  }
  releaseMediaLease(seriesId, number, lease) {
    for (const entry of this.tokens.values()) {
      if (entry.seriesId === seriesId && entry.number === number) entry.job?.leases.delete(lease);
    }
  }
  replaceMediaLease(seriesId, number, lease) {
    for (const entry of this.tokens.values()) {
      if (entry.seriesId === seriesId && entry.number === number) continue;
      if (entry.job?.leases.delete(lease)) this.mobile.cancelUnleased(entry.job);
    }
  }
  public(entry, { position = entry.job?.offset || 0, session = entry.token } = {}) {
    return { seriesId: entry.seriesId, number: entry.number, title: entry.title, total: entry.total, duration: entry.expectedDuration || entry.duration, width: entry.width, height: entry.height, verification: entry.verification, checkedAt: entry.checkedAt, provider: entry.provider,
      format: entry.job ? 'hls' : 'mp4', media: entry.job ? `/hls/${entry.token}/index.m3u8` : '/media/' + entry.token,
      processing: entry.job ? !entry.job.complete : false, startupMs: entry.job?.timing.firstSegmentMs,
      quality: Math.min(entry.width || 0, entry.height || 0) >= 720 ? 'hd' : 'sd', appIssue: entry.appIssue,
      availableThrough: entry.job ? Math.min(entry.duration, entry.job.offset + entry.job.availableDuration) : entry.duration,
      status: '/api/playback/' + entry.token,
      session, offset: entry.job?.offset || 0, position,
      expiresAt: new Date(entry.expiresAt).toISOString() };
  }
  claim(entry, client, { renew = false } = {}) {
    if (!validClient(client)) return;
    if (renew && !entry.job?.leases.has(client)) return;
    for (const job of this.mobile.jobs) job.leases.delete(client);
    entry.job?.leases.set(client, Date.now() + 45_000);
  }
  begin(entry, client) {
    if (!validClient(client)) return;
    const previous = this.sessions.get(client); previous?.controller?.abort();
    previous?.active?.job?.leases.delete(client);
    if (previous?.active?.job !== entry.job) this.mobile.cancelUnleased(previous?.active?.job);
    this.sessions.set(client, { anchor: entry.token, base: entry, active: entry, sequence: 0, expiresAt: entry.expiresAt }); this.claim(entry, client);
    for (const [id, session] of this.sessions) if (session.expiresAt < Date.now()) { session.controller?.abort(); this.sessions.delete(id); }
  }
  async preload({ session: anchor, parentClientId, clientId }, disconnected = () => false) {
    const parent = this.sessions.get(parentClientId);
    if (!validClient(clientId) || clientId === parentClientId || !parent || parent.anchor !== anchor || parent.expiresAt <= Date.now()) throw new AppError('SESSION_EXPIRED', '播放会话已失效，请重新选集', 410);
    if (this.sessions.has(clientId) && parent.nextClient !== clientId) throw new AppError('INVALID_CLIENT', '预加载会话不能替换正在播放的会话', 409);
    if (parent.base.number >= parent.base.total) return { next: null };
    if (parent.nextClient && parent.nextClient !== clientId) this.releaseNext(parentClientId);
    parent.nextClient = clientId;
    const entry = await this.resolve(parent.base.seriesId, parent.base.number + 1, { preload: true });
    if (disconnected() || this.sessions.get(parentClientId) !== parent || parent.nextClient !== clientId) {
      this.mobile.cancelUnleased(entry.job, { preloadOnly: true }); throw new AppError('PLAY_CANCELLED', '已取消预加载', 499);
    }
    this.begin(entry, clientId); return this.public(entry);
  }
  releaseNext(client, expectedNext) {
    const parent = this.sessions.get(client); if (!parent?.nextClient) return;
    if (expectedNext && parent.nextClient !== expectedNext) return;
    const nextClient = parent.nextClient; delete parent.nextClient;
    const next = this.sessions.get(nextClient); if (next) this.release(next.anchor, nextClient);
  }
  // Transfer the prepared session before releasing its parent. The same media
  // job and lease then serve foreground playback without another conversion.
  adopt({ parentClientId, clientId, session: anchor }) {
    const parent = this.sessions.get(parentClientId), next = this.sessions.get(clientId);
    if (!parent || parent.nextClient !== clientId || !next || next.anchor !== anchor || next.expiresAt <= Date.now() || (next.active.job && !this.mobile.available(next.active.job))) throw new AppError('PRELOAD_EXPIRED', '预加载已失效，正在重新准备', 410);
    this.mobile.promote(next.active.videoId);
    delete parent.nextClient; this.claim(next.active, clientId); return this.public(next.active);
  }
  release(token, client) {
    this.tokens.get(token)?.job?.leases.delete(client);
    const session = this.sessions.get(client);
    if (session?.anchor === token || session?.active?.token === token) {
      this.releaseNext(client);
      session.controller?.abort(); session.active?.job?.leases.delete(client); this.mobile.cancelUnleased(session.active?.job); this.sessions.delete(client);
    }
  }
  async seek({ session: anchor, clientId, sequence, position }) {
    const session = this.sessions.get(clientId);
    if (!validClient(clientId) || !session || session.anchor !== anchor || session.expiresAt <= Date.now()) throw new AppError('SESSION_EXPIRED', '播放会话已失效，请重新选集', 410);
    if (!Number.isSafeInteger(sequence) || sequence <= session.sequence) throw superseded();
    const target = seekPosition(position, session.base.expectedDuration || session.base.duration);
    session.sequence = sequence; session.controller?.abort(); const controller = new AbortController(); session.controller = controller;
    const started = performance.now();
    try {
      if (!session.base.job) return { ...this.public(session.base, { position: target.position, session: session.anchor }), seekMs: 0, sequence, cached: true };
      let job = await this.mobile.covering(session.base.videoId, target.position);
      const cached = !!job;
      if (controller.signal.aborted || session.sequence !== sequence) throw superseded();
      if (!job) {
        session.active?.job?.leases.delete(clientId); this.mobile.cancelUnleased(session.active?.job);
        job = await this.mobile.prepare(session.base.videoId, { offset: target.offset, signal: controller.signal, priority: true, requestKey: `${clientId}:${sequence}` });
      }
      if (controller.signal.aborted || session.sequence !== sequence) { this.mobile.cancelUnleased(job); throw superseded(); }
      let entry = [...this.tokens.values()].find(value => value.job === job);
      if (!entry) {
        entry = { ...session.base, job, file: undefined, size: undefined, token: randomBytes(24).toString('hex'),
          width: job.width, height: job.height, video: job.video, audio: job.audio, duration: session.base.expectedDuration || session.base.duration,
          checkedAt: new Date().toISOString(), verification: 'not_checked', expiresAt: job.expiresAt };
        this.tokens.set(entry.token, entry);
      }
      const previous = session.active; session.active = entry; this.claim(entry, clientId);
      if (previous?.job !== job) this.mobile.cancelUnleased(previous?.job);
      for (const [token, value] of this.tokens) if (value.expiresAt < Date.now() || (value.job && !this.mobile.available(value.job))) this.tokens.delete(token);
      return { ...this.public(entry, { position: target.position, session: session.anchor }), seekMs: Math.round(performance.now() - started), sequence,
        cached, inputBytesAtFirstSegment: job.timing.inputBytesAtFirstSegment, maxInputRangeStart: job.timing.maxInputRangeStart,
        availableThrough: Math.min(entry.duration, job.offset + job.availableDuration) };
    } catch (error) { if (controller.signal.aborted || session.sequence !== sequence) throw superseded(); throw error; }
  }
  async byToken(token, { localMedia = false } = {}) {
    const old = this.tokens.get(token);
    if (!old) throw new AppError('SESSION_EXPIRED', '播放会话已失效，请重新选集', 410);
    if (old.job?.error) throw old.job.error;
    if (old.job && this.mobile.available(old.job) && (localMedia || old.expiresAt > Date.now() + 30000)) return old;
    if (old.job || localMedia) throw new AppError('SESSION_EXPIRED', '媒体会话已过期，请重新选集', 410);
    if (old.expiresAt > Date.now() + 30000) return old;
    const fresh = await this.resolve(old.seriesId, old.number, { refresh: true });
    if (fresh.size !== old.size || Math.abs(fresh.duration - old.duration) > 0.1) throw new AppError('MEDIA_CHANGED', '官网片源已变化，请重新加载此集', 409);
    return fresh;
  }
  renewLocalMedia(entry) { entry.expiresAt = this.mobile.renew(entry.job); }
  async verify(seriesId, number, { requireApp = false, minimumSide = 0 } = {}) {
    const entry = await this.resolve(seriesId, number, { refresh: true });
    if (requireApp && entry.provider !== 'official_app') throw new AppError('APP_HD_UNAVAILABLE', `尚未恢复官方 App 高清来源（${entry.appIssue || 'APP_UNAVAILABLE'}）`);
    if (minimumSide > 0 && !(Math.min(entry.width, entry.height) >= minimumSide)) throw new AppError('HD_RESOLUTION_REQUIRED', '本次媒体分辨率未达到高清核验要求');
    if (entry.job) {
      const job = await entry.job.done;
      Object.assign(entry, { file: job.file, size: job.size, duration: job.duration, video: job.video, audio: job.audio });
    }
    if (!entry.expectedDuration) entry.expectedDuration = await this.browser.describe(entry.seriesId, entry.videoId);
    const verification = await decodeMedia(entry.file || entry.url, entry, entry.expectedDuration, { local: !!entry.file });
    entry.verification = verification.classification;
    return { ...this.public(entry), duration: entry.duration, media: '/media/' + entry.token, format: 'mp4',
      timing: entry.job?.timing, videoId: entry.videoId, video: entry.video, audio: entry.audio, expectedDuration: entry.expectedDuration, decodedSeconds: verification.decodedSeconds, finished: verification.finished, errors: verification.errors, identityVerified: entry.identityVerified };
  }
  clear() { for (const session of this.sessions.values()) session.controller?.abort(); this.sessions.clear(); this.entries.clear(); this.tokens.clear(); }
  close() { this.clear(); return this.mobile.close(); }
}
