/**
 * 公开频道给 libVLC（Ceau Player、VLC 等）的清单视图。
 *
 * 公开频道是 TS 分片、播放器直连官方 CDN，上游清单只列 3 片、TARGETDURATION 在 5～9 之间跳。
 * libVLC 有两条规则（modules/demux/adaptive，用 Ceau Player 自带的 libVLC 4.0 复现过）：
 *   1. 正在读的那一项是清单最后一项时就停止解复用（SegmentTracker::bufferingAvailable），
 *      所以最新的一整片（5～9 秒）要等下一片也列出来才用得上；
 *   2. 按 TARGETDURATION 的间隔刷新清单，上游报 9 它就 9 秒多才刷一次。
 * 两条叠在一起，上游一出长片它手里的内容就见底：日志里是「ES_OUT_SET_(GROUP_)PCR is called
 * … ms late」，画面停一两秒，它把自己的延迟调大，卡两三次后才顺。
 *
 * 对策只给它：
 *   - 每个整片后面跟一个「垫片」，清单最后一项永远是垫片，最新的整片不再被扣住。垫片由本机
 *     提供，内容是 TS 空包（PID 0x1FFF），解复用器直接丢弃，不含时间戳。
 *   - TARGETDURATION 最多报 5，长片期间也按 5 秒刷新。它不校验 EXTINF 是否超过 TARGETDURATION。
 *     不能再小：它每刷一次本机就向官方取一次清单，回放里报 3 比报 5 更稳，但对真实上游
 *     3 秒一取时官方入口 112 次里有 4 次挂住 10～20 秒不回应，5 秒及以上约 200 次一次没有。
 *   - 清单最前面再垫两个垫片：它冷起时固定跳过清单头两项，不垫就少一整片可放。
 *
 * 几条试过不行的路，别再走：
 *   - 预告还没发布的下一片：它读完上一项马上就去取最后一项，拿到 404 后整条流停住不再恢复。
 *   - 垫片只给几个包（比如 CDN 分片开头的 PAT+PMT）：一次解复用就读穿，读到流尾当成播完。
 *     解复用一次最多读 50 个包，垫片必须明显多于这个数。
 *   - 少报时长让它起播点更靠后（会员频道 fMP4 的做法）：TS 上声明时长不准会让它在分片边界
 *     重新对时间线，每片卡一下。这里整片 + 垫片的声明时长加起来等于上游的真实时长。
 *
 * 验证方法：录一段真实分片（271 秒，含连续三片 8 秒以上的长片），本机按原节奏回放，
 * 用 Ceau Player 自带的 libVLC 各播 2 分钟，换 9 个起播时机。结果见提交说明。
 */
export const LIBVLC_UA = /(?:^|\s)(?:VLC|LibVLC)\//i
export const LIBVLC_MAX_TARGET_DURATION_S = 5
export const FILLER_PATH = '/ysp-pad.ts'
export const FILLER_EXTINF_S = 0.01
export const LEADING_FILLERS = 2
const FILLER_PACKETS = 200

function nullPackets(count) {
  const packet = Buffer.alloc(188, 0xff)
  packet.set([0x47, 0x1f, 0xff, 0x10])
  return Buffer.concat(Array.from({ length: count }, () => packet))
}

export const FILLER_BODY = nullPackets(FILLER_PACKETS)

// 只认最朴素的 TS 直播清单；带这些标签的清单原样下发，不冒险改写
const UNSUPPORTED = /^#EXT-X-(?:KEY|MAP|BYTERANGE|DISCONTINUITY|ENDLIST|PART|STREAM-INF)\b/m

/**
 * 序号空间：上游第 n 片的整片排在 2n，它后面的垫片排在 2n+1。libVLC 只认序号、不更新已知的项，
 * 这样同一片在每次刷新里序号都不变；最前面的两个垫片占的是上一片的位置，冷起时被它跳过，
 * 已经在播的客户端早就认得这两个序号，不会再看。
 */
export function libvlcPlaylist(text, fillerUrl) {
  const body = String(text).replace(/\r/g, '')
  if (!fillerUrl || UNSUPPORTED.test(body)) return null
  const first = Number(body.match(/^#EXT-X-MEDIA-SEQUENCE:\s*(\d+)/m)?.[1])
  const targetDuration = Number(body.match(/^#EXT-X-TARGETDURATION:\s*(\d+)/m)?.[1])
  if (!Number.isInteger(first) || first < 1 || !targetDuration) return null

  const segments = []
  let duration = null
  for (const line of body.split('\n')) {
    const value = line.trim()
    if (value.startsWith('#EXTINF:')) duration = Number(value.slice(8).split(',')[0])
    else if (value && !value.startsWith('#')) {
      if (!(duration > FILLER_EXTINF_S) || !/\.ts(?:$|\?)/i.test(value)) return null
      segments.push({ duration, url: value })
      duration = null
    }
  }
  if (!segments.length) return null

  const filler = [`#EXTINF:${FILLER_EXTINF_S.toFixed(3)},`, fillerUrl]
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-MEDIA-SEQUENCE:${first * 2 - LEADING_FILLERS}`,
    `#EXT-X-TARGETDURATION:${Math.min(targetDuration, LIBVLC_MAX_TARGET_DURATION_S)}`,
  ]
  for (let i = 0; i < LEADING_FILLERS; i++) lines.push(...filler)
  for (const segment of segments) {
    lines.push(`#EXTINF:${(segment.duration - FILLER_EXTINF_S).toFixed(3)},`, segment.url, ...filler)
  }
  return `${lines.join('\n')}\n`
}
