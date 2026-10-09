/**
 * 青岛广播电视台电视频道表：取流（api.js）与节目单（epg.js）共用，纯数据、不 import 任何东西。
 *
 * stream 是官网播放器（www.qtv.com.cn/live/tv/ 的 playerOption.channelName）给 CDN 的路径名，
 * epgChannel 是同一页节目单接口 bls_adapters 的 channel 参数（playerOption.channel）。
 * 2026-10-09 按官网各频道页核对，并逐路解出分片截帧看台标确认：
 * - 官网 QTV-5、QTV-6 两个页面都指向 qtv6at，画面台标是「QTV-5 教育」，所以第五路按 QTV-5 收；
 * - qtv5at 能取到流，但画面是「QTV 青岛电视台 共享美好」台标待机循环，不是电视频道，不收。
 * 官网没有单独的频道图标，台标统一用官网页头的电视台台标（api.js 的 LOGO_URL）。
 */
export const CHANNELS = [
  { ref: 'qingdao-1', stream: 'qtv1at', epgChannel: '1', rawName: 'QTV-1', name: '青岛新闻综合' },
  { ref: 'qingdao-2', stream: 'qtv2at', epgChannel: '2', rawName: 'QTV-2', name: '青岛生活服务' },
  { ref: 'qingdao-3', stream: 'qtv3at', epgChannel: '3', rawName: 'QTV-3', name: '青岛影视' },
  { ref: 'qingdao-4', stream: 'qtv4at', epgChannel: '4', rawName: 'QTV-4', name: '青岛都市' },
  { ref: 'qingdao-5', stream: 'qtv6at', epgChannel: '6', rawName: 'QTV-5', name: '青岛教育' },
]
