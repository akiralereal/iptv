/**
 * 宁德市广播电视台两路电视频道。
 *
 * 取自宁德台 App 与分享页（app.0593tv.cn/jhxtapi/jhxt/Live/newsShow/id/<id>）共用的直播详情接口 Live/detail：
 * - id：接口的 lid；同一套 id 里 21、22 是综合广播和交通旅游广播，不收；
 * - logo：详情里的 thumb，512x512 白底频道图标（频道角标同款，2025-10 上传、地址不带版本号，写死）。
 * 二套以前叫公共频道，现在接口、台角都叫「文化旅游」。
 *
 * 节目单：分享页的节目单组件调 Live/getProgram，昨天、今天、明天三天全是 24 条整点「精彩节目」占位，
 * 页面自己也把节目名写死成「精彩节目」，官方没有真节目单；海博地市台同样只有占位（见 EPG.md）。
 */
const IMG = 'https://app.0593tv.cn/files/jhxt/image/'

export const CHANNELS = Object.freeze([
  Object.freeze({ id: 19, name: '宁德新闻综合', logo: `${IMG}20251027/13ad1c04e01f9f254ff66ce2e6d42b2f.jpg` }),
  Object.freeze({ id: 20, name: '宁德文化旅游', logo: `${IMG}20251027/0bcf044dd729275633f0423ef3bd44e3.jpg` }),
])
