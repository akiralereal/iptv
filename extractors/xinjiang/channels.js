/**
 * 新疆广播电视台五路公开频道的固定频道表：取流（api.js）与节目单（epg.js）共用。
 * 纯数据，不 import 任何东西——epg.js 连同本文件拿出去就能单独产出节目单。
 *
 * channelId 是官网频道接口 TVChannelList 的 Id，也是节目单接口 TVGuideList 的 tvChannelId。
 */
export const CHANNELS = Object.freeze([
  Object.freeze({
    ref: 'xjtv-1', channelId: '1', callSign: 'XJTV-1', name: '新疆卫视',
    path: '/xjtv1/xjtv1stream.m3u8',
    logo: 'https://slststore.xjtvs.com.cn/imgs/2024/09/06/xj_img_2024090610562817*$*1.000',
  }),
  Object.freeze({
    ref: 'xjtv-2', channelId: '3', callSign: 'XJTV-2', name: '维吾尔语新闻综合',
    path: '/xjtv2/xjtv2stream.m3u8',
    logo: 'https://slststore.xjtvs.com.cn/imgs/2024/09/06/xj_img_20240906105701646*$*1.000',
  }),
  Object.freeze({
    ref: 'xjtv-3', channelId: '4', callSign: 'XJTV-3', name: '哈萨克语新闻综合',
    path: '/xjtv3/xjtv3stream.m3u8',
    logo: 'https://slststore.xjtvs.com.cn/imgs/2024/09/06/xj_img_20240906105720257*$*1.000',
  }),
  Object.freeze({
    ref: 'xjtv-7', channelId: '21', callSign: 'XJTV-7', name: '新疆体育健康',
    path: '/xjtv10/xjtv10stream.m3u8',
    logo: 'https://slststore.xjtvs.com.cn/imgs/2024/09/06/xj_img_20240906105823916*$*1.000',
  }),
  Object.freeze({
    ref: 'xjtv-8', channelId: '23', callSign: 'XJTV-8', name: '新疆少儿',
    path: '/xjtv12/xjtv12stream.m3u8',
    logo: 'https://slststore.xjtvs.com.cn/imgs/2024/09/06/xj_img_20240906105836950*$*1.000',
  }),
])
