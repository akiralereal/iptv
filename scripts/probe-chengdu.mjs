#!/usr/bin/env node
/** 成都官方直播复测：核验 API → CDN 调度清单 → 媒体清单 → TS；不输出签名地址。 */
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { CHANNELS, requestPlayUrl } from '../extractors/chengdu/api.js'

const args = process.argv.slice(2)
const outputIndex = args.indexOf('--output')
const output = outputIndex >= 0 ? args[outputIndex + 1] : ''
if (outputIndex >= 0 && !output) throw new Error('--output 需要文件名')
const ids = args.filter((arg, index) => arg !== '--all'
  && (outputIndex < 0 || (index !== outputIndex && index !== outputIndex + 1)))
const selected = args.includes('--all') ? CHANNELS : CHANNELS.filter(channel => (ids.length ? ids : ['cdtv1', 'jy']).includes(channel.id))
if (!selected.length) throw new Error('没有对应的频道；参数用 cdtv1、jy 等短名或 --all')
const dir = mkdtempSync(join(tmpdir(), 'chengdu-probe-'))

function officialMedia(raw) {
  const url = new URL(raw)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port
      || !(/(^|\.)cditv\.cn$/.test(url.hostname) || /^[a-z0-9-]+\.100ycdn\.com$/.test(url.hostname))) {
    throw new Error('清单指向非官方媒体域名，需要重新核对')
  }
  return url.href
}

async function read(raw, limit) {
  let url = officialMedia(raw)
  for (let hop = 0; hop < 4; hop++) {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(12000) })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location) throw new Error('CDN 跳转没有目标')
      url = officialMedia(new URL(location, url).href)
      continue
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`CDN HTTP ${response.status}`) }
    let size = 0
    const chunks = []
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > limit) throw new Error('媒体响应过大')
      chunks.push(chunk)
    }
    return { bytes: Buffer.concat(chunks), url }
  }
  throw new Error('CDN 跳转过多')
}

const rows = []
try {
  for (const channel of selected) {
    const row = { id: channel.id, name: channel.name }
    try {
      let url = await requestPlayUrl(channel, { fetchImpl: fetch })
      for (let depth = 0; depth < 4; depth++) {
        const result = await read(url, 512 * 1024)
        const text = result.bytes.toString('utf8')
        if (!text.startsWith('#EXTM3U')) throw new Error('CDN 未返回 HLS')
        if (/#EXT-X-KEY:/.test(text)) throw new Error('出现加密清单，停止普通分片验证')
        const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'))
        if (!lines.length) throw new Error('清单为空')
        url = officialMedia(new URL(lines[0], result.url).href)
        if (text.includes('#EXT-X-STREAM-INF')) continue
        const segment = (await read(url, 12 * 1024 * 1024)).bytes
        const sync = segment.length > 376 && [0, 188, 376].every(index => segment[index] === 0x47)
        if (!sync) throw new Error('分片不是 MPEG-TS')
        const file = join(dir, `${channel.id}.ts`)
        writeFileSync(file, segment)
        const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', file], { encoding: 'utf8', timeout: 12000 })
        if (probe.error || probe.status !== 0) throw new Error('ffprobe 失败；请确认已安装 FFmpeg')
        Object.assign(row, { ok: true, segmentBytes: segment.length, streams: JSON.parse(probe.stdout).streams })
        break
      }
      if (!row.ok) throw new Error('清单层级过多')
    } catch (error) {
      // 网络库错误有时包含完整 URL，不把短效签名写进报告。
      row.ok = false
      row.error = /https?:\/\//.test(error.message) ? '网络请求失败（地址已隐藏）' : error.message
    }
    rows.push(row)
    console.log(JSON.stringify(row))
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
if (output) writeFileSync(output, JSON.stringify({ verifiedAt: new Date().toISOString(), rows }, null, 2) + '\n')
if (rows.some(row => !row.ok)) process.exitCode = 1
