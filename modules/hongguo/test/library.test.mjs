import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJSON } from '../src/common.mjs';
import { MobileCatalog, seriesCard } from '../src/mobile/catalog.mjs';
import { Account, personalCard } from '../src/mobile/account.mjs';

const video = (id = '123') => ({ series_id: id, title: '示例剧', episode_cnt: 80, category_schema: '[]' });
test('numeric JSON identifiers remain exact while durations and indexes stay numeric', () => {
  const row = parseJSON('{"vid":7706514631732235289,"book_id_str":"7706512650816982040","duration":81.619,"vid_index":48}');
  assert.equal(row.vid, '7706514631732235289'); assert.equal(row.duration, 81.619); assert.equal(row.vid_index, 48);
});
test('catalog cursors bind category and filters, reject expiry, and detect stalled upstream pages', async () => {
  const catalog = new MobileCatalog({ signedGet: async (url, params) => ({ code: 0, data: { video_info: [video()], selector: { rows: [] }, offset: params.offset ? params.offset : 12, has_more: true } }) });
  const first = await catalog.page();
  assert.throws(() => catalog.cursor(first.cursor, 'different category'), { code: 'PAGE_EXPIRED' });
  await assert.rejects(catalog.page({ cursor: first.cursor }), { code: 'APP_PAGE_STALLED' });
  catalog.cursors.get(first.cursor).expires = 0;
  await assert.rejects(catalog.page({ cursor: first.cursor }), { code: 'PAGE_EXPIRED' });
});
test('only server-provided filters can be sent, and empty pages are valid', async () => {
  let calls = 0;
  const catalog = new MobileCatalog({ signedGet: async () => { calls++; return { code: 0, data: { video_info: null, selector: { rows: [] }, has_more: false, offset: 0 } }; } });
  assert.deepEqual((await catalog.page()).items, []);
  await assert.rejects(catalog.page({ filters: 'invented_filter' }), { code: 'INVALID_FILTER' });
  assert.equal(calls, 1); assert.deepEqual(seriesCard({ ...video(), category_schema: '{}' }).tags, []);
});
test('the live-action filter uses official content types and keeps category, selectors and pagination', async () => {
  const liveAction = { ...video('124'), content_type: 1 };
  const comic = { ...video('125'), content_type: 1004 };
  const videosByOffset = { 0: [comic, video()], 12: [comic, liveAction], 24: [{ ...liveAction, series_id: '126' }] };
  const upstreamRequests = [];
  const catalog = new MobileCatalog({ signedGet: async (url, params) => {
    if (url.endsWith('/front/v')) return { code: 0, data: { category_tab_data: { cell_data: [
      { cell_name: '题材', atom_data: [{ category_data: { category_id: 12, name: '古装' } }] },
    ] } } };
    upstreamRequests.push([params.category_id, params.selected_items, params.offset, params.session_id]);
    const { offset } = params;
    return { code: 0, data: {
      video_info: videosByOffset[offset],
      selector: { rows: [{ type: 'order', row_name: '排序', items: [{ selector_item_id: 'sort_hot', show_name: '热门' }] }] },
      offset: offset + 12, session_id: `official-${offset}`, has_more: offset < 24,
    } };
  } });
  const options = { category: '12', filters: 'sort_hot' };
  const all = await catalog.page({ category: '12' });
  assert.deepEqual(all.items.map(item => item.id), ['125', '123']);
  const selected = { ...options, contentType: 'real-drama' };
  const first = await catalog.page(selected);
  assert.deepEqual(first.items.map(item => item.id), ['124']);
  await assert.rejects(catalog.page({ ...options, cursor: first.cursor }), { code: 'PAGE_EXPIRED' });
  await assert.rejects(catalog.page({ ...options, contentType: 'unknown' }), { code: 'INVALID_CONTENT_TYPE' });
  const next = await catalog.page({ ...selected, cursor: first.cursor });
  assert.deepEqual(next.items.map(item => item.id), ['126']);
  assert.equal(next.hasMore, false);
  assert.deepEqual(upstreamRequests, [
    ['12', '', 0, ''], ['12', 'sort_hot', 0, ''], ['12', 'sort_hot', 12, 'official-0'], ['12', 'sort_hot', 24, 'official-12'],
  ]);
});
test('liked episodes of the same series have separate keys and history time uses milliseconds', () => {
  const a = personalCard('likes', { video_data: { ...video(), vid: '100', vid_index: 4 } });
  const b = personalCard('likes', { video_data: { ...video(), vid: '101', vid_index: 5 } });
  assert.notEqual(a.key, b.key); assert.equal(a.episode, 4);
  const history = personalCard('history', { book_id_str: '123', book_name: '示例剧', episode_cnt: 80, vid: '100', vid_index: 4, current_play_position: 4500 });
  assert.equal(history.position, 4.5); assert.equal(history.videoId, '100'); assert.equal(history.recordKind, 'history');
  assert.equal(personalCard('history', { is_delete: true }), null);
});
function fixtureAccount(session) {
  const account = new Account('/unused', null); account.appUserId = 'fixture-user';
  account.linkedSession = async () => session; account.ready = async () => {}; account.save = async () => {};
  return account;
}
test('large official snapshots paginate locally without repeatedly downloading the entire collection', async () => {
  let calls = 0;
  const rows = Array.from({ length: 40 }, (_, i) => ({ series_title: '示例剧', collect_time: 100 - i, video_data: video(String(i + 1)) }));
  const account = fixtureAccount({ signedGet: async () => { calls++; return { code: 0, data: { video_shelf_info: rows } }; } });
  const first = await account.list('favorites'), second = await account.list('favorites', first.cursor), last = await account.list('favorites', second.cursor);
  assert.deepEqual([first.items.length, second.items.length, last.items.length], [18, 18, 4]);
  assert.equal(calls, 1); assert.equal(last.hasMore, false);
  await assert.rejects(account.list('likes', first.cursor), { code: 'PAGE_EXPIRED' });
  account.appUserId = 'another-user'; await assert.rejects(account.list('favorites', first.cursor), { code: 'PAGE_EXPIRED' });
});
test('disconnect invalidates in-flight personal data and retained page cursors', async () => {
  let resolve, entered;
  const started = new Promise(r => { entered = r; });
  const account = fixtureAccount({ signedGet: () => { entered(); return new Promise(r => { resolve = r; }); } });
  const work = account.list('favorites'); await started; await account.disconnect();
  resolve({ code: 0, data: { video_shelf_info: [] } });
  await assert.rejects(work, { code: 'ACCOUNT_CHANGED' }); assert.equal(account.pages.size, 0);
});
test('login callback may return HTML; ordinary API responses and external callback origins remain rejected', async () => {
  let calls = 0;
  const account = new Account('/unused', null, { fetcher: async () => { calls++; return new Response('<html>done</html>', { headers: { 'content-type': 'text/html' } }); } });
  assert.deepEqual(await account.request('/passport/callback/', {}, account.jar, { allowDocument: true }), { document: true });
  await assert.rejects(account.request('/passport/account/info/v2/'), { code: 'ACCOUNT_RESPONSE_INVALID' });
  await assert.rejects(account.request('https://example.com/callback'), { code: 'ACCOUNT_REDIRECT_REJECTED' }); assert.equal(calls, 2);
});
test('confirmed QR accepts callback cookies and persists the session before account verification', async () => {
  const calls = [];
  const account = new Account('/unused', null, { fetcher: async url => {
    calls.push(url.pathname);
    if (url.pathname === '/passport/web/get_qrcode/') return Response.json({ message: 'success', data: { token: 'fixture-token', qrcode: 'data:image/png;base64,AA==', expire_time: Math.floor(Date.now() / 1000) + 60 } });
    if (url.pathname === '/passport/web/check_qrconnect/') return Response.json({ message: 'success', data: { status: 'confirmed', redirect_url: '/passport/callback/' } });
    return new Response('<html>done</html>', { headers: { 'content-type': 'text/html', 'set-cookie': 'sessionid=fixture; Path=/; Secure; HttpOnly' } });
  } });
  account.ready = async () => {}; let saved = false;
  account.save = async () => { saved = true; };
  account.status = async () => { assert.equal(saved, true); assert.equal(await account.jar.getCookieString('https://hongguoduanju.com/'), 'sessionid=fixture'); return { connected: true, appConnected: true }; };
  const qr = await account.start(); assert.equal('token' in qr, false);
  const result = await account.poll(qr.id);
  assert.equal(result.state, 'confirmed'); assert.equal(result.appConnected, true); assert.equal(account.pending, null);
  assert.deepEqual(calls, ['/passport/web/get_qrcode/', '/passport/web/check_qrconnect/', '/passport/callback/']);
});
