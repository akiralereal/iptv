/**
 * 把 HLS 主清单里画质最高的一档挪到最前，其余各档按画质从高到低跟在后面。
 *
 * 为什么要这样：AVPlayer（APTV 等）和网页里的 hls.js 都从主清单里列的第一档起播，不少官方主清单
 * 把最低档排在第一（CNA 270p、NASA+ 234p、Thai PBS 144p），一开播先糊一阵；只写死最高档的子清单
 * 又没了降档。服务端转发一次主清单、调好顺序，播放器从最高档起播，网速跟不上时照常降到后面几档；
 * 子清单和分片仍由播放器直连官方 CDN。
 *
 * 只动 #EXT-X-STREAM-INF 和紧跟它的地址行；#EXT-X-MEDIA（独立音轨、字幕）、I 帧清单和其余标签原样保留
 * （主清单里标签的先后不影响语义）。排序键是分辨率像素数，其次 BANDWIDTH，都从高到低；没写分辨率、
 * CODECS 里也没有视频编码的纯音频档排最后；同分辨率同码率的保持原顺序（DW 的 -b 备用线路跟在主线路后）。
 * 不是主清单、不足两档、格式看不懂或本来就是这个顺序时原样返回。纯字符串处理，便于单测。
 */
const VIDEO_CODEC_RE = /\b(?:avc[13]|hvc1|hev1|av01|vp09|vp8|dvh[1e]|dva[1v])\b/i

function attribute(line, name) {
  return new RegExp(`(?:^|[:,])${name}=("[^"]*"|[^,]*)`).exec(line)?.[1]?.replace(/^"|"$/g, '')
}

/** 一档的排序键：[是否有视频, 像素数, 码率]。 */
export function variantRank(streamInf) {
  const resolution = /^(\d+)x(\d+)$/.exec(attribute(streamInf, 'RESOLUTION') || '')
  const pixels = resolution ? Number(resolution[1]) * Number(resolution[2]) : 0
  const codecs = attribute(streamInf, 'CODECS')
  const hasVideo = pixels > 0 || !codecs || VIDEO_CODEC_RE.test(codecs)
  return [hasVideo ? 1 : 0, pixels, Number(attribute(streamInf, 'BANDWIDTH')) || 0]
}

export function topVariantFirst(text) {
  if (typeof text !== 'string' || !text.includes('#EXT-X-STREAM-INF')) return text
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const head = []
  const tail = []
  const blocks = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim().startsWith('#EXT-X-STREAM-INF')) {
      ;(blocks.length ? tail : head).push(line)
      continue
    }
    // 紧跟的空行和普通注释随这一档走；在地址之前又出现别的标签，说明格式看不懂，不动它
    const block = [line]
    let j = i + 1
    while (j < lines.length && (!lines[j].trim() || (lines[j].trim().startsWith('#') && !lines[j].trim().startsWith('#EXT')))) {
      block.push(lines[j++])
    }
    if (j >= lines.length || lines[j].trim().startsWith('#')) return text
    block.push(lines[j])
    blocks.push({ lines: block, rank: variantRank(line), order: blocks.length })
    i = j
  }
  if (blocks.length < 2) return text
  const sorted = [...blocks].sort((a, b) => {
    for (let k = 0; k < 3; k++) if (a.rank[k] !== b.rank[k]) return b.rank[k] - a.rank[k]
    return a.order - b.order
  })
  if (sorted.every((block, index) => block === blocks[index])) return text
  return [...head, ...sorted.flatMap(block => block.lines), ...tail].join(eol)
}

/** 用几条官方单档子清单拼一份主清单（官方只给了单档地址的频道，例如 France 24）。按给的顺序列出。 */
export function buildMasterPlaylist(variants) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3']
  for (const { url, bandwidth, resolution } of variants) {
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth}${resolution ? `,RESOLUTION=${resolution}` : ''}`, url)
  }
  return `${lines.join('\n')}\n`
}
