/**
 * 看直播流的真实分辨率：只读清单和第一个分片的开头，不解码。
 * 线路名和域名说明不了画质（同一条 wlive 这场 720p、那场 1080p），清单大多也不写 RESOLUTION，
 * 只有视频里的 SPS 靠得住。目前的线路都是 H.264；HEVC、加密分片认不出来，返回 0 按未知处理。
 */
const TS_PACKET = 188
const MAX_SPS_BYTES = 128

export function declaredHeight(manifest) {
  return Math.max(0, ...[...manifest.matchAll(/RESOLUTION=\d+x(\d+)/g)].map(m => Number(m[1])))
}

/** 清单里第一个地址：主清单是子清单，媒体清单是分片 */
export function firstUri(manifest) {
  return manifest.split(/\r?\n/).map(line => line.trim()).find(line => line && !line.startsWith('#')) || ''
}

/** 去掉 TS 包头，把各包载荷接起来；SPS 很短，不用按 PID 分流 */
function tsPayload(bytes) {
  let offset = 0
  while (offset < TS_PACKET && !(bytes[offset] === 0x47 && bytes[offset + TS_PACKET] === 0x47)) offset++
  if (offset === TS_PACKET) return null
  const parts = []
  for (; offset + TS_PACKET <= bytes.length; offset += TS_PACKET) {
    if (bytes[offset] !== 0x47) break
    const control = (bytes[offset + 3] >> 4) & 3
    const start = offset + 4 + (control & 2 ? 1 + bytes[offset + 4] : 0)
    if (control & 1 && start < offset + TS_PACKET) parts.push(bytes.subarray(start, offset + TS_PACKET))
  }
  return Buffer.concat(parts)
}

function bitReader(bytes) {
  let position = 0
  const bit = () => {
    const byte = position >> 3
    if (byte >= bytes.length) throw new Error('SPS 读过头')
    return (bytes[byte] >> (7 - (position++ & 7))) & 1
  }
  const bits = count => { let value = 0; for (let i = 0; i < count; i++) value = value * 2 + bit(); return value }
  const ue = () => {
    let zeros = 0
    while (!bit()) if (++zeros > 31) throw new Error('SPS 数值异常')
    return 2 ** zeros - 1 + bits(zeros)
  }
  const se = () => { const value = ue(); return value % 2 ? (value + 1) / 2 : -value / 2 }
  return { bit, bits, ue, se }
}

function skipScalingLists(read, chromaFormat) {
  for (let list = 0; list < (chromaFormat === 3 ? 12 : 8); list++) {
    if (!read.bit()) continue
    let last = 8, next = 8
    for (let i = 0; i < (list < 6 ? 16 : 64); i++) {
      if (next !== 0) next = (last + read.se() + 256) % 256
      last = next === 0 ? last : next
    }
  }
}

/** 解 SPS（ITU-T H.264 7.3.2.1.1），rbsp 不含 NAL 头、已去掉防竞争字节 */
export function spsHeight(rbsp) {
  const read = bitReader(rbsp)
  const profile = read.bits(8)
  read.bits(16)  // 约束标志与 level
  read.ue()      // sps id
  let chromaFormat = 1
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    chromaFormat = read.ue()
    if (chromaFormat === 3) read.bit()
    read.ue(); read.ue(); read.bit()
    if (read.bit()) skipScalingLists(read, chromaFormat)
  }
  read.ue()  // log2_max_frame_num
  const pocType = read.ue()
  if (pocType === 0) read.ue()
  else if (pocType === 1) {
    read.bit(); read.se(); read.se()
    for (let cycle = read.ue(); cycle > 0; cycle--) read.se()
  }
  read.ue(); read.bit()  // 参考帧数、gaps_in_frame_num
  read.ue()              // 宽度，这里只比高度
  const heightUnits = read.ue() + 1
  const progressive = read.bit()
  if (!progressive) read.bit()
  read.bit()
  let crop = 0
  if (read.bit()) {
    read.ue(); read.ue()
    crop = read.ue() + read.ue()
  }
  const cropUnit = (chromaFormat === 1 ? 2 : 1) * (2 - progressive)
  return (2 - progressive) * heightUnits * 16 - crop * cropUnit
}

/** 分片开头（未解复用的 TS）→ 视频高度，认不出返回 0 */
export function heightOfSegment(bytes) {
  const payload = tsPayload(bytes)
  if (!payload) return 0
  for (let i = 0; i + 4 < payload.length; i++) {
    if (payload[i] !== 0 || payload[i + 1] !== 0 || payload[i + 2] !== 1 || (payload[i + 3] & 0x1f) !== 7) continue
    const rbsp = []
    for (let j = i + 4, end = Math.min(payload.length, i + 4 + MAX_SPS_BYTES); j < end; j++) {
      if (payload[j] === 3 && payload[j - 1] === 0 && payload[j - 2] === 0) continue
      rbsp.push(payload[j])
    }
    try {
      const height = spsHeight(Buffer.from(rbsp))
      if (height >= 120 && height <= 4320) return height
    } catch {}
  }
  return 0
}
