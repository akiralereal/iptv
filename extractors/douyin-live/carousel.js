// 抖音官网分区用于发现房间，分区本身不代表当场在轮播。
export const CAROUSELS = {
  音乐轮播: {
    slug: 'music', directory: '102', content: /音乐|歌曲|唱片|金曲|老歌|歌单|音乐会|\bMV\b/i,
    publishers: /唱片|音乐|广播电台|广播电视台/,
    rooms: {
      '24225754530': 'MS4wLjABAAAAnaLc4bfw3wGMMrDIUH6I_MXkq0XCf1_6k1NEwwqgsDo',
    },
  },
  综艺轮播: {
    slug: 'variety', directory: '106', content: /综艺|相声|小品|缘来不晚|男生女生向前冲/,
    publishers: /综艺|节目|广播电视台|卫视|演艺|曲艺/,
    rooms: {
      '32923419266': 'MS4wLjABAAAAhwVqTwF1Q3I1pZFZA4z4oZpmQkEZm7H-DcqaNNnhwA6QnlexVXTwuiPj3OxSR8Xt',
      '38274317216': 'MS4wLjABAAAAId9DdDBeQKST7IG_Hkl7NAYcqdbKx7q4T4pRQz1u4IA',
    },
  },
  动画轮播: {
    slug: 'animation', directory: '104', content: /动画|动漫|卡通|喜羊羊|熊出没/,
    publishers: /动画|动漫|卡通|少儿|广播电视台/,
    rooms: {
      '692362400522': 'MS4wLjABAAAAz_KIRiuZckkRI8JxsgV9bRzFFRCQ64T2GYiJa_dsE4w',
      '754257752446': 'MS4wLjABAAAAZlzaEGgehJMWubo9mTuEHsv_0a9hKcuMyzi9Q5uqaes',
    },
  },
}

const replay = /轮播|连播|连续播[放出]|循环播[放出]|系列展播|回放连映|往期回放合集/
const other = /带货|甄选|上新|购物|折扣|特卖|福利|招募|面试|报名|配音|解说|混剪|玩具|拆卡|抽卡|游戏|陪聊|真人点歌|现场点歌|访谈|见面会|生日直播|预告|预约|即将|明[天日]|取消|暂停|停播|不[再做]?(?:轮播|连播)|佛教|道教|基督教|宗教|讲经|布道/

export function hasCarouselTitle(kind, title) {
  return !other.test(title) && replay.test(title) && kind.content.test(title)
}

export async function matchesCarousel(kind, row, certificate) {
  if (!row.ownerId || !/^\d{1,16}$/.test(row.id)) return false
  const owner = kind.rooms[row.id]
  if (owner && owner !== row.ownerId) return false
  // 此房有橱窗。房号、账号与核验过的老唱片节目标题必须同时匹配。
  if (kind.slug === 'music' && row.id === '24225754530' && owner && /^重温[粵粤]语天王歌后经典金曲汇$/.test(row.title)) return true
  if (row.hasGoods !== false || !hasCarouselTitle(kind, row.title)) return false
  return Boolean(owner) || kind.publishers.test(await certificate(row.ownerId))
}

const refKinds = new Map(Object.values(CAROUSELS).map(kind => [kind.slug, kind]))
export function parseCarouselRef(ref) {
  const m = /^douyincarousel-([a-z]+)-(\d{1,16})$/.exec(ref)
  const kind = m && refKinds.get(m[1])
  return kind ? { kind, id: m[2] } : null
}
