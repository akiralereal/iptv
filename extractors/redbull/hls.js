/** 红牛赛事的 EVENT 清单从开赛起不断追加。向直播客户端只提供最近三分钟，
 * 避免每个画质/音轨把数千个历史分片登记到主项目的共享代理表。序号和 discontinuity 保持连续。
 * 不改写未知低延迟或 byte-range 结构：官方若更换格式明确报错，不能默默输出错误时间轴。
 */
export function liveWindow(text, seconds = 180) {
  if (!/^#EXT-X-PLAYLIST-TYPE:EVENT\s*$/m.test(text) || text.includes('#EXT-X-STREAM-INF')) return text
  const lines = text.split(/\r?\n/), header = [], segments = []
  let pending = [], map = '', discontinuities = 0, unsupported = false
  const global = /^#(?:EXTM3U|EXT-X-(?:VERSION|TARGETDURATION|MEDIA-SEQUENCE|DISCONTINUITY-SEQUENCE|PLAYLIST-TYPE|ALLOW-CACHE|INDEPENDENT-SEGMENTS))(?::|$)/
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (global.test(line)) { header.push(line); continue }
    if (line === '#EXT-X-ENDLIST') continue
    if (line.startsWith('#')) {
      if (/^#EXT-X-MAP:/.test(line)) map = line
      if (line === '#EXT-X-DISCONTINUITY') discontinuities++
      if (/^#EXT-X-(?:BYTERANGE|PART|PRELOAD-HINT|SKIP|START|DATERANGE)/.test(line)) unsupported = true
      pending.push(line); continue
    }
    const duration = Number(pending.find(l => l.startsWith('#EXTINF:'))?.match(/^#EXTINF:([\d.]+)/)?.[1])
    if (!(duration > 0)) throw new Error('红牛赛事清单缺少有效分片时长')
    segments.push({ lines: [...pending, line], duration, map, discontinuities })
    pending = []
  }
  let first = segments.length, duration = 0
  while (first > 0 && (duration < seconds || segments.length - first < 3)) duration += segments[--first].duration
  if (!first) return text
  if (unsupported || pending.length) throw new Error('红牛赛事清单结构已变化，需要重新确认直播窗口')
  const sequence = Number(header.find(l => l.startsWith('#EXT-X-MEDIA-SEQUENCE:'))?.split(':')[1] || 0)
  const discontinuitySequence = Number(header.find(l => l.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:'))?.split(':')[1] || 0)
  const head = header.filter(l => !/^#EXT-X-(?:PLAYLIST-TYPE|MEDIA-SEQUENCE|DISCONTINUITY-SEQUENCE):/.test(l))
  head.push(`#EXT-X-MEDIA-SEQUENCE:${sequence + first}`)
  head.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${discontinuitySequence + segments[first - 1].discontinuities}`)
  if (segments[first].map && !segments[first].lines.some(l => l.startsWith('#EXT-X-MAP:'))) head.push(segments[first].map)
  return [...head, ...segments.slice(first).flatMap(s => s.lines), ...(text.includes('#EXT-X-ENDLIST') ? ['#EXT-X-ENDLIST'] : []), ''].join('\n')
}
