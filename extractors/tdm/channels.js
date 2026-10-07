/**
 * 澳广视（TDM）自办的六套电视（91–96 台）。
 *
 * 取自官网直播页 SSR 状态（www.tdm.com.mo/zh-hans/live?ssr=on 的 __INITIAL_STATE__.live.categories，
 * 2026-10-06）：streamUrl 是官网写的源地址，域名播放时由官方路由接口换成当前网络可用的 CDN（见 api.js）；
 * channelId 是节目单接口的频道号（与台号无关）；台标是官网频道卡用的官方图。
 * 官网同一页还有转播的 CCTV 综合 71 台、CGTN 73 / 74 台（央视频已有）和立法会直播（非常规频道），不收。
 * 台名去掉台号（官方原名「澳视澳门 91台」留作 rawName），与 from-the-web 里的叫法一致。
 *
 * 改频道或台标要把 index.js 的 catalogVersion 加 1。
 */
const LOGO = path => `https://cdn2.tdm.com.mo/uploads/attachment/${path}`

export const CHANNELS = Object.freeze([
  { ref: 'tdm-ctvp', name: '澳视澳门', rawName: '澳视澳门 91台', channelId: 1, streamUrl: 'https://live3.tdm.com.mo/ch1/ch1.live/playlist.m3u8', logo: LOGO('2021-03/a8fbac1841a5372178278304967c69fb.png') },
  { ref: 'tdm-ptvp', name: '澳视葡文', rawName: '澳视葡文 92台', channelId: 2, streamUrl: 'https://live3.tdm.com.mo/ch2/ch2.live/playlist.m3u8', logo: LOGO('2021-03/595c1e8233d7a436a0747bad38a27e81.png') },
  { ref: 'tdm-sports', name: '澳门体育', rawName: '澳门体育 93台', channelId: 6, streamUrl: 'https://live3.tdm.com.mo/ch4/sport_ch4.live/playlist.m3u8', logo: LOGO('2021-03/0fb7aed6ff1aca16c34963fcee8eb367.png') },
  { ref: 'tdm-info', name: '澳门资讯', rawName: '澳门资讯 94台', channelId: 5, streamUrl: 'https://live3.tdm.com.mo/ch5/info_ch5.live/playlist.m3u8', logo: LOGO('2021-03/5bde9db9db093ab310ceef6976cd0ee2.png') },
  { ref: 'tdm-variety', name: '澳门综艺', rawName: '澳门综艺 95台', channelId: 7, streamUrl: 'https://live3.tdm.com.mo/ch6/hd_ch6.live/playlist.m3u8', logo: LOGO('2021-03/3a515e0352b60f146b1c6a79ddd4c54d.png') },
  { ref: 'tdm-satellite', name: '澳门-Macau', rawName: '澳门-Macau 96台', channelId: 8, streamUrl: 'https://live3.tdm.com.mo/ch3/ch3.live/playlist.m3u8', logo: LOGO('2021-09/931a1b83173c0557b46f6b7343e7e9f2.png') },
])

export const CHANNEL_BY_REF = new Map(CHANNELS.map(channel => [channel.ref, channel]))
