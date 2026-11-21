import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { simonBlocks, speckBlocks, unsigned, playbackHeaders, heliosHeader, mediaKey, unwrapMediaAddress } from '../src/mobile/wire.mjs';
import { exactModel, appMediaURL } from '../src/mobile/model.mjs';
import { MobileSession } from '../src/mobile/session.mjs';
import { byteRange } from '../src/ranges.mjs';

// Standard 128/256 test vectors, from the designers' Implementation Guide 1.1.
// https://nsacyber.github.io/simon-speck/implementations/ImplementationGuide1.1.pdf
test('standard SIMON and SPECK vectors validate byte order, schedules and rounds', () => {
  const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  const plain = Buffer.from('697320612073696d6f6f6d20696e2074', 'hex');
  const encrypted = Buffer.from('68b8e7ef872af73ba0a3c8af79552b8d', 'hex');
  assert.deepEqual(simonBlocks(plain, key), encrypted);
  assert.deepEqual(simonBlocks(encrypted, key, true), plain);
  assert.equal(speckBlocks(Buffer.from('706f6f6e65722e20496e2074686f7365', 'hex'), key).toString('hex'), '438f189c8db4ee4e3ef5c00504010941');
  assert.throws(() => simonBlocks(Buffer.alloc(15), key));
});
test('wire integers preserve values beyond JavaScript safe integer precision', () => {
  assert.equal(unsigned(18446744073709551615n).toString('hex'), 'ffffffffffffffffff01');
  assert.throws(() => unsigned(-1));
});
test('Helios matches two independently observed official SDK outputs', () => {
  // Only nonce, time and output hash are kept, with no signed request or identity.
  for (const [seconds, nonce, expected] of [
    [1794824943, '14436a64', '6ecaf2451ec1e7b393b977bd725fbc88f5e764ab85a423113413d433645fd509'],
    [1794824944, '52267a29', 'fbe99485628417ed71705bc18170c6509dfea660ec5bdbefd39c2c12287919c6'],
  ]) {
    const value = Buffer.from(heliosHeader(seconds, Buffer.from(nonce, 'hex')), 'base64');
    assert.equal(createHash('sha256').update(value).digest('hex'), expected);
  }
  for (const time of [-1, NaN, 1.5, 0x100000000]) assert.throws(() => heliosHeader(time), RangeError);
  assert.throws(() => heliosHeader(1800000000, Buffer.alloc(3)), RangeError);
});
test('request signature binds the exact body, query and installation identity', () => {
  const body = Buffer.from('compressed-request-fixture');
  const query = 'aid=8662&device_id=123&iid=456&version_name=7.4.3.32';
  const headers = playbackHeaders(query, body, 1800000000, Buffer.alloc(8, 7));
  assert.equal(headers['x-ss-stub'], createHash('md5').update(body).digest('hex').toUpperCase());
  for (const [q, b] of [[query + '&x=1', body], [query.replace('456', '457'), body], [query, Buffer.from('changed')]]) {
    assert.notEqual(playbackHeaders(q, b, 1800000000, Buffer.alloc(8, 7))['x-argus'], headers['x-argus']);
  }
});
test('models must contain the exact requested episode and an authoritative duration', () => {
  const model = { video_duration: 123.4 };
  assert.deepEqual(exactModel({ code: 0, data: { '38': { video_model: JSON.stringify(model) } } }, '38'), model);
  assert.throws(() => exactModel({ code: 0, data: { '1': { video_model: model } } }, '38'), { code: 'APP_EPISODE_MISMATCH' });
  assert.throws(() => exactModel({ code: 1001, data: { '38': { video_model: model } } }, '38'), { code: 'APP_PLAY_REJECTED' });
  assert.throws(() => exactModel({ code: 0, data: { '38': { video_model: {} } } }, '38'), { code: 'APP_DURATION_MISSING' });
  assert.throws(() => exactModel({ code: 0, data: { '38': { video_model: { video_duration: 'Infinity' } } } }, '38'), { code: 'APP_DURATION_MISSING' });
});
test('mobile media addresses and encrypted envelopes fail closed', () => {
  assert.equal(appMediaURL('https://v26-reading-video.qznovelvod.com/a'), 'https://v26-reading-video.qznovelvod.com/a');
  for (const address of ['https://qznovelvod.com.evil.test/a', 'https://127.0.0.1/a', 'http://v3.douyinvod.com/a', 'https://x@v3.fqnovelvod.com/a']) assert.throws(() => appMediaURL(address));
  assert.throws(() => mediaKey('bad'));
  assert.throws(() => unwrapMediaAddress(Buffer.alloc(64).toString('base64'), Buffer.alloc(32).toString('base64')));
});
test('invalid saved identities are preserved and never silently replaced', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'drama-session-test-'));
  try {
    await mkdir(path.join(root, '.runtime'));
    const file = path.join(root, '.runtime', 'app-session.json');
    await writeFile(file, '{broken');
    await assert.rejects(new MobileSession(root).ready(), { code: 'APP_SESSION_INVALID' });
    assert.equal(await readFile(file, 'utf8'), '{broken');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('media ranges cover seeking, suffixes, clamping and invalid requests', () => {
  assert.deepEqual(byteRange(undefined, 100), { status: 200, start: 0, end: 99 });
  assert.deepEqual(byteRange('bytes=10-19', 100), { status: 206, start: 10, end: 19 });
  assert.deepEqual(byteRange('bytes=-10', 100), { status: 206, start: 90, end: 99 });
  assert.deepEqual(byteRange('bytes=90-999', 100), { status: 206, start: 90, end: 99 });
  assert.deepEqual(byteRange('bytes=90-', 100), { status: 206, start: 90, end: 99 });
  for (const header of ['bytes=-0', 'bytes=100-', 'bytes=20-10', 'bytes=0-1,2-3', 'bytes=-', 'bytes=999999999999999999999999-']) assert.equal(byteRange(header, 100), null);
});
