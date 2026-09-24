/**
 * 南京广电四套电视频道：取流（api.js）与节目单（epg.js）共用，纯数据、不 import 任何东西。
 *
 * 顺序与官网电视脚本里四个直播地址的顺序一致，取流按下标对应。contentId 是牛咔内容号
 * （官网 live/?id= 与 m2.nbs.cn/tv/<id>.html），epgTaskId 是该内容详情 stream_api 里的
 * 节目单任务号，2026-09-25 对照 apigateway.nbs.cn/content/detail 核实。
 */
export const TV_CHANNELS = [
  { name: '南京新闻综合', contentId: '109152', epgTaskId: '39', fallbackUrl: 'https://nklive.nbs.cn/hls/d511bc9d-a694-4453-b3a2-4fc842cc97a1/index.m3u8' },
  { name: '南京教育科技', contentId: '109153', epgTaskId: '40', fallbackUrl: 'https://nklive.nbs.cn/hls/75b3c462-b831-4de7-a34b-5d3221db2069/index.m3u8' },
  { name: '南京十八·生活', contentId: '110094', epgTaskId: '42', fallbackUrl: 'https://nklive.nbs.cn/hls/1173a815-bfdb-4c3c-9f73-89ec37ae7716/index.m3u8' },
  { name: '南京文旅纪录', contentId: '110093', epgTaskId: '43', fallbackUrl: 'https://nklive.nbs.cn/hls/9b2005c4-046c-422f-ba45-e6adc4f4de07/index.m3u8' },
]
