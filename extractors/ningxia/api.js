/**
 * 宁夏广播电视台：黄河云（宁夏网络广播电视台）公开的三套电视直播，直连不代理。
 *
 * 由 tv-lab/ningxia-live-lab 验证后移植，此前这三条写在精选列表 IPTV.m3u 里。实测（2026-09-25）：
 * - 入口地址固定：hls.nxhhy.cn/live/<频道>1M.m3u8 先 302 到带 session 参数的 index.m3u8，
 *   播放器跟随跳转即可；清单与分片都不校验 Referer、不挑 UA，去掉 session 参数分片照样 200。
 *   所以频道直接给 url，播放器直连官方 CDN，本机不转发媒体。
 * - 宁夏经济（nxjj1M）、宁夏少儿（nxse1M）入口仍在出流，但实验台核对过只循环测试卡，不收。
 *
 * 台标留空：黄河云节目单接口里的频道图（web.ningxiahuangheyun.com/upload/column/…）是带背景的
 * 16:9 宣传图，不是频道图标；官网 nxtv.com.cn 也没有干净的频道台标。三台在内置台标库里都有
 * （宁夏卫视取自央视频、宁夏文旅用宁夏台台标、宁夏公共取自公开台标库，出处见 logo-pack/index.json）。
 */

export const NXTV_MEDIA_ORIGIN = 'https://hls.nxhhy.cn'
const MEDIA_HOST = 'hls.nxhhy.cn'
const MEDIA_PATH_PREFIX = '/live/'

// key 是黄河云节目单接口里的频道代号（menu[].ename），stream 是直播入口文件名
export const CHANNELS = Object.freeze([
  Object.freeze({ ref: 'ningxia-nxws', key: 'nxws', name: '宁夏卫视', stream: 'nxws1M.m3u8' }),
  Object.freeze({ ref: 'ningxia-nxgg', key: 'nxgg', name: '宁夏公共', stream: 'nxgg1M.m3u8' }),
  Object.freeze({ ref: 'ningxia-nxwl', key: 'nxwl', name: '宁夏文旅', stream: 'nxwl1M.m3u8' }),
])

/** 频道表写进播放列表前统一校验，免得改错一条 stream 名就把用户导去别处。 */
export function officialHlsUrl(stream) {
  const url = new URL(`${MEDIA_PATH_PREFIX}${String(stream || '').trim()}`, NXTV_MEDIA_ORIGIN)
  if (url.protocol !== 'https:' || url.username || url.password || url.port
      || url.hostname !== MEDIA_HOST || !url.pathname.startsWith(MEDIA_PATH_PREFIX)
      || !/^[a-z]+1M\.m3u8$/.test(url.pathname.slice(MEDIA_PATH_PREFIX.length))
      || url.search || url.hash) {
    throw new Error('宁夏广电频道表里有非官方直播地址')
  }
  return url.href
}

export function buildChannels() {
  return CHANNELS.map(channel => ({
    name: channel.name,
    url: officialHlsUrl(channel.stream),
    groupTitle: '宁夏',
    opts: ['network-caching=3000'],
    catchup: 'none',
  }))
}
