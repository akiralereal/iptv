/**
 * 大爱电视两路频道：取流（api.js）与节目单（epg.js）共用的频道表。
 *
 * url 是官网移动版直播页 (m.daai.tv/v3/live) 写死的官方 HLS；
 * schedule 是同一页面频道配置里 playlist 字段的频道段
 * （daai.tv/api/live/json/v1.1/<schedule>/{date}），一台是 ch1、二台是 ch3。
 */
export const CHANNELS = Object.freeze([
  Object.freeze({
    ref: 'daai-tv1',
    name: '大爱一台',
    url: 'https://pulltv1.wanfudaluye.com/live/tv1.m3u8',
    schedule: 'ch1',
  }),
  Object.freeze({
    ref: 'daai-tv2',
    name: '大爱二台',
    url: 'https://pulltv2.wanfudaluye.com/live/tv2.m3u8',
    schedule: 'ch3',
  }),
])
