/**
 * 亚洲直播实验台收敛出的动态公开直播频道。
 *
 * 固定直连源已写入根目录 IPTV.m3u 的独立标记区块；这里只保留必须先访问
 * 官方接口才能取得当前 HLS 地址的频道，避免同一频道同时出现在模块和精选列表。
 * rules 是服务端允许访问的精确媒体边界。
 *
 * logo 取官网自有的频道标（取流接口都不带图标；YTN cdnurl.js 里的 thumb 是 1280×720 的
 * 「HD LIVE」播放器封面，不是台标）：
 * - YTN：移动版直播页（即 page）的 og:image，200×200 的方形「YTN」标，大陆直连可取。
 * - NHK World：英文直播页 browserconfig 里的方形站标 PNG（与页面上的 logo_world.svg 同图，
 *   SVG 不少播放器画不出来）。www3.nhk.or.jp 大陆连不上（取流的 nhkworld.jp 线路可以），
 *   nhkworld.jp 上找不到这张图，服务端走系统代理才托管得到。
 */
export const SOURCES = [
  {
    id: 'ytn',
    name: 'YTN News',
    group: '韩国',
    page: 'https://m.ytn.co.kr/live_view_cdn.php',
    logo: 'https://m.ytn.co.kr/img/common/ytnlogo_2024.jpg',
    kind: 'ytn',
    rules: ['ytnlive.ytn.co.kr'],
  },
  {
    id: 'nhk-world',
    name: 'NHK World',
    group: '日本',
    page: 'https://www3.nhk.or.jp/nhkworld/en/live_tv/',
    logo: 'https://www3.nhk.or.jp/nhkworld/common/site_images/nw_logo_270x270.png',
    kind: 'nhk',
    rules: ['masterpl.hls.nhkworld.jp', /^media-[a-z0-9-]+\.hls\.nhkworld\.jp$/],
  },
]

const BY_ID = new Map(SOURCES.map(source => [source.id, source]))

/** 频道对外的 deferredRef；取流按它认领频道，节目单（epg.js）也按它对齐。 */
export const sourceRef = source => `asian-live-${source.id}`

export function sourceFromRef(ref) {
  const match = /^asian-live-([a-z0-9][a-z0-9-]{0,47})$/.exec(String(ref || ''))
  return match ? BY_ID.get(match[1]) : undefined
}

export function claimsRef(ref) {
  return !!sourceFromRef(ref)
}

export function buildGroups() {
  const groups = new Map()
  for (const source of SOURCES) {
    if (!groups.has(source.group)) groups.set(source.group, { name: source.group, dataList: [] })
    groups.get(source.group).dataList.push({
      name: source.name,
      deferredRef: sourceRef(source),
      logo: source.logo || '',
      opts: ['network-caching=3000'],
      catchup: 'none',
    })
  }
  return [...groups.values()]
}
