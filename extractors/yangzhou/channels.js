/**
 * 扬州市新闻传媒中心「扬州发布」App（原扬帆）直播的四路电视频道。
 *
 * - id：App 的频道号（频道详情、节目单接口都用它，share.96189.com/client/app/index.html#/channel/<id>）；
 * - url：getChannelDetail 的 playUrl 去掉 t / k 签名参数。实测（2026-09-29）CDN 不校验签名（去掉、改一位、
 *   过期都照样 200），清单与分片也不看 Referer 和 UA，播放器直连即可。官方同一路流挂在
 *   yztv-wshls.homecdn.com 与 yztv-wshls.yzbtv.cn 两个域名，接口按频道随机给其一；统一用 yzbtv.cn
 *   （OV 证书，扬州新闻网传媒有限公司）。哪天开始校验签名，改成播放时调 getChannelDetail 取地址。
 * - 生活频道（236，8bf）清单 404、官方也没有节目表，已停播，不收；仪征、高邮、宝应不在 App 里。
 *
 * 台标留空：频道详情的 logo 是 1080x608 的主持人宣传图；hostUserIcon（ucoss.96189.com/upload/202510/…，
 * 100x100）才是频道台标，但透明底黑字，深色界面上看不清。已裁边、铺白底后按名收进内置台标库（logo-pack）。
 */
const CDN = 'https://yztv-wshls.yzbtv.cn/live/'

export const CHANNELS = Object.freeze([
  Object.freeze({ id: '235', name: '扬州新闻', url: `${CDN}8bb.m3u8` }),
  Object.freeze({ id: '291', name: '扬州民生', url: `${CDN}8bd.m3u8` }),
  Object.freeze({ id: '290', name: '江都频道', url: `${CDN}8c1.m3u8` }),
  Object.freeze({ id: '292', name: '邗江频道', url: `${CDN}8c3.m3u8` }),
])

export const CHANNEL_BY_ID = new Map(CHANNELS.map(channel => [channel.id, channel]))
