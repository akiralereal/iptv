/**
 * 新疆广播电视台七路公开频道的固定频道表：取流（api.js）与节目单（epg.js）共用。
 * 纯数据，不 import 任何东西——epg.js 连同本文件拿出去就能单独产出节目单。
 *
 * channelId 是官网频道接口 TVChannelList 的 Id，也是节目单接口 TVGuideList 的 tvChannelId。
 *
 * XJTV-4 汉语综艺、XJTV-5 维吾尔语影视的禁播标记是按节目打的：电视剧时段多半标着、CDN 同时 404，
 * 其余节目正常（2026-09-25 夜间复查：汉语综艺 10:45–20:11 等几段、维吾尔语影视 09:38–23:29 大部分时段都标着）。
 * 标着的那档播放时报「这档节目官网不提供网络直播」，换档后自动恢复。两台每天约 01:30–08:00 停播，推的是测试卡。
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
    ref: 'xjtv-4', channelId: '16', callSign: 'XJTV-4', name: '新疆汉语综艺',
    path: '/xjtv4/xjtv4stream.m3u8',
    logo: 'https://slststore.xjtvs.com.cn/imgs/2024/09/06/xj_img_20240906105747205*$*1.000',
  }),
  Object.freeze({
    ref: 'xjtv-5', channelId: '17', callSign: 'XJTV-5', name: '维吾尔语影视',
    path: '/xjtv5/xjtv5stream.m3u8',
    logo: 'https://slststore.xjtvs.com.cn/imgs/2024/09/06/xj_img_20240906105806938*$*1.000',
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
