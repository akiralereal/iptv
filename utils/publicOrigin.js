/**
 * 下发给播放器的本机地址（订阅里的频道地址、清单直出里引用本机的地址）用哪个来源。
 *
 * 平时看 Host / X-Forwarded-Host 就够了。但有的反代（Lucky 等）转发时把 Host 换成后端的内网地址、
 * 又不带 X-Forwarded-Host，单看 Host 会把频道地址写成 192.168.x.x：外网播放器拉得到列表、播不了。
 * 这种请求的 X-Forwarded-For / X-Real-IP 里，访问者是公网 IP —— 填了「公网地址」(mhost) 就该用它，
 * README「公网地址」一节一直是这么写的。
 *
 * 转发头客户端自己也能写，但写了的后果只是给它自己的清单换了个前缀，不涉及权限。
 */
import { isPrivateAddress } from './logoCache.js'

/** Host 头是否指向本机 / 内网（沿用原来的判断：localhost、127.0.0.1、192.168.、10.、172. 开头）。 */
export function isLanHostHeader(hostHeader) {
  const name = String(hostHeader || '').split(':')[0]
  return name === 'localhost' || name === '127.0.0.1' || name.startsWith('192.168.') || name.startsWith('10.') || name.startsWith('172.')
}

/** 转发头里的访问者 IP 是不是公网地址；没有转发头、写的不是 IP、或是内网地址都算否。 */
export function cameFromInternet(headers = {}) {
  const forwardedFor = String(headers['x-forwarded-for'] || '').split(',')[0].trim()
  const raw = forwardedFor || String(headers['x-real-ip'] || '').trim()
  if (!raw) return false
  // 个别反代会带端口：[2001:db8::1]:443、203.0.113.9:5678
  const ip = /^\[([^\]]+)\](?::\d+)?$/.exec(raw)?.[1] || raw.replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, '$1')
  return !isPrivateAddress(ip)
}

/**
 * 反代改写了 Host、访问者来自公网、又填了公网地址时，返回公网地址（去掉末尾斜杠）；其余情况返回空串，
 * 调用方照原来的规则用 Host。公网地址不是 http(s):// 开头的（环境变量 mhost 写了裸域名）不用，免得拼出没有协议的地址。
 */
export function proxiedPublicBase(headers = {}, mhost = '') {
  const base = String(mhost || '').trim()
  if (!/^https?:\/\//i.test(base)) return ''
  if (headers['x-forwarded-host'] || !isLanHostHeader(headers.host)) return ''
  return cameFromInternet(headers) ? base.replace(/\/+$/, '') : ''
}
