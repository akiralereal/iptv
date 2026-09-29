/**
 * 泉州下辖县级市台的固定频道表，取流与节目单共用。
 *
 * 两台都是各自融媒体中心官网直播页（ijjnews.com/live、chinashishi.net 直播栏目）播的那一路，
 * 地址长期不变、不带签名，也不看 Referer 与 UA，CDN 放行跨域。实测（2026-09-29）：
 * - 晋江：官网频道列表只有「晋江电视台」一路，720p；台角是黄色「J」球标加「晋江市电视台」，
 *   和官网频道图一致，台标直接用这张。
 * - 石狮：官网频道列表只有「石狮新闻综合频道」一路，1080p；官网频道图是节目宣传海报、不是台标，
 *   官网、H5 与「看石狮」App 里都没有台角那个 SSTV 彩色标，台标留空，由内置台标库兜底
 *   （石狮市融媒体中心官网页头的狮子标）。
 *
 * 节目单：两台官网直播页用同一套云直播接口 cloudlive-manage-mapi/api/topic/program/list，
 * app_secret 写在各自官网的页面脚本里，按 topic_id（官网频道 id）取，见 epg.js。
 */
export const CHANNELS = Object.freeze([
  Object.freeze({
    id: 'jinjiang',
    name: '晋江电视台',
    url: 'https://live.ijjnews.com/jjtv/sd/live.m3u8',
    logo: 'https://filestorage.ijjnews.com/file/storage1-cloudlivemanage/cloudlivemanage/2026/1067/0f5007bcbfe40cd8.jpg',
    epg: Object.freeze({
      api: 'https://mapi.ijjnews.com/cloudlive-manage-mapi/api/topic/program/list',
      topicId: '657527900022525952',
      appSecret: '31ca2c44a23e6cd127ddee647fa9cf92',
      referer: 'https://www.ijjnews.com/live/',
    }),
  }),
  Object.freeze({
    id: 'shishi',
    name: '石狮新闻综合',
    url: 'https://live-new.chinashishi.net/SSTV/sd/live.m3u8',
    epg: Object.freeze({
      api: 'https://mapi-new.chinashishi.net/cloudlive-manage-mapi/api/topic/program/list',
      topicId: '662611405685436416',
      appSecret: '5c03f9843fa239c14b52222e83098919',
      companyId: '492',
      referer: 'https://www.chinashishi.net/folder113/folder120/',
    }),
  }),
])

export const CHANNEL_BY_ID = new Map(CHANNELS.map(channel => [channel.id, channel]))
