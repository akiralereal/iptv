/** Minimal SM2 C1C2C3 implementation for the public Dalian Cloud media handshake. */
import { createHash, randomBytes } from 'node:crypto'

const P = 0xFFFFFFFEFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00000000FFFFFFFFFFFFFFFFn
const A = 0xFFFFFFFEFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00000000FFFFFFFFFFFFFFFCn
const B = 0x28E9FA9E9D9F5E344D5A9E4BCF6509A7F39789F515AB8F92DDBCBD414D940E93n
const N = 0xFFFFFFFEFFFFFFFFFFFFFFFFFFFFFFFF7203DF6B21C6052B53BBF40939D54123n
const G = {
  x: 0x32C4AE2C1F1981195F9904466A39C9948FE30BBFF2660BE1715A4589334C74C7n,
  y: 0xBC3736A2F4F6779C59BDCEE36B692153D0A9877CC62A474002DF32E52139F0A0n,
}

const mod = value => {
  const result = value % P
  return result < 0n ? result + P : result
}

function inverse(value) {
  let a = mod(value)
  if (!a) throw new Error('SM2 point has no inverse')
  let [oldR, r] = [a, P]
  let [oldS, s] = [1n, 0n]
  while (r) {
    const quotient = oldR / r
    ;[oldR, r] = [r, oldR - quotient * r]
    ;[oldS, s] = [s, oldS - quotient * s]
  }
  return mod(oldS)
}

function doubleJacobian(point) {
  if (!point || point.y === 0n) return null
  const yy = mod(point.y * point.y)
  const yyyy = mod(yy * yy)
  const zz = mod(point.z * point.z)
  const s = mod(4n * point.x * yy)
  const m = mod(3n * point.x * point.x + A * zz * zz)
  const x = mod(m * m - 2n * s)
  return {
    x,
    y: mod(m * (s - x) - 8n * yyyy),
    z: mod(2n * point.y * point.z),
  }
}

function addMixed(point, affine) {
  if (!point) return { ...affine, z: 1n }
  const zz = mod(point.z * point.z)
  const u2 = mod(affine.x * zz)
  const s2 = mod(affine.y * point.z * zz)
  const h = mod(u2 - point.x)
  const deltaY = mod(s2 - point.y)
  if (!h) return deltaY ? null : doubleJacobian(point)
  const hh = mod(h * h)
  const i = mod(4n * hh)
  const j = mod(h * i)
  const r = mod(2n * deltaY)
  const v = mod(point.x * i)
  const x = mod(r * r - j - 2n * v)
  return {
    x,
    y: mod(r * (v - x) - 2n * point.y * j),
    z: mod((point.z + h) * (point.z + h) - zz - hh),
  }
}

function scalarMultiply(scalar, point) {
  if (scalar <= 0n || scalar >= N) throw new Error('SM2 private scalar is out of range')
  let result = null
  for (const bit of scalar.toString(2)) {
    if (result) result = doubleJacobian(result)
    if (bit === '1') result = addMixed(result, point)
  }
  if (!result) throw new Error('SM2 point at infinity')
  const zInverse = inverse(result.z)
  const z2 = mod(zInverse * zInverse)
  return { x: mod(result.x * z2), y: mod(result.y * z2 * zInverse) }
}

const hex64 = value => value.toString(16).padStart(64, '0')

function parsePoint(raw) {
  const hex = String(raw || '').replace(/^04/i, '')
  if (!/^[0-9a-f]{128}$/i.test(hex)) throw new Error('SM2 public point is malformed')
  const point = { x: BigInt(`0x${hex.slice(0, 64)}`), y: BigInt(`0x${hex.slice(64)}`) }
  if (point.x >= P || point.y >= P || mod(point.y * point.y) !== mod(point.x ** 3n + A * point.x + B)) {
    throw new Error('SM2 public point is not on the curve')
  }
  return point
}

function randomScalar(randomBytesImpl = randomBytes) {
  for (;;) {
    const bytes = Buffer.from(randomBytesImpl(32))
    if (bytes.length !== 32) throw new Error('SM2 random source must return 32 bytes')
    const scalar = BigInt(`0x${bytes.toString('hex')}`)
    if (scalar > 0n && scalar < N) return scalar
  }
}

function sm3(buffer) {
  return createHash('sm3').update(buffer).digest()
}

function kdf(input, length) {
  const output = Buffer.alloc(length)
  let offset = 0
  for (let counter = 1; offset < length; counter++) {
    const suffix = Buffer.allocUnsafe(4)
    suffix.writeUInt32BE(counter)
    const digest = sm3(Buffer.concat([input, suffix]))
    digest.copy(output, offset, 0, Math.min(digest.length, length - offset))
    offset += digest.length
  }
  return output
}

function hasNonZero(buffer) {
  for (const byte of buffer) if (byte) return true
  return false
}

export function generateSm2KeyPair(options = {}) {
  const privateScalar = randomScalar(options.randomBytesImpl)
  const publicPoint = scalarMultiply(privateScalar, G)
  return {
    privateKey: hex64(privateScalar),
    publicKey: `04${hex64(publicPoint.x)}${hex64(publicPoint.y)}`,
  }
}

/** Returns lowercase hex without the optional 04 C1 prefix, matching the current Flutter client. */
export function sm2Encrypt(publicKey, plaintext, options = {}) {
  const target = parsePoint(publicKey)
  const message = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8')
  for (;;) {
    const ephemeral = randomScalar(options.randomBytesImpl)
    const c1 = scalarMultiply(ephemeral, G)
    const shared = scalarMultiply(ephemeral, target)
    const xy = Buffer.from(`${hex64(shared.x)}${hex64(shared.y)}`, 'hex')
    const mask = kdf(xy, message.length)
    if (message.length && !hasNonZero(mask)) continue
    const c2 = Buffer.alloc(message.length)
    for (let index = 0; index < message.length; index++) c2[index] = message[index] ^ mask[index]
    const c3 = sm3(Buffer.concat([
      Buffer.from(hex64(shared.x), 'hex'), message, Buffer.from(hex64(shared.y), 'hex'),
    ]))
    return `${hex64(c1.x)}${hex64(c1.y)}${c2.toString('hex')}${c3.toString('hex')}`
  }
}

export function sm2Decrypt(privateKey, ciphertext) {
  const privateHex = String(privateKey || '')
  if (!/^[0-9a-f]{64}$/i.test(privateHex)) throw new Error('SM2 private key is malformed')
  const privateScalar = BigInt(`0x${privateHex}`)
  if (privateScalar <= 0n || privateScalar >= N) throw new Error('SM2 private key is malformed')
  const hex = String(ciphertext || '').replace(/^04/i, '')
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length < 192 || hex.length % 2) throw new Error('SM2 ciphertext is malformed')
  const c1 = parsePoint(hex.slice(0, 128))
  const c2 = Buffer.from(hex.slice(128, -64), 'hex')
  const c3 = hex.slice(-64).toLowerCase()
  const shared = scalarMultiply(privateScalar, c1)
  const xy = Buffer.from(`${hex64(shared.x)}${hex64(shared.y)}`, 'hex')
  const mask = kdf(xy, c2.length)
  const message = Buffer.alloc(c2.length)
  for (let index = 0; index < c2.length; index++) message[index] = c2[index] ^ mask[index]
  const digest = sm3(Buffer.concat([
    Buffer.from(hex64(shared.x), 'hex'), message, Buffer.from(hex64(shared.y), 'hex'),
  ])).toString('hex')
  if (digest !== c3) throw new Error('SM2 ciphertext integrity check failed')
  return message
}
