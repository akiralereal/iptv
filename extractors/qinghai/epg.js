/**
 * 青海节目单：只有青海卫视，取自央视网（utils/cntvEpg.js，代号 qinghai）。
 *
 * 云直播平台的 program/list 对四路都只回整点「精彩节目」占位（见 EPG.md）；经济生活、都市、安多卫视
 * 央视网与央视频都没有收（2026-10-08 试过 qhjs、qhsh、qhds、qinghaijingji、anduo、amdo 等代号都是 params error）。
 */
import { createCntvEpg } from '../../utils/cntvEpg.js'

// ref 与 channels.js 的频道表一致
export const EPG_CHANNELS = Object.freeze([
  { ref: 'qinghai-qhws', name: '青海卫视', key: 'qinghai' },
])

export default createCntvEpg({ id: 'qinghai', channels: EPG_CHANNELS })
