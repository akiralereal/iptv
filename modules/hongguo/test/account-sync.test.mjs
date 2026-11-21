import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountSync, newerHistory } from '../src/mobile/account-sync.mjs';

const item = (id = '123', updatedAt = 100, position = 40, episode = 4) => ({ id, key: id, recordKind: 'history', episode, videoId: String(1000 + episode), position, updatedAt });
function fixture() {
  let rows = [item()], calls = 0;
  const account = { epoch: 'one', status: async () => ({ connected: true }), linkedSession: async () => ({}),
    list: async (kind, cursor = '') => { calls++; const start = Number(cursor || 0); return { items: rows.slice(start, start + 18), cursor: rows.length > start + 18 ? String(start + 18) : null }; } };
  const actions = { version: 0, recentProgress: new Map(), remoteProgress: new Map(), check: epoch => { if (epoch !== account.epoch) throw Error('wrong account'); }, state: async seriesId => ({ seriesId, favorite: false, likedEpisodes: [] }) };
  const catalog = { detail: async () => ({ episodes: Array.from({ length: 80 }, (_, i) => ({ number: i + 1, id: String(1001 + i) })) }) };
  const sync = new AccountSync(account, actions, catalog);
  return { sync, account, actions, setRows: next => { rows = next; }, calls: () => calls };
}
test('history follows timestamps, permits a newer rewind and ignores stale replicas', () => {
  const newer = newerHistory(item('123', 100, 40), item('123', 200, 10));
  assert.equal(newer.position, 10); assert.equal(newerHistory(newer, item('123', 100, 40)).position, 10);
  assert.equal(newerHistory(newer, null), null);
});
test('refresh replaces the complete visible window, including removals, while preserving further pagination', async () => {
  const { sync, account, setRows } = fixture();
  setRows(Array.from({ length: 50 }, (_, i) => item(String(i + 1), 100 - i)));
  const first = await sync.window('history', 36, account.epoch);
  assert.equal(first.items.length, 36); assert.equal(first.cursor, '36');
  setRows(Array.from({ length: 49 }, (_, i) => item(String(i + 2), 100 - i)));
  const next = await sync.window('history', 36, account.epoch, true);
  assert.equal(next.items.length, 36); assert.equal(next.items.some(x => x.id === '1'), false); assert.equal(next.hasMore, true);
});
test('continue fetches again, finds history beyond page one, and uses a newly changed episode and position', async () => {
  const { sync, account, setRows, calls } = fixture();
  setRows([...Array.from({ length: 20 }, (_, i) => item(String(i + 1))), item()]);
  const first = await sync.resume('123', account.epoch); assert.equal(first.resume.episode, 4); assert.equal(calls(), 2);
  setRows([item('123', 200, 12, 8)]);
  const next = await sync.resume('123', account.epoch);
  assert.equal(next.resume.episode, 8); assert.equal(next.resume.position, 12); assert.equal(calls(), 3);
});
test('a late cloud response cannot cross account boundaries', async () => {
  const { sync, account } = fixture(); let finish;
  account.list = () => new Promise(resolve => { finish = resolve; });
  const work = sync.window('history', 18, account.epoch); account.epoch = 'two';
  finish({ items: [item()], cursor: null });
  await assert.rejects(work, { code: 'ACCOUNT_CHANGED' }); assert.equal(sync.history.size, 0);
});
test('concurrent visible windows coalesce and acknowledged local progress survives read lag', async () => {
  const { sync, account, actions, calls, setRows } = fixture();
  actions.recentProgress.set('one:123', { ...item('123', 200, 55), clientId: 'local' });
  const [first, second] = await Promise.all([sync.window('history', 18, account.epoch), sync.window('history', 18, account.epoch)]);
  assert.equal(calls(), 1); assert.equal(first.items[0].position, 55); assert.deepEqual(first, second);
  setRows([item('123', 300, 8)]);
  const phone = await sync.window('history', 18, account.epoch, true);
  assert.equal(phone.items[0].position, 8); assert.equal(actions.remoteProgress.get('one:123'), 300);
});
test('fresh resume fails on mismatched episodes or network errors rather than using stale history', async () => {
  const { sync, account, setRows } = fixture();
  await sync.resume('123', account.epoch);
  setRows([{ ...item('123', 200), videoId: 'wrong' }]);
  await assert.rejects(sync.resume('123', account.epoch), { code: 'HISTORY_EPISODE_MISMATCH' });
  account.list = async () => { throw Error('network down'); };
  await assert.rejects(sync.resume('123', account.epoch), /network down/);
});
test('empty cloud history removes the continuation target and malformed sync ranges are rejected', async () => {
  const { sync, account, setRows } = fixture();
  await sync.resume('123', account.epoch); setRows([]);
  assert.equal((await sync.resume('123', account.epoch)).resume, null);
  await assert.rejects(sync.pull({ count: 'Infinity' }), { code: 'INVALID_COUNT' });
});
