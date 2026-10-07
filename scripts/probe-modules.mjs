#!/usr/bin/env node
/**
 * 抓取模块可达性探测：逐个模块跑「取列表 → 换签 → 取清单 → 取分片」整条链路，每段记状态、
 * 耗时、主机。用来比较不同网络（大陆 / 海外）下哪些模块能用——本机跑一遍当基线，放到
 * GitHub Actions（美国 Azure）再跑一遍当海外视角。节目单另用 scripts/probe-epg.mjs。
 *
 * 用法:
 *   node scripts/probe-modules.mjs [--only id1,id2] [--skip id1,id2] [--samples 2|all]
 *                                  [--concurrency 4] [--json 明细.json] [--md 汇总.md] [--keep-urls]
 *
 * 每个模块默认取 2 个样本频道：第一个频道，加一个卫视（没有卫视就取另一个分组的第一个）；
 * --samples all 逐台全测（同一模块内串行、台与台之间留间隔，央视频按取票预算放慢）。
 * 请求头按项目实际下发的给：浏览器 UA + 频道 #EXTVLCOPT 请求头 + 模块 upstreamHeaders，
 * 所以这里的失败基本就是网络层面的拒绝，而不是少带了防盗链头。
 *
 * 取列表、换签两段会记下模块自己发出的 HTTP 请求（主机 + 状态码，Chromium 里的请求除外），
 * 用来定位是哪个官方接口在拦。
 *
 * --keep-urls 把签好名的清单 / 分片完整地址和请求头、模块请求的完整地址写进 JSON（默认只记
 * 主机），供换个出口（如 Globalping 探针）复核同一条地址；地址带短效令牌，只留在本机，别上传。
 *
 * 不碰真实数据目录：mdataDir 指向临时目录，远程配置拉取关闭。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import diagnostics from 'node:diagnostics_channel'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.mdataDir = mkdtempSync(join(tmpdir(), 'iptv-probe-modules-'))
process.env.mbuiltInSourcesUrl = ''

// 模块各用各的 HTTP 客户端（node-fetch / undici / 全局 fetch），在 diagnostics_channel 上统一
// 记账：请求创建时按当前所在的模块阶段（AsyncLocalStorage）认领，响应和出错时按请求对象回填
const requestLog = new AsyncLocalStorage()
const rawFetch = globalThis.fetch
const pending = new WeakMap()
function track(request, url, method) {
  const log = requestLog.getStore()
  if (!log || method === 'CONNECT') return
  const entry = { method, host: hostOf(url), ...(keepUrls ? { url } : {}) }
  log.push(entry)
  pending.set(request, entry)
}
function settle(request, patch) {
  const entry = pending.get(request)
  if (entry && entry.status === undefined && entry.error === undefined) Object.assign(entry, patch)
}
diagnostics.subscribe('undici:request:create', ({ request }) => track(request, `${request.origin}${request.path}`, request.method))
diagnostics.subscribe('undici:request:headers', ({ request, response }) => settle(request, { status: response.statusCode }))
diagnostics.subscribe('undici:request:error', ({ request, error }) => settle(request, { error: errText(error) }))
// 走 HTTP 代理时 path 是完整地址
diagnostics.subscribe('http.client.request.start', ({ request }) => track(request, /^https?:\/\//.test(request.path) ? request.path : `${request.protocol}//${request.host}${request.path}`, request.method))
diagnostics.subscribe('http.client.response.finish', ({ request, response }) => settle(request, { status: response.statusCode }))
diagnostics.subscribe('http.client.request.error', ({ request, error }) => settle(request, { error: errText(error) }))

const { listModules } = await import('../extractors/registry.js')
const { resolveConfig } = await import('../utils/extractorManager.js')
const { mapSettled } = await import('../utils/epgXmltv.js')

const args = process.argv.slice(2)
const argOf = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : '' }
const listArg = name => new Set(argOf(name).split(',').map(s => s.trim()).filter(Boolean))
const only = listArg('--only')
const skip = listArg('--skip')
const sampleCount = argOf('--samples') === 'all' ? Infinity : Math.max(1, parseInt(argOf('--samples'), 10) || 2)
const concurrency = Math.max(1, parseInt(argOf('--concurrency'), 10) || 4)
const jsonOut = argOf('--json')
const mdOut = argOf('--md')
const keepUrls = args.includes('--keep-urls')

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const FETCH_TIMEOUT_MS = 90 * 1000
const RESOLVE_TIMEOUT_MS = 60 * 1000
const HTTP_TIMEOUT_MS = 15 * 1000
const SEGMENT_PEEK_BYTES = 64 * 1024
// 逐台全测时台与台之间的间隔；央视频实例级取票预算 20 张/分钟，按 4 秒一台走
const PACE_MS = { default: 300, yangshipin: 4000 }
// 这几个模块换签要起 Chromium；并发起会抢同一个 puppeteer profile，串行跑
const BROWSER_MODULES = new Set(['gdtv', 'hbtv', 'livechina'])
let browserChain = Promise.resolve()
function serialBrowser(fn) {
  const run = browserChain.then(fn, fn)
  browserChain = run.catch(() => {})
  return run
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}超时 ${ms / 1000}s`)), ms) }),
  ]).finally(() => clearTimeout(timer))
}

function hostOf(url) {
  try { return new URL(url).host } catch { return '' }
}

function errText(error) {
  const cause = error?.cause
  const code = cause?.code || cause?.name || ''
  const msg = error?.name === 'AbortError' || error?.name === 'TimeoutError' ? '超时' : (error?.message || String(error))
  return code && !msg.includes(code) ? `${msg} (${code})` : msg
}

function optHeaders(opts) {
  const headers = {}
  for (const raw of opts || []) {
    const [key, ...rest] = String(raw).split('=')
    const value = rest.join('=')
    if (key === 'http-referrer') headers.Referer = value
    else if (key === 'http-user-agent') headers['User-Agent'] = value
    else if (key === 'http-origin') headers.Origin = value
  }
  return headers
}

function headersFor(url, base, upstreamHeaders) {
  const extra = typeof upstreamHeaders === 'function' ? (upstreamHeaders(url) || {}) : (upstreamHeaders || {})
  return { 'User-Agent': UA, ...base, ...extra }
}

/** 取一段 HTTP：只读前 limit 字节就断开（分片不必下完）。不经记账的 fetch。 */
async function peek(url, headers, limit) {
  const t0 = Date.now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS)
  try {
    const response = await rawFetch(url, { headers, redirect: 'follow', signal: ctrl.signal })
    const chunks = []
    let size = 0
    if (response.body) {
      const reader = response.body.getReader()
      while (size < limit) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        size += value.length
      }
      reader.cancel().catch(() => {})
    }
    const body = Buffer.concat(chunks.map(c => Buffer.from(c)))
    return {
      status: response.status,
      finalUrl: response.url || url,
      host: hostOf(response.url || url),
      body,
      ms: Date.now() - t0,
    }
  } catch (error) {
    return { status: 0, error: errText(error), host: hostOf(url), ms: Date.now() - t0 }
  } finally {
    clearTimeout(timer)
  }
}

function firstVariant(text, base) {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('#EXT-X-STREAM-INF')) continue
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim()
      if (!t || t.startsWith('#')) continue
      try { return new URL(t, base).href } catch { return null }
    }
  }
  return null
}

function lastSegment(text, base) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  const last = lines[lines.length - 1]
  if (!last) return null
  try { return new URL(last, base).href } catch { return null }
}

function sniff(body) {
  if (!body?.length) return 'empty'
  if (body[0] === 0x47) return 'ts'
  const head = body.subarray(0, 12).toString('latin1')
  if (head.startsWith('FLV')) return 'flv'
  if (/ftyp|moof|styp|sidx/.test(head)) return 'fmp4'
  if (head.startsWith('ID3')) return 'id3'
  if (/^\s*</.test(head)) return 'html'
  if (/^\s*\{/.test(head)) return 'json'
  return 'bin'
}

function stageOk(stage) {
  return stage && stage.ok === true
}

function hlsStage(r, isHls) {
  return {
    ok: r.status >= 200 && r.status < 300 && isHls,
    status: r.status,
    host: r.host,
    ms: r.ms,
    error: r.error || (r.status && !isHls ? `不是 HLS（${sniff(r.body)}）` : undefined),
  }
}

async function probeStream(module, channel, config, index) {
  const sample = { name: channel.name, group: channel.group }
  const base = optHeaders(channel.opts)
  sample.route = channel.proxyHls ? 'proxy'
    : channel.relayHls ? 'relay'
      : (module.channelHlsMode || 'direct')
  let url = channel.url || ''
  let resolved = null

  if (!url && channel.deferredRef) {
    const t0 = Date.now()
    const requests = []
    try {
      resolved = await requestLog.run(requests, () => withTimeout(module.resolve(channel.deferredRef, {
        account: { userId: '', token: '' },
        config,
        // 每台换一个客户端身份：同一身份连换多台会被 resolveBurstGuard 当成扫台本地拒绝
        client: { key: `probe-${module.id}-${index}`, tag: 'probe' },
        selfBase: '',
      }), RESOLVE_TIMEOUT_MS, '换签'))
      url = resolved?.url || ''
      sample.resolve = url
        ? { ok: true, host: hostOf(url), ms: Date.now() - t0 }
        : { ok: false, error: resolved?.desc || '空地址', ms: Date.now() - t0 }
    } catch (error) {
      sample.resolve = { ok: false, error: errText(error), ms: Date.now() - t0 }
    }
    if (requests.length) sample.resolve.requests = requests
    if (!url) return sample
  } else {
    sample.resolve = { ok: true, direct: true }
  }

  if (!/^https?:\/\//i.test(url)) {
    sample.manifest = { ok: false, skipped: true, error: `本机桥接地址 ${url.slice(0, 40)}` }
    return sample
  }

  const upstream = resolved?.upstreamHeaders
  const transform = typeof resolved?.upstreamUrlTransform === 'function' ? resolved.upstreamUrlTransform : (u => u)
  const streamType = resolved?.streamType || module.streamType || 'hls'
  sample.streamType = streamType

  if (streamType === 'flv') {
    const r = await peek(url, headersFor(url, base, upstream), SEGMENT_PEEK_BYTES)
    const kind = sniff(r.body)
    sample.manifest = { ok: true, direct: true, note: 'FLV 无清单' }
    sample.segment = { ok: r.status >= 200 && r.status < 300 && kind === 'flv', status: r.status, host: r.host, kind, bytes: r.body?.length || 0, ms: r.ms, error: r.error }
    if (keepUrls) Object.assign(sample.segment, { url, headers: headersFor(url, base, upstream) })
    return sample
  }

  let manifestText = ''
  let manifestBase = url
  if (resolved?.manifestText) {
    manifestText = resolved.manifestText
    manifestBase = resolved.manifestUrl || url
    sample.manifest = { ok: true, viaModule: true, host: hostOf(manifestBase) }
  } else {
    const r = await peek(url, headersFor(url, base, upstream), 2 * 1024 * 1024)
    manifestText = r.body?.toString('utf8') || ''
    manifestBase = r.finalUrl || url
    sample.manifest = hlsStage(r, manifestText.includes('#EXTM3U'))
    if (keepUrls) Object.assign(sample.manifest, { url, headers: headersFor(url, base, upstream) })
    if (!sample.manifest.ok) return sample
  }

  const variant = firstVariant(manifestText, manifestBase)
  if (variant) {
    const target = transform(variant)
    const r = await peek(target, headersFor(target, base, upstream), 2 * 1024 * 1024)
    const text = r.body?.toString('utf8') || ''
    sample.variant = hlsStage(r, text.includes('#EXTM3U'))
    if (keepUrls) Object.assign(sample.variant, { url: target, headers: headersFor(target, base, upstream) })
    if (!sample.variant.ok) return sample
    manifestText = text
    manifestBase = r.finalUrl || target
  }

  const segment = lastSegment(manifestText, manifestBase)
  if (!segment) {
    sample.segment = { ok: false, error: '清单里没有分片' }
    return sample
  }
  const target = transform(segment)
  const r = await peek(target, headersFor(target, base, upstream), SEGMENT_PEEK_BYTES)
  const kind = sniff(r.body)
  sample.segment = {
    ok: r.status >= 200 && r.status < 300 && !['html', 'json', 'empty'].includes(kind),
    status: r.status, host: r.host, kind, bytes: r.body?.length || 0, ms: r.ms, error: r.error,
  }
  if (keepUrls) Object.assign(sample.segment, { url: target, headers: headersFor(target, base, upstream) })
  return sample
}

function pickSamples(channels) {
  if (sampleCount === Infinity) return channels
  const picked = []
  const add = c => { if (c && !picked.includes(c) && picked.length < sampleCount) picked.push(c) }
  add(channels[0])
  add(channels.find(c => /卫视/.test(c.name)))
  add(channels.find(c => c.group !== channels[0]?.group))
  for (const c of channels) add(c)
  return picked
}

async function probeModule(module) {
  const row = {
    id: module.id,
    name: module.name,
    category: module.category || 'standard',
    channelHlsMode: module.channelHlsMode || '',
    streamType: module.streamType || 'hls',
    samples: [],
  }
  const config = resolveConfig(module, {})
  const t0 = Date.now()
  const requests = []
  let payload
  // 失败重试一次：单次超时多半是官网偶发慢，不该记成地域拦截
  for (let attempt = 1; attempt <= 2 && !payload; attempt++) {
    try {
      payload = await requestLog.run(requests, () => withTimeout(module.fetch(config, { timeoutMs: 10000 }), FETCH_TIMEOUT_MS, '取列表'))
    } catch (error) {
      if (attempt === 2) {
        row.list = { ok: false, error: errText(error), attempts: attempt, ms: Date.now() - t0, requests }
        return row
      }
    }
  }
  const channels = []
  for (const group of payload?.groups || []) {
    for (const channel of group?.dataList || []) channels.push({ ...channel, group: group.name })
  }
  const skipped = payload?.meta?.skipped || []
  row.list = {
    ok: channels.length > 0,
    count: channels.length,
    groups: (payload?.groups || []).length,
    skipped: skipped.length,
    skippedSample: skipped.slice(0, 3).map(s => typeof s === 'string' ? s : (s?.reason || s?.name || JSON.stringify(s))),
    warnings: (payload?.meta?.warnings || []).slice(0, 3).map(String),
    ms: Date.now() - t0,
    requests,
  }
  if (!channels.length) {
    row.list.error = '返回 0 个频道'
    return row
  }
  const samples = pickSamples(channels)
  const pace = sampleCount === Infinity ? (PACE_MS[module.id] ?? PACE_MS.default) : 0
  for (let i = 0; i < samples.length; i++) {
    if (i && pace) await sleep(pace)
    try {
      row.samples.push(await probeStream(module, samples[i], config, i))
    } catch (error) {
      row.samples.push({ name: samples[i].name, group: samples[i].group, error: errText(error) })
    }
  }
  return row
}

/** 样本卡在哪一段：ok / resolve / manifest / segment / bridge */
function failedStage(s) {
  if (stageOk(s.segment)) return 'ok'
  if (!stageOk(s.resolve)) return 'resolve'
  if (s.manifest?.skipped) return 'bridge'
  if (!stageOk(s.manifest) || (s.variant && !stageOk(s.variant))) return 'manifest'
  return 'segment'
}

function verdict(row) {
  if (!stageOk(row.list) && row.list?.count === 0 && row.list.warnings?.length) return '需配置'
  if (!stageOk(row.list)) return '列表不通'
  const okCount = row.samples.filter(s => failedStage(s) === 'ok').length
  if (okCount === row.samples.length && okCount) return '通'
  if (okCount) return '部分通'
  return { resolve: '换签不通', bridge: '本机桥接', manifest: '清单不通', segment: '分片不通' }[failedStage(row.samples[0])]
}

function cell(stage) {
  if (!stage) return '—'
  if (stage.direct && stage.ok) return '直链'
  if (stage.viaModule) return '✅ 模块内取'
  if (stage.ok) return `✅${stage.status ? ` ${stage.status}` : ''}${stage.kind ? ` ${stage.kind}` : ''}`
  if (stage.skipped) return `⏭ ${stage.error}`
  return `❌ ${stage.status || ''} ${stage.error || ''}`.replace(/\s+/g, ' ').trim()
}

/** 一个样本失败的一句话原因，用于归并 */
function failReason(s) {
  const stage = failedStage(s)
  if (stage === 'ok') return ''
  if (stage === 'resolve') return `换签：${String(s.resolve?.error || s.error || '').replace(/^\S+?(链接请求失败|取流失败)：/, '').slice(0, 60)}`
  if (stage === 'bridge') return '本机桥接'
  const m = !stageOk(s.manifest) ? s.manifest : s.variant
  if (stage === 'manifest') return `清单：${m?.status || ''} ${m?.error || ''} @${m?.host || ''}`.replace(/\s+/g, ' ')
  return `分片：${s.segment?.status || ''} ${s.segment?.error || s.segment?.kind || ''} @${s.segment?.host || ''}`.replace(/\s+/g, ' ')
}

function requestSummary(requests) {
  const byHost = new Map()
  for (const r of requests || []) {
    const key = r.host
    const val = r.status || r.error?.replace(/^fetch failed\s*/, '').replace(/[()]/g, '') || '?'
    if (!byHost.has(key)) byHost.set(key, new Set())
    byHost.get(key).add(String(val))
  }
  return [...byHost].map(([host, vals]) => `${host} ${[...vals].join('/')}`).join('，')
}

async function vantage() {
  const out = {}
  const probes = [
    ['intl', 'https://ipinfo.io/json'],
    ['cn', 'https://myip.ipip.net/json'],
  ]
  await Promise.all(probes.map(async ([key, url]) => {
    try {
      const response = await rawFetch(url, { headers: { 'User-Agent': 'curl/8' }, signal: AbortSignal.timeout(8000) })
      out[key] = (await response.text()).slice(0, 400)
    } catch (error) {
      out[key] = `取不到：${errText(error)}`
    }
  }))
  return out
}

const modules = listModules().filter(m => (!only.size || only.has(m.id)) && !skip.has(m.id))
const started = Date.now()
const where = await vantage()
console.log(`出口：${JSON.stringify(where)}`)
console.log(`探测 ${modules.length} 个模块，每个 ${sampleCount === Infinity ? '全部' : sampleCount} 个样本，并发 ${concurrency}`)

const settled = await mapSettled(modules, concurrency, async module => {
  const row = BROWSER_MODULES.has(module.id) ? await serialBrowser(() => probeModule(module)) : await probeModule(module)
  row.verdict = verdict(row)
  const okCount = row.samples.filter(s => failedStage(s) === 'ok').length
  const detail = sampleCount === Infinity
    ? row.samples.filter(s => failedStage(s) !== 'ok').map(s => `\n    ✗ ${s.name}：${failReason(s)}`).join('')
    : row.samples.map(s => `\n    · ${s.name}：换签 ${cell(s.resolve)} | 清单 ${cell(s.manifest)}${s.variant ? ` → ${cell(s.variant)}` : ''} | 分片 ${cell(s.segment)}`).join('')
  console.log(`[${row.verdict}] ${module.id} ${module.name}：列表 ${cell(row.list)}${row.list?.count ? `（${row.list.count} 台）` : ''}`
    + (row.samples.length ? ` 通 ${okCount}/${row.samples.length}` : '')
    + (row.list?.ok ? '' : `\n    请求：${requestSummary(row.list?.requests)}`)
    + detail)
  return row
})
const rows = settled.map((r, i) => r.status === 'fulfilled'
  ? r.value
  : { id: modules[i].id, name: modules[i].name, list: { ok: false, error: errText(r.reason) }, samples: [], verdict: '脚本出错' })

for (const module of modules) {
  try { await module.shutdown?.() } catch {}
}

const tally = {}
for (const row of rows) tally[row.verdict] = (tally[row.verdict] || 0) + 1
const totals = rows.reduce((acc, row) => {
  acc.samples += row.samples.length
  acc.ok += row.samples.filter(s => failedStage(s) === 'ok').length
  return acc
}, { samples: 0, ok: 0 })

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ at: new Date().toISOString(), vantage: where, sampleCount: sampleCount === Infinity ? 'all' : sampleCount, tally, totals, rows }, null, 2))
}

if (mdOut) {
  const lines = [
    '# 抓取模块可达性探测',
    '',
    `- 时间(UTC)：${new Date().toISOString()}，耗时 ${Math.round((Date.now() - started) / 1000)}s`,
    `- 出口：\`${JSON.stringify(where)}\``,
    `- 模块：${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join('，')}；频道：通 ${totals.ok}/${totals.samples}`,
    '',
    '| 结论 | 模块 | 列表 | 通/测 | 失败原因（归并） | 线路 · 主机 |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  for (const row of rows) {
    const listCell = row.list?.ok ? `✅ ${row.list.count} 台` : `${cell(row.list)}${row.list?.requests?.length ? `（${requestSummary(row.list.requests)}）` : ''}`
    const okCount = row.samples.filter(s => failedStage(s) === 'ok').length
    const reasons = new Map()
    for (const s of row.samples) {
      const reason = failReason(s)
      if (!reason) continue
      if (!reasons.has(reason)) reasons.set(reason, [])
      reasons.get(reason).push(s.name)
    }
    const reasonText = [...reasons].map(([reason, names]) => `${reason}（${names.length > 3 ? `${names.slice(0, 3).join('、')} 等 ${names.length} 台` : names.join('、')}）`).join('；')
    const routes = [...new Set(row.samples.map(s => s.route))].join('/')
    const hosts = [...new Set(row.samples.flatMap(s => [s.manifest?.host, s.segment?.host]).filter(Boolean))].slice(0, 3).join(' ')
    lines.push(`| ${row.verdict} | ${row.id} ${row.name} | ${listCell} | ${row.samples.length ? `${okCount}/${row.samples.length}` : '—'} | ${reasonText.replace(/\|/g, '｜') || '—'} | ${routes}${hosts ? ` · ${hosts}` : ''} |`)
  }
  writeFileSync(mdOut, `${lines.join('\n')}\n`)
}

console.log(`\n模块：${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join('，')}；频道：通 ${totals.ok}/${totals.samples}，耗时 ${Math.round((Date.now() - started) / 1000)}s`)
process.exit(0)
