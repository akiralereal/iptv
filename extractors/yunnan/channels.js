/**
 * 云南广电七路频道的固定表：取流（api.js）与节目单（epg.js）共用。
 * 纯数据，不 import 任何东西——epg.js 连同本文件拿出去就能单独产出节目单。
 *
 * kind 'yntv' 是云视网省级频道，webName 是官网直播页的频道标识，取流的 getRq 与节目单的
 * getJmd 都按它查；kind 'qicai' 是七彩云端的地方台直播间，按 room 房间名取当前机位，
 * 那边只有机位没有节目单。
 *
 * 台标都是七彩云端目录（queryLivePage）里直播间的 listImg 频道卡。云视网直播页只有文字
 * 频道名、没有台标，省级三套取自同一目录「电视」标签下的直播间：那几间房间名是空的，
 * 只能按图认台，所以写死而不在运行时按名字查。
 */
const QICAI_LOGO = 'https://cdnproduce.yntv.cn/ysxw/HDZB_FABU/'

export const CHANNELS = Object.freeze([
  Object.freeze({
    ref: 'yunnan-satellite', name: '云南卫视', kind: 'yntv', webName: 'yunnanweishi',
    logo: `${QICAI_LOGO}E1951D62616149C4A00E5BCB34643EE9/6BC8335DE8BB4BB18004E863CA296325.png`,
  }),
  Object.freeze({
    ref: 'yunnan-urban', name: '云南都市', kind: 'yntv', webName: 'yunnandushi',
    logo: `${QICAI_LOGO}E1951D62616149C4A00E5BCB34643EE9/FF511558690C490191B6A38048BE847B.png`,
  }),
  Object.freeze({
    ref: 'yunnan-travel', name: '云南康旅', kind: 'yntv', webName: 'yunnangonggong',
    logo: `${QICAI_LOGO}E1951D62616149C4A00E5BCB34643EE9/52EB99B986EF4F97851FA553ED2B4E37.png`,
  }),
  // 澜湄国际没有官方台标可用：七彩云端「电视」「地方台」「广播」三个标签都没有这台，云视网
  // 直播页与首页只有文字，台里另办的澜湄视听（mekonglook.com）大陆探针也连不上，只能留空
  Object.freeze({ ref: 'yunnan-lancang', name: '澜湄国际', kind: 'yntv', webName: 'yunnanguoji', logo: '' }),
  Object.freeze({
    ref: 'yunnan-lincang', name: '临沧综合', kind: 'qicai', room: '临沧综合',
    logo: `${QICAI_LOGO}8805AF7347544A9C8ECCC6789DB4A2C2/A5E97376B5E04AC58072C0B0039ACD61.png`,
  }),
  Object.freeze({
    ref: 'yunnan-nujiang', name: '怒江综合', kind: 'qicai', room: '怒江综合',
    logo: `${QICAI_LOGO}8805AF7347544A9C8ECCC6789DB4A2C2/702F785952DD4829BB0DB63CE6A8B0EE.png`,
  }),
  Object.freeze({
    ref: 'yunnan-zhaotong', name: '昭通综合', kind: 'qicai', room: '昭通综合',
    logo: `${QICAI_LOGO}E1951D62616149C4A00E5BCB34643EE9/7DC1772170DC41C5BFBE73F27C43522D.png`,
  }),
])
