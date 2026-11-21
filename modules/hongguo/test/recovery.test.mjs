import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CookieJar } from 'tough-cookie';
import { MobileSession } from '../src/mobile/session.mjs';
import { MobileModels } from '../src/mobile/model.mjs';
import { Playback } from '../src/playback.mjs';
import { AppError } from '../src/common.mjs';

test('empty HTTP 200 is classified without leaking query, headers or cookies', async () => {
  const diagnostics = [];
  const session = new MobileSession(os.tmpdir(), { readOnly: true, onResponse: item => diagnostics.push(item),
    fetcher: async () => new Response('', { headers: { 'content-type': 'application/json', 'set-cookie': 'private=test-secret; Secure; Path=/' } }) });
  await assert.rejects(session.request('https://reading.snssdk.com/test?device_id=private-id', { headers: { authorization: 'private-header' } }), { code: 'APP_EMPTY_RESPONSE' });
  assert.equal(diagnostics[0].bodyBytes, 0); assert.equal(diagnostics[0].status, 200); assert.equal(diagnostics[0].path, '/test');
  assert.doesNotMatch(JSON.stringify(diagnostics), /private|test-secret|authorization|device_id/);
});

test('read-only diagnostics never register a new identity or overwrite saved cookies', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'drama-readonly-')); let calls = 0;
  const fetcher = async () => { calls++; return new Response('{}', { headers: { 'set-cookie': 'new=value; Path=/; Secure' } }); };
  try {
    await assert.rejects(new MobileSession(root, { readOnly: true, fetcher }).ready(), { code: 'APP_SESSION_MISSING' }); assert.equal(calls, 0);
    await mkdir(path.join(root, '.runtime')); const file = path.join(root, '.runtime/app-session.json');
    const saved = JSON.stringify({ version: 1, identity: { deviceId: '123', installationId: '456', clientId: 'fixture' }, cookies: await new CookieJar().serialize() });
    await writeFile(file, saved);
    const session = new MobileSession(root, { readOnly: true, fetcher }); await session.ready();
    await session.request('https://reading.snssdk.com/test'); assert.equal(calls, 1); assert.equal(await readFile(file, 'utf8'), saved);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('concurrent foreground and preload failures share a cooldown; expiry recovers using the same session', async () => {
  let now = 1000, calls = 0, healthy = false; const identity = { deviceId: '123', installationId: '456', clientId: 'fixture' };
  const session = { ready: async () => identity, signedPost: async (_url, parameters) => {
    calls++; assert.equal(parameters.device_id, identity.deviceId);
    if (!healthy) throw new AppError('APP_EMPTY_RESPONSE', 'empty');
    return { code: 0, data: { '4': { video_model: { video_duration: 85 } } } };
  } };
  const models = new MobileModels('', { session, now: () => now });
  const outcomes = await Promise.allSettled([models.model('4'), models.model('38'), models.model('76')]);
  assert.deepEqual(outcomes.map(x => x.reason.code), ['APP_EMPTY_RESPONSE', 'APP_PLAYBACK_COOLDOWN', 'APP_PLAYBACK_COOLDOWN']);
  assert.equal(calls, 2); assert.equal(outcomes[1].reason.retryAfterSeconds, 30);
  healthy = true; now += 30000; assert.equal((await models.model('4')).video_duration, 85); assert.equal(calls, 3);
});

test('authorization rejection is not retried against another cluster', async () => {
  let calls = 0;
  const models = new MobileModels('', { session: { ready: async () => ({}), signedPost: async () => { calls++; return { code: 1001 }; } } });
  await assert.rejects(models.model('4'), { code: 'APP_PLAY_REJECTED' }); assert.equal(calls, 1);
});

test('HD HEVC wins over SD AVC for both object and array variant lists', async () => {
  const variants = [{ codec_type: 'h264', height: 640, main_url: 'https://v3.qznovelvod.com/sd' }, { codec_type: 'hevc', height: 1920, main_url: 'https://v3.qznovelvod.com/hd' }];
  for (const list of [variants, { sd: variants[0], hd: variants[1] }]) {
    const models = new MobileModels('', { session: {} }); models.model = async () => ({ video_duration: 85, video_list: list });
    const source = await models.resolve('4'); assert.equal(source.codec, 'hevc'); assert.equal(source.url, variants[1].main_url);
  }
});

test('ByteVC2 can be selected, while an available compatible variant takes precedence', async () => {
  const models = new MobileModels('', { session: {} });
  const videoList = [{ codec_type: 'bytevc2', height: 1920, main_url: 'https://v3.qznovelvod.com/hd' }];
  models.model = async () => ({ video_duration: 85, video_list: videoList });
  assert.equal((await models.resolve('4')).codec, 'bytevc2');
  videoList.push({ codec_type: 'h264', height: 640, main_url: 'https://v3.qznovelvod.com/sd' });
  assert.equal((await models.resolve('4')).codec, 'h264');
});

test('strict HD verification rejects website fallback and unknown or low resolution before decoding', async () => {
  const check = entry => Playback.prototype.verify.call({ resolve: async () => entry }, '1', 4, { requireApp: true, minimumSide: 1080 });
  await assert.rejects(check({ provider: 'official_public_endpoint', width: 360, height: 640 }), { code: 'APP_HD_UNAVAILABLE' });
  for (const entry of [{ width: 360, height: 640 }, { height: 1920 }]) await assert.rejects(check({ provider: 'official_app', ...entry }), { code: 'HD_RESOLUTION_REQUIRED' });
});

test('a fallback entry stops masking a recovered App source after its retry window', async () => {
  let calls = 0;
  const fallback = { key: '1:4', token: 'old', expiresAt: Date.now() + 600000, appRetryAt: Date.now() + 30000, appIssue: 'APP_EMPTY_RESPONSE' };
  const job = { provider: 'official_app', width: 1080, height: 1920, duration: 85, expectedDuration: 85, expiresAt: Date.now() + 600000 };
  const playback = Object.assign(Object.create(Playback.prototype), {
    entries: new Map([['1:4', fallback]]), pending: new Map(), tokens: new Map(),
    catalog: { detail: async () => ({ total: 4, title: 'fixture', episodes: [1, 2, 3, 4].map(n => ({ id: String(n) })) }) },
    mobile: { promote() {}, prepare: async () => { calls++; return job; }, available: candidate => candidate === job },
  });
  assert.strictEqual(await playback.resolve('1', 4), fallback); assert.equal(calls, 0);
  fallback.appRetryAt = Date.now() - 1;
  const recovered = await playback.resolve('1', 4); assert.equal(calls, 1); assert.equal(recovered.provider, 'official_app'); assert.equal(recovered.appIssue, undefined);
});
