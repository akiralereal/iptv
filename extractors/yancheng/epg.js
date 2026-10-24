import { CHANNELS, dateRange, programList } from './protocol.js'

export function parseProgrammes(rows, channel, day) {
  const range = dateRange(day)
  const items = rows.filter(r => r && r.date === range.date && String(r.stream_id) === channel.streamId).map(r => ({
    title: String(r.title || '').trim(), start: Number(r.star_time_timestamp) * 1000, stop: Number(r.end_time_timestamp) * 1000,
  })).filter(r => r.title && !/^(?:精彩视频|精彩节目)$|频道形象片|导视|节目预告|宣传片/.test(r.title)
    && Number.isSafeInteger(r.start) && Number.isSafeInteger(r.stop) && r.stop - r.start >= 60000
    && r.start >= range.start && r.start < range.end && r.stop <= range.end + 86400000).sort((a, b) => a.start - b.start)
  const result = []
  for (const item of items) {
    const previous = result.at(-1)
    if (previous?.start === item.start) continue
    if (previous && previous.stop > item.start) previous.stop = item.start
    result.push(item)
  }
  return result
}

export default {
  id: 'yancheng', days: 2,
  channels: () => CHANNELS.map(c => ({ ref: c.ref, name: c.name, key: c.id })),
  async programmes(key, day, options) {
    const channel = CHANNELS.find(c => c.id === key)
    if (!channel) throw new Error('盐城节目单频道无效')
    return parseProgrammes(await programList(channel, day, options), channel, day)
  },
}
