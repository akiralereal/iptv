/**
 * 杭州文广集团五路电视频道（葫芦网 tv.hoolo.tv 看电视页）。
 *
 * - id：葫芦网频道接口 mapi.hoolo.tv/api/v1/channel_detail.php 的 channel_id，看电视页的播放器也用它；
 * - code：直播 CDN 上的路径名（live.hoolo.tv/<code>/hd/live.m3u8，影视、青少·体育在 live3.hoolo.tv）；
 * - rawName：接口里的 name，按它认接口数据。只有「青少·体育频道」是通用名，按规则补市名、去掉「频道」；
 * - logo：频道接口 logo.square 的官方频道图（2020-08 上传、地址不带版本号，写死）。
 *   杭州生活那张是旧版「B」字标，官方没换新图；影视那张只有 80x80。
 * 顺序按官方 HTV1–HTV5 编号（code 即 hztv1–hztv5，与 channel_id 的顺序不同）。
 */
const IMG = 'https://image.hoolo.tv/'

export const CHANNELS = Object.freeze([
  Object.freeze({ id: 16, code: 'hztv1', ref: 'hangzhou-general', name: '杭州综合', rawName: '杭州综合', logo: `${IMG}2020081440758eac386ac9bb46ca2a07b16e5582.png` }),
  Object.freeze({ id: 17, code: 'hztv2', ref: 'hangzhou-pearl', name: '西湖明珠', rawName: '西湖明珠', logo: `${IMG}2020081443d00dd845ec670adae22d7d120be5d2.png` }),
  Object.freeze({ id: 18, code: 'hztv3', ref: 'hangzhou-life', name: '杭州生活', rawName: '杭州生活', logo: `${IMG}20200814e0ee32f6048e644370098512df914e05.png` }),
  Object.freeze({ id: 21, code: 'hztv4', ref: 'hangzhou-film', name: '杭州影视', rawName: '杭州影视', logo: `${IMG}202008145170e1fff3d269abf9a3945d275eb80e.png` }),
  Object.freeze({ id: 20, code: 'hztv5', ref: 'hangzhou-youth', name: '杭州青少体育', rawName: '青少·体育频道', logo: `${IMG}202008145acd1afe9fa08cd99f1e9283e28c59b2.jpg` }),
])

export const CHANNEL_BY_REF = new Map(CHANNELS.map(channel => [channel.ref, channel]))
