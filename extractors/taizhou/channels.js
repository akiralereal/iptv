// 台标留空：和合天台 App「看电视」页（app.ttcmzx.cn/client/lightPage.html?tenant_id=5&id=61）给这一路的
// 频道卡是一张 720×360 的「欢迎点击观看」点击横幅（img.tmuyun.com/assets/20191015/…b38.jpeg），不是台标；
// 趣看播放接口只给地址，天台新闻网（www.ttcmzx.cn）也没有频道标。
// 已按所属电视台台标的规则，把天台县融媒体中心官网站标的图标部分收进内置台标库（logo-pack），由内置库兜底。
export const CHANNELS = Object.freeze([
  Object.freeze({ id: '1783497905770300', ref: 'taizhou-tiantai-hehe', name: '天台和合频道' }),
])

export const CHANNEL_BY_REF = new Map(CHANNELS.map(channel => [channel.ref, channel]))
