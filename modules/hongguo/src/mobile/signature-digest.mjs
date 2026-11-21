import { digest as hash } from './wire.mjs';
import profile from './signature-profile.json' with { type: 'json' };
const constants = Buffer.from(profile.roundConstants, 'base64');
const rr = (x, n) => (x >>> (n & 31)) | (x << (-n & 31));
export function selector(bytes) {
  let value = 0x20230928;
  for (let i = 0; i < bytes.length; i++)
    value =
      (i % 2
        ? ~((value >>> 7) ^ value ^ (bytes[i] | (value << 12)))
        : (value >>> 4) ^ value ^ (value << 6) ^ bytes[i]) >>> 0;
  return value & 15;
}
export function checkDigest(bytes) {
  let value = 0x20220420;
  for (let i = 0; i < 12; i++)
    value =
      (i % 2
        ? ~(bytes[i] | (value << 11)) ^ (value >>> 5) ^ value
        : bytes[i] ^ (value << 7) ^ (value >>> 3) ^ value) >>> 0;
  return (((value | 4) ^ 0x1000000) | 0x20) >>> 0;
}
const indexBytes = Buffer.from(profile.digestOrders);
const seeds = profile.digestRotations;
export function requestDigest(query, body, seconds) {
  if (
    !Buffer.isBuffer(body) ||
    !Number.isSafeInteger(seconds) ||
    seconds < 0 ||
    seconds > 0xffffffff
  )
    throw new RangeError('Invalid request digest input');
  const stamp = Buffer.alloc(4);
  stamp.writeUInt32LE(seconds);
  const q = hash('sm3', Buffer.from(query)),
    b = body.length ? hash('md5', body) : Buffer.alloc(16),
    input = Buffer.concat([q, b, stamp]);
  const branch = selector(input);
  if (branch % 3 !== 2) return null;
  const variant = (branch - 2) / 3,
    s = (seeds[variant] + seconds) >>> 0;
  const block = Buffer.alloc(64);
  input.copy(block);
  const tail = Buffer.from('8496779dd4150bf8', 'hex');
  for (let i = 0; i < 8; i++) block[52 + i] = (tail[i] * 257) >>> ((s + 5) & 7);
  block.writeUInt32LE(416, 60);
  const state = [0x79e0f2fb, 0xc8b52570, 0xebc2f8cd, 0x7c104d93].map((x) =>
    rr(x, s),
  );
  let [a, c1, c2, c3] = state;
  const rotations = [
    [7, 12, 17, 22],
    [5, 9, 14, 20],
    [4, 11, 16, 23],
    [6, 10, 15, 21],
  ];
  for (let step = 0; step < 64; step++) {
    const phase = step >>> 4;
    let f =
      phase === 0
        ? (c1 & c2) | (~c1 & c3)
        : phase === 1
          ? (c1 & c3) | (c2 & ~c3)
          : phase === 2
            ? c1 ^ c2 ^ c3
            : c2 ^ (c1 | ~c3);
    const m = block.readUInt32LE(indexBytes[variant * 64 + step] * 4),
      k = rr(constants.readUInt32LE(4 * step), s + 1 + phase);
    const next =
      (c1 + rr((a + f + m + k) >>> 0, -rotations[phase][step % 4])) >>> 0;
    [a, c1, c2, c3] = [c3, next, c1, c2];
  }
  const out = Buffer.alloc(20),
    last = [a, c1, c2, c3],
    mask = [0x19be4866, 0xe85986b4, 0xe19b326e, 0x71d1d7d4];
  for (let i = 0; i < 4; i++)
    out.writeUInt32LE(((last[i] + state[i]) ^ rr(mask[i], s + 6)) >>> 0, i * 4);
  out.writeUInt32LE(checkDigest(out), 16);
  return { digest: out, branch, queryHash: q };
}
