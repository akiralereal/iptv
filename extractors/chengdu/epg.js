/**
 * 看度频道详情 billcontent 均为空，官网 playbill 的今明两天 lists 也为空。
 * 央视网已核验 cdtv1 / cdtv5 有今明两天真实编排；cdtv2/3/4/6、cdrcxf 返回 params error。
 * 区县没有可用官方节目单，不按名称猜配。
 */
import { createCntvEpg } from '../../utils/cntvEpg.js'
import { CHANNELS } from './channels.js'

export const EPG_CHANNELS = Object.freeze(CHANNELS
  .filter(channel => ['cdtv1', 'cdtv5'].includes(channel.id))
  .map(channel => Object.freeze({ ref: channel.ref, name: channel.name, key: channel.id })))

export default createCntvEpg({ id: 'chengdu', channels: EPG_CHANNELS })
