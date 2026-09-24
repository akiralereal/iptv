/**
 * GOOD TV 两路频道：取流（api.js）与节目单（epg.js）共用的频道表。
 *
 * stream 是官方 HLS 路径里的频道段；schedule 是官网直播页取节目单用的频道名
 * （api.goodtv.tv/Channel/Live/<schedule>，即 GOODTV + 页面的 ch 参数）。
 */
export const CHANNELS = Object.freeze([
  Object.freeze({
    ref: 'goodtv-main',
    name: 'GOODTV',
    page: 'https://www.goodtv.tv/tv-channel?ch=1',
    stream: 'live-ch1',
    schedule: 'GOODTV1',
  }),
  Object.freeze({
    ref: 'goodtv-truth',
    name: 'GOODTV2',
    page: 'https://www.goodtv.tv/tv-channel?ch=2',
    stream: 'live-ch2',
    schedule: 'GOODTV2',
  }),
])
