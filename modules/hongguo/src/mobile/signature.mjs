import { randomBytes } from 'node:crypto';
import { digest as hash, message, heliosHeader } from './wire.mjs';
import { requestDigest } from './signature-digest.mjs';
import { sealEnvelope } from './signature-envelope.mjs';
import protocol from './signature-profile.json' with { type: 'json' };
const boxes = Buffer.from(protocol.substitution, 'base64'),
  magic = Buffer.from(protocol.magic, 'base64'),
  key = Buffer.from(protocol.signKey, 'base64');
// The millisecond ticket is selected locally within 255 ms of the request time
// to use one of five independently verified digest branches. Only one request
// is sent; no native SDK, device token, captured signature or emulator is used.
export class PlaybackSigner {
  constructor({ profile, version, now = Date.now, entropy = randomBytes }) {
    this.profile = profile;
    this.version = version;
    this.now = now;
    this.entropy = entropy;
    this.born = now();
    this.count = 0;
  }
  sign(address, body) {
    const url = new URL(address),
      now = this.now(),
      seconds = Math.floor(now / 1000),
      PROFILE = this.profile,
      APP_VERSION = this.version,
      born = this.born,
      randomBytes = this.entropy;
    let digest, query, ticket;
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      seconds > 0xffffffff ||
      !Buffer.isBuffer(body)
    )
      throw new RangeError('Invalid signing input');
    if (
      url.searchParams.get('aid') !== '8662' ||
      !/^\d{1,24}$/.test(url.searchParams.get('device_id') || '') ||
      !/^\d{1,24}$/.test(url.searchParams.get('iid') || '')
    )
      throw new RangeError('Invalid signing identity');
    for (let attempt = 0; attempt < 256; attempt++) {
      ticket = now - attempt;
      url.searchParams.set('_rticket', String(ticket));
      query = url.search.slice(1);
      digest = requestDigest(query, body, seconds);
      if (digest) break;
    }
    if (!digest) throw Error('Request digest selection failed');
    const flags = Buffer.alloc(8);
    flags.writeUInt32LE(0x0504);
    const encode = (fields) =>
      message(fields.filter(([, v]) => v !== undefined && v !== ''));
    const signed = (n) => BigInt(Math.trunc(n)) * 2n;
    const device = encode([
      [1, 2],
      [2, 2],
      [3, '8662'],
      [4, url.searchParams.get('device_id')],
      [6, APP_VERSION],
      [7, 200],
      [8, 200],
      [9, 4],
      [11, 'wifi'],
      [12, 'Asia/Shanghai'],
      [13, 'zh'],
      [14, 16],
      [15, PROFILE.resolution],
      [22, PROFILE.os],
      [25, signed(now)],
      [26, signed(born)],
      [30, PROFILE.model],
      [31, PROFILE.brand],
      [32, 'panther'],
      [33, 'panther'],
      [34, 'panther'],
      [35, PROFILE.brand],
      [36, 'tensor'],
    ]);
    this.count = (this.count + 1) % 0x7fffffff;
    const count = this.count;
    const env = encode([
      [1, signed(count)],
      [6, 'v04.10.03.04-bugfix'],
      [7, signed(process.pid)],
      [8, 'update_64'],
      [12, device],
      [14, APP_VERSION],
      [15, 4228],
      [19, signed(now)],
    ]);
    const runtime = JSON.stringify({
      cmr: 16777216,
      cmr2: 16777216,
      vpn: 0,
      kd: 0,
      dyn: '',
      do: 0,
      tk: false,
    });
    const data = encode([
      [1, magic],
      [2, 10],
      [3, signed(randomBytes(4).readUInt32LE())],
      [4, '8662'],
      [5, url.searchParams.get('device_id')],
      [6, '646637794'],
      [7, APP_VERSION],
      [8, 'v04.10.03-ml-android'],
      [9, 135529984],
      [10, flags],
      [12, signed(seconds)],
      [13, digest.digest],
      [14, digest.queryHash.subarray(0, 6)],
      [
        15,
        encode([
          [1, signed(count)],
          [2, 1388734],
          [3, 1388734],
          [5, 1388734],
        ]),
      ],
      [17, signed(seconds)],
      [20, 'none'],
      [21, 738],
      [23, env],
      [24, runtime],
    ]);
    const check =
      (0x18000001 |
        ((digest.queryHash[0] & 63) << 14) |
        ((digest.digest[0] & 63) << 8)) >>>
      0;
    return {
      url: url.href,
      headers: {
        'x-khronos': String(seconds),
        'x-ss-req-ticket': String(ticket),
        'x-ss-stub': hash('md5', body).toString('hex').toUpperCase(),
        'x-helios': heliosHeader(seconds, randomBytes(4)),
        'x-medusa': sealEnvelope(
          {
            message: data,
            magic,
            flags,
            nonce: randomBytes(4).readUInt32LE(),
            packedNonce: randomBytes(4).readUInt32LE(),
            check,
          },
          seconds,
          key,
          boxes,
        ),
      },
      branch: digest.branch,
    };
  }
}
