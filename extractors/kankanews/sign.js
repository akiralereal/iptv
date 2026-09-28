/**
 * 看看新闻（SMG）接口验签，取流（api.js）与节目单（epg.js）共用。
 *
 * 只依赖 node:crypto，不 import 项目里的其它模块——节目单拆出去时连它一起搬走即可。
 */
import { createHash, randomBytes } from 'node:crypto'

// v2 详情接口虽然仍返回成功，但它生成的播放 token 会被 CDN 拒绝（HTTP 403）。
// 官网兼容的 v1 / 2.42.15 组合生成的同一条 HLS 地址可正常取回。
const APP_VERSION = '2.42.15'
const API_VERSION = 'v1'
const SIGN_SALT = '28c8edde3d61a0411511d3b1866f0636'
const NONCE_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const UUID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

// 必须与 utils/appUtils.js / utils/hlsProxy.js 的上游 UA 一致。官网把 UA 的 MD5
// 写进播放 token；取详情和随后代理清单/分片若不是同一个 UA，CDN 会直接 403。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export const UPSTREAM_HEADERS = {
  Origin: 'https://live.kankanews.com',
  Referer: 'https://live.kankanews.com/huikan',
}

function randomString(length, alphabet) {
  const bytes = randomBytes(length)
  return Array.from(bytes, byte => alphabet[byte % alphabet.length]).join('')
}

function md5(value) {
  return createHash('md5').update(value).digest('hex')
}

/** 官网请求头：公共字段与业务参数排序拼接，末尾加盐后连续 MD5 两次。 */
export function buildSignedHeaders(params = {}, options = {}) {
  const common = {
    platform: 'pc',
    version: APP_VERSION,
    nonce: String(options.nonce || randomString(8, NONCE_ALPHABET)),
    timestamp: Math.floor(Number(options.now ?? Date.now()) / 1000),
    'Api-Version': API_VERSION,
  }
  const all = { ...params, ...common }
  const canonical = Object.keys(all).sort()
    .filter(key => all[key] != null)
    .map(key => `${key}=${all[key]}&`)
    .join('') + SIGN_SALT
  return {
    ...common,
    sign: md5(md5(canonical)),
    'm-uuid': String(options.uuid || randomString(21, UUID_ALPHABET)),
    Accept: 'application/json',
    'User-Agent': UA,
    ...UPSTREAM_HEADERS,
  }
}
