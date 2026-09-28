/**
 * 大连云匿名媒体令牌与 ticket 请求头：取流（api.js）与节目单（epg.js）共用。
 *
 * 只放纯计算（SM2 加解密见 sm2.js），不发请求、不 import 项目内部模块——节目单拆出去单独维护时
 * 连同 sm2.js 整份带走即可。
 */
import { generateSm2KeyPair, sm2Decrypt, sm2Encrypt } from './sm2.js'

export const API_ORIGIN = 'https://wan-dlrm.dlrm.cn'
export const API_BASE = `${API_ORIGIN}/app/`
export const API_HOST = 'wan-dlrm.dlrm.cn'
export const APP_VERSION = '5.7.0'
export const UA = `DalianCloud/${APP_VERSION} (Android; MediaX)`
export const SERVER_PUBLIC_KEY = '04195D1F93F950DDCC8C8384DD47DEBBD19B2897753686DE6B2EC87B583578325DF9191865258EB22A08AEFE4AA5E0EAD59D0EFB0187B0649EEF9008222BD3DA22'

// 当前公开客户端内置的应用参数，不是用户凭据
const APP_KEY = 'mediax-dev-app'
const APP_SECRET = '367bde41-4eae-4c59-b151-47fc1ce83153'
const CLIENT_TIME_OFFSET_MS = 3 * 60 * 60 * 1000

export function ticketPlaintext(token, now = Date.now(), secret = APP_SECRET) {
  return JSON.stringify({ token, timestamp: Number(now) + CLIENT_TIME_OFFSET_MS, secret })
}

/** 每次业务请求带的 ticket 头：令牌 + 校正后的时间戳，用服务端公钥 SM2 加密。 */
export function buildTicket(token, now = Date.now(), serverPublicKey = SERVER_PUBLIC_KEY) {
  return sm2Encrypt(serverPublicKey, ticketPlaintext(token, now))
}

/** 匿名换令牌的请求地址（四个参数各自 SM2 加密）与本次临时密钥对（解响应要用）。 */
export function buildTokenRequest(options = {}) {
  const serverPublicKey = options.serverPublicKey || SERVER_PUBLIC_KEY
  const keyPair = generateSm2KeyPair(options)
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries({
    type: 'app', key: APP_KEY, secret: APP_SECRET, publicKey: keyPair.publicKey,
  })) query.set(key, sm2Encrypt(serverPublicKey, value, options))
  const url = new URL(`security/token?${query}`, API_BASE)
  if (url.hostname !== API_HOST) throw new Error('媒体令牌接口域名异常')
  return { url, keyPair }
}

/** 解开换令牌的响应：{ token, timeout }，timeout 为毫秒时间戳；无效或已过期抛错。 */
export function decodeTokenPayload(payload, keyPair, now = Date.now()) {
  if (Number(payload?.status) !== 0 || typeof payload?.data !== 'string') {
    throw new Error(payload?.message || `媒体令牌状态 ${payload?.status}`)
  }
  let decoded
  try { decoded = JSON.parse(sm2Decrypt(keyPair.privateKey, payload.data).toString('utf8')) }
  catch (error) { throw new Error(`媒体令牌解密失败：${error?.message || String(error)}`) }
  const token = String(decoded?.token || '')
  const timeout = Number(decoded?.timeout)
  if (!/^app\.[A-Za-z0-9.]+$/.test(token) || !Number.isSafeInteger(timeout) || timeout <= Number(now)) {
    throw new Error('媒体令牌内容无效或已过期')
  }
  return { token, timeout }
}
