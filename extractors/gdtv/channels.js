/** 广东台荔枝网当前提供的固定电视直播频道。 */

// 台标取官网频道目录（gdtv-api.gdtv.cn/api/tv/v2/tvChannel）每路下发的 coverUrl，即官网的频道卡：
// 台标加频道名。同一接口的 avatarUrl 除 GRTN生活 外都是同一张广东台总台标，分不出频道，不用。
// 频道卡原图 1408×792 起、最大约 1.6 MB，拼上官网自己也在用的 OSS 缩放参数，取 400 宽、约 100 KB 的版本。
const LOGO_BASE = 'https://img.gdtv.cn/image/'
const logo = file => `${LOGO_BASE}${file}?x-oss-process=image/resize,w_400`

export const CHANNELS = [
  { id: '43', name: '广东卫视', logo: logo('202212/0.341152693165587748d6fc1c271c6514dOSS1670410407.jpg') },
  { id: '44', name: '广东珠江', logo: logo('202010/0.738782547490970872c02ffb3f2629ab9OSS1603767838.jpg') },
  { id: '45', name: '广东新闻', logo: logo('202010/0.3589920562510753391d9b20d6ddbf6a34OSS1603767900.jpg') },
  { id: '48', name: '广东民生', logo: logo('202302/0.6635126245907732254ccab30fa2e47aOSS1677599250.jpg') },
  { id: '47', name: '广东体育', logo: logo('202010/0.799768891583749813d003bb91b99a06dcOSS1603768050.jpg') },
  { id: '51', name: '大湾区卫视', logo: logo('202212/0.96623648728218273d1f4baae78850241OSS1670410383.png') },
  { id: '46', name: '大湾区卫视（海外版）', logo: logo('202310/0.74855430504605062d1f4baae78850241OSS1696866716.png') },
  { id: '53', name: '广东影视', logo: logo('202010/0.0350220365808817667b9d18512cf1d1e7aOSS1603782549.jpg') },
  { id: '16', name: '广东4K超高清', logo: logo('202302/0.101244267923196632684cbddc616947adOSS1676950586.jpg') },
  { id: '54', name: '广东少儿', logo: logo('202010/0.2857784718212295132fd948cad573007dOSS1603782706.jpg') },
  { id: '66', name: '嘉佳卡通', logo: logo('202010/0.4323796645645616715ebdbdc2447efc5afOSS1603782825.jpg') },
  // 官网还有 id=42 的南方购物，按项目其它省级模块的规则固定排除。
  // 岭南戏曲、经典剧、纪录片、健康四路在目录里的 avatarUrl / coverUrl 都只是广东台总台标，
  // 官网 PC 站、m 站再没有别的频道图，留空。
  { id: '15', name: '岭南戏曲' },
  { id: '74', name: '广东移动', logo: logo('202104/0.3846491553040145625cfad8900b7a5586OSS1618306860.jpg') },
  { id: '100', name: '广东台经典剧' },
  { id: '94', name: '广东纪录片' },
  { id: '99', name: '广东健康' },
  // 这一路反过来：avatarUrl 是自己的频道标，coverUrl 是宣传图
  { id: '102', name: 'GRTN生活', logo: logo('202608/0.29335022560898566d4ccb20274272f64OSS1786593646.jpg') },
]

export const CHANNEL_BY_ID = new Map(CHANNELS.map(channel => [channel.id, channel]))

export function channelPageUrl(channelId) {
  const id = String(channelId || '')
  if (!CHANNEL_BY_ID.has(id)) throw new Error('广东台频道 ID 无效')
  return `https://www.gdtv.cn/tvChannelDetail/${id}`
}

/**
 * 频道编号来自官网固定路由，不把约两分钟过期的播放地址写进频道缓存。
 * 播放时由 resolver.js 通过浏览器会话即时换取地址。
 */
export function buildChannels() {
  return CHANNELS.map(channel => ({
    name: channel.name,
    deferredRef: `gdtv-${channel.id}`,
    relayHls: true,
    logo: channel.logo || '',
    opts: ['network-caching=3000'],
  }))
}

export function channelIdFromRef(ref) {
  const match = /^gdtv-(\d{1,8})$/.exec(String(ref || ''))
  return match && CHANNEL_BY_ID.has(match[1]) ? match[1] : ''
}
