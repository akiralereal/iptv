import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { requestDigest } from '../src/mobile/signature-digest.mjs';
import { PlaybackSigner } from '../src/mobile/signature.mjs';
import { MobileSession, PROFILE, APP_VERSION } from '../src/mobile/session.mjs';
import { digest } from '../src/mobile/wire.mjs';
const vectors = JSON.parse(
  await readFile(new URL('./fixtures/request-digests.json', import.meta.url)),
);
const endpoint =
  'https://reading.snssdk.com/novel/player/multi_video_model/player/v1';
const parameters = {
  aid: '8662',
  device_id: '123',
  iid: '456',
  version_name: APP_VERSION,
};
const address = endpoint + '?' + new URLSearchParams(parameters);
const body = Buffer.from('request binding fixture');
const signer = (now = 1700000000123) =>
  new PlaybackSigner({
    profile: PROFILE,
    version: APP_VERSION,
    now: () => now,
    entropy: (n) => Buffer.alloc(n, 7),
  });

test('all five digest branches match 20 native SDK vectors with synthetic inputs', () => {
  assert.deepEqual(
    [...new Set(vectors.cases.map((r) => r.mode))],
    [2, 5, 8, 11, 14],
  );
  for (const row of vectors.cases) {
    const value = requestDigest(
      row.query,
      Buffer.from(row.body, 'base64'),
      row.seconds,
    );
    assert.equal(value.branch, row.mode);
    assert.equal(value.digest.toString('hex'), row.expected);
  }
});
test('current signatures bind query, compressed body and both module identity fields', () => {
  const original = signer().sign(address, body);
  assert.equal(
    original.headers['x-ss-stub'],
    digest('md5', body).toString('hex').toUpperCase(),
  );
  assert.equal(
    Buffer.from(original.headers['x-medusa'], 'base64').readUInt32LE() ^
      1700000000,
    5,
  );
  for (const [url, bytes] of [
    [address + '&extra=%2B', body],
    [address.replace('iid=456', 'iid=457'), body],
    [address.replace('device_id=123', 'device_id=124'), body],
    [address, Buffer.from('different body')],
  ])
    assert.notEqual(
      signer().sign(url, bytes).headers['x-medusa'],
      original.headers['x-medusa'],
    );
  assert.equal(
    signer().sign(address, body).headers['x-medusa'],
    original.headers['x-medusa'],
  );
});
test('supported branch selection stays local and preserves encoded query values', () => {
  for (const now of [
    1700000000000, 1700000000001, 1700000000999, 1700000001000, 1794830000123,
  ]) {
    const result = signer(now).sign(
        address + '&term=%E6%B5%8B%E8%AF%95%2B%20space',
        body,
      ),
      url = new URL(result.url),
      ticket = Number(url.searchParams.get('_rticket'));
    assert.ok(now - ticket >= 0 && now - ticket <= 255);
    assert.equal(result.headers['x-ss-req-ticket'], String(ticket));
    assert.equal(url.searchParams.get('term'), '测试+ space');
    assert.equal(
      requestDigest(url.search.slice(1), body, Math.floor(now / 1000)).branch,
      result.branch,
    );
  }
  assert.throws(() => signer(NaN).sign(address, body), RangeError);
  assert.throws(
    () =>
      signer().sign(
        address.replace('device_id=123', 'device_id=invalid'),
        body,
      ),
    RangeError,
  );
});
test('session transmits the exact signed URL and bytes with one upstream call', async () => {
  let calls = 0;
  const session = new MobileSession('/unused', {
    readOnly: true,
    fetcher: async (url, options) => {
      calls++;
      assert.equal(url.hostname, 'reading.snssdk.com');
      assert.strictEqual(options.body, body);
      assert.ok(options.headers['x-helios']);
      assert.ok(options.headers['x-medusa']);
      assert.equal(options.headers['x-argus'], undefined);
      const result = requestDigest(
        url.search.slice(1),
        options.body,
        Number(options.headers['x-khronos']),
      );
      assert.ok(result);
      return new Response('{"code":0}');
    },
  });
  session.identity = {
    deviceId: '123',
    installationId: '456',
    clientId: 'fixture',
  };
  await session.signedPost(endpoint, parameters, body, {
    'content-encoding': 'gzip',
  });
  assert.equal(calls, 1);
});
