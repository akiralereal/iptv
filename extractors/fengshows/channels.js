// Fixed television scope: no business lives, VOD or replay.
// id is the official live resource id, shared by stream resolution (api.js) and the programme guide (epg.js).
export const CHANNELS = Object.freeze([
  { key: 'info', id: '7c96b084-60e1-40a9-89c5-682b994fb680', name: '凤凰资讯', logo: 'https://q1.fengshows.com/a/2021_22/79dcc3a9da358a3.png' },
  { key: 'chinese', id: 'f7f48462-9b13-485b-8101-7b54716411ec', name: '凤凰中文', logo: 'https://q1.fengshows.com/a/2021_22/ede3d9e09be28e5.png' },
  { key: 'hongkong', id: '15e02d92-1698-416c-af2f-3e9a872b4d78', name: '凤凰香港', logo: 'https://q1.fengshows.com/a/2021_23/325d941090bee17.png' },
])

/** Channel ref as emitted by buildGroups(); the programme guide keys on the same string. */
export const channelRef = channel => `fengshows-${channel.key}.flv`

// TiviMate 5.3.3 把以 .flv 结尾的地址归为电影。只标记 M3U 里本模块的本机播放地址。
export function markFengshowsLiveUrls(m3u) {
  return m3u.replace(/^\$\{replace\}\/fengshows-(?:info|chinese|hongkong)\.flv$/gm, '$&?live=1')
}
