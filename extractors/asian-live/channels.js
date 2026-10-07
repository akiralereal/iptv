/**
 * 亚洲直播实验台、公共直播实验台收敛出的、要经服务端处理的公开直播频道。
 *
 * 固定直连源写在根目录 IPTV.m3u 的独立标记区块；这里只放两类：
 * - 必须先访问官方接口才能取得当前 HLS 地址的频道（YTN、NHK World），清单与媒体都由本机代理；
 * - 地址固定、但官方主清单把低档排在前面的频道（CNA、France 24 English / Français、World Poker Tour）：
 *   服务端转发一次主清单，
 *   把最高档挪到最前（utils/hlsTopFirst.js），子清单和分片仍由播放器直连官方 CDN，网速不够照常降档。
 *   France 24 各语种官方只公开了 1080p、360p 两条单档清单（master.m3u8 回 403），由模块拼成两档主清单。
 *   西语台在海外频道表里，由海外频道模块照同样办法拼（extractors/overseas 的 LADDERS）。
 *   这几台原先写在 IPTV.m3u（只能写死最高档、不能降档），那里的条目留给没升级的部署；
 *   频道标了 supersedesFeatured，新镜像里同组同名的精选频道条目会被收掉（channelMerger）。
 * rules 是服务端允许访问的精确媒体边界。
 *
 * logo 取官网自有的频道标（取流接口都不带图标；YTN cdnurl.js 里的 thumb 是 1280×720 的
 * 「HD LIVE」播放器封面，不是台标）：
 * - YTN：移动版直播页（即 page）的 og:image，200×200 的方形「YTN」标，大陆直连可取。
 * - NHK World：英文直播页 browserconfig 里的方形站标 PNG（与页面上的 logo_world.svg 同图，
 *   SVG 不少播放器画不出来）。www3.nhk.or.jp 大陆连不上（取流的 nhkworld.jp 线路可以），
 *   nhkworld.jp 上找不到这张图，服务端走系统代理才托管得到。
 * - CNA、France 24、World Poker Tour：台标在内置台标库（logo-pack），按台名对上，这里留空。
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
  {
    id: 'cna',
    name: 'CNA',
    group: '国际',
    page: 'https://www.channelnewsasia.com/watch',
    logo: '',
    // 官方主清单 270p 排第一、1080p 排最后；同目录 index_5.m3u8 就是 1080p 那一档
    kind: 'master',
    masterUrl: 'https://d2e1asnsl7br7b.cloudfront.net/7782e205e72f43aeb4a48ec97f66ebbe/index.m3u8',
    rules: ['d2e1asnsl7br7b.cloudfront.net'],
    direct: true,
    supersedesFeatured: true,
  },
  {
    id: 'france24-en',
    name: 'France 24 English',
    group: '国际',
    page: 'https://www.france24.com/en/live',
    logo: '',
    // 两条官方单档清单分片序号、时长对齐，可以当同一组码率切换；BANDWIDTH 按实测峰值略放宽
    kind: 'ladder',
    variants: [
      { url: 'https://live.france24.com/hls/live/2037218-b/F24_EN_HI_HLS/master_5000.m3u8', bandwidth: 5600000, resolution: '1920x1080' },
      { url: 'https://live.france24.com/hls/live/2037218-b/F24_EN_HI_HLS/master_500.m3u8', bandwidth: 760000, resolution: '640x360' },
    ],
    rules: ['live.france24.com'],
    direct: true,
    supersedesFeatured: true,
  },
  {
    id: 'france24-fr',
    name: 'France 24 Français',
    group: '国际',
    page: 'https://www.france24.com/fr/direct',
    logo: '',
    kind: 'ladder',
    variants: [
      { url: 'https://live.france24.com/hls/live/2037179-b/F24_FR_HI_HLS/master_5000.m3u8', bandwidth: 5600000, resolution: '1920x1080' },
      { url: 'https://live.france24.com/hls/live/2037179-b/F24_FR_HI_HLS/master_500.m3u8', bandwidth: 760000, resolution: '640x360' },
    ],
    rules: ['live.france24.com'],
    direct: true,
    supersedesFeatured: true,
  },
  {
    id: 'world-poker-tour',
    name: 'World Poker Tour',
    group: '体育',
    page: 'https://www.samsungtvplus.com/',
    logo: '',
    // Samsung TV Plus 英国区的 Amagi 频道：主清单 360p 排第一；子清单落在区域节点、带长会话串，
    // 服务端取主清单时建立的会话换个 IP 的播放器照样能用（10-06 Globalping 大陆、德、日探针都通）
    kind: 'master',
    masterUrl: 'https://amg00477-samsungelectron-worldpokertour-samsunguk-81igb.amagi.tv/playlist/amg00477-samsungelectron-worldpokertour-samsunguk/playlist.m3u8',
    rules: ['amg00477-samsungelectron-worldpokertour-samsunguk-81igb.amagi.tv'],
    direct: true,
    supersedesFeatured: true,
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
      // 动态取址的频道清单与媒体都经本机代理；最高档前置的频道只转发主清单，地址写成普通入口
      ...(source.direct ? {} : { proxyHls: true }),
      ...(source.supersedesFeatured ? { supersedesFeatured: true } : {}),
    })
  }
  return [...groups.values()]
}
