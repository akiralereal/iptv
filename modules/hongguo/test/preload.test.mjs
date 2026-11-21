import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { Playback } from '../src/playback.mjs';

const parentClientId = '11111111-2222-4333-8444-555555555555';
const clientId = '22222222-2222-4333-8444-555555555555';
const newerId = '33333333-2222-4333-8444-555555555555';
async function setup() {
  const playback = new Playback({}, {}, os.tmpdir()); await playback.mobile.close();
  playback.mobile = { jobs: new Set(), promote() {}, available: job => !job.error, cancelUnleased: job => { if (job && !job.leases.size) job.error = true; }, close: async () => {} };
  const entry = number => { const job = { leases: new Map(), timing: {}, offset: 0, availableDuration: 2 }; playback.mobile.jobs.add(job); return { token: 'episode-' + number, job, seriesId: '1', number, total: 4, duration: 12, expiresAt: Date.now() + 60000 }; };
  const current = entry(1); playback.begin(current, parentClientId);
  return { playback, current, entry, request: { session: current.token, parentClientId, clientId } };
}
test('cancelling in-flight preload cannot create an orphan session or disturb current playback', async () => {
  const { playback, current, entry, request } = await setup(); let finish;
  const next = entry(2); playback.resolve = () => new Promise(resolve => { finish = resolve; });
  const work = playback.preload(request); playback.releaseNext(parentClientId, clientId); finish(next);
  await assert.rejects(work, { code: 'PLAY_CANCELLED' });
  assert.equal(playback.sessions.has(clientId), false); assert.equal(next.job.error, true);
  assert.equal(current.job.error, undefined); assert.ok(current.job.leases.has(parentClientId)); await playback.close();
});
test('a delayed cancel cannot cancel a newer preload and releasing a parent releases its child', async () => {
  const { playback, current, entry, request } = await setup(); playback.resolve = async () => entry(2);
  await playback.preload(request); const first = playback.sessions.get(clientId).active.job;
  const latest = await playback.preload({ ...request, clientId: newerId });
  playback.releaseNext(parentClientId, clientId);
  assert.equal(first.error, true); assert.equal(playback.sessions.get(parentClientId).nextClient, newerId);
  assert.equal(playback.sessions.get(newerId).active.job.error, undefined);
  assert.throws(() => playback.adopt({ parentClientId, clientId: newerId, session: 'wrong' }), { code: 'PRELOAD_EXPIRED' });
  playback.release(current.token, parentClientId); assert.equal(playback.sessions.size, 0);
  assert.throws(() => playback.adopt({ parentClientId, clientId: newerId, session: latest.session }), { code: 'PRELOAD_EXPIRED' }); await playback.close();
});
test('preload failure and invalid parents do not interrupt or replace foreground sessions', async () => {
  const { playback, current, request } = await setup();
  playback.resolve = async () => { throw Object.assign(new Error('busy'), { code: 'APP_BUSY' }); };
  await assert.rejects(playback.preload(request), { code: 'APP_BUSY' });
  await assert.rejects(playback.preload({ ...request, session: 'wrong' }), { code: 'SESSION_EXPIRED' });
  await assert.rejects(playback.preload({ ...request, clientId: parentClientId }), { code: 'SESSION_EXPIRED' });
  assert.strictEqual(playback.sessions.get(parentClientId).active, current); assert.equal(current.job.error, undefined); await playback.close();
});
