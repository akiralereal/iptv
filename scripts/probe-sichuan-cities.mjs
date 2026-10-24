#!/usr/bin/env node
/** 官方入口 → HLS → 分片 → 解码；--base http://127.0.0.1:端口 可验证主项目路由。 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { CHANNELS, createResolver } from '../extractors/sichuan-cities/api.js'
import { officialMedia, needsProxy, mediaHeaders } from '../extractors/sichuan-cities/protocol.js'

const args = process.argv.slice(2)
const option = name => {
  const index = args.indexOf(name)
  if (index < 0) return ''
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} 需要参数`)
  args.splice(index, 2)
  return value
}
const output = option('--output'), base = option('--base')
if (base && !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(base)) throw new Error('--base 只接受本机测试实例')
const selected = args.length ? CHANNELS.filter(row => args.includes(row.id)) : CHANNELS
if (!selected.length || args.some(id => !CHANNELS.some(row => row.id === id))) throw new Error('频道编号无效')
const resolver = createResolver({ fetchImpl: fetch })
const dir = mkdtempSync(join(tmpdir(), 'sichuan-cities-probe-'))

async function read(url, limit, channel, client = false) {
  const headers = client || (base && new URL(url).origin === base) ? {} : mediaHeaders(url, channel)
  const response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(15000) })
  if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`) }
  let length = 0
  const chunks = []
  for await (const chunk of response.body) {
    length += chunk.length
    if (length > limit) throw new Error('响应过大')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks, length)
}

async function probe(channel) {
  const row = { id: channel.id, name: channel.name, city: channel.city }
  try {
    let url
    if (base) url = `${base}/${needsProxy(channel) ? 'proxy' : 'relay'}/${channel.ref}.m3u8`
    else {
      const result = await resolver.resolve(channel.ref)
      if (!result.url) throw new Error(result.desc)
      url = result.url
    }
    for (let depth = 0; depth < 4; depth++) {
      const text = (await read(url, 1024 * 1024, channel)).toString('utf8').replace(/^\uFEFF/, '')
      if (!text.startsWith('#EXTM3U')) throw new Error('不是 HLS 清单')
      if (/#EXT-X-KEY:/.test(text)) throw new Error('出现加密清单，需要另行核对')
      const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
      const variants = lines.flatMap((line, index) => line.startsWith('#EXT-X-STREAM-INF:')
        ? [{ bandwidth: Number(line.match(/BANDWIDTH=(\d+)/)?.[1] || 0), uri: lines[index + 1] }] : [])
      if (variants.length) {
        variants.sort((a, b) => b.bandwidth - a.bandwidth)
        url = officialMedia(new URL(variants[0].uri, url).href, channel, { asset: true })
        continue
      }
      const segments = lines.filter(line => !line.startsWith('#'))
      if (!segments.length) throw new Error('清单没有媒体分片')
      let target = new URL(segments.at(-2) || segments[0], url).href
      if (base && new URL(target).origin === base && /^\/proxy\/s[a-f0-9]+\.ts$/.test(new URL(target).pathname)) {
        // 主项目代理模式返回本机分片；真正回源的目标由服务端模块逐跳校验。
      } else target = officialMedia(target, channel, { asset: true })
      // 中继频道的分片按实际播放器请求验证，不携带服务端的来源头。
      const bytes = await read(target, 16 * 1024 * 1024, channel, !needsProxy(channel))
      if (bytes.length < 376 || bytes[0] !== 0x47 || bytes[188] !== 0x47) throw new Error('不是 MPEG-TS 分片')
      const file = join(dir, `${channel.id}.ts`)
      writeFileSync(file, bytes)
      const info = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height',
        '-of', 'json', file], { encoding: 'utf8', timeout: 15000 })
      if (info.error || info.status !== 0) throw new Error('ffprobe 失败，请确认已安装 FFmpeg')
      const streams = JSON.parse(info.stdout).streams || []
      if (!streams.some(row => row.codec_type === 'video') || !streams.some(row => row.codec_type === 'audio')) throw new Error('缺少视频或音频')
      const decode = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-t', '3', '-map', '0:v:0', '-map', '0:a:0',
        '-progress', 'pipe:1', '-f', 'null', '-'], { encoding: 'utf8', timeout: 20000 })
      const frames = [...(decode.stdout || '').matchAll(/^frame=(\d+)/gm)].map(match => Number(match[1]))
      if (decode.error || decode.status !== 0 || !frames.some(value => value > 0)) throw new Error('音视频分片解码失败')
      Object.assign(row, { ok: true, segmentBytes: bytes.length, streams, decodeExit: decode.status,
        decodedFrames: Math.max(...frames), decodeWarning: Boolean(decode.stderr.trim()) })
      return row
    }
    throw new Error('清单层级过多')
  } catch (error) {
    return { ...row, ok: false, error: /https?:\/\//.test(error.message) ? '网络请求失败（地址已隐藏）' : error.message }
  }
}

const rows = []
try {
  for (let offset = 0; offset < selected.length; offset += 3) {
    const batch = await Promise.all(selected.slice(offset, offset + 3).map(probe))
    for (const row of batch) { rows.push(row); console.log(JSON.stringify(row)) }
  }
} finally { rmSync(dir, { recursive: true, force: true }) }
if (output) writeFileSync(output, JSON.stringify({ verifiedAt: new Date().toISOString(), viaMainProject: Boolean(base), rows }, null, 2) + '\n')
if (rows.some(row => !row.ok)) process.exitCode = 1
