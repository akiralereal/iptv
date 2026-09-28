/**
 * 长江云官网当前公开展示的六套湖北省级电视直播。
 *
 * epgCode 是长江云 TV（湖北 IPTV）频道表里的 CHANNELCODE，节目单接口按它查（见 epg.js）；
 * 长江云 TV 的 H5 把这几个频道播成与这里相同的 live21-cjy 路径，2026-09-25 核对。
 */

export const CHANNELS = Object.freeze([
  Object.freeze({ id: '431', rawName: '湖北卫视', name: '湖北卫视', streamPath: 'new-hbws', epgCode: '99180001000000050000000000000204' }),
  Object.freeze({ id: '432', rawName: '湖北经视', name: '湖北经视', streamPath: 'new-hbjs', epgCode: '99180001000000050000000000000338' }),
  Object.freeze({ id: '433', rawName: '湖北综合', name: '湖北综合', streamPath: 'new-hbzh', epgCode: '99180001000000050000000000000339' }),
  Object.freeze({ id: '435', rawName: '湖北影视', name: '湖北影视', streamPath: 'new-hbys', epgCode: '99180001000000050000000000000178' }),
  Object.freeze({ id: '437', rawName: '湖北教育', name: '湖北教育', streamPath: 'new-hbjy', epgCode: '99180001000000050000000000000180' }),
  Object.freeze({ id: '438', rawName: '垄上频道', name: '湖北垄上', streamPath: 'new-hbls', epgCode: '99180001000000050000000000000340' }),
])

export const CHANNEL_BY_ID = new Map(CHANNELS.map(channel => [channel.id, channel]))

export function channelIdFromRef(ref) {
  const match = /^hbtv-(\d{3})$/.exec(String(ref || ''))
  return match && CHANNEL_BY_ID.has(match[1]) ? match[1] : ''
}

/** rows 是 api.js 解析官网直播页得到的六套频道，台标用其中的 logo（官网频道图标）。 */
export function buildChannels(rows = []) {
  const logos = new Map((Array.isArray(rows) ? rows : []).map(row => [String(row?.id), row?.logo || '']))
  return CHANNELS.map(channel => ({
    name: channel.name,
    deferredRef: `hbtv-${channel.id}`,
    // CDN 清单有浏览器指纹校验，分片又要求官网 Referer；两者都在服务端完成，
    // 不把匿名 client-id、短效票或请求头暴露给播放器。
    proxyHls: true,
    logo: logos.get(channel.id) || '',
    opts: ['network-caching=3000'],
  }))
}
