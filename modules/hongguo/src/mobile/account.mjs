import path from 'node:path';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { CookieJar } from 'tough-cookie';
import { AppError, boundedText, ORIGIN, USER_AGENT } from '../common.mjs';
import { MobileSession } from './session.mjs';
import { seriesCard } from './catalog.mjs';

const APP = 'https://reading.snssdk.com';
const cover = value => typeof value === 'string' ? value.replace(/^http:/, 'https:') : '';
const time = value => { const n = Math.max(0, Math.floor(value)); return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`; };
export function personalCard(kind, row) {
  let card, episode, position = 0, videoId;
  if (kind === 'favorites') {
    card = seriesCard({ ...row.video_data, title: row.series_title, cover: cover(row.series_cover_url || row.video_data?.cover), video_desc: row.series_intro, category_schema: row.category_schema });
  } else if (kind === 'likes') {
    const video = row.video_data, detail = video?.video_detail;
    if (!video) return null;
    card = seriesCard({ ...video, title: detail?.series_title || video.title, cover: cover(detail?.series_cover || video.cover), category_schema: detail?.category_schema });
    episode = Number(video.vid_index); videoId = String(video.vid || '');
  } else {
    if (row.is_delete) return null;
    card = seriesCard({ series_id: row.book_id_str || row.book_id, title: row.book_name, cover: cover(row.thumb_url), episode_cnt: row.episode_cnt });
    episode = Number(row.vid_index); position = Math.max(0, Number(row.current_play_position) / 1000 || 0); videoId = String(row.vid || '');
  }
  if (!card) return null;
  const validEpisode = Number.isSafeInteger(episode) && episode >= 1 && episode <= card.total;
  return { ...card, recordKind: kind, key: kind === 'likes' ? `${card.id}:${videoId}` : card.id,
    ...(kind === 'history' ? { updatedAt: Math.max(Number(row.read_timestamp_ms) || 0, Number(row.update_timestamp_ms) || 0) } : {}),
    ...(validEpisode ? { episode, videoId, position, progressLabel: kind === 'history' ? `看到第 ${episode} 集 · ${time(position)}` : `喜欢 · 第 ${episode} 集` } : {}) };
}

const WEB_AID = '513755';
export class Account {
  constructor(root, mobile, { fetcher = fetch } = {}) { this.root = root; this.mobile = mobile; this.fetcher = fetcher; this.file = path.join(root, '.runtime', 'account-session.json'); this.jar = new CookieJar(); this.pages = new Map(); this.revision = 0; this.epoch = randomUUID(); }
  async ready() {
    if (!this.loading) this.loading = (async () => {
      try { const saved = JSON.parse(await readFile(this.file, 'utf8')); this.jar = await CookieJar.deserialize(saved.cookies); this.appUserId = saved.appUserId; }
      catch (e) { if (e.code !== 'ENOENT') throw new AppError('ACCOUNT_STORE_INVALID', '账号会话文件暂不可用'); }
    })();
    return this.loading;
  }
  save() {
    const job = (this.saving || Promise.resolve()).catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = this.file + '.' + randomUUID() + '.tmp';
      await writeFile(tmp, JSON.stringify({ version: 1, cookies: await this.jar.serialize(), appUserId: this.appUserId }), { mode: 0o600 }); await rename(tmp, this.file);
    });
    this.saving = job; return job;
  }
  async request(route, params = {}, jar = this.jar, { allowDocument = false } = {}) {
    const url = new URL(route, ORIGIN);
    if (url.origin !== ORIGIN) throw new AppError('ACCOUNT_REDIRECT_REJECTED', '登录跳转不属于官方账号服务');
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await this.fetcher(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT, referer: ORIGIN + '/', cookie: await jar.getCookieString(url.href) }, redirect: 'manual', signal: AbortSignal.timeout(20000) });
    for (const cookie of response.headers.getSetCookie()) await jar.setCookie(cookie, url.href, { ignoreError: true });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); return { redirect: response.headers.get('location') }; }
    if (!response.ok) { await response.body?.cancel(); throw new AppError('ACCOUNT_UNAVAILABLE', '官方账号服务暂不可用'); }
    const text = await boundedText(response, 1_000_000);
    try { return JSON.parse(text); } catch { if (allowDocument && response.headers.get('content-type')?.includes('text/html')) return { document: true }; throw new AppError('ACCOUNT_RESPONSE_INVALID', '官方账号响应暂不可用'); }
  }
  async status({ refresh = false } = {}) {
    await this.ready();
    if (!refresh && this.cached?.expires > Date.now()) return this.cached.value;
    if (this.statusPending) return this.statusPending;
    const job = this.fetchStatus(this.revision); this.statusPending = job;
    try { return await job; } finally { if (this.statusPending === job) this.statusPending = null; }
  }
  checkRevision(revision) { if (revision !== this.revision) throw new AppError('ACCOUNT_CHANGED', '账号已切换，请重新打开列表', 409); }
  async fetchStatus(revision) {
    const result = await this.request('/passport/account/info/v2/', { aid: WEB_AID });
    this.checkRevision(revision);
    const data = result.data;
    if (result.message !== 'success' || !data || data.error_code || data.is_visitor_account) {
      this.profile = null; this.linked = null; this.appVerified = false; this.pages.clear(); const value = { connected: false }; this.cached = { value, expires: Date.now() + 15000 }; return value;
    }
    this.profile = { userId: data.user_id_str };
    await this.connectApp();
    this.checkRevision(revision);
    const value = { connected: true, name: this.appName, appConnected: this.appVerified, accountEpoch: this.epoch };
    this.cached = { value, expires: Date.now() + 30000 }; return value;
  }
  async start() {
    await this.ready();
    const jar = new CookieJar();
    const result = await this.request('/passport/web/get_qrcode/', { aid: WEB_AID, next: ORIGIN + '/' }, jar);
    const d = result.data;
    if (result.message !== 'success' || d?.error_code || !d?.token || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(d.qrcode || '')) throw new AppError('QR_UNAVAILABLE', '官方登录二维码暂不可用');
    this.pending = { id: randomUUID(), jar, token: d.token, expires: Number(d.expire_time) * 1000, lastPoll: 0, state: 'new' };
    return { id: this.pending.id, image: d.qrcode, expiresAt: this.pending.expires };
  }
  async poll(id) {
    const p = this.pending;
    if (!p || p.id !== id) throw new AppError('QR_EXPIRED', '请刷新登录二维码', 410);
    if (p.expires < Date.now()) return { state: 'expired' };
    if (Date.now() - p.lastPoll < 1800) return { state: p.state };
    p.lastPoll = Date.now();
    const result = await this.request('/passport/web/check_qrconnect/', { aid: WEB_AID, next: ORIGIN + '/', token: p.token }, p.jar);
    const d = result.data;
    if (this.pending !== p) throw new AppError('QR_EXPIRED', '登录二维码已刷新', 410);
    if (result.message !== 'success' || d?.error_code) throw new AppError('QR_CHECK_FAILED', '登录确认暂未完成，请稍后重试');
    p.state = d.status;
    if (d.status === 'confirmed') {
      if (d.redirect_url) {
        let destination = new URL(d.redirect_url, ORIGIN);
        for (let i = 0; i < 4; i++) {
          const reply = await this.request(destination.href, {}, p.jar, { allowDocument: true });
          if (!reply.redirect) break;
          destination = new URL(reply.redirect, destination);
          if (destination.origin === ORIGIN && destination.pathname === '/') break;
        }
      }
      if (this.pending !== p) throw new AppError('QR_EXPIRED', '本次登录已取消', 410);
      this.revision++; this.epoch = randomUUID(); this.statusPending = null; this.jar = p.jar; this.cached = null; this.linked = null; this.appUserId = null; this.appVerified = false; this.pages.clear(); await this.save(); this.pending = null;
      const status = await this.status({ refresh: true });
      return { state: status.connected ? 'confirmed' : 'unconfirmed', ...status };
    }
    return { state: ['new', 'scanned', 'expired', 'canceled'].includes(d.status) ? d.status : 'new' };
  }
  async linkedSession() {
    if (!(await this.status()).connected) throw new AppError('ACCOUNT_REQUIRED', '请先登录账号', 401);
    return this.connectApp();
  }
  async connectApp() {
    if (this.linked) return this.linked;
    const revision = this.revision;
    await this.mobile.ready();
    const session = new MobileSession(this.root, { readOnly: true }); await session.ready();
    const cookies = await this.jar.getCookies(ORIGIN);
    const names = new Set(['sessionid', 'sessionid_ss', 'sid_guard', 'sid_tt', 'uid_tt', 'uid_tt_ss']);
    for (const cookie of cookies.filter(x => names.has(x.key))) await session.jar.setCookie(`${cookie.key}=${cookie.value}; Path=/; Secure; HttpOnly`, 'https://reading.snssdk.com');
    const info = await session.signedGet(APP + '/reading/user/info/v');
    this.checkRevision(revision);
    const uid = info.data?.user_id;
    // App user identifiers are opaque strings (not the website's numeric uid).
    if (info.code !== 0 || typeof uid !== 'string' || !/^[\x21-\x7e]{8,256}$/.test(uid)) throw new AppError('APP_ACCOUNT_REQUIRED', '当前登录尚未获得 App 账号身份，请重新登录', 401);
    if (this.appUserId && this.appUserId !== uid) throw new AppError('ACCOUNT_CHANGED', '账号身份已变化，请退出后重新登录', 401);
    this.appUserId = uid; this.appName = String(info.data.user_name || '已登录账号'); this.appVerified = true;
    this.linked = session; await this.save(); return session;
  }
  async list(kind, cursor = '') {
    if (!['favorites', 'likes', 'history'].includes(kind)) throw new AppError('INVALID_LIST', '个人列表类型无效', 400);
    const session = await this.linkedSession();
    const revision = this.revision;
    for (const [key, page] of this.pages) if (page.expires < Date.now()) this.pages.delete(key);
    let state = { offset: 0, items: [], hasMore: true };
    if (cursor) {
      const page = this.pages.get(cursor);
      if (!page || page.kind !== kind || page.userId !== this.appUserId) throw new AppError('PAGE_EXPIRED', '这一页已过期，请刷新个人列表', 409);
      state = page.state;
    }
    // Upstream collections and history may return a full snapshot or a batch of
    // 500 regardless of count. Retain the remaining metadata for UI paging.
    let items = [...state.items], offset = state.offset, hasMore = state.hasMore;
    let total = state.total;
    if (items.length < 18 && hasMore) {
      let result, rows;
      if (kind === 'favorites') {
        result = await session.signedGet(APP + '/reading/bookapi/bookshelf/video/info/v', { offset: 0, count: 18 });
        rows = result.data?.video_shelf_info; hasMore = false; total = rows?.length;
        if (Array.isArray(rows)) rows = [...rows].sort((a, b) => Number(b.collect_time || b.modify_time) - Number(a.collect_time || a.modify_time));
      } else if (kind === 'likes') {
        result = await session.signedGet(APP + '/reading/ugc/action/mget/v', { object_type_list: '6,15', action_type: 3, count: 30, offset });
        rows = result.data?.mixed_data_list; hasMore = !!result.data?.has_more; offset = Number(result.data?.next_offset);
      } else {
        result = await session.signedGet(APP + '/reading/bookapi/read_history/list/v', { book_type: 2, offset, limit: 30, full_field: true, is_first_load: offset === 0 });
        rows = result.data?.data_list; hasMore = !!result.data?.has_more; offset = Number(result.data?.next_offset); total = Number(result.data?.total);
      }
      if (result.code !== 0) throw new AppError('ACCOUNT_LIST_REJECTED', '官方暂未返回此账号列表，请刷新登录状态', 401);
      this.checkRevision(revision);
      if (rows !== null && !Array.isArray(rows)) throw new AppError('ACCOUNT_LIST_CHANGED', '官方个人列表结构已变化');
      if (hasMore && (!Number.isSafeInteger(offset) || offset <= state.offset)) throw new AppError('APP_PAGE_STALLED', '官方个人列表分页没有前进');
      items.push(...(rows || []).map(row => personalCard(kind, row)).filter(Boolean));
    }
    const visible = items.slice(0, 18); items = items.slice(18);
    let next = null;
    if (items.length || hasMore) {
      while (this.pages.size >= 160) this.pages.delete(this.pages.keys().next().value);
      next = randomUUID(); this.pages.set(next, { kind, userId: this.appUserId, expires: Date.now() + 15 * 60000, state: { items, offset, hasMore, total } });
    }
    return { items: visible, cursor: next, hasMore: !!next, total, filters: [], provider: 'official_app', accountSource: '红果账号云端 · 短剧', readOnly: true };
  }
  async disconnect() {
    await this.ready(); this.revision++; this.epoch = randomUUID(); this.statusPending = null; this.pending = null; this.profile = null; this.linked = null; this.appUserId = null; this.appVerified = false; this.cached = null; this.pages.clear(); this.jar = new CookieJar(); await this.save();
    return { connected: false };
  }
}
