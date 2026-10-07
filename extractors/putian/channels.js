/**
 * 莆田广播电视台三路电视频道，取流与节目单共用。
 *
 * 取自「莆田TV」App 与官网直播页（www.ptbtv.com/live/）共用的 M2O 接口 mapi.ptbtv.com/api/v1/channel.php：
 * - id：接口的 channel_id，节目单接口 program.php 也用它；
 * - stream：live1.ptbtv.com 上的路径名（pttv1、pttv2、xytv）。
 * 官网把三路叫「莆田1套」「莆田2套」「仙游电视」；一套是新闻综合频道，二套 2024-08 由公共频道
 * 更名为文旅生活频道；仙游电视台是仙游县融媒体中心的频道，挂在莆田台的平台上播。
 * 同一张表里另有两路广播、四路直播间和「直播未开始」「第三方拉流」这类占位，不收。
 *
 * 台标留空：接口给的一套、仙游是整台宣传图，二套是「莆田二套」旧名频道标；而且图床 image.ptbtv.com
 * 与接口同在网宿人机验证后面，浏览器 UA 回 403，本机台标托管取不到。三台都按名收进内置台标库
 * （logo-pack）：二套用那张频道标，一套、仙游用官网页头的莆田台台标（仙游台角也是这个标）。
 */
export const CHANNELS = Object.freeze([
  Object.freeze({ id: 4, ref: 'putian-news', stream: 'pttv1', name: '莆田新闻综合' }),
  Object.freeze({ id: 5, ref: 'putian-culture', stream: 'pttv2', name: '莆田文旅生活' }),
  Object.freeze({ id: 6, ref: 'putian-xianyou', stream: 'xytv', name: '仙游电视台' }),
])

export const CHANNEL_BY_REF = new Map(CHANNELS.map(channel => [channel.ref, channel]))
export const CHANNEL_BY_ID = new Map(CHANNELS.map(channel => [String(channel.id), channel]))
