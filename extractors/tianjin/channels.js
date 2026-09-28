/**
 * 天津广播电视台（津云 WiseTV）频道表：取流（api.js）与节目单（epg.js）共用，不 import 任何模块，
 * 节目单连同本文件与 auth.js 拿出去就能单独跑。
 *
 * channelId 是津云 App 里每路电视频道的 32 位标识：签发直播地址的明文里带它，
 * 节目单接口 /tv/programs/show/<起>/<止>/<channelId> 也用它。
 * 购物频道不收。
 */

// 台标是津云 App 频道卡用的图，放在 WiseTV 自己的图片服务器上：180×180，蓝底「津」字标，
// 右下角 1～6 的序号与底部台名区分七路（2026-09-25 逐张取过：200、image/jpeg / image/png，
// 不看 UA 与 Referer）。
const LOGO_BASE = 'https://s1.wisetv.com.cn/pic/1000/4110/0000/0000/0000/0000/'

const channel = (ref, name, channelId, logo) => Object.freeze({ ref, name, channelId, logo: LOGO_BASE + logo })

// 央视频模块也有「天津卫视」：跨源同台按设计不合并，两边各自保留作备份。
export const CHANNELS = Object.freeze([
  channel('tianjin-satellite', '天津卫视', '30001110000000000000000000000698', '0410/xFpQxxKWBZVNklayssQTKgocGJTdymo5249.jpg'),
  channel('tianjin-news', '天津新闻', '30001110000000000000000000000699', '0410/WvuEgggwHhWXiGlfnKoTgtVFHMpVySd5253.jpg'),
  channel('tianjin-arts', '天津文艺', '30001110000000000000000000000700', '0410/vByNddWwTgIGaVocsVmWWuCXXiwFBrR5260.jpg'),
  channel('tianjin-film', '天津影视', '30001110000000000000000000000701', '0410/BTshVVIHWWZVQCmUuSivILNOKhwORvI5270.jpg'),
  channel('tianjin-city', '天津都市', '30001110000000000000000000000702', '0410/TxPcssZTvIKCjNirynaBZhlfZVHirtV5274.jpg'),
  channel('tianjin-sports', '天津体育', '30001110000000000000000000000692', '0410/WvuEgggwHhWXiGlfnKoTgtVFHMpVyUm5276.jpg'),
  channel('tianjin-education', '天津教育', '30001110000000000000000000000693', '0573/loUWffvGCWBMhbtefFuNvwYQdrUHbFt3564.png'),
])
