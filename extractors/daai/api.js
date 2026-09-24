/**
 * 大爱电视官网：两路固定公开 HLS。
 *
 * 与贵州 / 甘肃那类模块不同，这里没有需要现算的签名——官网移动版直播页
 * (m.daai.tv/v3/live) 上写死的就是下面两条地址，长期未变。之所以仍然走
 * deferredRef + resolve，是因为上游按 Referer 做防盗链：清单和 .ts 分片
 * 都要带官网 Referer 才 200，裸请求一律 403。而 upstreamHeaders 只有
 * resolve() 能返回，频道对象上没有别的口子。
 */
import { CHANNELS } from './channels.js'

export { CHANNELS }

export const DAAI_ORIGIN = 'https://m.daai.tv'
export const DAAI_PAGE = `${DAAI_ORIGIN}/v3/live`

// 官方推流域名按台分开；路径前缀固定，媒体分片与清单同目录。
const MEDIA_HOSTS = new Set(['pulltv1.wanfudaluye.com', 'pulltv2.wanfudaluye.com'])
const MEDIA_PATH_PREFIX = '/live/'

const CHANNEL_BY_REF = new Map(CHANNELS.map(channel => [channel.ref, channel]))

/** 全代理登记清单与分片前统一校验，避免官方清单把回源引到白名单之外。 */
export function officialAssetUrl(raw) {
  let url
  try {
    url = new URL(String(raw || '').trim())
  } catch {
    throw new Error('大爱电视返回了无效媒体地址')
  }
  if (url.protocol !== 'https:' || url.username || url.password || !['', '443'].includes(url.port)
      || !MEDIA_HOSTS.has(url.hostname) || !url.pathname.startsWith(MEDIA_PATH_PREFIX)
      || /%2f|%5c/i.test(url.pathname) || url.hash) {
    throw new Error('大爱电视返回了非官方媒体地址')
  }
  return url.href
}

/**
 * 本机代取清单或分片时补齐的请求头。
 *
 * 实测只有 Referer 是硬门（缺了清单和分片都 403），Origin 跟着一起发是与
 * 官网播放器保持一致。User-Agent 由代理层统一改写，这里不声明。
 */
export function upstreamHeadersFor(raw) {
  officialAssetUrl(raw)
  return { Referer: DAAI_PAGE, Origin: DAAI_ORIGIN }
}

export function buildChannels() {
  return CHANNELS.map(channel => ({
    name: channel.name,
    deferredRef: channel.ref,
    logo: '',
    groupTitle: '台湾',
    opts: ['network-caching=3000'],
    catchup: 'none',
  }))
}

export function claimsRef(ref) {
  return CHANNEL_BY_REF.has(String(ref || ''))
}

/** 地址是常量，这里不打网络；上游是否健在由代理层回源时暴露。 */
export async function resolveChannel(ref) {
  const channel = CHANNEL_BY_REF.get(String(ref || ''))
  if (!channel) return { url: '', desc: '大爱电视频道引用格式错误' }
  return {
    url: channel.url,
    desc: `${channel.name}官方直播地址`,
    upstreamHeaders: upstreamHeadersFor,
    upstreamUrlTransform: officialAssetUrl,
  }
}
