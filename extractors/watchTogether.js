// 从两家官网“一起看”目录抽样播放，确认正片后登记房号和能辨认节目的标题。
// 两家都会在专区中混排其他分类，同一主播也可能改播解说、综艺或带货。
const filmTitles = {
  huya: new Map([
    ['11342412', /星爷经典|周星驰电影/],
    ['11342396', /纪晓岚/],
    ['23740156', /庆(?:余|yu)年/i],
    ['11342384', /水浒传/],
  ]),
  douyu: new Map([
    ['431460', /二营长.{0,8}意大利炮|亮剑/],
    ['4549169', /港剧间/],
    ['12655359', /神探狄仁杰/],
  ]),
}

const otherContent = /解说|说电影|影评|速看|看完|盘点|混剪|剪辑|片段|集锦|预告|花絮|reaction|综艺|音乐|点歌|带货|购物|闲聊|陪聊|试玩|游戏/i

export function isWatchTogetherFilm(platform, room, category) {
  if (category !== '一起看' || room.name === room.nick || otherContent.test(room.name)) return false
  return filmTitles[platform].get(room.roomId)?.test(room.name) ?? false
}
