const $ = id => document.getElementById(id);
const filePreview = location.protocol === 'file:';
const moduleUrl = path => new URL(path.replace(/^\//, ''), document.baseURI);
function newClientId() {
  // getRandomValues is available on HTTP when IPTV is opened on a LAN.
  return Array.from(crypto.getRandomValues(new Uint8Array(18)), byte => byte.toString(16).padStart(2, '0')).join('');
}
function postOnLeave(path, data) {
  fetch(moduleUrl(path), {
    method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
  }).catch(() => {});
}
const state = { home: null, detail: null, current: 0, range: 0, searchGeneration: 0, detailGeneration: 0, playGeneration: 0, hls: null, statusTimer: null, request: null, lease: null, clientId: newClientId(), session: null, offset: 0, total: 0, streamGeneration: 0, seekSequence: 0, seekRequest: null, scrubbing: false, seeking: false, processing: false, frameCallback: null, warm: null, adopting: null, preloadTimer: null, preloadRetryAt: 0, automaticTransitions: 0 };
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
async function api(path, data, signal) {
  let res;
  try {
    res = await fetch(moduleUrl(path), { signal, ...(data === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }) });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('无法连接 IPTV 服务，请确认服务正在运行后刷新页面。');
  }
  let body;
  try {
    body = await res.json();
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('当前地址的 IPTV 服务未能返回红果数据，请从已更新的 IPTV 管理后台重新进入「红果短剧」。');
  }
  if (!res.ok) throw Object.assign(new Error(body?.error || '请求暂未完成'), { code: body?.code, retryAfterSeconds: body?.retryAfterSeconds });
  return body;
}
function notice(text = '') { $('notice').textContent = text; $('notice').hidden = !text; }
const library = { view: 'catalog', category: '0', contentType: '', query: '', filters: [], cursor: null, items: [], generation: 0, loading: false, controller: null };
const accountView = { resume: null, epoch: null, loaded: false, busy: false, generation: 0, favorite: false, likedEpisodes: [] };
const progressSync = { sequence: 0, lastSent: 0, lastPosition: null, lastClient: null, lastObservedAt: 0, pending: new Map(), running: false };
try { $('sync-progress').checked = localStorage.getItem('iptv-hongguo-progress-sync') !== 'false'; } catch {}
const incomingSync = { timer: null, running: false, again: false, failures: 0, lastStarted: 0 };
const personalView = view => ['favorites', 'likes', 'history'].includes(view);
function paintResume() {
  const resume = accountView.resume;
  $('resume-play').hidden = !resume;
  if (resume) $('resume-play').textContent = `继续观看 · 第 ${resume.episode} 集 · ${clock(resume.position)}`;
}
function paintConnection({ connected, name }) {
  const status = $('connection');
  status.textContent = connected ? name || '已登录账号' : '未登录红果';
  status.classList.toggle('connected', connected);
  $('login').textContent = connected ? '账号' : '登录账号';
}
function applyCloudIdentity(result) {
  const epoch = result.connected ? result.accountEpoch : null;
  if (accountView.epoch !== epoch) {
    accountView.epoch = epoch; accountView.loaded = false; accountView.favorite = false; accountView.likedEpisodes = []; accountView.resume = null;
    progressSync.pending.clear(); state.remoteProgressPending = !!state.session;
    if (personalView(library.view)) { library.items = []; library.cursor = null; cards([]); $('load-more').hidden = true; }
    paintAccountActions(); paintResume();
  }
  paintConnection(result);
}
function scheduleAccountPull(delay = 20000) {
  clearTimeout(incomingSync.timer);
  if (!document.hidden && navigator.onLine) incomingSync.timer = setTimeout(() => pullAccount(), delay);
}
async function pullAccount(force = false) {
  clearTimeout(incomingSync.timer);
  if (document.hidden || !navigator.onLine) return;
  if (incomingSync.running) { incomingSync.again ||= force; return; }
  if (accountView.busy || state.resumeLookup) { scheduleAccountPull(2000); return; }
  incomingSync.running = true; incomingSync.lastStarted = Date.now();
  const view = personalView(library.view) ? library.view : '', seriesId = !$('viewer').hidden ? state.detail?.id || '' : '';
  const libraryGeneration = library.generation, detailGeneration = state.detailGeneration, actionGeneration = accountView.generation;
  let delay = 20000;
  try {
    const result = await api('/api/account/sync?' + new URLSearchParams({ view, count: String(Math.max(18, library.items.length)), seriesId }));
    if (actionGeneration !== accountView.generation || accountView.busy) { incomingSync.again = true; return; }
    applyCloudIdentity(result);
    if (!result.connected) { $('cloud-status').textContent = '登录后自动同步账号数据'; delay = 30000; return; }
    if (result.list && libraryGeneration === library.generation && !library.loading && library.view === view) {
      const changed = JSON.stringify(library.items) !== JSON.stringify(result.list.items);
      library.items = result.list.items; library.cursor = result.list.cursor;
      if (changed) cards(library.items, true);
      $('catalog-meta').textContent = `${result.list.accountSource} · 已展示 ${library.items.length} 条`;
      $('load-more').hidden = !result.list.hasMore; $('load-more-status').textContent = result.list.hasMore ? '' : '已加载全部结果';
    }
    if (result.actions && detailGeneration === state.detailGeneration && state.detail?.id === seriesId) {
      accountView.favorite = result.actions.favorite; accountView.likedEpisodes = result.actions.likedEpisodes; accountView.loaded = true;
      const resume = result.actions.resume;
      const localTime = progressSync.lastClient === state.clientId ? progressSync.lastObservedAt : 0;
      if (resume && state.session && resume.updatedAt > Math.max(state.cloudSeenAt || 0, state.playbackStartedAt || 0, localTime) && (resume.episode !== state.current || Math.abs(resume.position - state.offset - $('video').currentTime) > 2)) {
        state.remoteProgressPending = true; progressSync.pending.clear();
        $('progress-status').textContent = '其他设备更新了进度。点击继续观看使用云端进度，或点击播放继续当前画面。';
      }
      state.cloudSeenAt = Math.max(state.cloudSeenAt || 0, resume?.updatedAt || 0);
      accountView.resume = resume; paintResume(); paintAccountActions();
      $('account-action-status').textContent = '收藏与喜欢会自动同步手机端变化。';
    }
    incomingSync.failures = 0; delay = result.pollAfterMs || 20000;
    $('cloud-status').textContent = `账号已自动同步 · ${new Date(result.checkedAt).toLocaleTimeString('zh-CN', { hour12: false })}`;
  } catch (error) {
    delay = Math.min(120000, 20000 * 2 ** ++incomingSync.failures);
    $('cloud-status').textContent = '自动同步暂未完成，将自动重试；现有内容保留。';
  } finally {
    incomingSync.running = false;
    if (incomingSync.again) { incomingSync.again = false; scheduleAccountPull(500); } else scheduleAccountPull(delay);
  }
}
async function continueLatest() {
  if (!state.detail || !accountView.epoch || state.resumeLookup) return;
  const seriesId = state.detail.id, generation = state.detailGeneration, epoch = accountView.epoch;
  state.resumeLookup = true; accountView.generation++; progressSync.pending.clear(); $('resume-play').disabled = true; $('video').pause();
  $('account-action-status').textContent = '正在核对云端最新观看进度…';
  try {
    const result = await api('/api/account/resume?' + new URLSearchParams({ seriesId, accountEpoch: epoch }));
    if (generation !== state.detailGeneration || epoch !== accountView.epoch) return;
    accountView.resume = result.resume; paintResume();
    if (!result.resume) { $('account-action-status').textContent = '云端没有这部剧的观看记录，请选择集数。'; return; }
    const resume = result.resume;
    if (!await play(resume.episode)) return;
    if (generation !== state.detailGeneration || state.current !== resume.episode || !state.session) return;
    if (resume.position > 0 && !await seekTo(Math.min(resume.position, Math.max(0, state.total - 0.2)))) return;
    $('account-action-status').textContent = '已使用刚刚读取的云端进度继续观看。';
  } catch (error) { if (generation === state.detailGeneration) $('account-action-status').textContent = '未能确认最新进度：' + error.message; }
  finally { state.resumeLookup = false; $('resume-play').disabled = false; scheduleAccountPull(1000); }
}
$('resume-play').onclick = continueLatest;
document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(incomingSync.timer); else scheduleAccountPull(0); });
// 切回窗口时补拉一次；距上次不到 20 秒就不补，免得来回切窗口时一阵阵请求官方接口
window.addEventListener('focus', () => { if (Date.now() - incomingSync.lastStarted > 20000) scheduleAccountPull(200); });
window.addEventListener('online', () => scheduleAccountPull(0));
window.addEventListener('offline', () => { clearTimeout(incomingSync.timer); $('cloud-status').textContent = '网络离线，恢复连接后自动同步。'; });
function paintAccountActions() {
  $('refresh-actions').disabled = accountView.busy;
  $('favorite-toggle').disabled = !accountView.loaded || accountView.busy;
  $('like-toggle').disabled = !accountView.loaded || accountView.busy || !state.current;
  $('favorite-toggle').textContent = accountView.favorite ? '已收藏 · 取消' : '收藏这部剧';
  $('favorite-toggle').setAttribute('aria-pressed', String(accountView.favorite));
  const liked = accountView.likedEpisodes.includes(state.current);
  $('like-toggle').textContent = liked ? '已喜欢 · 取消' : '喜欢这一集';
  $('like-toggle').setAttribute('aria-pressed', String(liked));
}
async function loadAccountActions() {
  accountView.generation++; accountView.loaded = false; paintAccountActions();
  if (state.detail) $('account-action-status').textContent = '正在读取最新账号状态…';
  await pullAccount(true);
}
async function setAccountAction(kind) {
  if (!accountView.loaded || accountView.busy || !state.detail) return;
  const seriesId = state.detail.id, number = state.current, epoch = accountView.epoch;
  const selected = kind === 'favorites' ? !accountView.favorite : !accountView.likedEpisodes.includes(number);
  accountView.busy = true; accountView.generation++; paintAccountActions(); $('account-action-status').textContent = '正在更新官方账号…';
  try {
    await api('/api/account/action', { kind, seriesId, number, selected, accountEpoch: epoch });
    if (state.detail?.id === seriesId && accountView.epoch === epoch) {
      if (kind === 'favorites') accountView.favorite = selected;
      else accountView.likedEpisodes = [...accountView.likedEpisodes.filter(x => x !== number), ...(selected ? [number] : [])];
      $('account-action-status').textContent = selected ? '已添加，并从官方账号确认。' : '已取消，并从官方账号确认。';
    }
    if (library.view === kind) loadLibrary();
  } catch (error) { if (state.detail?.id === seriesId && accountView.epoch === epoch) $('account-action-status').textContent = error.message; }
  finally { accountView.busy = false; paintAccountActions(); }
}
function submitProgress(force = false, leaving = false) {
  const player = $('video'), epoch = state.playbackAccountEpoch;
  if (state.resumeLookup || state.remoteProgressPending || !$('sync-progress').checked || !epoch || epoch !== accountView.epoch || !state.session || state.seeking || state.scrubbing || player.readyState < 2 || !state.hasPlaybackFrame) return;
  const position = Math.min(state.total, state.offset + player.currentTime), now = Date.now();
  const observedAt = state.mediaObservedAt || now;
  if (now - observedAt > 120000) return;
  if (!force && (player.paused || now - progressSync.lastSent < 15000)) return;
  if (!leaving && progressSync.lastClient === state.clientId && Math.abs(position - progressSync.lastPosition) < 0.25) return;
  // Seeking replaces the media token while retaining the original session
  // anchor; the active media token remains valid after that old stream retires.
  const data = { accountEpoch: epoch, token: state.lease, clientId: state.clientId, sequence: ++progressSync.sequence, position, observedAt };
  progressSync.lastSent = now; progressSync.lastPosition = position; progressSync.lastClient = state.clientId; progressSync.lastObservedAt = observedAt;
  if (leaving) { postOnLeave('/api/account/progress', data); return; }
  progressSync.pending.set(data.clientId, data); drainProgress();
}
async function drainProgress() {
  if (progressSync.running) return;
  progressSync.running = true;
  while (progressSync.pending.size) {
    const key = progressSync.pending.keys().next().value, data = progressSync.pending.get(key); progressSync.pending.delete(key);
    if (data.accountEpoch !== accountView.epoch || !$('sync-progress').checked) continue;
    try {
      const result = await api('/api/account/progress', data);
      if (result.remote && data.clientId === state.clientId) { state.remoteProgressPending = true; progressSync.pending.clear(); $('progress-status').textContent = '其他设备有更新，点击继续观看使用云端进度。'; scheduleAccountPull(0); }
      if (data.accountEpoch === accountView.epoch && data.clientId === state.clientId && result.submitted) { $('progress-status').textContent = `第 ${result.number} 集 · ${clock(result.position)} 进度已提交到账号`; $('retry-progress').hidden = true; }
    } catch (error) {
      if (data.accountEpoch === accountView.epoch && data.clientId === state.clientId) { $('progress-status').textContent = '进度同步未完成：' + error.message; $('retry-progress').hidden = false; progressSync.lastSent = 0; }
    }
  }
  progressSync.running = false;
}
$('favorite-toggle').onclick = () => setAccountAction('favorites'); $('like-toggle').onclick = () => setAccountAction('likes');
$('refresh-actions').onclick = () => loadAccountActions(true);
$('retry-progress').onclick = () => { progressSync.lastSent = 0; submitProgress(true); };
$('sync-progress').onchange = () => { try { localStorage.setItem('iptv-hongguo-progress-sync', String($('sync-progress').checked)); } catch {} progressSync.pending.clear(); $('retry-progress').hidden = true; $('progress-status').textContent = $('sync-progress').checked ? '播放后自动同步进度。' : '已关闭进度同步。'; if ($('sync-progress').checked) { state.playbackAccountEpoch = accountView.epoch; submitProgress(true); } };
function cards(items, preserve = false) {
  const focused = document.activeElement?.closest?.('.card')?.dataset.key;
  const anchor = preserve ? [...$('cards').children].find(x => x.getBoundingClientRect().bottom > 0 && x.getBoundingClientRect().top < innerHeight) : null;
  const anchorKey = anchor?.dataset.key, anchorTop = anchor?.getBoundingClientRect().top;
  $('cards').replaceChildren();
  if (!items.length) { $('cards').append(el('p', 'loading', '这里暂时没有剧集。可以换个分类、筛选条件或关键词。')); return; }
  for (const item of items) {
    const b = el('button', 'card'); b.type = 'button'; b.dataset.key = item.key || item.id; b.setAttribute('aria-label', '查看 ' + item.title);
    const poster = el('div', 'poster');
    if (item.cover) { const img = el('img'); img.src = item.cover; img.alt = ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'; poster.append(img); }
    poster.append(el('span', '', item.progressLabel || (item.total ? `全 ${item.total} 集` : '查看详情')));
    const info = el('div', 'card-info');
    info.append(el('h3', '', item.title), el('p', '', item.tags.slice(0, 3).join(' · ') || '短剧'));
    b.append(poster, info);
    b.onclick = () => openDetail(item.id, item); $('cards').append(b);
  }
  if (preserve) { const children = [...$('cards').children], current = children.find(x => x.dataset.key === anchorKey); if (current && Number.isFinite(anchorTop)) scrollBy(0, current.getBoundingClientRect().top - anchorTop); children.find(x => x.dataset.key === focused)?.focus({ preventScroll: true }); }
}
function paintCategories() {
  const topics = $('catalog-topics');
  topics.replaceChildren();
  $('catalog-active-topic').textContent = '全部';
  function topicButton(id, title) {
    const selected = library.category === id;
    const button = el('button', selected ? 'active' : '', title);
    button.setAttribute('aria-pressed', String(selected));
    button.onclick = () => {
      if (selected) return;
      library.category = id;
      library.filters = [];
      paintCategories();
      topics.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
      loadLibrary();
    };
    return button;
  }
  topics.append(topicButton('0', '全部题材'));
  for (const group of state.home?.groups || []) {
    const row = el('div', 'filter-row'); row.append(el('span', 'filter-label', group.title));
    const options = el('div', 'filter-options');
    for (const item of group.items) {
      options.append(topicButton(item.id, item.title));
      if (library.category === item.id) $('catalog-active-topic').textContent = item.title;
    }
    row.append(options); topics.append(row);
  }
}
const contentTypeButtons = $('catalog-content-type').querySelectorAll('button');
for (const button of contentTypeButtons) {
  button.onclick = () => {
    if (library.contentType === button.dataset.contentType) return;
    library.contentType = button.dataset.contentType;
    for (const option of contentTypeButtons) {
      const selected = option === button;
      option.classList.toggle('active', selected);
      option.setAttribute('aria-pressed', String(selected));
    }
    loadLibrary();
  };
}
function paintFilters(rows) {
  $('filters').replaceChildren();
  for (const row of rows || []) {
    const line = el('div', 'filter-row'), options = el('div', 'filter-options'); line.append(el('span', 'filter-label', row.title));
    for (const option of row.options) {
      const selected = library.filters.includes(option.id) || (!row.options.some(x => library.filters.includes(x.id)) && option.selected);
      const button = el('button', selected ? 'active' : '', option.title);
      button.setAttribute('aria-pressed', String(selected));
      button.onclick = () => {
        if (row.multiple) library.filters = library.filters.includes(option.id) ? library.filters.filter(x => x !== option.id) : [...library.filters, option.id];
        else library.filters = [...library.filters.filter(x => !row.options.some(y => x === y.id)), option.id];
        loadLibrary();
      }; options.append(button);
    }
    line.append(options); $('filters').append(line);
  }
}
async function loadLibrary(more = false) {
  if (more && (library.loading || !library.cursor)) return;
  const generation = ++library.generation; library.controller?.abort(); const controller = new AbortController(); library.controller = controller;
  library.loading = true; $('load-more').disabled = true; $('load-more-status').textContent = '';
  if (!more) { library.cursor = null; library.items = []; $('catalog-meta').textContent = ''; $('filters').replaceChildren(); $('load-more').hidden = true; $('cards').replaceChildren(el('p', 'loading', '正在读取剧集…')); }
  const names = { catalog: '剧集', search: '搜索：' + library.query, favorites: '我的收藏', likes: '我的喜欢', history: '观看历史' };
  $('catalog-title').textContent = names[library.view]; $('back-home').hidden = library.view === 'catalog';
  $('categories').hidden = library.view !== 'catalog';
  $('cloud-status').hidden = !personalView(library.view);
  for (const b of $('library-nav').querySelectorAll('button')) {
    const active = b.dataset.view === library.view;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  }
  try {
    const params = new URLSearchParams({ filters: library.filters.join(','), ...(more ? { cursor: library.cursor } : {}) });
    let route;
    if (library.view === 'catalog') {
      params.set('category', library.category);
      if (library.contentType) params.set('contentType', library.contentType);
      route = '/api/catalog/page';
    }
    else if (library.view === 'search') { params.set('q', library.query); route = '/api/search'; }
    else { params.set('kind', library.view); route = '/api/account/list'; }
    const result = await api(route + '?' + params, undefined, controller.signal);
    if (generation !== library.generation) return;
    const seen = new Map(library.items.map(x => [x.key || x.id, x])); for (const item of result.items) seen.set(item.key || item.id, item);
    library.items = [...seen.values()]; library.cursor = result.cursor; cards(library.items); paintFilters(result.filters);
    $('catalog-meta').textContent = `已展示 ${library.items.length} ${result.accountSource ? '条' : '部'}`;
    $('load-more').hidden = !result.hasMore;
    $('load-more-status').textContent = !result.hasMore ? '已加载全部结果' : library.items.length ? '' : '可以继续加载后面的结果。';
  } catch (e) {
    if (generation !== library.generation || e.name === 'AbortError') return;
    $('catalog-meta').textContent = '';
    if (more) { $('load-more-status').textContent = e.message; $('load-more').hidden = false; }
    else { $('filters').replaceChildren(); $('cards').replaceChildren(el('p', 'loading', e.message)); }
  } finally { if (generation === library.generation) { library.loading = false; $('load-more').disabled = false; } }
}
async function loadHome() { try { state.home = await api('/api/catalog/categories'); paintCategories(); await loadLibrary(); } catch (e) { $('cards').replaceChildren(el('p', 'loading', e.message)); } }
$('search-form').onsubmit = event => { event.preventDefault(); library.view = 'search'; library.query = $('query').value.trim(); library.filters = []; loadLibrary(); };
function libraryView(view) { library.view = view; library.filters = []; loadLibrary().then(() => scheduleAccountPull(0)); }
$('back-home').onclick = () => libraryView('catalog');
$('load-more').onclick = () => loadLibrary(true);
for (const button of $('library-nav').querySelectorAll('button')) button.onclick = () => libraryView(button.dataset.view);
function releaseLease() {
  if (!state.lease) return; const token = state.session || state.lease; state.lease = null; state.session = null;
  postOnLeave('/api/release', { token, clientId: state.clientId });
}
window.addEventListener('pagehide', () => { submitProgress(true, true); cancelPreload(); releaseLease(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) submitProgress(true); });
function releaseSession(token, clientId) {
  if (token) postOnLeave('/api/release', { token, clientId });
}
function discardWarm(warm) {
  if (!warm || warm.promoted || warm.cancelled) return;
  warm.cancelled = true; warm.controller.abort(); clearTimeout(warm.timer); warm.hls?.destroy();
  warm.player?.pause(); warm.player?.removeAttribute('src'); warm.player?.load();
  postOnLeave('/api/preload/release', { session: warm.parentSession, clientId: warm.parentClientId, nextClientId: warm.clientId });
  releaseSession(warm.result?.session, warm.clientId);
}
function cancelPreload() {
  clearTimeout(state.preloadTimer); state.preloadTimer = null;
  discardWarm(state.warm); state.warm = null; discardWarm(state.adopting); state.adopting = null;
  $('next-status').textContent = '';
}
function stopVideo({ release = true } = {}) {
  submitProgress(true); state.hasPlaybackFrame = false;
  $('retry-hd').hidden = true;
  cancelPreload(); if (release) releaseLease(); state.seekRequest?.abort(); state.seekRequest = null;
  state.streamGeneration++; state.seeking = false; state.scrubbing = false; $('timeline').disabled = true;
  state.request?.abort(); state.request = null; clearTimeout(state.statusTimer); state.hls?.destroy(); state.hls = null;
  if (state.frameCallback !== null) $('video').cancelVideoFrameCallback?.(state.frameCallback); state.frameCallback = null;
  $('video').pause(); $('video').removeAttribute('src'); $('video').load(); $('screen-empty').hidden = false;
}
function schedulePreload() {
  if (!$('auto-next').checked || !state.session || state.current >= state.detail?.total || state.warm || state.adopting || state.preloadTimer || state.processing || state.seeking || Date.now() < state.preloadRetryAt) return;
  const generation = state.playGeneration;
  state.preloadTimer = setTimeout(() => { state.preloadTimer = null; if (generation === state.playGeneration && !$('video').paused) startPreload(); }, 1000);
}
function startPreload() {
  if (state.warm || !$('auto-next').checked || !state.session || state.current >= state.detail?.total || state.processing || state.seeking) return;
  const warm = { number: state.current + 1, seriesId: state.detail.id, parentSession: state.session, parentClientId: state.clientId,
    clientId: newClientId(), controller: new AbortController(), player: $('standby'), started: performance.now() };
  state.warm = warm; $('next-status').textContent = `正在准备第 ${warm.number} 集…`;
  const valid = () => !warm.cancelled && (state.warm === warm || state.adopting === warm);
  warm.promise = (async () => {
    const result = await api('/api/preload', { session: warm.parentSession, parentClientId: warm.parentClientId, clientId: warm.clientId }, warm.controller.signal);
    warm.result = result;
    if (!valid()) { releaseSession(result.session, warm.clientId); throw new DOMException('Cancelled', 'AbortError'); }
    const player = warm.player; player.muted = true; player.preload = 'auto';
    const ready = () => { if (valid()) { warm.buffered = true; warm.readyMs = Math.round(performance.now() - warm.started); $('next-status').textContent = `第 ${warm.number} 集已就绪`; } };
    player.addEventListener('canplay', ready, { once: true });
    const failed = () => { if (state.warm === warm) { discardWarm(warm); state.warm = null; state.preloadRetryAt = Date.now() + 10000; $('next-status').textContent = '下一集将自动重试准备'; } };
    player.addEventListener('error', failed, { once: true });
    if (result.format === 'hls' && window.Hls?.isSupported()) {
      warm.hls = new Hls({ startPosition: 0, lowLatencyMode: false, maxBufferLength: 6, maxMaxBufferLength: 6, backBufferLength: 0, enableWorker: true });
      warm.hls.on(Hls.Events.ERROR, (_, error) => { if (error.fatal) failed(); });
      warm.hls.loadSource(moduleUrl(result.media).href); warm.hls.attachMedia(player);
    } else { player.src = moduleUrl(result.media).href; player.load(); }
    const renew = async () => {
      if (state.warm !== warm || warm.cancelled) return;
      try { await api(result.status + '?client=' + warm.clientId, undefined, warm.controller.signal); if (state.warm === warm) warm.timer = setTimeout(renew, 10000); }
      catch { failed(); }
    };
    warm.timer = setTimeout(renew, 10000); return result;
  })();
  warm.promise.catch(error => {
    if (state.warm !== warm) return;
    discardWarm(warm); state.warm = null;
    const busy = ['APP_BUSY', 'PLAY_CANCELLED'].includes(error.code);
    state.preloadRetryAt = Date.now() + Math.max(busy ? 3000 : 10000, (error.retryAfterSeconds || 0) * 1000);
    $('next-status').textContent = busy ? '空闲后准备下一集' : '下一集暂未就绪，播放不受影响';
  });
}
async function openDetail(id, resume) {
  const generation = ++state.detailGeneration; state.playGeneration++; stopVideo(); state.detail = null; state.current = 0;
  $('catalog-publish-status').textContent = '';
  updatePlaybackCatalogUI();
  $('viewer').hidden = false; $('start-play').hidden = true; $('resume-play').hidden = true; $('liked-play').hidden = true; accountView.resume = null; $('viewer').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('detail-title').textContent = '正在读取详情…'; $('episodes').replaceChildren(); $('episode-ranges').replaceChildren(); $('play-status').textContent = ''; $('previous').disabled = $('next').disabled = true; notice();
  try {
    const detail = await api('/api/series/' + id); if (generation !== state.detailGeneration) return;
    state.detail = detail; state.range = 0; $('detail-title').textContent = detail.title; $('detail-cover').src = detail.cover; $('detail-cover').hidden = !detail.cover; $('detail-meta').textContent = `${detail.total} 集 · ` + detail.tags.join(' / '); $('detail-intro').textContent = detail.intro; $('official').href = detail.official; $('episode-count').textContent = `${detail.total} 集`; $('playing-label').textContent = '尚未选择'; renderEpisodes();
    $('start-play').hidden = false;
    loadAccountActions();
    loadPlaybackCatalog();
    $('liked-play').hidden = true;
    if (resume?.recordKind === 'likes' && detail.episodes[resume.episode - 1]?.id === resume.videoId) {
      $('liked-play').hidden = false; $('liked-play').textContent = `播放喜欢的第 ${resume.episode} 集`;
      $('liked-play').onclick = () => { if (generation === state.detailGeneration) play(resume.episode); };
    }

  } catch (e) { if (generation === state.detailGeneration) { $('detail-title').textContent = '暂时无法读取详情'; notice(e.message); } }
}
function renderEpisodes() {
  const d = state.detail; if (!d) return;
  $('episode-ranges').replaceChildren(); $('episodes').replaceChildren();
  for (let start = 0; start < d.total; start += 30) { const b = el('button', state.range === start ? 'active' : '', `${start + 1}–${Math.min(start + 30, d.total)}`); b.onclick = () => { state.range = start; renderEpisodes(); }; $('episode-ranges').append(b); }
  for (const ep of d.episodes.slice(state.range, state.range + 30)) { const b = el('button', ep.number === state.current ? 'selected' : '', String(ep.number)); b.setAttribute('aria-label', `播放第 ${ep.number} 集`); b.onclick = () => play(ep.number); $('episodes').append(b); }
}
function clock(seconds) { const n = Math.max(0, Math.floor(Number(seconds) || 0)); return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`; }
function paintTimeline(position = state.offset + $('video').currentTime) {
  const value = Math.min(state.total, Math.max(0, position));
  $('play-time').textContent = `${clock(value)} / ${clock(state.total)}`;
  $('timeline').value = String(value); $('timeline').setAttribute('aria-valuetext', `${clock(value)}，共 ${clock(state.total)}`);
}
function playbackStatus(result) {
  $('retry-hd').hidden = !result.appIssue;
  const quality = result.provider === 'official_app' ? (result.quality === 'hd' ? 'App 高清 · ' : 'App 标清 · ') : result.appIssue ? '官网备用，高清接口未恢复 · ' : '';
  let status = result.verification === 'complete' ? '整集核验通过' : '可直接拖动到任意位置';
  if ($('video').ended) status = state.current === state.detail?.total ? '本剧已播完' : '本集已播完';
  $('play-status').textContent = `${quality}${result.width} × ${result.height} · ${Math.round(result.duration)} 秒 · ${status}`;
}
function attachPlayback(result, generation, requestedAt, { seeking = false, autoplay = true, prepared = null, automatic = false, fromEpisode = 0 } = {}) {
  if (prepared?.player) {
    const previous = $('video'), next = prepared.player;
    next.muted = previous.muted; next.volume = previous.volume; next.playbackRate = previous.playbackRate;
    previous.id = 'standby'; previous.hidden = true; previous.setAttribute('aria-hidden', 'true'); previous.removeAttribute('aria-label'); previous.tabIndex = -1;
    next.id = 'video'; next.hidden = false; next.removeAttribute('aria-hidden'); next.setAttribute('aria-label', '短剧画面'); next.tabIndex = 0;
  }
  const player = $('video'), stream = ++state.streamGeneration;
  state.hls?.destroy(); state.hls = null; clearTimeout(state.statusTimer);
  if (state.frameCallback !== null && player.cancelVideoFrameCallback) player.cancelVideoFrameCallback(state.frameCallback);
  if (!prepared) { player.pause(); player.removeAttribute('src'); player.load(); }
  state.lease = result.status.split('/').pop(); state.session = result.session;
  state.offset = result.offset || 0; state.total = result.duration; state.processing = result.processing; state.seeking = true; state.resumeAfterSeek = autoplay;
  state.breakAt = result.interrupted ? result.availableThrough : null;
  $('timeline').max = String(result.duration); $('timeline').disabled = false; $('screen-empty').hidden = true;
  paintTimeline(result.position || 0); playbackStatus(result);
  const valid = () => generation === state.playGeneration && stream === state.streamGeneration;
  const firstFrame = (_now, metadata) => {
    if (!valid()) return; state.seeking = false; state.hasPlaybackFrame = true; state.mediaObservedAt = Date.now(); state.lastObservedPosition = state.offset + player.currentTime;
    if (seeking) { player.dataset.seekMs = String(Math.round(performance.now() - requestedAt)); player.dataset.seekLanded = String(state.offset + (metadata?.mediaTime ?? player.currentTime)); player.dataset.seekSequence = String(state.seekSequence); }
    else { player.dataset.firstFrameMs = String(Math.round(performance.now() - requestedAt)); player.dataset.transitionMs = player.dataset.firstFrameMs; player.dataset.transitionMode = automatic ? 'automatic' : 'manual'; player.dataset.preloadHit = String(!!prepared); player.dataset.preloadBuffered = String(!!prepared?.buffered); player.dataset.fromEpisode = String(fromEpisode); player.dataset.episode = String(state.current); if (automatic) state.automaticTransitions++; player.dataset.automaticTransitions = String(state.automaticTransitions); }
    paintTimeline(); schedulePreload(); submitProgress(true);
  };
  state.frameCallback = player.requestVideoFrameCallback ? player.requestVideoFrameCallback(firstFrame) : null;
  if (!player.requestVideoFrameCallback) player.addEventListener('loadeddata', firstFrame, { once: true });
  const position = Math.max(0, (result.position || 0) - state.offset);
  const start = () => { if (valid() && autoplay) player.play().catch(() => { if (valid()) $('play-status').textContent = '已准备就绪，点击播放继续'; }); };
  const watchHls = hls => hls.on(Hls.Events.ERROR, (_, error) => { if (error.fatal && valid()) { hls.destroy(); clearTimeout(state.statusTimer); $('play-status').textContent = '播放中断，请重新选择位置或集数。'; state.seeking = false; } });
  if (prepared) {
    state.hls = prepared.hls || null;
    if (state.hls) { state.hls.config.maxBufferLength = 20; state.hls.config.maxMaxBufferLength = 600; state.hls.config.backBufferLength = 30; watchHls(state.hls); }
    start();
  } else if (result.format === 'hls' && window.Hls?.isSupported()) {
    const hls = new Hls({ startPosition: position, lowLatencyMode: false, maxBufferLength: 20, backBufferLength: 30, enableWorker: true }); state.hls = hls;
    hls.on(Hls.Events.MANIFEST_PARSED, start); watchHls(hls);
    hls.loadSource(moduleUrl(result.media).href); hls.attachMedia(player);
  } else if (result.format !== 'hls' || player.canPlayType('application/vnd.apple.mpegurl')) {
    player.addEventListener('loadedmetadata', () => { if (valid()) { player.currentTime = position; start(); } }, { once: true });
    player.src = moduleUrl(result.media).href; player.load();
  } else throw new Error('当前浏览器不支持此播放格式，请使用新版 Chrome 或 Safari。');
  const update = async () => {
    if (!valid()) return;
    try {
      const status = await api(result.status + '?client=' + state.clientId); if (!valid()) return;
      const justCompleted = state.processing && !status.processing;
      state.processing = status.processing;
      // 可能已经卡在断点上不再触发 timeupdate，拿到状态时先检查一次
      if (status.interrupted && state.breakAt == null) { state.breakAt = status.availableThrough; continueAfterBreak(player, 2); if (!valid()) return; }
      if (justCompleted && !player.paused) schedulePreload();
      if (!state.seeking) playbackStatus(status);
      // Keep the session available after the end so replay/backward seeking works.
      state.statusTimer = setTimeout(update, status.processing ? 1500 : 10000);
    } catch (error) { if (valid()) { state.hls?.destroy(); player.pause(); $('play-status').textContent = error.message; } }
  };
  state.statusTimer = setTimeout(update, 1500);
}
async function play(number, { automatic = false, refresh = false } = {}) {
  const d = state.detail; if (!d || number < 1 || number > d.total) return;
  const generation = ++state.playGeneration, fromEpisode = state.current, requestedAt = performance.now();
  const warm = state.warm?.result && state.warm.seriesId === d.id && state.warm.number === number && !state.warm.cancelled ? state.warm : null;
  const previous = { token: state.session || state.lease, clientId: state.clientId };
  let released = false; const releasePrevious = () => { if (!released) { released = true; releaseSession(previous.token, previous.clientId); } };
  if (warm) { state.warm = null; clearTimeout(warm.timer); }
  stopVideo({ release: !warm }); state.lease = null; state.session = null; state.adopting = warm;
  let clientId = warm?.clientId || newClientId(); state.clientId = clientId; state.seekSequence = 0; state.preloadRetryAt = 0;
  state.playbackAccountEpoch = accountView.epoch; state.hasPlaybackFrame = false; state.playbackStartedAt = Date.now(); state.cloudSeenAt = accountView.resume?.updatedAt || 0; state.remoteProgressPending = false; state.mediaObservedAt = 0; $('progress-status').textContent = ''; $('retry-progress').hidden = true;
  state.current = number; state.range = Math.floor((number - 1) / 30) * 30; renderEpisodes(); paintAccountActions();
  $('playing-label').textContent = `第 ${number} / ${d.total} 集`; $('previous').disabled = $('next').disabled = true;
  $('retry-hd').hidden = true; $('play-status').textContent = automatic ? `正在接着播放第 ${number} 集…` : '正在加载这一集…'; notice();
  state.request = warm?.controller || new AbortController(); const request = state.request;
  try {
    let result, prepared;
    if (warm) {
      try {
        await warm.promise;
        result = await api('/api/preload/adopt', { parentClientId: warm.parentClientId, clientId: warm.clientId, session: warm.result.session }, request.signal);
        if (generation !== state.playGeneration) { releaseSession(result.session, warm.clientId); return; }
        prepared = warm; warm.promoted = true; clearTimeout(warm.timer); state.adopting = null;
      } catch (error) {
        discardWarm(warm); if (state.adopting === warm) state.adopting = null; releasePrevious();
        if (generation !== state.playGeneration || error.name === 'AbortError') return;
        clientId = newClientId(); state.clientId = clientId; state.request = new AbortController();
      }
    }
    if (!result) result = await api('/api/play', { seriesId: d.id, number, clientId, refresh }, state.request.signal);
    if (generation !== state.playGeneration || state.detail?.id !== d.id) { releaseSession(result.session, clientId); return; }
    attachPlayback(result, generation, requestedAt, { prepared, automatic, fromEpisode });
    $('video').dataset.prepareMs = String(Math.round(performance.now() - requestedAt));
    $('previous').disabled = number === 1; $('next').disabled = number === d.total;
    return true;
  } catch (e) { if (generation === state.playGeneration) { $('retry-hd').hidden = !e.code?.startsWith('APP_'); $('play-status').textContent = e.message; notice(e.message); $('previous').disabled = number <= 1; $('next').disabled = number >= d.total; } }
  finally { if (warm) releasePrevious(); }
}
async function seekTo(value) {
  if (!state.session || !state.total) return;
  const position = Math.max(0, Math.min(state.total, Number(value))), generation = state.playGeneration;
  const sequence = ++state.seekSequence, requestedAt = performance.now();
  const autoplay = state.seeking ? state.resumeAfterSeek : !$('video').paused || $('video').ended;
  state.resumeAfterSeek = autoplay; state.seeking = true; state.scrubbing = false; state.streamGeneration++;
  state.seekRequest?.abort(); state.seekRequest = new AbortController(); clearTimeout(state.statusTimer);
  state.hls?.destroy(); state.hls = null; $('video').pause();
  $('video').dataset.seekMs = ''; $('video').dataset.seekTarget = String(position);
  $('play-status').textContent = `正在跳转至 ${clock(position)}…`; paintTimeline(position);
  try {
    const result = await api('/api/seek', { session: state.session, clientId: state.clientId, sequence, position }, state.seekRequest.signal);
    if (generation !== state.playGeneration || sequence !== state.seekSequence) return;
    attachPlayback(result, generation, requestedAt, { seeking: true, autoplay });
    return true;
  } catch (error) { if (generation === state.playGeneration && sequence === state.seekSequence && error.name !== 'AbortError') { state.seeking = false; $('play-status').textContent = error.message; } }
}
// 转码中途断了（片源断流等）：已转好的部分照常播，播到断点时从断点重新转一段接上，不用重新选集
function continueAfterBreak(player, margin) {
  if (state.breakAt == null || state.seeking || state.scrubbing || player !== $('video')) return;
  const position = state.offset + player.currentTime;
  if (state.breakAt >= state.total - 0.5 || position < state.breakAt - margin) return;
  state.breakAt = null; $('play-status').textContent = '这一集转码中途断开，正在从断点接着播放…';
  seekTo(Math.min(position, state.total));
}
function togglePlayback() { const player = $('video'); if (player.ended) seekTo(0); else if (player.paused) { state.remoteProgressPending = false; player.play().catch(() => {}); } else player.pause(); }
$('play-toggle').onclick = togglePlayback;
$('retry-hd').onclick = () => play(state.current, { refresh: true });
$('auto-next').onchange = () => { if ($('auto-next').checked) { state.preloadRetryAt = 0; schedulePreload(); } else cancelPreload(); };
$('mute').onclick = () => { const player = $('video'); player.muted = !player.muted; $('mute').textContent = player.muted ? '取消静音' : '静音'; };
$('fullscreen').onclick = () => { if (document.fullscreenElement) document.exitFullscreen(); else $('screen').requestFullscreen?.(); };
$('timeline').addEventListener('input', () => { state.scrubbing = true; $('play-time').textContent = `${clock($('timeline').value)} / ${clock(state.total)}`; });
$('timeline').addEventListener('change', () => seekTo(Number($('timeline').value)));
function playbackKeys(event) {
  if (['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) {
    event.preventDefault(); const position = state.seeking || state.scrubbing ? Number($('timeline').value) : state.offset + $('video').currentTime;
    seekTo(event.key === 'Home' ? 0 : event.key === 'End' ? state.total - 0.2 : position + (event.key === 'ArrowRight' ? 5 : -5));
  } else if (event.code === 'Space') { event.preventDefault(); togglePlayback(); }
}
$('timeline').addEventListener('keydown', playbackKeys);
for (const player of [$('video'), $('standby')]) {
  player.addEventListener('click', () => { if (player === $('video')) togglePlayback(); });
  player.addEventListener('keydown', event => { if (player === $('video')) playbackKeys(event); });
  player.addEventListener('waiting', () => continueAfterBreak(player, 2));
  player.addEventListener('timeupdate', () => { if (player === $('video')) { continueAfterBreak(player, 0.3); if (!state.scrubbing && !state.seeking) paintTimeline(); if (!player.paused) schedulePreload(); if (!state.seeking && !state.scrubbing && Math.abs(state.offset + player.currentTime - (state.lastObservedPosition ?? -1)) > 0.01) { state.mediaObservedAt = Date.now(); state.lastObservedPosition = state.offset + player.currentTime; } submitProgress(); } });
  player.addEventListener('pause', () => { if (player === $('video')) submitProgress(true); });
  for (const event of ['play','pause','ended']) player.addEventListener(event, () => { if (player === $('video')) $('play-toggle').textContent = player.paused ? '播放' : '暂停'; });
  player.addEventListener('ended', () => {
    if (player !== $('video') || state.seeking || !state.detail) return;
    submitProgress(true);
    if ($('auto-next').checked && state.current < state.detail.total) play(state.current + 1, { automatic: true });
    else $('play-status').textContent = state.current === state.detail.total ? '本剧已播完' : '本集已播完';
  });
  player.addEventListener('error', () => { if (player === $('video') && player.getAttribute('src')) $('play-status').textContent = '播放暂时中断，请重新选择此集刷新官方地址。'; });
}
$('start-play').onclick = () => play(1);
$('previous').onclick = () => play(state.current - 1); $('next').onclick = () => play(state.current + 1);
$('close-viewer').onclick = () => { state.detailGeneration++; state.playGeneration++; stopVideo(); $('viewer').hidden = true; if (library.view === 'history') loadLibrary(); };
let qrTimer, qrId;
let playbackCatalog = null;
let playbackCatalogLoading = null;
let catalogUpdating = false;
let playbackCatalogRevision = 0;

function updatePlaybackCatalogUI() {
  const published = playbackCatalog?.series || [];
  const selected = published.some(item => item.id === state.detail?.id);
  $('rotate-playback-catalog').disabled = !playbackCatalog?.emby || catalogUpdating;
  $('publish-series').textContent = selected ? '移出点播目录' : '加入点播目录';
  $('publish-series').disabled = !state.detail || !playbackCatalog || catalogUpdating;
  const emby = playbackCatalog?.emby;
  $('emby-server').value = emby ? moduleUrl(emby.server).href : '';
  const directServer = emby?.directPort ? new URL(location.href) : null;
  if (directServer) {
    directServer.protocol = 'http:';
    directServer.port = emby.directPort;
  }
  $('emby-direct-server').value = directServer?.origin || '';
  for (const element of document.querySelectorAll('[data-direct-emby]')) element.hidden = !directServer;
  const portField = $('emby-direct-port');
  const savedPort = String(emby?.portSettings?.port ?? '');
  if (portField.dataset.savedPort !== savedPort) {
    portField.dataset.savedPort = savedPort;
    portField.value = savedPort;
  }
  portField.disabled = $('save-emby-port').disabled = !savedPort || catalogUpdating;
  $('emby-user').value = emby?.username || '';
  $('emby-password').value = emby?.password || '';
  for (const id of Object.keys(catalogFieldNames)) $('copy-' + id).disabled = !$(id).value;
  $('catalog-published-series').replaceChildren(...published.map(item => {
    const row = el('li');
    const remove = el('button', 'quiet', '移除');
    remove.disabled = catalogUpdating;
    remove.setAttribute('aria-label', '移除 ' + item.title);
    remove.onclick = () => changePlaybackCatalog({ seriesId: item.id, published: false });
    row.append(el('span', '', item.title), remove);
    return row;
  }));
}

async function loadPlaybackCatalog() {
  updatePlaybackCatalogUI();
  const revision = playbackCatalogRevision;
  playbackCatalogLoading ||= api('/api/playback-catalog').finally(() => { playbackCatalogLoading = null; });
  try {
    const result = await playbackCatalogLoading;
    if (catalogUpdating || revision !== playbackCatalogRevision) return;
    playbackCatalog = result;
    $('playback-catalog-status').textContent = result.emby?.portSettings?.error || (result.series.length ? '' : '从剧集详情加入要在播放器观看的剧。');
  } catch (error) {
    $('playback-catalog-status').textContent = error.message;
    $('catalog-publish-status').textContent = error.message;
  }
  updatePlaybackCatalogUI();
}

async function changePlaybackCatalog(input) {
  if (catalogUpdating) return;
  catalogUpdating = true;
  playbackCatalogRevision++;
  updatePlaybackCatalogUI();
  try {
    playbackCatalog = await api('/api/playback-catalog', input);
    if (Object.hasOwn(input, 'directPort')) {
      $('playback-catalog-status').textContent = `无路径端口已保存为 ${playbackCatalog.emby.directPort}。`;
    } else {
      $('playback-catalog-status').textContent = input.rotate ? '播放凭据已重置，请更新播放器来源。' : '';
    }
    if (input.seriesId && state.detail?.id === input.seriesId) {
      $('catalog-publish-status').textContent = input.published ? '已加入点播目录。' : '已移出点播目录。';
    }
  } catch (error) {
    $('playback-catalog-status').textContent = error.message;
    if (input.seriesId && state.detail?.id === input.seriesId) $('catalog-publish-status').textContent = error.message;
  } finally {
    catalogUpdating = false;
    updatePlaybackCatalogUI();
  }
}

$('open-playback-catalog').onclick = () => {
  if (playbackCatalog?.emby?.portSettings) $('emby-direct-port').value = playbackCatalog.emby.portSettings.port;
  $('playback-catalog-dialog').showModal();
  loadPlaybackCatalog();
};
$('close-playback-catalog').onclick = () => $('playback-catalog-dialog').close();
$('save-emby-port').onclick = () => {
  const port = $('emby-direct-port');
  if (port.reportValidity()) changePlaybackCatalog({ directPort: port.valueAsNumber });
};
$('publish-series').onclick = () => {
  const seriesId = state.detail?.id;
  if (seriesId && playbackCatalog) {
    changePlaybackCatalog({ seriesId, published: !playbackCatalog.series.some(item => item.id === seriesId) });
  }
};
$('rotate-playback-catalog').onclick = () => {
  if (confirm('重置会让当前 Emby 播放登录失效。继续重置？')) changePlaybackCatalog({ rotate: true });
};
let toastTimer;
function toast(text, type = 'success') {
  let box = $('toast');
  if (!box) { box = document.createElement('div'); box.id = 'toast'; box.setAttribute('role', 'status'); }
  // 模态对话框打开时它在最上层，提示要放进对话框里才不会被盖住
  (document.querySelector('dialog[open]') || document.body).append(box);
  box.className = `toast ${type}`;
  box.textContent = text;
  box.getBoundingClientRect();
  box.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('show'), 2000);
}
async function writeClipboard(text, host) {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return; } catch {}
  }
  // 用局域网 http 地址打开时没有 Clipboard API，只能选中文字再复制；模态对话框外的元素选不中，
  // 所以在对话框里临时放一个文本框来复制
  const area = document.createElement('textarea');
  area.value = text;
  area.readOnly = true;
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  host.append(area);
  area.select();
  try { if (!document.execCommand('copy')) throw new Error('copy failed'); } finally { area.remove(); }
}
const catalogFieldNames = { 'emby-server': '服务器地址', 'emby-direct-server': '无路径地址', 'emby-user': '用户名', 'emby-password': '播放密码' };
async function copyCatalogField(id) {
  const field = $(id);
  $('playback-catalog-status').textContent = '';
  try {
    await writeClipboard(field.value, field.closest('dialog') || document.body);
    $('copy-' + id).focus();
    toast(`${catalogFieldNames[id]}已复制`);
  } catch {
    field.select();
    toast('复制失败，请手动复制已选中的内容', 'error');
  }
}
for (const id of Object.keys(catalogFieldNames)) {
  $('copy-' + id).onclick = () => copyCatalogField(id);
}

async function connection() {
  try { const s = await api('/api/account'); if (accountView.epoch !== (s.accountEpoch || null)) { accountView.epoch = s.accountEpoch || null; progressSync.pending.clear(); accountView.loaded = false; paintAccountActions(); } paintConnection(s); return s; }
  // 读不到状态（如网页已登录但 App 账号关联失败）时带上原因，登录框据此显示「退出」，否则只能反复扫码
  catch (e) { return { connected: false, error: e.message }; }
}
async function startQr() {
  clearTimeout(qrTimer); $('refresh-qr').hidden = true; $('account-qr').hidden = true; $('account-message').textContent = '正在获取登录二维码…';
  try { const qr = await api('/api/account/login', {}); qrId = qr.id; $('account-qr').src = qr.image; $('account-qr').hidden = false; $('account-message').textContent = '请使用红果 App「我的 → 扫一扫」，并在手机上确认登录。'; qrTimer = setTimeout(pollQr, 2200); }
  catch (e) { $('account-message').textContent = e.message; $('refresh-qr').hidden = false; }
}
async function pollQr() {
  if (!$('account-dialog').open) return;
  try {
    const result = await api('/api/account/poll', { id: qrId });
    if (result.state === 'confirmed') { $('account-qr').hidden = true; $('refresh-qr').hidden = true; $('account-message').textContent = '已登录：' + result.name; $('disconnect-account').hidden = false; await connection(); if (state.detail) loadAccountActions(); if (!['catalog', 'search'].includes(library.view)) loadLibrary(); return; }
    if (['expired', 'canceled', 'unconfirmed'].includes(result.state)) { $('account-message').textContent = '本次登录已结束，请刷新二维码重试。'; $('refresh-qr').hidden = false; return; }
    $('account-message').textContent = result.state === 'scanned' ? '已扫码，请在手机上确认。' : '请使用红果 App「我的 → 扫一扫」，并在手机上确认登录。';
    qrTimer = setTimeout(pollQr, 2200);
  } catch (e) { $('account-message').textContent = e.message; $('refresh-qr').hidden = false; $('disconnect-account').hidden = false; }
}
$('login').onclick = async () => {
  $('account-dialog').showModal(); $('refresh-qr').hidden = true;
  const s = await connection(); $('disconnect-account').hidden = !s.connected && !s.error;
  if (s.connected) { $('account-qr').hidden = true; $('account-message').textContent = '已登录：' + s.name; }
  else if (s.error) { $('account-qr').hidden = true; $('account-message').textContent = s.error.replace(/[。.]$/, '') + '。可点「退出本模块账号」后重新扫码登录。'; $('refresh-qr').hidden = false; }
  else await startQr();
};
$('close-account').onclick = () => $('account-dialog').close();
$('account-dialog').addEventListener('close', () => clearTimeout(qrTimer));
$('refresh-qr').onclick = startQr;
$('disconnect-account').onclick = async () => {
  try { await api('/api/account/disconnect', {}); } catch (e) { $('account-message').textContent = '退出未完成：' + e.message; return; }
  $('account-dialog').close(); await connection(); if (state.detail) loadAccountActions(); if (!['catalog', 'search'].includes(library.view)) loadLibrary(); };
if (filePreview) {
  notice('当前打开的是本地 HTML 文件。请从 IPTV 管理后台进入「红果短剧」，再登录和选剧。');
  for (const selector of ['.catalog', 'header .account', '#open-playback-catalog']) document.querySelector(selector).hidden = true;
} else {
  loadHome();
  connection().then(() => scheduleAccountPull(0));
}
