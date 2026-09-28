/**
 * 甘肃广电节目单：只有甘肃卫视，取自央视网（utils/cntvEpg.js，代号 gansu）。
 *
 * 甘肃台自己的 getTvProgramList 全空，且本身不是带时间的节目表；五个地面频道
 * （文化影视、移动电视、少儿、科教、公共应急）央视网、央视频都没有收，不出节目单。
 */
import { createCntvEpg } from '../../utils/cntvEpg.js'

// ref 与 api.js 的频道表一致
export const EPG_CHANNELS = Object.freeze([
  { ref: 'gansu-1', name: '甘肃卫视', key: 'gansu' },
])

export default createCntvEpg({ id: 'gansu', channels: EPG_CHANNELS })
