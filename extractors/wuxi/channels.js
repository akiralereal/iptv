/**
 * 无锡广电五路电视频道。
 *
 * 取自无锡博报「直播」分享页（bb-share.wifiwx.com/wxbb/share/live/）内嵌的 window.LIVE_CHANNELS：
 * - id：博报的频道号，节目单接口 ds_program.php 也用它；
 * - stream：bb-live.wifiwx.com 上的路径名（wxtv1…wxtv5，也是太湖明珠网 stream.thmz.com 的同名路径）；
 * - logo：频道表 logo.square 的官方频道图（180x180 不透明 PNG，2022-08 上传、地址不带版本号，写死）。
 * 同一张表里另有六路广播（aac_*），不收。顺序按 wxtv 编号（经济频道台标就是「5」）。
 */
const IMG = 'https://bb-img.wifiwx.com/'

export const CHANNELS = Object.freeze([
  Object.freeze({ id: 4, ref: 'wuxi-news', stream: 'wxtv1', name: '无锡新闻综合', logo: `${IMG}20220801be428e2d4896146a1521f1d12ba3bc1b.png` }),
  Object.freeze({ id: 8, ref: 'wuxi-ent', stream: 'wxtv2', name: '无锡娱乐', logo: `${IMG}20220801ec0e5017ef5adda908172038a3a477f5.png` }),
  Object.freeze({ id: 9, ref: 'wuxi-city', stream: 'wxtv3', name: '无锡都市资讯', logo: `${IMG}20220801c22666cd9a348a2b0458f97fdcbbb68e.png` }),
  Object.freeze({ id: 10, ref: 'wuxi-life', stream: 'wxtv4', name: '无锡生活', logo: `${IMG}20220801a6fb8ba6058cf329f6b9cda2c009b7dc.png` }),
  Object.freeze({ id: 11, ref: 'wuxi-economy', stream: 'wxtv5', name: '无锡经济', logo: `${IMG}202208016797793c42b9f64891b93631e045e9a0.png` }),
])

export const CHANNEL_BY_REF = new Map(CHANNELS.map(channel => [channel.ref, channel]))
export const CHANNEL_BY_ID = new Map(CHANNELS.map(channel => [String(channel.id), channel]))
