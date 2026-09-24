/**
 * 陕西广电频道表：取流（api.js）与节目单（epg.js）共用，不 import 任何模块，
 * 节目单连同本文件拿出去就能单独跑。
 *
 * key 是官网看电视页（live.snrtv.com）频道按钮的 data-num，同时是
 * ① stream.js 解出来的频道目录 sxbc 分组里的键、② 节目单接口 program/tv?channel= 的参数。
 * 官网还列着影视频道（4，目录里没有播放地址）和乐家购物（6，购物台），都不收。
 */

const LOGO_BASE = 'http://res.cnwest.com/t/site/10001/a209bcf3e52b0593bd2c51ae47c9d6ab/assets/sxtvs2020/images/tv/'

const channel = (ref, name, key, logoFile) => Object.freeze({ ref, name, key, logo: `${LOGO_BASE}${logoFile}.png` })

// 台名跟咪咕同台的叫法走（陕西新闻资讯频道 …），播放列表里两路同名、节目单同一个 tvg-id；
// 咪咕没有的按省台惯例加「陕西」。农林卫视是全国上星频道，照官方台名不加省名。
// 台标是频道目录里每路下发的 logo（官网看电视页的圆形频道图标），文件名与目录一致，
// 8 张实测都是 PNG；官网图片主机只有 HTTP，HTTPS 握手失败。
export const CHANNELS = Object.freeze([
  channel('shaanxi-satellite', '陕西卫视', 'star', 'star'),
  channel('shaanxi-news', '陕西新闻资讯频道', '1', '1'),
  channel('shaanxi-urban-youth', '陕西都市青春频道', '2', '2'),
  channel('shaanxi-silver-age', '陕西银龄频道', '3', '3-1'),
  channel('shaanxi-qinqiang', '陕西秦腔频道', '5', '5'),
  channel('shaanxi-sports-leisure', '陕西体育休闲频道', '7', '7'),
  channel('shaanxi-nonglin', '农林卫视', 'nl', 'nl'),
  channel('shaanxi-mobile', '陕西移动电视', '11', 'yidong'),
])
