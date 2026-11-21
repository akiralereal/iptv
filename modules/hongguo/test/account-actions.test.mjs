import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountActions, exactJSON, historyUpdate } from '../src/mobile/account-actions.mjs';
import { parseJSON } from '../src/common.mjs';

const seriesId = '7503745441910017049', videoId = '7503745441910017050';
const entry = { seriesId, videoId, number: 4, duration: 85.68, expiresAt: Date.now() + 600000 };
function fixture() {
  const calls = []; let favorite = false, liked = false;
  const session = {
    parameters: async () => ({}),
    signedPost: async (url, params, bytes) => {
      const body = parseJSON(bytes.toString()); calls.push({ url, body });
      if (url.includes('bookshelf')) favorite = body.update_bookshelf_video_list[0].video_shelf_operate_type === 0;
      if (url.includes('/action/')) liked = body.action_type === 3;
      return { code: 0, data: { update_fail_datas: [] } };
    },
    signedGet: async url => url.includes('bookshelf') ? { code: 0, data: { video_shelf_info: favorite ? [{ video_data: { series_id: seriesId } }] : [] } } : { code: 0, data: { mixed_data_list: liked ? [{ video_data: { vid: videoId } }] : [], has_more: false } },
  };
  const account = { epoch: 'test-epoch', pages: new Map(), linkedSession: async () => session, status: async () => ({ connected: true }) };
  const catalog = { detail: async () => ({ id: seriesId, total: 4, episodes: [{ number: 1, id: '11' }, { number: 2, id: '12' }, { number: 3, id: '13' }, { number: 4, id: videoId }] }) };
  const actions = new AccountActions(account, catalog, { tokens: new Map([['test-token', entry]]) });
  const progress = { accountEpoch: account.epoch, token: 'test-token', clientId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', sequence: 1, position: 12, observedAt: Date.now() };
  return { actions, account, session, calls, progress };
}
test('history writes numeric IDs exactly and converts seconds once to milliseconds', () => {
  const row = historyUpdate(entry, 12.345, Date.now()), parsed = parseJSON(exactJSON({ update_datas: [row] }));
  assert.equal(parsed.update_datas[0].vid, videoId); assert.equal(parsed.update_datas[0].book_id, seriesId);
  assert.equal(parsed.update_datas[0].current_play_position, 12345);
  for (const position of [NaN, -1, 900]) assert.throws(() => historyUpdate(entry, position, Date.now()), { code: 'INVALID_PROGRESS' });
});
test('favorite and episode-like desired states are written and read back, including cancellation', async () => {
  const { actions, account, calls } = fixture();
  for (const kind of ['favorites', 'likes']) for (const selected of [true, false]) {
    const result = await actions.set({ kind, seriesId, number: 4, selected, accountEpoch: account.epoch });
    assert.equal(result.verified, true); assert.equal(result.selected, selected);
    const state = await actions.state(seriesId);
    assert.equal(kind === 'favorites' ? state.favorite : state.likedEpisodes.includes(4), selected);
  }
  assert.equal(calls.length, 4); assert.equal(calls[2].body.object_id, videoId); assert.equal(calls[3].body.action_type, 4);
});
test('wrong accounts, invalid episodes and non-boolean actions never write', async () => {
  const { actions, account, calls } = fixture();
  assert.throws(() => actions.set({ kind: 'favorites', seriesId, selected: true, accountEpoch: 'old' }), { code: 'ACCOUNT_CHANGED' });
  assert.throws(() => actions.set({ kind: 'favorites', seriesId, selected: 'true', accountEpoch: account.epoch }), { code: 'INVALID_ACTION' });
  await assert.rejects(actions.set({ kind: 'likes', seriesId, number: 5, selected: true, accountEpoch: account.epoch }), { code: 'INVALID_EPISODE' });
  assert.equal(calls.length, 0);
});
test('queued writes are cancelled if the account changes before dispatch', async () => {
  const { actions, account, calls } = fixture(); let release;
  actions.tail = new Promise(resolve => { release = resolve; });
  const work = actions.set({ kind: 'favorites', seriesId, selected: true, accountEpoch: account.epoch });
  account.epoch = 'new-account'; release();
  await assert.rejects(work, { code: 'ACCOUNT_CHANGED' }); assert.equal(calls.length, 0);
});
test('progress rejects stale sessions and times, collapses old sequences, and permits intentional rewind', async () => {
  const { actions, calls, progress } = fixture();
  assert.throws(() => actions.progress({ ...progress, token: 'unknown' }), { code: 'INVALID_PROGRESS_SESSION' });
  assert.throws(() => actions.progress({ ...progress, observedAt: Date.now() - 200000 }), { code: 'PROGRESS_EXPIRED' });
  const first = actions.progress(progress), second = actions.progress({ ...progress, position: 20, sequence: 2 });
  assert.equal((await first).superseded, true); assert.equal((await second).submitted, true);
  assert.equal((await actions.progress({ ...progress, sequence: 1 })).superseded, true);
  assert.equal((await actions.progress({ ...progress, sequence: 3, position: 3, observedAt: Date.now() })).position, 3);
  assert.equal(calls.length, 2);
});
test('upstream progress partial failures and collection errors never produce a success response', async () => {
  const { actions, session, progress, account } = fixture();
  session.signedPost = async () => ({ code: 0, data: { update_fail_datas: [{ book_id: seriesId }] } });
  await assert.rejects(actions.progress(progress), { code: 'PROGRESS_REJECTED' });
  session.signedPost = async () => ({ code: 401 });
  await assert.rejects(actions.set({ kind: 'favorites', seriesId, selected: true, accountEpoch: account.epoch }), { code: 'ACCOUNT_WRITE_REJECTED' });
});
test('previously observed newer phone progress rejects an old paused-page submission', async () => {
  const { actions, progress, calls } = fixture();
  actions.remoteProgress.set(progress.accountEpoch + ':' + seriesId, progress.observedAt + 1000);
  assert.equal((await actions.progress(progress)).remote, true); assert.equal(calls.length, 0);
});
