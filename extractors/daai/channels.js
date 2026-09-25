/**
 * 大爱电视两路频道：取流（api.js）与节目单（epg.js）共用的频道表。
 *
 * url 是官网移动版直播页 (m.daai.tv/v3/live) 写死的官方 HLS；
 * schedule 是同一页面频道配置里 playlist 字段的频道段
 * （daai.tv/api/live/json/v1.1/<schedule>/{date}），一台是 ch1、二台是 ch3。
 *
 * logo 是同一份频道配置里每台的 thumbnail_url：官方 App 图片桶里的频道卡（640×360 JPEG，
 * 一台是慈济会徽 +「大愛」，二台是「DaAi2 HD」），两台分得开。桌面官网只有整台的「大愛電視」
 * 站标，没有分台图标。图床 s3.hicloud.net.tw 不挑 Referer；大陆多数 DNS 解析不出这个域名，
 * 服务端走系统代理才托管得到。
 */
export const CHANNELS = Object.freeze([
  Object.freeze({
    ref: 'daai-tv1',
    name: '大爱一台',
    url: 'https://pulltv1.wanfudaluye.com/live/tv1.m3u8',
    schedule: 'ch1',
    logo: 'https://s3.hicloud.net.tw/daaiapp/images/ch1.jpg',
  }),
  Object.freeze({
    ref: 'daai-tv2',
    name: '大爱二台',
    url: 'https://pulltv2.wanfudaluye.com/live/tv2.m3u8',
    schedule: 'ch3',
    logo: 'https://s3.hicloud.net.tw/daaiapp/images/ch3.jpg',
  }),
])
