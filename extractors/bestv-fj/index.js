import { CHANNELS, DEFAULT_CHANNEL_IDS, GROUP, channelForRef } from './channels.js'
import { clearResolveCache, fetchChannels, resolveChannel } from './api.js'
import epg from './epg.js'

export default {
  id: 'bestv-fj',
  name: '百视通',
  region: '百视通',
  description: '支持 64 路福建百视通频道，默认仅选择现有来源缺少的七路专业频道；每次刷新清单时检查并自动更新短效地址，默认视频分片直连官方 CDN，也可选择服务器 IPv6 转发。官方按地区下发频道，这台服务器拿到的目录里没有的频道会自动跳过；地区、运营商及平台策略可能影响播放。',
  catalogVersion: 1,
  capabilities: { cache: 'disk', resolve: true, epg: true, catchup: false },
  outputGroupName: GROUP,
  channelHlsMode: 'relay',
  channelHlsModeForConfig: config => config.networkMode === 'ipv6' ? 'proxy' : 'relay',
  relayProxyCompatible: true,
  defaultRefreshMinutes: 360,
  refreshConfigurable: false,
  refreshDescription: '每 360 分钟同步官方目录和台标；播放地址最多缓存 120 秒，每次清单刷新都检查可用性，失败时立即重新获取。',
  configSchema: [{ key: 'channels', label: '加入订阅的频道', type: 'multiselect',
    options: CHANNELS.map(c => ({ value: c.id, label: c.name })),
    default: DEFAULT_CHANNEL_IDS.join('\n'),
    hint: '默认勾选多彩文体4K、都市剧场、动漫秀场、乐游、法治天地、东方财经、生活时尚。其他央视、卫视等已有来源，按需勾选作为备用；至少选择一路。多彩文体4K 本次实际流为 1080p。' },
    { key: 'networkMode', label: '播放网络', type: 'select', default: 'auto',
      options: [{ value: 'auto', label: '默认网络（遵循现有代理设置）' }, { value: 'ipv6', label: 'IPv6 直连并转发视频' }],
      hint: 'IPv4 播放遇到 403 时，可尝试 IPv6 模式。需先确认 Docker 容器具备可用的 IPv6 出网；NAS 有 IPv6 地址不代表容器已能出网。播放器只有 IPv4 也可使用。开启后视频由 NAS／服务器转发，占用其网络带宽，并绕过应用中配置的代理；不同地区的可用性仍以上游实际响应为准。保存后点击模块「立即刷新」，再刷新播放器订阅。' },
  ],
  fetch: fetchChannels,
  epg,
  claimsRef: ref => !!channelForRef(ref),
  resolve: resolveChannel,
  clearResolveCache,
}
