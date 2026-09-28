/**
 * 吉林广电节目单：只有延边卫视，取自央视网（utils/cntvEpg.js，代号 yanbian）。
 *
 * 吉林台的 broadcast/programs 只维护广播，电视频道全空；吉林卫视由咪咕 / 央视频覆盖，
 * 其余省级与地市频道央视网没有收。延边卫视是朝鲜语频道，央视网给的节目名就是朝鲜语，照官方原样输出。
 */
import { createCntvEpg } from '../../utils/cntvEpg.js'

// ref 与 api.js 的 BROADCAST_CHANNELS 一致
export const EPG_CHANNELS = Object.freeze([
  { ref: 'jlntv-yanbian', name: '延边卫视', key: 'yanbian' },
])

export default createCntvEpg({ id: 'jlntv', channels: EPG_CHANNELS })
