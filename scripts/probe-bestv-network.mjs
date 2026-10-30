#!/usr/bin/env node
/** 容器内只读探测：不改配置、不输出 clientID 或签名 URL，不需要 FFmpeg。 */
import { createApiClient } from '../extractors/bestv-fj/auth.js'
import { networkFetch, createResolver, mediaUrl } from '../extractors/bestv-fj/api.js'
import { DEFAULT_CHANNEL_IDS, CHANNELS } from '../extractors/bestv-fj/channels.js'

const mode = process.argv[2] || 'auto'
if (!['auto', 'ipv6'].includes(mode)) { console.error('用法：node scripts/probe-bestv-network.mjs auto|ipv6'); process.exit(2) }
const fetchImpl = networkFetch({ networkMode: mode })
const resolver = createResolver({ fetchImpl, family: mode === 'ipv6' ? 6 : undefined })
const report = { checkedAt: new Date().toISOString(), mode, channels: [] }
try {
  const catalog = await createApiClient({ fetchImpl }).request('/tvs')
  const available = new Set(catalog.flatMap(g => g.items || []).filter(c => c.enabled === 1 && c.mode === 'live' && c.audio === 0).map(c => String(c.id)))
  report.catalogGroups = catalog.map(g => g.tagName)
  for (const id of DEFAULT_CHANNEL_IDS) {
    const row = { id, name: CHANNELS.find(c => c.id === id).name }
    if (!available.has(id)) row.result = '目录未提供'
    else {
      const resolved = await resolver.resolve(`bestv-fj-${id}`)
      if (!resolved.url) { row.result = '清单失败'; row.error = resolved.desc }
      else {
        row.host = new URL(resolved.url).hostname
        const line = resolved.manifestText.split(/\r?\n/).filter(l => l && !l.startsWith('#')).at(-3)
        const url = mediaUrl(new URL(line, resolved.url).href, resolved.url)
        const res = await fetchImpl(url, { headers: { Range: 'bytes=0-4095' }, redirect: 'manual', signal: AbortSignal.timeout(12000) })
        const bytes = Buffer.from(await res.arrayBuffer())
        row.segmentStatus = res.status
        row.result = res.ok && bytes.length >= 188 && bytes[0] === 0x47 ? '清单与TS通过' : '分片失败'
      }
    }
    report.channels.push(row)
  }
} catch (error) { report.error = error.message; if (mode === 'ipv6') report.hint = '请在容器内部确认原生 IPv6 出网和 DNS AAAA 解析；NAS 主机有 IPv6 不代表 Docker 桥接网络也有。系统 VPN/TUN 仍可能接管流量。' }
console.log(JSON.stringify(report, null, 2))
if (report.error || !report.channels.some(c => c.result === '清单与TS通过') || report.channels.some(c => c.result === '清单失败' || c.result === '分片失败')) process.exitCode = 1
