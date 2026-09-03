/** 北斗融媒 Android 4.0.66 的公开直播鉴权协议（authVersion=5）。 */
import { constants, createHash, createPrivateKey, privateDecrypt, randomInt } from 'node:crypto'

// 客户端内置的配置解码材料，用于解开匿名 getOauth 下发的 refer/pullKey，
// 不是用户私钥。原始 DER 实际为 PKCS#8，客户端的 PEM 标签却写成 RSA PRIVATE KEY。
const CLIENT_KEY = createPrivateKey({
  key: Buffer.from([
    'MIICeAIBADANBgkqhkiG9w0BAQEFAASCAmIwggJeAgEAAoGBAMcFKk19QDRaWMgz',
    '55NnzbmAo6vvGMNZl35n6T4yrCiPChCoXvevNW5+Uzp8mWnx9n1jR2SRUChifVgH',
    'cHEigI8CFrW5Vw85WV03JdnA2sKghCN/DsGqwMXwdoNwPot6CJzmZfRCfSo0RZRf',
    '2yrwtu6mbV9L0EvwtNZ6Mqv/RDrNAgMBAAECgYEAp8NG4YMPOBJgfIKkVrFNzW0O',
    'isRFj4ZaGYfmKTP1w0qwJVKImyjqVXXPGqIlgBUivpeNesyzUReUqTu8IOIAkw9+',
    'SoCc9p8LtSoyze84l/hAwHF+QolX/lvsYe0hyR0qJZXIuyERLgRuHb2nqP4RwmwI',
    'lXt/8o2LxpYE+t+iKlECQQDnCKcZ/M9NysFARx9ZBobbYk0I8MCbFEsN6/XEoHU2',
    'TfwgAiRd/GfgkXIs04rM0qf0dgKaz+3OjKs9UxNAEITfAkEA3IbiO+QfpiXOVhIg',
    'sjO8BDAprWp7u+Xn4G8X1JCVF6dpe4fvNcNc7Yhqb1uZg81wBaRjXSzc7lHRjXOC',
    'aIEp0wJBAJIlXhdJXhW2qbKwivr07v/+Wf7K1PwExUmkNw7P9fWJNXFGCZ1OmqNr',
    'Pk9u7gGNTGOO9yzZVXRwda5QTAAdsv8CQG6HEDayVIaCplMPTOHj+hUjSpBHMXLw',
    'fPJI2+nG+WLcnoqyi9snapkG6Umc4Gll+wJo7QBTLvwnd97siOz1588CQQCQ+/6o',
    'i1rctaAa92ifzsUgAsZFZ1ECFhktS9zWxo9YEv7fzbbaefHnDhXKbUh3Aisgo2kY',
    'Tp01Ga+RawIZBo3R',
  ].join(''), 'base64'),
  format: 'der', type: 'pkcs8',
})

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
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{171}=$/.test(value)) {
    throw new Error('直播鉴权密文格式错误')
  }
  // Node/OpenSSL 部分版本禁止 RSA_PKCS1_PADDING 私钥解码；按客户端协议
  // 解出固定 128 字节块后，完整验证 PKCS#1 v1.5 的 00 02 PS 00 填充。
  const block = privateDecrypt({ key: CLIENT_KEY, padding: constants.RSA_NO_PADDING }, Buffer.from(value, 'base64'))
  const separator = block.indexOf(0, 2)
  if (block.length !== 128 || block[0] !== 0 || block[1] !== 2 || separator < 10 || separator === 127) {
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
