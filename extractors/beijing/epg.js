/**
 * 北京广播电视台节目单：取自央视网（utils/cntvEpg.js）。
 *
 * 北京台自己没有：官网北京时间（btime.com，brtn.cn 也跳到这里）的电视页只有编辑挑的几条「节目预告」，
 * 页面脚本只调取流接口；电视频道还要登录才出现；App 加了固、在模拟器里启动即退出，也不信任用户证书，
 * 不再往下。央视网按代号 btv1…btv9 收着北京台各频道（它自己的节目单页只列央视频道，这组代号是逐个
 * 试出来的），咪咕取央视频道节目单走的也是央视网。
 *
 * 代号：btv1 北京卫视、btv2 文艺、btv3 纪实科教、btv4 影视、btv5 财经、btv6 体育、btv7 生活、
 * btv8 青年（本模块不收）、btv9 新闻。btv6 连续多天都是空的；卡酷少儿没试出代号，不出节目单。
 */
import { CNTV_EPG_API, createCntvEpg, dayStartMs, parseCntvProgrammes } from '../../utils/cntvEpg.js'

export const EPG_API = CNTV_EPG_API
export { dayStartMs }
export const parseProgrammes = parseCntvProgrammes

// ref 与 api.js 的电视频道一致（beijing-tv-<slug>）；卡酷少儿（se）没有代号
export const EPG_CHANNELS = Object.freeze([
  { slug: 'sn', name: '北京卫视', key: 'btv1' },
  { slug: 'wy', name: 'BRTV文艺', key: 'btv2' },
  { slug: 'kj', name: 'BRTV纪实科教', key: 'btv3' },
  { slug: 'ys', name: 'BRTV影视', key: 'btv4' },
  { slug: 'cj', name: 'BRTV财经', key: 'btv5' },
  { slug: 'ty', name: 'BRTV体育休闲', key: 'btv6' },
  { slug: 'sh', name: 'BRTV i生活', key: 'btv7' },
  { slug: 'xw', name: 'BRTV新闻', key: 'btv9' },
])

export default createCntvEpg({
  id: 'beijing',
  channels: EPG_CHANNELS.map(channel => ({ ref: `beijing-tv-${channel.slug}`, name: channel.name, key: channel.key })),
})
