/**
 * 大象新闻接口的请求签名：请求头带 timestamp（unix 秒）与 sign = SHA-256(盐 + timestamp)。
 *
 * 取流（api.js）与节目单（epg.js）共用。只依赖 node:crypto，节目单拆出去时整份带走即可。
 * 服务端校验时间戳新鲜度（实测偏 2 分钟放行、偏 5 分钟回「timestamp无效」），本机时钟
 * 偏差过大时两条链路会一起失败。
 */
import { createHash } from 'node:crypto'

// 官网 2026-08 播放器公开携带的 Web 请求盐；不是用户凭据，但属于易变实现细节。
const SIGN_SECRET = '6ca114a836ac7d73'

export function buildSignedHeaders(now = Date.now()) {
  const timestamp = String(Math.floor(Number(now) / 1000))
  if (!/^\d{10}$/.test(timestamp)) throw new Error('请求时间无效')
  return {
    sign: createHash('sha256').update(`${SIGN_SECRET}${timestamp}`).digest('hex'),
    timestamp,
  }
}
