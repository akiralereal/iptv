/**
 * 黑龙江广播电视台：极光新闻 App 在用的七套官方直播入口。
 *
 * 这是本项目里少见的「什么都不需要」的源：地址固定、不带签名，清单和分片都
 * 不校验 Referer，也不挑 UA（实测 ffmpeg 的 Lavf、okhttp 都是 200）。所以
 * 频道直接给 url 而不是 deferredRef——既不用 resolve，也不必让分片绕本机一圈，
 * 播放器直连官方 CDN 就行。哪天上游加了门再改成 deferredRef + proxy。
 *
 * 唯一要留意的是端口：官方业务域名走的是 4430 而不是 443，白名单必须放行它。
 */

export const HLJTV_MEDIA_ORIGIN = 'https://idclive.hljtv.com:4430'

const MEDIA_HOST = 'idclive.hljtv.com'
const MEDIA_PORT = '4430'
const MEDIA_PATH_PREFIX = '/live/'
const LOGO_BASE = 'https://imgcdn.hljtv.com/'

// 台标取极光新闻 App 电视直播的频道卡：zmt-api.hljtv.com/live/getTVInfo（POST，按 tvId 逐台查）
// 下发的 imgUrl，400×300、红色台标加频道名，7 张实测都是 JPEG；tvId 依次是 10、50、49、11、16、12、15。
// 东北网（黑龙江网络广播电视台）直播页也有频道卡，但都是带背景的 16:9 宣传图（最大一张 2859×1599），
// 不用；实验台那张是研究占位图，同样不用。
export const CHANNELS = Object.freeze([
  Object.freeze({ name: '黑龙江卫视', stream: 'hljws_own.m3u8',
    logo: `${LOGO_BASE}newscontent-48f3f374-054b-4611-9f2b-f3fc426a50d8-1583018250011.jpeg` }),
  Object.freeze({ name: '黑龙江都市', stream: 'dushi_hd.m3u8',
    logo: `${LOGO_BASE}newscontent-60c83952-0ca3-43b9-b17e-4e109a65fe9d-1626922264107.jpeg` }),
  Object.freeze({ name: '黑龙江新闻法治', stream: 'hljxw_hd.m3u8',
    logo: `${LOGO_BASE}newscontent-972a32ed-fc2e-455a-9863-93ea2fb176a2-1611449642107.jpeg` }),
  Object.freeze({ name: '黑龙江文体', stream: 'hljwy_hd.m3u8',
    logo: `${LOGO_BASE}newscontent-142df96e-616d-402d-a4ba-12ed3338f48c-1583018453221.jpeg` }),
  Object.freeze({ name: '黑龙江少儿', stream: 'hljse_hd.m3u8',
    logo: `${LOGO_BASE}newscontent-1f45b6e9-cce7-4131-b814-e652fdd8aea4-1583018440044.jpeg` }),
  Object.freeze({ name: '黑龙江影视', stream: 'hljys_hd.m3u8',
    logo: `${LOGO_BASE}newscontent-491c84b1-8a81-4e53-8281-139b87522d72-1583018429109.jpeg` }),
  Object.freeze({ name: '黑龙江农业科教', stream: 'hljgg_hd.m3u8',
    logo: `${LOGO_BASE}newscontent-5a51beb0-19da-42b6-90c5-492a30ff312e-1658661402463.jpeg` }),
])

/** 频道表写进播放列表前统一校验，免得改错一条 stream 名就把用户导去别处。 */
export function officialHlsUrl(stream) {
  const url = new URL(`${MEDIA_PATH_PREFIX}${String(stream || '').trim()}`, HLJTV_MEDIA_ORIGIN)
  if (url.protocol !== 'https:' || url.username || url.password || url.port !== MEDIA_PORT
      || url.hostname !== MEDIA_HOST || !url.pathname.startsWith(MEDIA_PATH_PREFIX)
      || !/^[a-z0-9_]+\.m3u8$/i.test(url.pathname.slice(MEDIA_PATH_PREFIX.length))
      || url.search || url.hash) {
    throw new Error('黑龙江广电频道表里有非官方直播地址')
  }
  return url.href
}

export function buildChannels() {
  return CHANNELS.map(channel => ({
    name: channel.name,
    url: officialHlsUrl(channel.stream),
    logo: channel.logo,
    groupTitle: '黑龙江',
    opts: ['network-caching=3000'],
    catchup: 'none',
  }))
}
