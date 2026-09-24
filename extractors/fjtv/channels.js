/**
 * 福建省级六路、厦门三路与福州三路的固定频道表：取流（api.js）与节目单（epg.js）共用，纯数据、不 import 任何东西。
 *
 * 省级 id 同时是官网 m2o 取流接口的 channel_id 和云直播平台的 topic_id（节目单按它查）；
 * 厦门 id 同时是看厦门取流接口与节目单接口的 channel_id。
 * 福州 streamId 是福视悦动官网播放器节目单接口的 stream_id。
 * epg: false 表示官方不出节目单：东南卫视与厦视三套的节目单接口只回整点「精彩节目」占位
 * （2026-09-25 往前查到 09-18、往后到次日都是），不去白白请求。
 */

// 省级六路来自官网直播页的固定频道 ID；播放地址在用户打开频道时按官网
// m2o 签名接口获取，不再依赖海博频道表里可能过期或串台的 streams[].hls。
export const PROVINCE_CHANNELS = Object.freeze([
  Object.freeze({ id: '665248990102917120', rawName: '综合频道', name: '福建综合', path: 'zhpd/hd',
    logo: 'https://fyfile.fjtv.net/file/storage1-cloudlivemanage/cloudlivemanage/2024/468/3363c3e049251201.png' }),
  Object.freeze({ id: '665248966136664064', rawName: '东南卫视', name: '东南卫视', path: 'dnpd/hd', epg: false,
    logo: 'https://fyfile.fjtv.net/file/storage1-cloudlivemanage/cloudlivemanage/2024/468/5c0e71b56c10085b.png' }),
  Object.freeze({ id: '665248914378952704', rawName: '新闻频道', name: '福建新闻', path: 'xwpd/hd',
    logo: 'https://fyfile.fjtv.net/file/storage1-cloudlivemanage/cloudlivemanage/2024/468/a8ba93a63f73bd96.png' }),
  Object.freeze({ id: '665248752898248704', rawName: '文旅·体育频道', name: '福建文旅体育', path: 'dspd/hd',
    logo: 'https://fyfile.fjtv.net/file/storage1-cloudlivemanage/cloudlivemanage/2026/468/a506ae5283b09312.png' }),
  Object.freeze({ id: '665248553475870720', rawName: '少儿频道', name: '福建少儿', path: 'child/hd',
    logo: 'https://fyfile.fjtv.net/file/storage1-cloudlivemanage/cloudlivemanage/2024/468/e04ccb9cd4982251.png' }),
  Object.freeze({ id: '665248523855695872', rawName: '海峡卫视', name: '海峡卫视', path: 'haixiapd/hd',
    logo: 'https://fyfile.fjtv.net/file/storage1-cloudlivemanage/cloudlivemanage/2024/468/15411d7dabac026f.png' }),
])

// 看厦门官方频道接口当前提供 3 个值得保留的地面频道。厦门卫视清晰度低且
// 咪咕已有更优来源，与移动电视一起固定排除；第三频道的接口原名是
// 「直播通道3」，对外使用正式频道名。
export const XIAMEN_CHANNELS = Object.freeze([
  Object.freeze({ id: '16', rawNames: Object.freeze(['厦视一套']), name: '厦视一套', path: 'xmtjs1' }),
  Object.freeze({ id: '17', rawNames: Object.freeze(['厦视二套']), name: '厦视二套', path: 'xmtjs2' }),
  Object.freeze({ id: '18', rawNames: Object.freeze(['直播通道3', '厦视三套']), name: '厦视三套', path: 'xmtjs3', epg: false }),
])

// 福视悦动官网播放器公开的三路固定 HLS。它们不经过海博 API，因而海博被
// 讯飞 WAF 拦截时仍可独立工作。只接受这张固定表，避免把活动直播混进频道组。
// 官网节目单只列台里的自办栏目，中间大段空白；少儿频道一天只有一条，不值得出节目单。
// 台标是官网播放器频道列表接口（app.zohi.tv/video/player/streamlist?live_type=1）的 icon 字段：
// 接口给相对路径，按官网图床 img.zohi.tv 拼全（800×450 频道卡）。取流不走这个接口，就写死在这里。
const FUZHOU_LOGO = 'https://img.zohi.tv/a/10001/202211/'

export const FUZHOU_CHANNELS = Object.freeze([
  Object.freeze({ name: '福州综合', url: 'http://live.zohi.tv/video/s10001-fztv-1/index.m3u8', streamId: '804',
    logo: `${FUZHOU_LOGO}7dc00f5410904976c5d8b577209accdd.jpeg` }),
  Object.freeze({ name: '福州生活', url: 'http://live.zohi.tv/video/s10001-fztv-3/index.m3u8', streamId: '801',
    logo: `${FUZHOU_LOGO}1e6fccf484ec0e4ae1246af0382484e3.jpg` }),
  Object.freeze({ name: '福州少儿', url: 'http://live.zohi.tv/video/s10001-fztv-4/index.m3u8', streamId: '795', epg: false,
    logo: `${FUZHOU_LOGO}c30842306796c86665249c5db6f47ba4.jpg` }),
])
