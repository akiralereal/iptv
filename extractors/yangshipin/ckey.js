import { randomBytes, randomUUID } from 'node:crypto'

const PLATFORM = 4330403
const APP_VERSION = 'V8.22.1035.3031'
const CKEY_TEA_KEY = Buffer.from('59b2f7cf725ef43c34fdd7c123411ed3', 'hex')
const GUARD_TEA_KEY = Buffer.from('110DBEC10C23E7D2E56A1CAD6914EF1B', 'hex')
const CKEY_XOR = Buffer.from([0x84, 0x2e, 0xed, 0x08, 0xf0, 0x66, 0xe6, 0xea, 0x48, 0xb4, 0xca, 0xa9, 0x91, 0xed, 0x6f, 0xf3])
const GUARD_XOR = Buffer.from([0xb3, 0xc9, 0x53, 0xa0, 0x69, 0x13, 0xad, 0x4d])

function u32(value) {
  return value >>> 0
}

function teaEncryptBlock(block, key) {
  let y = block.readUInt32BE(0)
  let z = block.readUInt32BE(4)
  const k = [0, 4, 8, 12].map(offset => key.readUInt32BE(offset))
  let sum = 0
  for (let i = 0; i < 16; i++) {
    sum = u32(sum + 0x9e3779b9)
    y = u32(y + u32(u32((z << 4) + k[0]) ^ u32(z + sum) ^ u32((z >>> 5) + k[1])))
    z = u32(z + u32(u32((y << 4) + k[2]) ^ u32(y + sum) ^ u32((y >>> 5) + k[3])))
  }
  const out = Buffer.allocUnsafe(8)
  out.writeUInt32BE(y, 0)
  out.writeUInt32BE(z, 4)
  return out
}

function checksum(buffer) {
  let value = 0
  for (const byte of buffer) value = (Math.imul(0x83, value) + byte) & 0x7fffffff
  return value >>> 0
}

/** Tencent/QQ TEA 的八字节反馈模式，央视频客户端票据沿用该封装。 */
function encryptTeaPacket(input, key, random = randomBytes) {
  const padLength = (8 - ((input.length + 10) % 8)) % 8
  const plain = Buffer.concat([
    Buffer.from([(random(1)[0] & 0xf8) | padLength]),
    random(padLength),
    random(2),
    input,
    Buffer.alloc(7),
  ])
  const output = []
  let previousPlain = Buffer.alloc(8)
  let previousCipher = Buffer.alloc(8)
  for (let offset = 0; offset < plain.length; offset += 8) {
    const source = Buffer.from(plain.subarray(offset, offset + 8))
    const mixed = Buffer.allocUnsafe(8)
    for (let i = 0; i < 8; i++) mixed[i] = source[i] ^ previousCipher[i]
    const encrypted = teaEncryptBlock(mixed, key)
    const cipher = Buffer.allocUnsafe(8)
    for (let i = 0; i < 8; i++) cipher[i] = encrypted[i] ^ previousPlain[i]
    output.push(cipher)
    previousPlain = mixed
    previousCipher = cipher
  }
  return Buffer.concat(output)
}

function lengthPrefixed(value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')
  const size = Buffer.allocUnsafe(2)
  size.writeUInt16BE(data.length)
  return Buffer.concat([size, data])
}

function uint32(value) {
  const out = Buffer.allocUnsafe(4)
  out.writeUInt32BE(value >>> 0)
  return out
}

function guardTail(value) {
  const text = String(value)
  return text.length >= 5 ? text.slice(-5) : ''
}

function createGuard(timestamp, guid, random) {
  const body = Buffer.concat([
    uint32(timestamp),
    lengthPrefixed(guardTail(guid)),
    lengthPrefixed(guardTail('null')),
    lengthPrefixed(guardTail('null')),
    lengthPrefixed('-1'),
  ])
  const plain = Buffer.concat([lengthPrefixed(body)])
  const encrypted = Buffer.concat([encryptTeaPacket(plain, GUARD_TEA_KEY, random), uint32(checksum(plain))])
  for (let i = 0; i < encrypted.length; i++) encrypted[i] ^= GUARD_XOR[i & 7]
  return encrypted.toString('hex').toUpperCase()
}

function buildPacket({ channelId, timestamp, guid, guard, uid }) {
  const body = Buffer.concat([
    Buffer.from('0000004200000004000004d2', 'hex'),
    uint32(PLATFORM),
    uint32(0),
    uint32(timestamp),
    lengthPrefixed('dcgh'),
    lengthPrefixed('_zj1A5Gh6QYcxWjIUGos2w=='),
    lengthPrefixed(APP_VERSION),
    lengthPrefixed(channelId),
    lengthPrefixed(guid),
    uint32(1),
    uint32(1),
    lengthPrefixed(uid),
    lengthPrefixed('nil'),
    lengthPrefixed('57eab0c4-2c58-44c6-8ae9-dd2757525dc5'),
    lengthPrefixed('nil'),
    lengthPrefixed('v0.1.000'),
    lengthPrefixed('com.cctv.yangshipin.app.iphone'),
    lengthPrefixed(String(PLATFORM)),
    lengthPrefixed('ex_json_bus'),
    lengthPrefixed('ex_json_vs'),
    lengthPrefixed(guard),
  ])
  const packet = Buffer.allocUnsafe(body.length + 2)
  packet.writeUInt16BE(body.length, 0)
  body.copy(packet, 2)
  packet.writeUInt32BE(checksum(packet), 18)
  return packet
}

function customBase64(buffer) {
  return buffer.toString('base64').replace(/\+/g, '_').replace(/\//g, '-').replace(/=+$/g, '')
}

export function createCKey(channelId, options = {}) {
  const timestamp = Math.floor(Number(options.now ?? Date.now()) / 1000)
  const guid = options.guid || randomBytes(16).toString('hex')
  const random = options.randomBytes || randomBytes
  const guard = createGuard(timestamp, guid, random)
  // 包体里的 uid 字段：实测服务端完全不校验它——换成随机值、纯数字乃至空字符串，
  // 可播频道照样可播、需登录的频道照样回 iretcode=25。既然不校验就每次随机，
  // 不留一个固定不变的客户端特征。cKey 是防篡改的客户端指纹而非身份凭证，
  // 想解锁需登录的频道不必在这里下手，登录态在 HTTP 参数或 Cookie 那一层。
  const uid = options.uid || randomBytes(4).toString('hex').toUpperCase()
  const packet = buildPacket({ channelId: String(channelId), timestamp, guid, guard, uid })
  const encrypted = Buffer.concat([encryptTeaPacket(packet, CKEY_TEA_KEY, random), uint32(checksum(packet))])
  for (let i = 0; i < encrypted.length; i++) encrypted[i] ^= CKEY_XOR[i & 15]
  return {
    cKey: `--01${customBase64(encrypted)}`,
    guid,
    timestamp,
    flowId: `${randomUUID().toUpperCase()}_${PLATFORM}`,
  }
}

export const clientConstants = Object.freeze({ platform: PLATFORM, appVersion: APP_VERSION })
