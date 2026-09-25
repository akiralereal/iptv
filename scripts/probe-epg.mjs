#!/usr/bin/env node
/**
 * 节目单可达性探测：逐个模块、逐个频道取今天的节目单，记条数、报错、耗时；另测咪咕的节目单接口。
 * 用来比较不同网络环境（本机 / 海外 CI）下各官方接口能不能取到。
 *
 * 用法:
 *   node scripts/probe-epg.mjs [--json 明细.json] [--md 汇总.md]
 */
import { writeFileSync } from 'node:fs'
import { listModules } from '../extractors/registry.js'
import { mapSettled, shanghaiDays } from '../utils/epgXmltv.js'

const args = process.argv.slice(2)
const argOf = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : '' }
const jsonOut = argOf('--json')
const mdOut = argOf('--md')

const now = Date.now()
const [today] = shanghaiDays(now, 1)
const jobs = []
for (const module of listModules()) {
  if (!module.epg) continue
  for (const channel of module.epg.channels()) jobs.push({ module: module.id, name: channel.name, key: channel.key, provider: module.epg })
}

const started = Date.now()
const results = await mapSettled(jobs, 6, async job => {
  const t0 = Date.now()
  try {
    const list = await job.provider.programmes(job.key, today, { timeoutMs: 15000 })
    return { count: list.length, ms: Date.now() - t0 }
  } catch (error) {
    const err = new Error(error?.name === 'AbortError' ? '超时 15s' : (error?.message || String(error)))
    err.ms = Date.now() - t0
    throw err
  }
})
const rows = jobs.map((job, index) => {
  const r = results[index]
  return r.status === 'fulfilled'
    ? { module: job.module, name: job.name, ok: true, count: r.value.count, ms: r.value.ms }
    : { module: job.module, name: job.name, ok: false, error: r.reason.message, ms: r.reason.ms }
})

// 咪咕：央视 / 卫视节目单走 program-sc.miguvideo.com（与模块无关的老通道）
async function probeUrl(label, url) {
  const t0 = Date.now()
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Mozilla/5.0' } })
    const text = await response.text()
    return { label, status: response.status, bytes: text.length, ms: Date.now() - t0 }
  } catch (error) {
    return { label, status: 0, error: error?.message || String(error), ms: Date.now() - t0 }
  }
}
const extra = await Promise.all([
  probeUrl('咪咕节目单（CCTV1）', `https://program-sc.miguvideo.com/live/v2/tv-programs-data/608807420/${today}`),
  probeUrl('咪咕频道目录', 'https://program-sc.miguvideo.com/live/v2/tv-data/1ff892f2b5ab4a79be6e25b69d2f5d05'),
  probeUrl('央视网 epginfo3（咪咕兜底）', `https://api.cntv.cn/epg/epginfo3?serviceId=shiyi&d=${today}&c=cctv1`),
])

const byModule = new Map()
for (const row of rows) {
  const m = byModule.get(row.module) || { module: row.module, total: 0, withData: 0, empty: 0, failed: 0, errors: new Set(), ms: 0 }
  m.total++
  m.ms = Math.max(m.ms, row.ms || 0)
  if (!row.ok) { m.failed++; m.errors.add(row.error.slice(0, 80)) } else if (row.count) m.withData++; else m.empty++
  byModule.set(row.module, m)
}
const modules = [...byModule.values()].sort((a, b) => (b.failed - a.failed) || a.module.localeCompare(b.module))
const totals = rows.reduce((t, r) => ({ total: t.total + 1, ok: t.ok + (r.ok && r.count ? 1 : 0), failed: t.failed + (r.ok ? 0 : 1) }), { total: 0, ok: 0, failed: 0 })

let md = `## 节目单可达性（${today}，${new Date(now).toISOString()}）\n\n`
md += `模块频道 ${totals.total} 个：有今天节目 ${totals.ok}，失败 ${totals.failed}，其余为官方当天为空。总耗时 ${Math.round((Date.now() - started) / 1000)}s。\n\n`
md += '| 模块 | 频道 | 有节目 | 当天为空 | 失败 | 最长耗时 | 错误 |\n|---|---|---|---|---|---|---|\n'
for (const m of modules) md += `| ${m.module} | ${m.total} | ${m.withData} | ${m.empty} | ${m.failed} | ${m.ms}ms | ${[...m.errors].join('；')} |\n`
md += '\n| 其它接口 | 状态 | 大小 | 耗时 |\n|---|---|---|---|\n'
for (const e of extra) md += `| ${e.label} | ${e.status || e.error} | ${e.bytes ?? '—'} | ${e.ms}ms |\n`

console.log(md)
if (mdOut) writeFileSync(mdOut, md)
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ today, at: new Date(now).toISOString(), rows, extra }, null, 1))
