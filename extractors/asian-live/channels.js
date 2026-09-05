/**
 * 亚洲直播实验台收敛出的动态公开直播频道。
 *
 * 固定直连源已写入根目录 IPTV.m3u 的独立标记区块；这里只保留必须先访问
 * 官方接口才能取得当前 HLS 地址的频道，避免同一频道同时出现在模块和精选列表。
 * rules 是服务端允许访问的精确媒体边界。
 */
export const SOURCES = [
  {
    id: 'ytn',
    name: 'YTN News',
    group: '韩国',
    page: 'https://m.ytn.co.kr/live_view_cdn.php',
    kind: 'ytn',
    rules: ['ytnlive.ytn.co.kr'],
  },
  {
    id: 'nhk-world',
    name: 'NHK World',
    group: '日本',
    page: 'https://www3.nhk.or.jp/nhkworld/en/live_tv/',
    kind: 'nhk',
    rules: ['masterpl.hls.nhkworld.jp', /^media-[a-z0-9-]+\.hls\.nhkworld\.jp$/],
  },
]

const BY_ID = new Map(SOURCES.map(source => [source.id, source]))

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
      deferredRef: `asian-live-${source.id}`,
      logo: source.logo || '',
      opts: ['network-caching=3000'],
      catchup: 'none',
    })
  }
  return [...groups.values()]
}
