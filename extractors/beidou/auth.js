/** 北斗融媒 Android 4.0.71 的公开直播鉴权协议（authVersion=6）。 */
import { constants, createHash, createPrivateKey, privateDecrypt, randomInt } from 'node:crypto'

// 客户端内置的配置解码材料，用于解开匿名 getOauth 下发的 refer/pullKey，
// 不是用户私钥。原始 DER 为 PKCS#1 RSA 私钥。
const CLIENT_KEY = createPrivateKey({
  key: Buffer.from([
     'MIIEogIBAAKCAQEApmgjiZZk4bgwp6CVh+OOSWbYp5IcIsK6pnSvzm2KAfLDD1Zo',
     'yw52xCjiT4rPfWJ2AUHETdnBhLziDFbnhy6ZoSOBfZm4XyXGYZ5URq0HJaMTbTxG',
     'NsZiCuxTxTJYF1UDConxKaZuOGLHFqvK68DJDBFzcjiyksNlcCViYGVgIXFgGqQ6',
     '3uQtPCdsT4VCtwhrqafjpiDMp7R2lDs/sn9uBE6eHOuEAS3Etn8C4vZARX+vLPa1',
     'bOjKyt7wo/wDWxVQFoRQqEdq1HTP08TME9/US3/FT3QWx9g+/LO4QxsgqNjC2iUL',
     'zfCGrKsQpXMrgdUQ6QkywEFWtM4LheE0l/O5ZwIDAQABAoIBADCcPjlcgha/8BKf',
     'od7C1hdSIFr/HxH2cYDbmFnEfOqpyFpsIwuiK4aM7ONQiOE3SIKAfEBDqrjEVoJF',
     'RrgiIEXGsfaHV6kPx15P2o2U0QApHa0szNQGarCHLcdut/YE4vEKr7S7hfoZvM++',
     'GnZ46CIK3P8SWfPueWzjttOy+Xx7ARb844d7FJlPHukaWlXfF2BMhDKeKidjZ4kq',
     'VEwLpuo3dRMnCnftCumC0Duzj/DLYG3TGGHmMYoZcaAQafdLuJfUPCwSdf03P3kh',
     'BK+BrClG19tVcmRs0QkRyf+uxqs86/vAqCIba1kWfitouZ/y4cz/t1CepsRhZ7zP',
     'UXisgL0CgYEA6YBjHGuClbAThCuSN5edF2jBA1mlF16RLE5jG9sqGxWlvJK00FXX',
     'rB9Ez9wTym4jrfH5PfkNxPMOZLZLnUx10H4RcJ7MZE0r3TixenfeLnQOFOAiHdgH',
     'UdN+/z2nqH5NIfFWlfckVcFjNMSvY18p217oMx9oCzTyZBneV5ZKQZ0CgYEAtnDG',
     'Vk6nUbM4qCHmYz9wgDIBxGxNwG43tBdTMIT7i4LKIhybz/+PQ3J90XU/EOy+X3Je',
     'r1PV141OX72aVaB4Ay6O6osWNpkv1tjfzItfoyQgLbAYw5dIugBSzVckvmptyu20',
     'l/6IIoz/OATbb7X5eNelZabu+qbommovZtF7qdMCgYATcGzP4ONuMsptJnN1zVl2',
     'qXHoJX5pA6ZyWdRGbWiD+LljiZMkBQF/gtrnsxqyr5io0ow9bI6I5vM7zzFcVxE3',
     '2kb5aT762rHcKOwdlf0ZQPArLL2qXmG9ni3kce2TSXCCcuUSdxC/Uuo/amBvlWyW',
     'psAOAX9X74B+dOjdwdVMwQKBgGZ2af35CKGq/Uv4VhMxgvaMn0944CYOALzlSLR8',
     'S2YsG2gTFzM3PXfM6nrj1Xqk67phWmovtG7uDrFYpEAo8p4e3Oc/HEenuyV4AiE3',
     'uYu/c08VkqLu6UqFefuXUKycy3LoE8A1lLGK7J/CopdX5XeH7X1sxtUBPqvSrTKa',
     'vlA/AoGAYcljmW/KxmvoRvpUIB5y0l0ZKsKWQgBkZAph3943jtEiSedcPJksd4Mw',
     'sBdsQ7OTfXitIV0ERx/xM1gXxsMAiDKTCSynqCLHcTF7vYRvapoSrxmgEbxnnyss',
     'EikDUpm6pBwpZ4S53AdfrGsvQFxKz8aLIkOYzVTCGKs/4WlW1/c=',
  ].join(''), 'base64'),
  format: 'der', type: 'pkcs1',
})
const RSA_BLOCK_BYTES = Math.ceil(CLIENT_KEY.asymmetricKeyDetails.modulusLength / 8)

const hash = (algorithm, value) => createHash(algorithm).update(value).digest('hex')

/** 在频道 ID 的四个位置插入同一随机数字，再计算带时间戳的摘要。 */
export function createOauthSign(channelId, now = Date.now(), random = randomInt) {
  if (!/^[a-f0-9]{32}$/.test(channelId)) throw new Error('北斗融媒频道 ID 无效')
  const seconds = Math.floor(Number(now) / 1000)
  if (!Number.isSafeInteger(seconds) || seconds < 1) throw new Error('鉴权时间无效')
  const digit = random(0, 10)
  const a = random(1, 3)
  const b = random(a + 1, 5)
  const c = random(b + 1, 7)
  const d = random(c + 1, 10)
  let text = ''
  let last = 0
  for (const position of [a, b, c, d]) {
    text += channelId.slice(last, position) + digit
    last = position
  }
  text += channelId.slice(last)
  const digest = hash('md5', hash('sha256', text) + seconds).toUpperCase()
  return Buffer.from('' + digit + a + b + c + d + seconds).toString('base64') + digest
}

function decryptValue(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('直播鉴权密文格式错误')
  }
  let encrypted
  try { encrypted = Buffer.from(value, 'base64') }
  catch { throw new Error('直播鉴权密文格式错误') }
  if (encrypted.length !== RSA_BLOCK_BYTES) throw new Error('直播鉴权密文格式错误')
  // Node/OpenSSL 部分版本禁止 RSA_PKCS1_PADDING 私钥解码；按客户端协议
  // 解出 RSA 块后，完整验证 PKCS#1 v1.5 的 00 02 PS 00 填充。
  const block = privateDecrypt({ key: CLIENT_KEY, padding: constants.RSA_NO_PADDING }, encrypted)
  const separator = block.indexOf(0, 2)
  if (block[0] !== 0 || block[1] !== 2 || separator < 10 || separator === block.length - 1) {
    throw new Error('直播鉴权解码失败')
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(block.subarray(separator + 1))
}

export function decodeOauth(payload, streamHost) {
  const data = typeof payload?.data === 'string' ? JSON.parse(payload.data) : payload?.data
  if (Number(payload?.code) !== 200 || !data || data.domain !== streamHost) {
    throw new Error('直播鉴权 CDN 不匹配')
  }
  const remainingSeconds = Number(data.referTimeOut)
  if (!Number.isFinite(remainingSeconds) || remainingSeconds <= 0) throw new Error('直播鉴权已过期')
  const pullKey = decryptValue(data.pullKey)
  const refer = decryptValue(data.refer)
  if (!/^[A-Za-z0-9]{1,64}$/.test(pullKey)) throw new Error('直播拉流密钥格式错误')
  const referer = /^https?:\/\//.test(refer) ? refer : 'http://' + refer
  // 官方返回租户域名，阻止控制字符或非平台地址成为上游请求头。
  if (!/^https?:\/\/[a-z0-9-]+\.bdy\.lnyun\.com\.cn\/?$/.test(referer)) {
    throw new Error('直播 Referer 格式错误')
  }
  return { pullKey, referer, remainingSeconds }
}
