/**
 * 山西广电频道表：取流（api.js）与节目单（epg.js）共用，不 import 任何模块，
 * 节目单连同本文件拿出去就能单独跑。
 *
 * epgKey 是官网直播页频道元素的 d 属性，即节目单文件 /epg/<epgKey>.json 的文件名：
 * 省级 SXTV1～6，地市用城市拼音。
 */

const LOGO_BASE = 'https://imagehhsitehttps.sxrtv.com/images/'

const province = (ref, name, channelCode, epgKey, logo = '') => Object.freeze({ ref, name, kind: 'province', channelCode, epgKey, logo })
const city = (ref, name, itemId, epgKey, logo = '') => Object.freeze({ ref, name, kind: 'city', itemId, epgKey, logo })

// 台名照官网直播页原样收：地市几路台标上打的就是「太原1」「吕梁-1」这种编号，不另起名。
// 公共台标库收了的留空按台名匹配（省级五套与晋中综合），其余用官网直播页下发的台标。
export const CHANNELS = Object.freeze([
  province('shanxi-satellite', '山西卫视', 'q8RVWgs', 'SXTV1'),
  province('shanxi-huanghe', '黄河电视台', 'lce1mC4', 'SXTV2', `${LOGO_BASE}2023/4/27/20234271682583913963_33_s.png`),
  province('shanxi-economy-tech', '山西经济与科技', '4j01KWX', 'SXTV3'),
  province('shanxi-film', '山西影视', 'Md571Kv', 'SXTV4'),
  province('shanxi-society-law', '山西社会与法治', 'p4y5do9', 'SXTV5'),
  province('shanxi-culture-sports-life', '山西文体生活', 'agmpyEk', 'SXTV6'),
  city('shanxi-taiyuan-1', '太原-1', 11, 'taiyuan', `${LOGO_BASE}2024/12/31/202412311735638644669_600.jpg`),
  city('shanxi-shuozhou-1', '朔州-1', 6, 'shuozhou', `${LOGO_BASE}2024/12/31/202412311735638665329_600.jpg`),
  city('shanxi-xinzhou-general', '忻州综合', 3, 'xinzhou', `${LOGO_BASE}2024/12/31/202412311735638682362_600.jpg`),
  city('shanxi-yangquan-news', '阳泉新闻综合', 9, 'yangquan', `${LOGO_BASE}2024/12/31/202412311735638693017_600.jpg`),
  city('shanxi-lvliang-1', '吕梁-1', 1, 'lvliang', `${LOGO_BASE}2024/12/31/202412311735638703220_600.jpg`),
  city('shanxi-jinzhong-general', '晋中综合', 5, 'jinzhong'),
  city('shanxi-changzhi-1', '长治-1', 8, 'changzhi', `${LOGO_BASE}2024/12/31/202412311735638720104_600.jpg`),
  city('shanxi-jincheng-news', '晋城新闻综合', 7, 'jincheng', `${LOGO_BASE}2024/12/31/202412311735637570027_601.jpg`),
  city('shanxi-linfen-1', '临汾-1', 2, 'linfen', `${LOGO_BASE}2024/12/31/202412311735638731479_600.jpg`),
  city('shanxi-yuncheng-1', '运城-1', 4, 'yuncheng', `${LOGO_BASE}2024/12/31/202412311735638742704_600.jpg`),
])
