// 台标留空：和合天台 App「看电视」页（app.ttcmzx.cn/client/lightPage.html?tenant_id=5&id=61）给这一路的
// 频道卡是一张 720×360 的「天台和合频道 / 欢迎点击观看」点击横幅（img.tmuyun.com/assets/20191015/…b38.jpeg），
// 整张不能当台标用；趣看播放接口只给地址，天台新闻网（www.ttcmzx.cn）也没有频道标。
// 横幅正中的橙色风车就是这路频道的台标（与播出画面左上角的台角一致），已裁出来收进内置台标库（logo-pack），
// 由内置库兜底。
export const CHANNELS = Object.freeze([
  Object.freeze({ id: '1783497905770300', ref: 'taizhou-tiantai-hehe', name: '天台和合频道' }),
])

export const CHANNEL_BY_REF = new Map(CHANNELS.map(channel => [channel.ref, channel]))
