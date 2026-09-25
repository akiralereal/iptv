// 台标留空：嘉兴在线「看电视」页（jyq.jiaxingren.com/dstv/tv）的三张官方频道卡在 Vite 打包资源里
// （/dstv/assets/tv1-<hash>.png…），文件名带哈希、站点重新构建就会变，不能写死；趣看播放接口只给地址。
// 三张频道卡已按名收进内置台标库（logo-pack），由内置库兜底。
export const CHANNELS = Object.freeze([
  Object.freeze({ id: '1675942165226154', ref: 'jiaxing-news', name: '嘉兴新闻综合' }),
  Object.freeze({ id: '1675149625220101', ref: 'jiaxing-culture', name: '嘉兴文化影视' }),
  Object.freeze({ id: '1675149601192103', ref: 'jiaxing-public', name: '嘉兴公共频道' }),
])

export const CHANNEL_BY_REF = new Map(CHANNELS.map(channel => [channel.ref, channel]))
