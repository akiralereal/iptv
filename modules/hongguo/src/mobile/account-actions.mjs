import { AppError, id, episodeNumber } from '../common.mjs';

const APP = 'https://reading.snssdk.com';
export function exactJSON(value) {
  return JSON.stringify(value, (_, item) => typeof item === 'bigint' ? JSON.rawJSON(item.toString()) : item);
}
function accepted(result) {
  if (result?.code !== 0) throw new AppError('ACCOUNT_WRITE_REJECTED', '官方账号未接受本次更新，请刷新账号后重试', 502);
  return result;
}
export function historyUpdate(entry, position, observedAt) {
  const duration = entry.expectedDuration || entry.duration;
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(position) || position < 0 || position > duration + 0.5) throw new AppError('INVALID_PROGRESS', '观看进度超出当前集时长', 400);
  return { book_id: BigInt(id(entry.seriesId)), book_id_str: entry.seriesId, book_type: 2, is_delete: false,
    read_timestamp_ms: observedAt, update_timestamp_ms: observedAt, genre_type: 130,
    current_play_position: Math.round(Math.min(position, duration) * 1000), vid_index: entry.number, vid: BigInt(id(entry.videoId)) };
}

export class AccountActions {
  constructor(account, catalog, playback) {
    this.account = account; this.catalog = catalog; this.playback = playback;
    this.tail = Promise.resolve(); this.snapshots = new Map(); this.sequences = new Map(); this.latestProgress = new Map();
    this.version = 0; this.recentProgress = new Map(); this.remoteProgress = new Map();
  }
  check(epoch) {
    if (typeof epoch !== 'string' || epoch !== this.account.epoch) throw new AppError('ACCOUNT_CHANGED', '账号状态已变化，请刷新页面后重试', 409);
  }
  async context(epoch) { this.check(epoch); const session = await this.account.linkedSession(); this.check(epoch); return session; }
  enqueue(epoch, operation) {
    this.check(epoch);
    const job = this.tail.catch(() => {}).then(async () => { const session = await this.context(epoch); const result = await operation(session); this.check(epoch); return result; });
    this.tail = job.catch(() => {}); return job;
  }
  invalidate(kind) {
    this.snapshots.delete(kind);
    // Existing history pages remain stable while playback submits progress.
    if (kind !== 'history') for (const [key, value] of this.account.pages) if (value.kind === kind) this.account.pages.delete(key);
  }
  async snapshot(kind, session, epoch, fresh = false) {
    const cached = this.snapshots.get(kind);
    if (!fresh && cached?.epoch === epoch && cached.expires > Date.now()) return cached.value;
    const value = new Set();
    if (kind === 'favorites') {
      const result = accepted(await session.signedGet(APP + '/reading/bookapi/bookshelf/video/info/v'));
      const rows = result.data?.video_shelf_info;
      if (rows !== null && !Array.isArray(rows)) throw new AppError('ACCOUNT_LIST_CHANGED', '收藏状态暂不可用');
      for (const row of rows || []) if (row.video_data?.series_id) value.add(String(row.video_data.series_id));
    } else {
      let offset = 0, more = true;
      for (let page = 0; more; page++) {
        if (page >= 100) throw new AppError('ACCOUNT_LIST_LIMIT', '喜欢记录较多，暂时无法确认完整状态');
        const result = accepted(await session.signedGet(APP + '/reading/ugc/action/mget/v', { object_type_list: '6,15', action_type: 3, count: 100, offset }));
        const rows = result.data?.mixed_data_list;
        if (rows !== null && !Array.isArray(rows)) throw new AppError('ACCOUNT_LIST_CHANGED', '喜欢状态暂不可用');
        for (const row of rows || []) if (row.video_data?.vid) value.add(String(row.video_data.vid));
        more = !!result.data?.has_more;
        if (more) { const next = Number(result.data.next_offset); if (!Number.isSafeInteger(next) || next <= offset) throw new AppError('APP_PAGE_STALLED', '喜欢列表分页没有前进'); offset = next; }
        this.check(epoch);
      }
    }
    this.check(epoch); this.snapshots.set(kind, { epoch, expires: Date.now() + 15000, value }); return value;
  }
  async state(seriesId, { fresh = false } = {}) {
    id(seriesId); const status = await this.account.status();
    if (!status.connected) return { connected: false };
    const epoch = this.account.epoch, session = await this.context(epoch);
    const [detail, favorites, likes] = await Promise.all([this.catalog.detail(seriesId), this.snapshot('favorites', session, epoch, fresh), this.snapshot('likes', session, epoch, fresh)]);
    this.check(epoch);
    return { connected: true, accountEpoch: epoch, seriesId, favorite: favorites.has(seriesId), likedEpisodes: detail.episodes.filter(x => likes.has(x.id)).map(x => x.number) };
  }
  async post(session, route, data, epoch) {
    const parameters = await session.parameters(); this.check(epoch);
    this.version++;
    const result = accepted(await session.signedPost(APP + route, parameters, Buffer.from(exactJSON(data))));
    this.version++;
    this.check(epoch); return result;
  }
  set({ kind, seriesId, number, selected, accountEpoch }) {
    id(seriesId);
    if (!['favorites', 'likes'].includes(kind) || typeof selected !== 'boolean') throw new AppError('INVALID_ACTION', '账号操作参数无效', 400);
    return this.enqueue(accountEpoch, async session => {
      const detail = await this.catalog.detail(seriesId);
      const videoId = kind === 'likes' ? detail.episodes[episodeNumber(number, detail.total) - 1].id : null;
      if (kind === 'favorites') await this.post(session, '/reading/bookapi/bookshelf/video/update/v', { update_bookshelf_video_list: [{ book_id: seriesId, modify_time: Date.now(), video_shelf_operate_type: selected ? 0 : 1, book_type: 2 }] }, accountEpoch);
      else await this.post(session, '/reading/ugc/action/set/v', { object_id: videoId, object_type: 6, action_type: selected ? 3 : 4, book_id: seriesId }, accountEpoch);
      this.invalidate(kind);
      let confirmed = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await new Promise(resolve => setTimeout(resolve, 400 * attempt));
        const values = await this.snapshot(kind, session, accountEpoch, true);
        if (values.has(videoId || seriesId) === selected) { confirmed = true; break; }
      }
      if (!confirmed) throw new AppError('ACCOUNT_WRITE_PENDING', '更新已提交，官方列表仍在刷新，请稍后刷新状态', 409);
      return { kind, seriesId, number: videoId ? number : undefined, selected, verified: true };
    });
  }
  progress({ accountEpoch, token, clientId, sequence, position, observedAt }) {
    this.check(accountEpoch);
    const entry = this.playback.tokens.get(token);
    if (!entry || entry.expiresAt <= Date.now()) throw new AppError('INVALID_PROGRESS_SESSION', '播放会话已过期，无法同步进度', 409);
    if (typeof clientId !== 'string' || !/^[a-f0-9-]{36}$/.test(clientId) || !Number.isSafeInteger(sequence) || sequence < 1) throw new AppError('INVALID_PROGRESS', '进度请求无效', 400);
    if (!Number.isSafeInteger(observedAt) || observedAt < Date.now() - 120000 || observedAt > Date.now() + 5000) throw new AppError('PROGRESS_EXPIRED', '观看进度已过期，请重新播放后同步', 409);
    const row = historyUpdate(entry, position, observedAt);
    const key = accountEpoch + ':' + clientId;
    if ((this.sequences.get(key) || 0) >= sequence) return Promise.resolve({ superseded: true });
    this.sequences.set(key, sequence);
    while (this.sequences.size > 500) this.sequences.delete(this.sequences.keys().next().value);
    return this.enqueue(accountEpoch, async session => {
      const progressKey = accountEpoch + ':' + entry.seriesId;
      if ((this.remoteProgress.get(progressKey) || 0) > observedAt) return { superseded: true, remote: true };
      if (this.sequences.get(key) !== sequence || (this.latestProgress.get(progressKey) || 0) > observedAt) return { superseded: true };
      const response = await this.post(session, '/reading/bookapi/read_history/update/v', { update_datas: [row] }, accountEpoch);
      if (!Array.isArray(response.data?.update_fail_datas) || response.data.update_fail_datas.length) throw new AppError('PROGRESS_REJECTED', '官方未保存本次观看进度，请稍后重试', 502);
      this.latestProgress.set(progressKey, observedAt);
      this.recentProgress.set(progressKey, { id: entry.seriesId, episode: entry.number, videoId: entry.videoId, position: row.current_play_position / 1000, updatedAt: observedAt, clientId });
      while (this.recentProgress.size > 500) this.recentProgress.delete(this.recentProgress.keys().next().value);
      while (this.latestProgress.size > 500) this.latestProgress.delete(this.latestProgress.keys().next().value);
      return { submitted: true, position: row.current_play_position / 1000, number: entry.number, observedAt, submittedAt: new Date().toISOString() };
    });
  }
}
