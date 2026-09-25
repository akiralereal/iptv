/**
 * GOOD TV 两路频道：取流（api.js）与节目单（epg.js）共用的频道表。
 *
 * stream 是官方 HLS 路径里的频道段；schedule 是官网直播页取节目单用的频道名
 * （api.goodtv.tv/Channel/Live/<schedule>，即 GOODTV + 页面的 ch 参数）。
 *
 * logo 是两台直播页各自的分享图（og:image，upload.goodtv.tv/file/channel/ch<N>.jpeg）：
 * 640×360 的频道卡，一张「GOODTV」、一张「GOOD2」，两台分得开。官网别处只有一张 GOODTV+
 * 站点 logo，还挡在 AWS WAF 后面，脚本取不到；节目表接口不带图。upload.goodtv.tv 在大陆被
 * 污染连不上，它是 CloudFront 分发 d1zx2ha9m044be 的别名（CNAME），直接写分发域名，
 * 大陆探针实测可取、内容逐字节相同——与取流用 CloudFront 线路是同一做法。
 */
const LOGO_BASE = 'https://d1zx2ha9m044be.cloudfront.net/file/channel/'

export const CHANNELS = Object.freeze([
  Object.freeze({
    ref: 'goodtv-main',
    name: 'GOODTV',
    page: 'https://www.goodtv.tv/tv-channel?ch=1',
    stream: 'live-ch1',
    schedule: 'GOODTV1',
    logo: `${LOGO_BASE}ch1.jpeg`,
  }),
  Object.freeze({
    ref: 'goodtv-truth',
    name: 'GOODTV2',
    page: 'https://www.goodtv.tv/tv-channel?ch=2',
    stream: 'live-ch2',
    schedule: 'GOODTV2',
    logo: `${LOGO_BASE}ch2.jpeg`,
  }),
])
