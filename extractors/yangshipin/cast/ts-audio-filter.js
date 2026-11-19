import { Transform } from 'node:stream'

// The cast feed muxes an Audio Vivid (AVS3 audio, stream_type 0xd5, registration
// "av3a") track ahead of AAC. Players cannot decode it, and ffmpeg probes its bytes
// and often reports "mp3 22050Hz 8kbps"; mpv and IINA then pick it and play silence.
// Hide it: drop its PMT entry and turn its packets into null packets. Byte length is
// unchanged, so Content-Length and Range offsets stay valid. Anything that does not
// look like aligned TS passes through untouched.
const SYNC = 0x47
const PACKET = 188
const AUDIO_VIVID = 0xd5
// Audio the player can fall back to: MPEG-1/2 audio, AAC ADTS/LATM, AC-3, E-AC-3.
const PLAIN_AUDIO = new Set([0x03, 0x04, 0x0f, 0x11, 0x81, 0x87])

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n << 24
  for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1
  return c >>> 0
})

export function mpegCrc32(buf, start = 0, end = buf.length) {
  let crc = 0xffffffff
  for (let i = start; i < end; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0
  return crc
}

// Returns [start, end) of a complete, CRC-valid PSI section in this packet, or null.
function section(buf, off, tableId) {
  if (!(buf[off + 1] & 0x40)) return null
  const afc = (buf[off + 3] >> 4) & 3
  if (!(afc & 1)) return null
  let i = off + 4
  if (afc & 2) i += 1 + buf[i]
  if (i >= off + PACKET) return null
  const start = i + 1 + buf[i]
  if (start + 12 > off + PACKET || buf[start] !== tableId) return null
  const end = start + 3 + (((buf[start + 1] & 0x0f) << 8) | buf[start + 2])
  if (end > off + PACKET || end - start < 16 || mpegCrc32(buf, start, end) !== 0) return null
  return [start, end]
}

function hasAudioVividRegistration(buf, start, end) {
  for (let i = start; i + 2 <= end; i += 2 + buf[i + 1]) {
    if (buf[i] === 0x05 && buf[i + 1] >= 4 && buf.toString('latin1', i + 2, i + 6) === 'av3a') return true
  }
  return false
}

function readPat(buf, off, state) {
  const range = section(buf, off, 0x00)
  if (!range) return
  const [start, end] = range
  const pids = new Set()
  for (let i = start + 8; i + 4 <= end - 4; i += 4) {
    if ((buf[i] << 8) | buf[i + 1]) pids.add(((buf[i + 2] & 0x1f) << 8) | buf[i + 3])
  }
  state.pmt = pids
}

function rewritePmt(buf, off, pmtPid, state) {
  const range = section(buf, off, 0x02)
  if (!range) return
  const [start, end] = range
  const pcrPid = ((buf[start + 8] & 0x1f) << 8) | buf[start + 9]
  const head = start + 12 + (((buf[start + 10] & 0x0f) << 8) | buf[start + 11])
  const entries = []
  for (let i = head; i < end - 4;) {
    if (i + 5 > end - 4) return
    const len = 5 + (((buf[i + 3] & 0x0f) << 8) | buf[i + 4])
    if (i + len > end - 4) return
    const pid = ((buf[i + 1] & 0x1f) << 8) | buf[i + 2]
    const vivid = buf[i] === AUDIO_VIVID || hasAudioVividRegistration(buf, i + 5, i + len)
    entries.push({ type: buf[i], pid, at: i, len, vivid })
    i += len
  }
  // Keep the track when it is the only audio or carries the clock.
  const dropped = entries.some(e => !e.vivid && PLAIN_AUDIO.has(e.type))
    ? entries.filter(e => e.vivid && e.pid !== pcrPid) : []
  state.drop.set(pmtPid, new Set(dropped.map(e => e.pid)))
  if (!dropped.length) return
  const kept = entries.filter(e => !dropped.includes(e))
  const out = Buffer.concat([buf.subarray(start, head), ...kept.map(e => buf.subarray(e.at, e.at + e.len))])
  const length = out.length - 3 + 4
  out[1] = (out[1] & 0xf0) | (length >> 8); out[2] = length & 0xff
  out.copy(buf, start)
  buf.writeUInt32BE(mpegCrc32(out), start + out.length)
  buf.fill(0xff, start + out.length + 4, off + PACKET)
}

function isDropped(state, pid) {
  for (const pids of state.drop.values()) if (pids.has(pid)) return true
  return false
}

function processPacket(buf, off, state) {
  const pid = ((buf[off + 1] & 0x1f) << 8) | buf[off + 2]
  if (pid === 0) return readPat(buf, off, state)
  if (state.pmt.has(pid)) return rewritePmt(buf, off, pid, state)
  if (pid !== 0x1fff && isDropped(state, pid)) {
    buf.fill(0xff, off, off + PACKET)
    buf[off] = SYNC; buf[off + 1] = 0x1f; buf[off + 2] = 0xff; buf[off + 3] = 0x10
  }
}

export function createAudioVividFilter() {
  const state = { pmt: new Set(), drop: new Map() }
  let mode = 'detect', carry = null
  return new Transform({
    transform(chunk, _encoding, done) {
      if (mode === 'pass') return done(null, chunk)
      // Incoming chunks belong to this response only, so packets are edited in place.
      const buf = carry ? Buffer.concat([carry, chunk]) : chunk
      carry = null
      if (!buf.length) return done()
      if (mode === 'detect') mode = buf[0] === SYNC ? 'ts' : 'pass'
      if (mode === 'pass') return done(null, buf)
      const whole = buf.length - buf.length % PACKET
      for (let off = 0; off < whole; off += PACKET) {
        if (buf[off] !== SYNC) { mode = 'pass'; break }
        processPacket(buf, off, state)
      }
      if (mode === 'pass') return done(null, buf)
      if (whole < buf.length) carry = Buffer.from(buf.subarray(whole))
      done(null, whole ? buf.subarray(0, whole) : undefined)
    },
    flush(done) { done(null, carry || undefined) },
  })
}

// Only filter responses that start on a packet boundary of the segment.
export function filtersResponse(res) {
  if (res.statusCode === 200) return true
  if (res.statusCode !== 206) return false
  const range = /^bytes (\d+)-/.exec(res.headers?.['content-range'] || '')
  return !!range && Number(range[1]) % PACKET === 0
}
