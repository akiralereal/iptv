/**
 * 山东广电九个省级电视频道的固定频道表：取流（api.js）与节目单（epg.js）共用。
 * 纯数据，不 import 任何东西——epg.js 连同本文件拿出去就能单独产出节目单。
 */

// 只收录官网当前九个省级电视频道。国际频道页复用了山东卫视 ID，不能作为独立频道；
// 居家购物固定排除。ref 使用页面 slug，而不是易变的内部数字 ID。
// epgId 是官网直播页节目单脚本（time-shifting-local.js）里的另一套编号，与频道页取流用的
// _pdCid 无关。
export const CHANNELS = [
  { slug: 'sdtv', name: '山东卫视', pageName: '山东卫视', epgId: '24', logo: 'https://file.iqilu.com/custom/new/v2016/webtv/images/wspd.png' },
  { slug: 'qlpd', name: '齐鲁频道', pageName: '齐鲁频道', epgId: '25', logo: 'https://file.iqilu.com/custom/new/v2016/webtv/images/qlpd.png' },
  { slug: 'ggpd', name: '山东新闻', pageName: '新闻频道', epgId: '31', logo: 'https://file.iqilu.com/custom/new/v2016/webtv/images/ggpd.png' },
  { slug: 'typd', name: '山东体育休闲', pageName: '体育休闲频道', epgId: '26', logo: 'https://file.iqilu.com/custom/new/v2016/webtv/images/typd.png' },
  { slug: 'shpd', name: '山东生活', pageName: '生活频道', epgId: '29', logo: 'https://file.iqilu.com/custom/new/v2016/webtv/images/shpd.png' },
  { slug: 'zypd', name: '山东综艺', pageName: '综艺频道', epgId: '28', logo: 'https://file.iqilu.com/custom/new/v2016/webtv/images/zypd.png' },
  { slug: 'nkpd', name: '山东农科', pageName: '农科频道', epgId: '30', logo: 'https://file.iqilu.com/custom/new/v2016/webtv/images/nkpd.png' },
  { slug: 'yspd', name: '山东文旅', pageName: '文旅频道', epgId: '27', logo: 'https://file.iqilu.com/custom/new/v2016/webtv/images/wlpd.png' },
  { slug: 'sepd', name: '山东少儿', pageName: '少儿频道', epgId: '32', logo: 'https://file.iqilu.com/custom/new/v2016/webtv/images/sepd.png' },
]
