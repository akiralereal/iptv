/**
 * 荔枝网匿名 Web 令牌的请求签名：取流（api.js）与节目单（epg.js）共用。
 *
 * 只放纯计算，不发请求、不 import 项目内部模块——节目单拆出去单独维护时整份带走即可。
 */
import { createHash, randomBytes } from 'node:crypto'

export const AUTH_URL = 'https://api-auth-lizhi.jstv.com/JwtAuth/GetWebToken'

// 官网网页包公开携带的 Web 应用参数。它们不是用户凭据，但属于易变的平台实现细节。
const APP_ID = '3b93c452b851431c8b3a076789ab1e14'
const APP_SECRET = '9dd4b0400f6e4d558f2b3497d734c2b4'

export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

function flattenForSign(value) {
  if (value && typeof value === 'object') {
    if (Array.isArray(value)) return value.map(flattenForSign).join('')
    return Object.keys(value).sort().map(key => key + flattenForSign(value[key])).join('')
  }
  return String(value)
}

/** 官网对秒级时间戳逐字节翻转后作为 TT；位运算结果有意保持 JS signed int32。 */
export function encodeTimestamp(seconds) {
  const value = Math.trunc(Number(seconds))
  const bytes = [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255]
    .map(byte => ((byte & 0xf0) ^ 0xf0) | (((byte & 0x0f) + 1) & 0x0f))
  return bytes[3] | (bytes[2] << 8) | (bytes[1] << 16) | (bytes[0] << 24)
}

export function buildAuthRequest(now = Date.now(), uuid = randomBytes(16).toString('hex')) {
  const seconds = Math.floor(Number(now) / 1000)
  const body = { platform: 41, uuid, appId: APP_ID }
  const path = `/JwtAuth/GetWebToken?AppID=${APP_ID}`
  const sign = createHash('md5')
    .update(`${APP_SECRET}${path}${flattenForSign(body)}${seconds}`)
    .digest('hex')
  return {
    url: `${AUTH_URL}?AppID=${APP_ID}&TT=${encodeTimestamp(seconds)}&Sign=${sign}`,
    body,
  }
}

/** JWT 的 exp（毫秒）；解不开返回 0，由调用方给保守有效期。 */
export function tokenExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'))
    return Number(payload.exp) * 1000
  } catch {
    return 0
  }
}
