export const CHANNELS = Object.freeze([
  Object.freeze({ id: '78', ref: 'shaoxing-news', name: '绍兴新闻综合', rawName: '新闻综合', stream: 'sxhb', logo: 'https://img.shaoxing.com.cn/a/thumb/10001/201907/fe10d7a786581be54ea5cf95b6cc18dd.png!w800_h600.png' }),
  Object.freeze({ id: '75', ref: 'shaoxing-public', name: '绍兴公共', rawName: '公共频道', stream: 'sxtv2', logo: 'https://img.shaoxing.com.cn/a/thumb/10001/201907/1343d3f112c5ddf2ccde3d8c28ce833f.png!w800_h600.png' }),
  Object.freeze({ id: '74', ref: 'shaoxing-culture', name: '绍兴文化影视', rawName: '文化影视', stream: 'sxtv3', logo: 'https://img.shaoxing.com.cn/a/thumb/10001/201907/46d0c198ee2f7c63fe5c272e2f8bb8e7.png!w800_h600.png' }),
])
export const CHANNEL_BY_REF = new Map(CHANNELS.map(channel => [channel.ref, channel]))
