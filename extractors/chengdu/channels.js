/** 看度官方 App 的 192 栏目；频道编号来自用户提供的可运行脚本，已逐台核对官方响应。 */
import { OFFICIAL_LOGOS } from './logos.js'

const rows = [
  ['cdtv1', 1, '成都新闻综合', 'CDTV-1 新闻综合频道'],
  ['cdtv2', 2, '成都经济资讯', 'CDTV-2 经济资讯频道'],
  ['cdtv3', 3, '成都都市生活', 'CDTV-3 都市生活频道'],
  ['cdtv4', 45, '成都影视文艺', 'CDTV-4 影视文艺频道'],
  ['cdtv5', 5, '成都公共', 'CDTV-5 公共频道'],
  ['cdtv6', 6, '成都少儿', 'CDTV-6 少儿频道'],
  ['cdrcxf', 15, '成都蓉城先锋', '蓉城先锋'],
  ['jy', 1698, '简阳新闻综合', '简阳市广播电视台', 'jianyang'],
  ['pz', 796, '彭州电视台', '彭州市广播电视台', 'pengzhou'],
  ['qbj', 966, '青白江电视台', '青白江融媒体中心', 'qingbaijiang'],
  ['pj', 828, '蒲江电视台', '蒲江电视台', 'pujiang'],
  ['dy', 790, '大邑综合', '大邑广播电视台', 'dayi'],
  ['jt', 840, '金堂电视台', '金堂电视台', 'jintang'],
  ['ql', 1427, '邛崃综合', '邛崃电视台综合频道', 'qionglai'],
  ['pd', 845, '郫都新闻综合', '郫都区广播电视台', 'pidu'],
  ['sl', 557, '双流综合', '双流区广播电视台', 'shuangliu'],
  ['wj', 559, '温江电视台', '温江电视台', 'wenjiang'],
  ['xd', 1712, '新都电视台', '新都区广播电视台', 'xindu'],
  ['ch', 1319, '成华有线电视', '成华有线电视', 'chenghua'],
  ['wh', 1766, '武侯电视台', '武侯电视', 'wuhou'],
  ['jn', 556, '金牛电视台', '金牛区有线电视台', 'jntv'],
  ['qy', 910, '青羊电视台', '青羊区融媒体中心', 'qingyang'],
  ['jj', 1541, '锦江电视', '锦江电视', 'jinjiang'],
  ['gx', 722, '成都高新电视台', '高新电视台', 'gaoxin'],
  ['cz', 1257, '崇州电视台', '崇州电视台', 'chongzhou'],
  ['djy', 1314, '都江堰电视台', '都江堰电视台', 'dujiangyan'],
  ['xj', 760, '新津电视台', '新津电视台', 'xinjin'],
]

// 旧接口 thumb / thumb_mob 的 xysj.cditv.cn 已不可用；优先取新版官网移动直播页的 cmsimg 频道图。
// 龙泉旧入口持续 404，未确认可用官方替代源，暂不收录。
// 崇州、都江堰、新津的官方图暂缺：外链字段留空，由附有资料库出处的内置包兜底。
export const CHANNELS = Object.freeze(rows.map(([id, code, name, rawName, stream]) => {
  const main = !stream
  const base = id === 'cdrcxf' ? 'dangjiao' : id
  return Object.freeze({
    id, code, name, rawName, main, ref: `chengdu-${id}`,
    logo: OFFICIAL_LOGOS[rawName]?.url || '',
    // 官方 CDN 主机与路径会调整，地址校验只认 cditv.cn 域；streamKeys 用于防止拿到别台地址。
    streamKeys: Object.freeze(main ? [base, `${base}high`] : [stream]),
  })
}))

export const CHANNEL_BY_REF = new Map(CHANNELS.map(channel => [channel.ref, channel]))
