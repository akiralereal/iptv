/**
 * 宁夏广播电视台：黄河云（宁夏网络广播电视台）公开的三套电视直播，直连不代理。
 *
 * 由 tv-lab/ningxia-live-lab 验证后移植，此前这三条写在精选列表 IPTV.m3u 里。实测（2026-09-25）：
 * - 入口地址固定：hls.nxhhy.cn/live/<频道>1M.m3u8 先 302 到带 session 参数的 index.m3u8，
 *   播放器跟随跳转即可；清单与分片都不校验 Referer、不挑 UA，去掉 session 参数分片照样 200。
 *   所以频道直接给 url，播放器直连官方 CDN，本机不转发媒体。
 * - 宁夏经济（nxjj1M）、宁夏少儿（nxse1M）入口仍在出流，但实验台核对过只循环测试卡，不收。
 *
 * 两个官方域名（issue #233，2026-11-07 实测）：hls.nxhhy.cn 与 hls.ningxiahuangheyun.com 解析到
 * 同一个腾讯云 CDN 节点、路径一样，但前面的腾讯云 WAF 按出口 IP 放行，两个域名的放行名单不同。
 * 同一批 50 个大陆探针跑两轮结果逐个一致：两个都放行 7 个、只放行后者 4 个（宁波 / 北京移动等）、
 * 只放行前者 3 个（阿里云 / 腾讯云成都）、都拦 35 个（三网家宽基本全拦），海外都拦。官方 App 与
 * 官网下发的仍是 hls.nxhhy.cn。所以每轮刷新由本机各取一次宁夏卫视入口，三台统一用放行的那个域名
 * （一个出口三台结果一样）；都放行或都不放行时用官方在用的 hls.nxhhy.cn。判断看的是服务器的出口，
 * 家里 NAS 和播放器同一个出口时最准。频道身份（identityUrl）始终钉在 hls.nxhhy.cn 的地址上，
 * 换域名不打乱用户的排序、隐藏与配置档。
 *
 * 台标留空：黄河云节目单接口里的频道图（web.ningxiahuangheyun.com/upload/column/…）是带背景的
 * 16:9 宣传图，不是频道图标；官网 nxtv.com.cn 也没有干净的频道台标。三台在内置台标库里都有
 * （宁夏卫视取自央视频、宁夏文旅用宁夏台台标、宁夏公共取自公开台标库，出处见 logo-pack/index.json）。
 */
import { proxyAwareFetch } from '../../utils/systemProxy.js'

// 第一个是官方 App / 官网在用的，两个都放行或都不放行时用它
export const MEDIA_HOSTS = Object.freeze(['hls.nxhhy.cn', 'hls.ningxiahuangheyun.com'])
export const DEFAULT_MEDIA_HOST = MEDIA_HOSTS[0]
const MEDIA_PATH_PREFIX = '/live/'
const PROBE_STREAM = 'nxws1M.m3u8'
const PROBE_TIMEOUT_MS = 8000
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// key 是黄河云节目单接口里的频道代号（menu[].ename），stream 是直播入口文件名
export const CHANNELS = Object.freeze([
  Object.freeze({ ref: 'ningxia-nxws', key: 'nxws', name: '宁夏卫视', stream: 'nxws1M.m3u8' }),
  Object.freeze({ ref: 'ningxia-nxgg', key: 'nxgg', name: '宁夏公共', stream: 'nxgg1M.m3u8' }),
  Object.freeze({ ref: 'ningxia-nxwl', key: 'nxwl', name: '宁夏文旅', stream: 'nxwl1M.m3u8' }),
])

/** 频道表写进播放列表前统一校验，免得改错一条 stream 名或域名就把用户导去别处。 */
export function officialHlsUrl(stream, host = DEFAULT_MEDIA_HOST) {
  if (!MEDIA_HOSTS.includes(host)) throw new Error('宁夏广电频道表里有非官方直播地址')
  const url = new URL(`${MEDIA_PATH_PREFIX}${String(stream || '').trim()}`, `https://${host}`)
  if (url.protocol !== 'https:' || url.username || url.password || url.port
      || url.hostname !== host || !url.pathname.startsWith(MEDIA_PATH_PREFIX)
      || !/^[a-z]+1M\.m3u8$/.test(url.pathname.slice(MEDIA_PATH_PREFIX.length))
      || url.search || url.hash) {
    throw new Error('宁夏广电频道表里有非官方直播地址')
  }
  return url.href
}

/**
 * 从本机出口取一次某域名的宁夏卫视入口，不跟随跳转。
 * → 'pass'（302 到同域名下的会话清单）| 'blocked'（WAF 403）| 'error'（超时、断网、其他状态码）
 */
export async function probeHost(host, { fetchImpl = proxyAwareFetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const entry = officialHlsUrl(PROBE_STREAM, host)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(entry, {
      method: 'GET', redirect: 'manual', headers: { 'User-Agent': UA }, signal: controller.signal,
    })
    // 只看状态和跳转头；403 拦截页、清单正文都不读
    try { await response.body?.cancel() } catch { /* 已关闭 */ }
    if (response.status === 403) return 'blocked'
    if (response.status >= 300 && response.status < 400) {
      let target
      try { target = new URL(response.headers.get('location') || '', entry) } catch { return 'error' }
      return target.hostname === host && target.pathname.startsWith(MEDIA_PATH_PREFIX) ? 'pass' : 'error'
    }
    return 'error'
  } catch {
    return 'error'
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 两个域名并行各探一次，按 MEDIA_HOSTS 顺序取第一个放行的。都没放行时：两边都是明确的 WAF 403
 * 就用默认域名；有一边是超时 / 断网这类说不准的结果，沿用上一轮选中的（previous），免得一次网络
 * 抖动把能播的域名换掉。
 */
export async function pickMediaHost({ fetchImpl, timeoutMs, previous } = {}) {
  const verdicts = await Promise.all(MEDIA_HOSTS.map(host => probeHost(host, { fetchImpl, timeoutMs })))
  const results = Object.fromEntries(MEDIA_HOSTS.map((host, i) => [host, verdicts[i]]))
  const passed = MEDIA_HOSTS.find(host => results[host] === 'pass')
  if (passed) return { host: passed, results }
  const uncertain = verdicts.includes('error')
  return { host: uncertain && MEDIA_HOSTS.includes(previous) ? previous : DEFAULT_MEDIA_HOST, results }
}

export function buildChannels(host = DEFAULT_MEDIA_HOST) {
  return CHANNELS.map(channel => ({
    name: channel.name,
    url: officialHlsUrl(channel.stream, host),
    identityUrl: officialHlsUrl(channel.stream, DEFAULT_MEDIA_HOST),
    groupTitle: '宁夏',
    opts: ['network-caching=3000'],
    catchup: 'none',
  }))
}
