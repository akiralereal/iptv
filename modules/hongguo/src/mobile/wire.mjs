import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';

// Wire constants are protocol data. Crypto and serialization below use our own
// implementation and Node's standard primitives; no third-party client code is loaded.
export const REGISTRATION_SALT = Buffer.from('4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58', 'hex');
const MASK = (1n << 64n) - 1n;
const rotate = (x, n) => ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK;
export const digest = (algorithm, value) => createHash(algorithm).update(value).digest();
function padded(value) { const n = 16 - value.length % 16; return Buffer.concat([value, Buffer.alloc(n, n)]); }
function wordBytes(words) { const out = Buffer.alloc(words.length * 8); words.forEach((v, i) => out.writeBigUInt64LE(v & MASK, i * 8)); return out; }
function words(bytes) { return Array.from({ length: bytes.length / 8 }, (_, i) => bytes.readBigUInt64LE(i * 8)); }
export function unsigned(value) {
  let remaining = BigInt(value); if (remaining < 0n) throw new RangeError('Unsigned wire integer required');
  const bytes = [];
  do { bytes.push(Number(remaining & 127n) | (remaining > 127n ? 128 : 0)); remaining >>= 7n; } while (remaining);
  return Buffer.from(bytes);
}
export function message(fields) {
  return Buffer.concat(fields.flatMap(([number, value]) => {
    const numeric = typeof value === 'number' || typeof value === 'bigint';
    const payload = numeric ? unsigned(value) : Buffer.isBuffer(value) ? value : Buffer.from(value);
    return [unsigned(number * 8 + (numeric ? 0 : 2)), ...(numeric ? [] : [unsigned(payload.length)]), payload];
  }));
}
export function simonBlocks(input, keyBytes, decrypt = false) {
  if (input.length % 16 || keyBytes.length !== 32) throw new RangeError('Invalid block/key size');
  const keys = words(keyBytes); const sequence = 0x3dc94c3a046d678bn;
  for (let i = 4; i < 72; i++) {
    const t = rotate(keys[i - 1], 61) ^ keys[i - 3];
    keys.push((keys[i - 4] ^ t ^ rotate(t, 63) ^ (MASK - 3n) ^ ((sequence >> BigInt((i - 4) % 62)) & 1n)) & MASK);
  }
  const blocks = [];
  for (let offset = 0; offset < input.length; offset += 16) {
    let [left, right] = words(input.subarray(offset, offset + 16));
    for (let step = 0; step < 72; step++) {
      const x = decrypt ? left : right;
      const round = (rotate(x, 1) & rotate(x, 8)) ^ rotate(x, 2) ^ keys[decrypt ? 71 - step : step];
      [left, right] = decrypt ? [right ^ round, left] : [right, left ^ round];
    }
    blocks.push(wordBytes([left, right]));
  }
  return Buffer.concat(blocks);
}
export function speckBlocks(input, key) {
  if (input.length % 16 || key.length !== 32) throw new RangeError('Invalid block/key size');
  const [first, ...l] = words(key); const schedule = [first];
  for (let round = 0; round < 33; round++) {
    l.push(((rotate(l[round], 56) + schedule[round]) & MASK) ^ BigInt(round));
    schedule.push(rotate(schedule[round], 3) ^ l[round + 3]);
  }
  const encrypted = [];
  for (let offset = 0; offset < input.length; offset += 16) {
    let [a, b] = words(input.subarray(offset, offset + 16));
    for (const k of schedule) { b = ((a + rotate(b, 56)) & MASK) ^ k; a = rotate(a, 3) ^ b; }
    encrypted.push(wordBytes([a, b]));
  }
  return Buffer.concat(encrypted);
}
function ladon(seconds, appId, salt, licenseId = '1611921764') {
  const key = Buffer.from(digest('md5', Buffer.concat([salt, Buffer.from(String(appId))])).toString('hex'));
  return Buffer.concat([salt, speckBlocks(padded(Buffer.from(`${seconds}-${licenseId}-${appId}`)), key)]).toString('base64');
}
// Matched byte-for-byte against the official 7.4.5.32 SDK and checked by a
// controlled live request. This component alone is not a complete signer:
// the server also requires a request- and device-bound Medusa value.
export function heliosHeader(seconds, salt = randomBytes(4)) {
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 0xffffffff ||
      !Buffer.isBuffer(salt) || salt.length !== 4) throw new RangeError('Invalid signature timestamp/nonce');
  return ladon(seconds, '8662', salt, '646637794');
}
export function playbackHeaders(query, body, seconds = Math.floor(Date.now() / 1000), entropy = randomBytes(8)) {
  const params = new URLSearchParams(query); const appId = params.get('aid') || '1967';
  const bodyHash = body.length ? digest('md5', body) : Buffer.alloc(16);
  const fields = [
    [1, 1077940818], [2, 2], [3, entropy.readUInt32LE(4)], [4, appId],
    [5, params.get('device_id') || ''], [6, '1611921764'], [7, params.get('version_name') || ''],
    [8, 'v04.04.05-ov-android'], [9, 134744640], [10, Buffer.alloc(8)], [11, 0],
    [12, (BigInt(seconds) * 2n) & 0xffffffffn], [13, digest('sm3', bodyHash).subarray(0, 6)],
    [14, digest('sm3', query ? Buffer.from(query) : Buffer.alloc(16)).subarray(0, 6)],
    [15, message([[1, 1], [2, 1], [3, 1], [7, 3348294860]])],
    [16, params.get('iid') || ''], [20, 'none'], [21, 738],
    [23, message([[1, 'NX551J'], [2, 8196], [4, 2162219008]])], [25, 2],
  ];
  const prefix = Buffer.from('f2f7fcfff2f7fcff', 'hex');
  const blocks = simonBlocks(padded(message(fields)), Buffer.from('fc78e0a9657a0c748ce51559903ccf03510e51d3cff232d71343e88a321c5304', 'hex'));
  const framed = Buffer.concat([prefix, blocks, Buffer.from('eafb2cfe8568519154', 'hex')]);
  for (let i = prefix.length; i < framed.length; i++) framed[i] ^= prefix[i % prefix.length];
  const cipher = createCipheriv('aes-128-cbc', Buffer.from('d31e3718288a1027baab59f146a09a9c', 'hex'), Buffer.from('ea180a0336ed352fcd24e4d50018ae54', 'hex'));
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([framed.reverse(), Buffer.from('ao')])), cipher.final()]);
  return { 'x-ss-req-ticket': String(seconds * 1000), 'x-khronos': String(seconds),
    'x-ladon': ladon(seconds, appId, entropy.subarray(0, 4)),
    'x-argus': Buffer.concat([Buffer.from('f281', 'hex'), encrypted]).toString('base64'),
    ...(body.length ? { 'x-ss-stub': bodyHash.toString('hex').toUpperCase() } : {}) };
}
function envelopeKey(seed) { return digest('sha512', Buffer.concat([digest('sha512', seed), REGISTRATION_SALT])); }
export function registrationEnvelope(data, nonce = randomBytes(32)) {
  const packed = gzipSync(Buffer.from(JSON.stringify(data))); const key = envelopeKey(nonce);
  const cipher = createCipheriv('aes-128-cbc', key.subarray(0, 16), key.subarray(16, 32));
  return Buffer.concat([Buffer.from('746305100000', 'hex'), nonce, cipher.update(Buffer.concat([digest('sha512', packed), packed])), cipher.final()]);
}
export function unwrapMediaAddress(encoded, seed) {
  const wire = Buffer.from(encoded, 'base64');
  if (wire[0] !== 168 || wire[2] !== 1 || wire[3] !== 0 || wire.length < 20) throw new Error('Unsupported media address envelope');
  const key = envelopeKey(Buffer.from(seed, 'base64')); const encrypted = wire.subarray(4, 4 + Math.floor((wire.length - 4) / 16) * 16);
  const cipher = createDecipheriv('aes-128-cbc', key.subarray(0, 16), key.subarray(16, 32));
  return Buffer.concat([cipher.update(encrypted), cipher.final()]).toString('utf8').replace(/\0+$/, '');
}
export function mediaKey(encoded) {
  const data = Buffer.from(encoded, 'base64url');
  const length = Math.min(data.length - 1, data.length - (data[0] ^ data[1] ^ data[2]) + 47);
  if (length < 33) throw new Error('Invalid media key envelope');
  const decoded = Buffer.alloc(length); const lanes = [246, 85];
  for (let i = 0; i < length; i++) {
    let bits = i, ones = 0; while (bits) { ones++; bits &= bits - 1; }
    decoded[i] = (lanes[i % 2] ^ data[i + 1]) - 21 - ones; lanes[i % 2] = data[i + 1];
  }
  const value = decoded.subarray(1, 33).toString('ascii');
  if (!/^[0-9a-f]{32}$/i.test(value)) throw new Error('Invalid media key format');
  return Buffer.from(value, 'hex');
}
