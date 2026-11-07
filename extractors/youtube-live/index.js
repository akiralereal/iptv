import { clearResolveCache, fetchProxyMedia, records, refOf, resolve } from './api.js'

// 用户订阅在配置里已有完整目录，修改后（包括模块停用期间）即可重建。
function groupsFromConfig(config) {
  const dataList = records(config).map(item => ({
    name: item.name, deferredRef: refOf(item), logo: '', catchup: 'none', proxyHls: true,
  }))
  return dataList.length ? [{ name: 'YouTube 直播', dataList }] : []
}

export default {
  id: 'youtube-live',
  name: 'YouTube 直播',
  category: 'overseas',
  outbound: 'proxy',
  proxyProbe: { name: 'YouTube', url: 'https://www.youtube.com/generate_204' },
  // 取址与 yt-dlp 走 youtube.com，清单和分片走 googlevideo.com；yt-dlp 更新用的 PyPI 大陆能直连，不列
  proxyHosts: ['youtube.com', 'googlevideo.com'],
  defaultEnabled: false,
  catalogVersion: 2,
  description: '输入用户名、频道 ID、频道或视频链接，自动关注所属频道的直播。部署机器需能访问 YouTube 和 Google Video，大陆部署在「设置 → 网络代理」填代理；默认输出最高画质（可在下方限制），保留配套音轨和字幕。',
  capabilities: { cache:'disk', resolve:true, epg:false, catchup:false },
  channelHlsMode: 'proxy',
  resolveBurstGuard: true,
  playbackRequiresEnabled: true,
  helper: 'youtube-subscriptions',
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '添加或移除订阅后更新列表。未开播的频道保留，播放时重新查找直播。',
  configSavedNotice: '配置已保存，重新打开频道即生效',
  configSchema: [
    { key:'subscriptions', type:'text', label:'YouTube 订阅', default:'[]', hidden:true },
    { key:'maxHeight', type:'select', label:'最高画质', default:0,
      options: [
        { value:0, label:'不限（输出直播的最高一档）' }, { value:2160, label:'2160p（4K）' }, { value:1440, label:'1440p' },
        { value:1080, label:'1080p' }, { value:720, label:'720p' }, { value:480, label:'480p' },
      ],
      hint:'视频全程经服务器转发，部署在大陆的还要走代理流量，4K 直播很费流量。限制后只在不超过这一档的画质里取最高的。' },
    { key:'muxedAudio', type:'boolean', label:'音视频合流（有画面没声音时打开）', default:false,
      hint: [
        'YouTube 直播的声音是单独一路，部分电视播放软件只放出画面、没有声音。',
        '打开后改取声音和画面合在一起的直播流，画质不变，打开频道会慢两三秒。',
        '播放正常的不用开；YouTube 不给这种流时，自动改用原来的方式。',
      ] },
  ],
  groupsFromConfig,
  async fetch(config) {
    return { groups: groupsFromConfig(config) }
  },
  claimsRef: ref => /^yt-[a-f0-9]{24}$/.test(ref),
  resolve,
  fetchProxyMedia,
  clearResolveCache,
}
