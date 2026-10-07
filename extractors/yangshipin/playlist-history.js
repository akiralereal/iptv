// Only extend the simple public TS feed. Stateful HLS tags require a different
// merger; pass those feeds through rather than lose encryption/discontinuities.
const UNSUPPORTED = /^#EXT-X-(?!VERSION:|MEDIA-SEQUENCE:|TARGETDURATION:|ALLOW-CACHE:|INDEPENDENT-SEGMENTS\s*$|START:|PROGRAM-DATE-TIME:)/m
const SEGMENT_TAG = /^#(?:EXTINF|EXT-QQHLS-MACHINEID|EXT-QQHLS-START-TIME|EXT-SID|EXT-X-PROGRAM-DATE-TIME)\b/
export const HISTORY_SECONDS = 30
export const HISTORY_MIN_SEGMENTS = 6
export const HISTORY_MAX_SEGMENTS = 10
export const HISTORY_IDLE_MS = 30_000
// 短分片流的小缺口补回：官方窗口只有 3 片，CCTV8K 每片 2 秒只够 6 秒，共享刷新 5 秒一次、各 CDN 节点
// 进度又差一两片，快慢节点交替时会有一片谁都没列过。只对每片不超过 BRIDGE_MAX_TD 秒、两头片长一样、
// 开始时刻（EXT-QQHLS-START-TIME，精确到秒）也对得上的情况补，最多补 BRIDGE_MAX_GAP 片；地址沿用
// 缺口后第一片的主机和令牌、只换文件名里的序号（同主机同令牌换序号可取，见 resolver 的跳片接回）。
// 片长不规则的流（普通频道 4～9 秒浮动）算不准时长，仍按「缺口不拼接」处理。
export const BRIDGE_MAX_TD = 3
export const BRIDGE_MAX_GAP = 3

const startOf = segment => Number(segment.lines.find(line => line.startsWith('#EXT-QQHLS-START-TIME:'))?.split(':')[1])

function parse(text) {
  const body = String(text).replace(/\r/g, '')
  if (UNSUPPORTED.test(body)) return null
  const first = Number(body.match(/^#EXT-X-MEDIA-SEQUENCE:\s*(\d+)/m)?.[1])
  const range = body.match(/^#EXT-QQHLS-SEGMENT_RANGE:\s*(\d+)-(\d+)/m)
  if (!Number.isSafeInteger(first) || !range) return null
  const kept = Number(range[1]), last = Number(range[2])
  const header = [], segments = []
  let tags = [], duration = null
  for (const line of body.trimEnd().split('\n')) {
    if (SEGMENT_TAG.test(line)) {
      tags.push(line)
      if (line.startsWith('#EXTINF:')) duration = Number(line.slice(8).split(',')[0])
    } else if (line && !line.startsWith('#')) {
      const seq = first + segments.length
      let name
      try { name = new URL(line).pathname.split('/').pop() } catch { return null }
      if (!(duration > 0 && duration <= 15) || !name.endsWith(`-${seq}.ts`)) return null
      segments.push({ seq, name, duration, lines: [...tags, line] })
      tags = []; duration = null
    } else if (line && !segments.length && !tags.length) header.push(line)
    else if (line) return null
  }
  if (!segments.length || tags.length || kept > first || last < segments.at(-1).seq) return null
  return { header, segments, kept, identity: segments[0].name.replace(/-\d+\.ts$/, '') }
}

export function createPlaylistHistory() {
  let entries = new Map(), identity = '', tail = -1, updatedAt = -Infinity, target = 0, covered = 0
  // 补回短分片流窗口跳过的一两片（见 BRIDGE_MAX_TD）
  function bridge(parsed) {
    const next = parsed.segments[0]
    const declared = Number(parsed.header.find(line => line.startsWith('#EXT-X-TARGETDURATION:'))?.split(':')[1])
    if (!(declared <= BRIDGE_MAX_TD) || entries.has(next.seq - 1)) return
    const before = Math.max(-1, ...[...entries.keys()].filter(seq => seq < next.seq))
    const prev = entries.get(before)
    const missing = next.seq - before - 1
    if (!prev || missing < 1 || missing > BRIDGE_MAX_GAP || before + 1 < parsed.kept) return
    if (prev.duration !== next.duration || !Number.isFinite(startOf(prev)) || !Number.isFinite(startOf(next))) return
    if (Math.abs(startOf(next) - startOf(prev) - (missing + 1) * prev.duration) > 1) return
    const url = next.lines.at(-1)
    for (let seq = before + 1; seq < next.seq; seq++) {
      const name = next.name.replace(`-${next.seq}.ts`, `-${seq}.ts`)
      entries.set(seq, {
        seq, name, duration: prev.duration,
        lines: [
          `#EXT-QQHLS-START-TIME:${startOf(prev) + (seq - before) * prev.duration}`,
          `#EXTINF:${prev.duration.toFixed(3)},`, url.replace(`-${next.seq}.ts`, `-${seq}.ts`),
        ],
      })
    }
  }

  return {
    clear() { entries.clear(); identity = ''; tail = -1; updatedAt = -Infinity; target = 0; covered = 0 },
    /** 上一次 extend 给出的清单共多少秒；清单不认识（原样下发）时为 0。 */
    get seconds() { return covered },
    extend(text, now = Date.now()) {
      const parsed = parse(text)
      if (!parsed) { this.clear(); return text }
      const end = parsed.segments.at(-1).seq
      if (identity !== parsed.identity || end < tail || now - updatedAt > HISTORY_IDLE_MS) this.clear()
      identity = parsed.identity; tail = end; updatedAt = now
      // Overlapping durations, tags and URLs stay immutable, just like URL pins.
      for (const segment of parsed.segments) if (!entries.has(segment.seq)) entries.set(segment.seq, segment)
      bridge(parsed)
      for (const seq of entries.keys()) if (seq < parsed.kept || seq > end) entries.delete(seq)
      const window = []
      let seconds = 0
      for (let seq = end; entries.has(seq) && window.length < HISTORY_MAX_SEGMENTS; seq--) {
        const segment = entries.get(seq)
        window.unshift(segment); seconds += segment.duration
        if (seconds >= HISTORY_SECONDS && window.length >= Math.max(HISTORY_MIN_SEGMENTS, parsed.segments.length)) break
      }
      for (const seq of entries.keys()) if (seq < window[0].seq) entries.delete(seq)
      covered = seconds
      // Keep a high watermark: older retained fragments may be longer than the
      // upstream's current three, so its smaller target cannot describe our window.
      target = Math.max(target, Number(text.match(/^#EXT-X-TARGETDURATION:\s*(\d+)/m)?.[1]) || 0,
        ...window.map(s => Math.ceil(s.duration)))
      if (window.length === parsed.segments.length && target === Number(text.match(/^#EXT-X-TARGETDURATION:\s*(\d+)/m)?.[1])) return text
      const header = parsed.header.filter(line => !/^#EXT-X-START:/.test(line))
        .map(line => line.startsWith('#EXT-X-MEDIA-SEQUENCE:') ? `#EXT-X-MEDIA-SEQUENCE:${window[0].seq}`
          : line.startsWith('#EXT-X-TARGETDURATION:') ? `#EXT-X-TARGETDURATION:${target}` : line)
      header.push(`#EXT-X-START:TIME-OFFSET=-${Math.min(HISTORY_SECONDS, seconds).toFixed(3)},PRECISE=NO`)
      return [...header, ...window.flatMap(s => s.lines)].join('\n') + '\n'
    },
  }
}
