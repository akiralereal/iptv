import { digest as hash } from './wire.mjs';
const octet = (x) => x & 255;
const rol8 = (x, n) => (((x & 255) << n) | ((x & 255) >>> (8 - n))) & 255;
const mapped = (b, f) => Buffer.from(Array.from(b, f));
const xor = (a, b) => Buffer.from(a.map((v, i) => v ^ b[i]));
const le = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};
const laneOrder = [
  [2, 0, 3, 1],
  [1, 3, 2, 0],
  [3, 2, 1, 0],
  [2, 3, 1, 0],
];
const permutations = [
  [0, 9, 14, 15, 4, 13, 2, 7, 8, 1, 6, 3, 12, 5, 10, 11],
  [0, 9, 14, 11, 4, 13, 2, 3, 8, 1, 6, 15, 12, 5, 10, 7],
  [0, 9, 14, 3, 4, 13, 2, 15, 8, 1, 6, 11, 12, 5, 10, 7],
  [0, 9, 14, 15, 4, 13, 2, 3, 8, 1, 6, 11, 12, 5, 10, 7],
];
const initial = [0xbbb5de72, 0xd4638d5b, 0x92a5f73b, 0x89f8a1c9];
const multiply = (a, b) => {
  let r = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) r ^= a;
    a = ((a << 1) ^ (a & 128 ? 0x11b : 0)) & 255;
    b >>>= 1;
  }
  return r;
};
function cipherFor(key, boxes, stamp) {
  const variant = stamp & 3,
    sbox = boxes.subarray(variant * 256, variant * 256 + 256);
  const lanes = laneOrder[variant],
    order = permutations[variant],
    iv = le(initial[variant]),
    expanded = Buffer.alloc(48);
  for (let i = 0; i < 16; i++) expanded[i] = key[i] ^ iv[i % 4];
  for (let word = 4; word < 12; word++) {
    let tmp = Array.from(expanded.subarray((word - 1) * 4, word * 4));
    if (word % 4 === 0) {
      tmp = [
        sbox[tmp[1]] ^ iv[((8 + 2 * (word - 4)) & 24) / 8],
        sbox[tmp[2]],
        sbox[tmp[3]],
        sbox[tmp[0]],
      ];
    }
    for (let c = 0; c < 4; c++)
      expanded[word * 4 + c] = tmp[c] ^ expanded[(word - 4) * 4 + c];
  }
  const roundKeys = [0, 1, 2].map((r) =>
    Buffer.from(
      Array.from(
        { length: 16 },
        (_, i) => expanded[16 * r + 4 * (i >> 2) + lanes[i % 4]],
      ),
    ),
  );
  const substitution = Array.from(
    { length: 16 },
    (_, i) => 4 * lanes[order[i] >> 2] + (order[i] % 4),
  );
  const columns = Array.from(
    { length: 16 },
    (_, i) => 4 * (i >> 2) + lanes[i % 4],
  );
  function permute(state, p) {
    const result = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) {
      result[i] = state[p[i]];
    }
    return result;
  }
  function mix(state) {
    const matrix = [2, 3, 1, 1],
      out = Buffer.alloc(16);
    for (let c = 0; c < 4; c++)
      for (let r = 0; r < 4; r++)
        for (let k = 0; k < 4; k++)
          out[4 * r + c] ^= multiply(state[4 * k + c], matrix[(k - r + 4) % 4]);
    return out;
  }
  return (input) => {
    let s = xor(input, roundKeys[0]);
    for (let r = 1; r <= 2; r++) {
      s = permute(
        mapped(s, (v) => sbox[v]),
        substitution,
      );
      if (r === 1) s = mix(permute(s, columns));
      s = xor(s, roundKeys[r]);
    }
    return xor(s, expanded.subarray(16, 32));
  };
}
const positions = [6, 5, 3, 4, 2, 7, 1, 0],
  slots = [1, 7, 3, 6, 2, 0, 4, 5];
function sparse(data, tail) {
  const small = Buffer.alloc(32);
  for (let n = 0; n < 31; n++)
    for (let p = 0; p < 8; p++)
      small[n] |= ((data[8 * n + p] >>> positions[p]) & 1) << slots[p];
  small[31] = tail;
  return small;
}
function inject(data, small) {
  const out = Buffer.from(data);
  for (let n = 0; n < 31; n++)
    for (let p = 0; p < 8; p++) {
      const at = 8 * n + p,
        mask = 1 << positions[p];
      out[at] =
        (out[at] & ~mask) | (((small[n] >>> slots[p]) & 1) << positions[p]);
    }
  return out;
}
function material(key, nonce) {
  const hi = (nonce >>> 16) & 255;
  return {
    mask: le(~(((hi << 11) | (nonce >>> 24)) ^ (hi >>> 5) ^ hi)),
    key: hash('sm3', Buffer.concat([key, le(nonce), key])),
  };
}
// Reversal and byte arithmetic are part of the wire format; values wrap to 8 bits.
function transform(input, key) {
  const n = input.length,
    b = Buffer.from(input);
  if (n < 8) throw Error('Short signing message');
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    const a = key[4 * (i % 8)],
      c = key[4 * (i % 8) + 1];
    out[n - 1 - i] = ~((rol8(~octet(rol8(b[i], 4) + a) ^ c, 3) + c) ^ a);
  }
  const tail = out[n - 1] ^ out[n - 2],
    first = out[0];
  out[0] += ~tail;
  out[1] += out[0] ^ out[n - 1] ^ 254;
  out[2] += (tail - first) ^ (rol8(out[1], 3) ^ 2);
  for (let i = 3; i < n - 1; i++)
    out[i] += ~(rol8(out[i - 1], 3) ^ out[i - 2] ^ octet(i));
  out[n - 1] ^= out[n - 2];
  out[0] = (out[0] ^ out[1]) + out.subarray(1).reduce((a, b) => a + b, 0);
  return out;
}
export function sealEnvelope(
  { message, magic, flags, nonce, packedNonce, check },
  stamp,
  key,
  boxes,
) {
  if (
    !Buffer.isBuffer(message) ||
    message.length < 229 ||
    message.length > 32768 ||
    magic.length !== 16 ||
    flags.length !== 8 ||
    key.length !== 32 ||
    boxes.length !== 1024
  )
    throw new RangeError('Invalid signing envelope');
  const m = material(key, nonce),
    stream = mapped(
      Buffer.concat([flags, transform(message, m.key)]).reverse(),
      (v, i) => v ^ m.mask[~i & 3],
    );
  const packed = Buffer.concat([
      Buffer.from([0xca]),
      le(packedNonce),
      le(check),
      stream,
      le(nonce).subarray(2),
    ]),
    small = sparse(packed, 1);
  const cipher = cipherFor(hash('md5', key.subarray(0, 16)), boxes, stamp),
    c1 = cipher(xor(small.subarray(0, 16), hash('md5', key.subarray(16)))),
    encrypted = Buffer.concat([c1, cipher(xor(small.subarray(16), c1))]);
  return Buffer.concat([
    le(5 ^ stamp),
    xor(magic, Buffer.concat([le(stamp), le(stamp), le(stamp), le(stamp)])),
    le(nonce).subarray(0, 2),
    Buffer.from([0, 1, encrypted[31]]),
    inject(packed, encrypted),
  ]).toString('base64');
}
