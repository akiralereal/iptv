/**
 * 宁波广电集团四路电视频道（宁波广电网 www.ncmc.nbtv.cn「直播」页 NBTV1–NBTV4）。
 *
 * - number：官网直播页路径 /gbds/folder8458/NBTV<number>/ 与 CDN 流名 nbtv<number>_* 里的编号；
 * - rawName：官网直播页和频道资料（JSONP 的 C_Name）里只写「NBTV1」这类编号；
 * - name：官网首页「频道频率」栏的正式名（新闻综合频道、经济生活频道、都市文体频道、影视剧频道），
 *   按规则补市名、去掉「频道」。
 *
 * 台标留空：官网直播页、首页、节目单页都没有频道图标，频道资料（JSONP）的 imagePath 是空的，
 * 页头只有「宁波广电网」站标（logo.png，白字版 logo_tv_replace.png）。四张 NBTV 台徽加编号的图
 * 按名收进内置台标库（logo-pack）。
 */
export const CHANNELS = Object.freeze([
  Object.freeze({ number: 1, ref: 'ningbo-news', name: '宁波新闻综合', rawName: 'NBTV1' }),
  Object.freeze({ number: 2, ref: 'ningbo-economy', name: '宁波经济生活', rawName: 'NBTV2' }),
  Object.freeze({ number: 3, ref: 'ningbo-city', name: '宁波都市文体', rawName: 'NBTV3' }),
  Object.freeze({ number: 4, ref: 'ningbo-drama', name: '宁波影视剧', rawName: 'NBTV4' }),
])

export const CHANNEL_BY_REF = new Map(CHANNELS.map(channel => [channel.ref, channel]))

export const livePage = channel => `https://www.ncmc.nbtv.cn/gbds/folder8458/NBTV${channel.number}/index.shtml`
