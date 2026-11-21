import { AppError, id } from '../common.mjs';

const kinds = new Set(['favorites', 'likes', 'history']);
const clock = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds) % 60).padStart(2, '0')}`;
export function newerHistory(previous, incoming) {
  if (!previous) return incoming;
  if (!incoming) return null;
  return previous.updatedAt > incoming.updatedAt ? { ...incoming, ...previous } : incoming;
}

export class AccountSync {
  constructor(account, actions, catalog) {
    this.account = account; this.actions = actions; this.catalog = catalog;
    this.cache = new Map(); this.pending = new Map(); this.history = new Map(); this.lookedUp = new Map(); this.epoch = null;
  }
  check(epoch) {
    if (epoch !== this.account.epoch) throw new AppError('ACCOUNT_CHANGED', '账号已变化，请重新读取', 409);
    if (this.epoch !== epoch) { this.epoch = epoch; this.cache.clear(); this.pending.clear(); this.history.clear(); this.lookedUp.clear(); }
  }
  observe(item, epoch) {
    if (item.recordKind !== 'history' || !item.episode || !Number.isFinite(item.position)) return item;
    const key = epoch + ':' + item.id, own = this.actions.recentProgress.get(key);
    // Prefer the newest observed cloud timestamp, including acknowledged local
    // writes while official read replicas catch up. Position itself is not a clock.
    let result = newerHistory(this.history.get(item.id), item);
    if (own && own.updatedAt >= result.updatedAt) result = { ...result, ...own };
    result = { ...result, progressLabel: `看到第 ${result.episode} 集 · ${clock(result.position)}` };
    if (!own || result.updatedAt > own.updatedAt) this.actions.remoteProgress.set(key, result.updatedAt);
    while (this.actions.remoteProgress.size > 1000) this.actions.remoteProgress.delete(this.actions.remoteProgress.keys().next().value);
    this.history.set(item.id, result);
    while (this.history.size > 10000) this.history.delete(this.history.keys().next().value);
    return result;
  }
  async window(kind, count, epoch, fresh = false) {
    this.check(epoch);
    const key = `${epoch}:${this.actions.version}:${kind}:${count}`;
    const cached = this.cache.get(key);
    if (!fresh && cached?.expires > Date.now()) return cached.value;
    if (!fresh && this.pending.has(key)) return this.pending.get(key);
    const task = (async () => {
      let page, cursor = '', items = [], pages = 0;
      do {
        if (++pages > 600) throw new AppError('ACCOUNT_PAGE_LIMIT', '账号分页暂未结束，请稍后重试');
        page = await this.account.list(kind, cursor); this.check(epoch);
        items.push(...page.items.map(item => this.observe(item, epoch))); cursor = page.cursor;
      } while (cursor && items.length < count);
      items = [...new Map(items.map(item => [item.key || item.id, item])).values()];
      if (kind === 'history') items.sort((a, b) => b.updatedAt - a.updatedAt);
      const value = { ...page, items, cursor, hasMore: !!cursor };
      this.cache.set(key, { value, expires: Date.now() + 3000 });
      while (this.cache.size > 50) this.cache.delete(this.cache.keys().next().value);
      return value;
    })();
    this.pending.set(key, task);
    try { return await task; } finally { if (this.pending.get(key) === task) this.pending.delete(key); }
  }
  async historyFor(seriesId, epoch, { fresh = false, first } = {}) {
    first ||= await this.window('history', 18, epoch, fresh);
    let found = first.items.find(x => x.id === seriesId);
    const lookedUp = this.lookedUp.get(seriesId);
    // 历史按最近观看排序：这部剧在别处有新进度会回到第一页，所以翻过一遍后半小时内不必再翻整个历史
    if (!found && !fresh && lookedUp > Date.now() - 1800000) return this.history.get(seriesId) || null;
    let cursor = first.cursor, scanned = first.items.length, pages = 0;
    while (!found && cursor) {
      if (scanned >= 10000 || ++pages > 600) throw new AppError('HISTORY_LOOKUP_LIMIT', '历史记录较多，尚未确认这部剧的最新进度');
      const page = await this.account.list('history', cursor); this.check(epoch);
      const rows = page.items.map(item => this.observe(item, epoch));
      found = rows.find(x => x.id === seriesId); cursor = page.cursor; scanned += page.items.length;
    }
    this.lookedUp.set(seriesId, Date.now());
    while (this.lookedUp.size > 1000) this.lookedUp.delete(this.lookedUp.keys().next().value);
    if (!found) this.history.delete(seriesId);
    return found || null;
  }
  async validResume(seriesId, item) {
    if (!item) return null;
    const detail = await this.catalog.detail(seriesId);
    if (!item.episode || detail.episodes[item.episode - 1]?.id !== item.videoId || !Number.isFinite(item.position) || item.position < 0) throw new AppError('HISTORY_EPISODE_MISMATCH', '云端进度暂未匹配到正确分集，请稍后重试');
    return { id: seriesId, episode: item.episode, videoId: item.videoId, position: item.position, updatedAt: item.updatedAt, recordKind: 'history' };
  }
  async pull({ view = '', count = '18', seriesId = '' } = {}) {
    if (view && !kinds.has(view)) throw new AppError('INVALID_LIST', '账号列表类型无效', 400);
    count = Number(count);
    if (!Number.isSafeInteger(count) || count < 1 || count > 10000) throw new AppError('INVALID_COUNT', '同步范围无效', 400);
    if (seriesId) id(seriesId);
    const status = await this.account.status();
    const epoch = this.account.epoch; this.check(epoch);
    if (!status.connected) return { connected: false, pollAfterMs: 30000 };
    const [list, actions, first] = await Promise.all([
      view ? this.window(view, count, epoch) : null,
      seriesId ? this.actions.state(seriesId, { fresh: true }) : null,
      seriesId && view !== 'history' ? this.window('history', 18, epoch) : null,
    ]);
    const resume = seriesId ? await this.validResume(seriesId, await this.historyFor(seriesId, epoch, { first: view === 'history' ? list : first })) : null;
    this.check(epoch);
    return { connected: true, name: status.name, accountEpoch: epoch, list, actions: actions ? { ...actions, resume } : null, checkedAt: new Date().toISOString(), pollAfterMs: 60000 };
  }
  async resume(seriesId, epoch) {
    id(seriesId); this.actions.check(epoch);
    await this.account.linkedSession(); this.check(epoch);
    const item = await this.historyFor(seriesId, epoch, { fresh: true });
    const resume = await this.validResume(seriesId, item); this.check(epoch);
    return { connected: true, accountEpoch: epoch, resume, checkedAt: new Date().toISOString() };
  }
}
