// IPTV.m3u 链接探活
// 默认 DRY_RUN：只生成报告 probe-report.md、不修改 IPTV.m3u。
// DRY_RUN=0 时才写回（仅保留存活），并带「存活比例过低则不写回」的安全阀。
// 失败会重试（默认 3 次、指数退避），任一次通即判活、连续都失败才判死。
//
// 「深度探活」(DEEP=1，默认开)：不止看状态码，而是把清单读出来验一遍，再真下一段分片。
//   很多死源是 HTTP 200 + 一个「链接已失效 / 短链不存在」的 HTML 页面，只看状态码会当成活的。
//   直播清单（没有 #EXT-X-ENDLIST）下的是最新一段：滑动窗口里最老的分片源站常已删掉
//   （大立电视台实测首段 404、末段正常），下首段会把活源判死、DRY_RUN=0 时误删。
// rtmp 源用真实 RTMP 握手 + connect + play 探活（node:net 手写，不依赖 ffprobe）。
//
// ⚠️ 务必在「真实使用网络」下运行：无外网环境会把外网源判失效（属预期）；
//    在有外网的机器上跑则外网源会「假活」，删除判断会偏乐观。
// ⚠️ 若本机走 Clash/Surge 一类代理，代理偶发对 CONNECT 回 503 会造成整片误判。
//    脚本已用指数退避 + 单主机并发限流规避，RETRIES 不建议低于 3。
//
// 用法:
//   node scripts/probe-m3u.mjs                          # 只报告、不改文件
//   DRY_RUN=0 node scripts/probe-m3u.mjs                # 探活并直接删除死链（带安全阀）
//   SAMPLES=3 node scripts/probe-m3u.mjs                # 每个源采样 3 次，出首帧延迟排行（取中位数）
//   RETRIES=5 TIMEOUT_MS=10000 node scripts/probe-m3u.mjs   # 调参
//   DEEP=0 node scripts/probe-m3u.mjs                   # 退回旧的「只看状态码」快速模式
//
// 仅用 Node 内置能力（node:fs / node:net + 全局 fetch），无需 npm 依赖。Node 18+ 即可。
import { readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { randomBytes } from 'node:crypto'

const FILE = process.env.M3U_FILE || 'IPTV.m3u'
const DRY_RUN = process.env.DRY_RUN !== '0' // 默认 dry-run
const DEEP = process.env.DEEP !== '0'       // 默认深度探活
const CONCURRENCY = Number(process.env.CONCURRENCY || 8)
const HOST_CONCURRENCY = Number(process.env.HOST_CONCURRENCY || 2) // 单主机并发上限，防把代理/源站打出 503
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 12000)
const SEG_TIMEOUT_MS = Number(process.env.SEG_TIMEOUT_MS || 10000)
const RETRIES = Math.max(1, Number(process.env.RETRIES || 3))     // 每个链接最多尝试次数
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS || 1500) // 首次重试间隔，之后指数退避
const SAMPLES = Math.max(1, Number(process.env.SAMPLES || 1))     // 延迟采样次数，取中位数
const MAX_LATENCY_MS = Number(process.env.MAX_LATENCY_MS || 0)    // >0 时把超时长的也判为待删；默认关闭
const MIN_KEEP_RATIO = Number(process.env.MIN_KEEP_RATIO || 0.5)  // 写回安全阀
const SEG_MIN_BYTES = Number(process.env.SEG_MIN_BYTES || 2000)   // 分片至少要下到这么多字节才算真的能播
const UA = process.env.PROBE_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }

const raw = readFileSync(FILE, 'utf-8')
const lines = raw.split(/\r?\n/)

// 解析 (extinf 行号, url 行号, 频道名, 分组, url)
const items = []
for (let i = 0; i < lines.length; i++) {
  if (!lines[i].startsWith('#EXTINF')) continue
  let j = i + 1
  while (j < lines.length && (lines[j].trim() === '' || lines[j].startsWith('#'))) j++
  if (j >= lines.length) continue
  items.push({
    extinfIdx: i,
    urlIdx: j,
    name: (lines[i].split(',').pop() || '').trim(),
    group: (lines[i].match(/group-title="([^"]*)"/) || [, ''])[1],
    url: lines[j].trim(),
  })
}

// ---------- 单主机并发限流 ----------
const gates = new Map()
function hostOf(url) { try { return new URL(url).host } catch { return url } }
async function withHostGate(url, fn) {
  const h = hostOf(url)
  let g = gates.get(h)
  if (!g) { g = { free: HOST_CONCURRENCY, queue: [] }; gates.set(h, g) }
  if (g.free <= 0) await new Promise((r) => g.queue.push(r))
  g.free--
  try { return await fn() } finally {
    g.free++
    g.queue.shift()?.()
  }
}

// ---------- HTTP ----------
async function httpGet(url, { timeoutMs = TIMEOUT_MS, maxBytes = 64 * 1024, referer, range } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const t0 = performance.now()
  try {
    const headers = { 'User-Agent': UA }
    if (referer) headers.Referer = referer
    if (range) headers.Range = range
    const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers })
    let ttfb = (performance.now() - t0) / 1000
    const chunks = []
    let total = 0
    if (res.body) {
      const reader = res.body.getReader()
      let first = true
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (first) { ttfb = (performance.now() - t0) / 1000; first = false }
          chunks.push(Buffer.from(value)); total += value.length
          if (maxBytes && total >= maxBytes) break
        }
      } catch { /* 读到一半被 abort：已下到的字节仍算数 */ }
      reader.cancel().catch(() => {})
    }
    return {
      ok: res.status >= 200 && res.status < 400, code: res.status, finalUrl: res.url || url,
      ctype: res.headers.get('content-type') || '', ttfb, bytes: total, buf: Buffer.concat(chunks),
    }
  } catch (e) {
    const code = e?.name === 'AbortError' ? 'timeout' : (e?.cause?.code || e?.code || 'error')
    return { ok: false, code, finalUrl: url, ctype: '', ttfb: 0, bytes: 0, buf: Buffer.alloc(0) }
  } finally { clearTimeout(timer) }
}

const firstUri = (txt, base) => {
  for (const l of txt.split('\n')) {
    const s = l.trim()
    if (s && !s.startsWith('#')) { try { return new URL(s, base).href } catch { return null } }
  }
  return null
}
const lastUri = (txt, base) => {
  const ls = txt.split('\n')
  for (let i = ls.length - 1; i >= 0; i--) {
    const s = ls[i].trim()
    if (s && !s.startsWith('#')) { try { return new URL(s, base).href } catch { return null } }
  }
  return null
}
const variantUri = (txt, base) => {
  const ls = txt.split('\n')
  for (let i = 0; i < ls.length; i++) {
    if (!ls[i].trim().startsWith('#EXT-X-STREAM-INF')) continue
    for (const n of ls.slice(i + 1)) {
      const s = n.trim()
      if (s && !s.startsWith('#')) { try { return new URL(s, base).href } catch { return null } }
    }
  }
  return null
}

async function probeHttpOnce(url) {
  const r = await withHostGate(url, () => httpGet(url))
  if (!r.ok) return { status: 'dead', code: r.code, detail: `HTTP ${r.code}` }
  if (!DEEP) return { status: 'alive', code: r.code, ttfb: r.ttfb, detail: '仅状态码' }

  const text = r.buf.toString('utf8')
  if (text.slice(0, 200).includes('#EXTM3U')) {
    // HLS：master 逐级下钻到媒体清单，再真下一段分片
    let txt = text, base = r.finalUrl, ttfb = r.ttfb
    for (let d = 0; d < 2 && txt.includes('#EXT-X-STREAM-INF'); d++) {
      const v = variantUri(txt, base)
      if (!v) break
      const rv = await withHostGate(v, () => httpGet(v, { referer: base }))
      if (!rv.ok || !rv.bytes) return { status: 'dead', code: 'variant', detail: `主清单通但子清单取不到 (${rv.code})` }
      txt = rv.buf.toString('utf8'); base = rv.finalUrl; ttfb += rv.ttfb
    }
    // 直播清单（无 ENDLIST）先下最新一段：滑动窗口最老的分片源站常已删掉（大立电视台实测首段 404、
    // 末段正常），只下首段会把活源判死；点播清单仍下首段。最新一段不行再退回首段试一次，
    // 照顾个别末段还没写完就先列进清单的源站
    const live = !txt.includes('#EXT-X-ENDLIST')
    const candidates = [...new Set([live ? lastUri(txt, base) : firstUri(txt, base), firstUri(txt, base)].filter(Boolean))]
    if (!candidates.length) return { status: 'dead', code: 'empty', detail: '清单里没有分片（空播放列表）' }
    let rs
    for (const seg of candidates) {
      rs = await withHostGate(seg, () => httpGet(seg, {
        timeoutMs: SEG_TIMEOUT_MS, maxBytes: 400_000, range: 'bytes=0-400000', referer: base,
      }))
      if (rs.bytes >= SEG_MIN_BYTES) break
    }
    if (rs.bytes < SEG_MIN_BYTES) return { status: 'dead', code: 'segment', detail: `分片下不动 (${rs.code}, ${rs.bytes}B)` }
    return { status: 'alive', code: r.code, ttfb: ttfb + rs.ttfb, detail: 'hls' }
  }

  // 非清单：可能是裸 TS/FLV 直流，也可能是伪装成 200 的错误页
  if (/^\s*<(!doctype|html)/i.test(text.slice(0, 200))) {
    const title = (text.match(/<title>([^<]*)<\/title>/i) || [, ''])[1].trim()
    return { status: 'dead', code: 'html', detail: `返回 HTML 而非流${title ? `：${title}` : ''}` }
  }
  const rs = r.bytes >= SEG_MIN_BYTES ? r : await withHostGate(url, () => httpGet(url, {
    timeoutMs: SEG_TIMEOUT_MS, maxBytes: 400_000, range: 'bytes=0-400000',
  }))
  if (rs.bytes < SEG_MIN_BYTES) return { status: 'dead', code: 'nodata', detail: `非清单且无数据 (${rs.ctype || '?'}, ${rs.bytes}B)` }
  const kind = rs.buf[0] === 0x47 ? 'ts' : (rs.buf.subarray(0, 3).toString() === 'FLV' ? 'flv' : 'bin')
  return { status: 'alive', code: r.code, ttfb: rs.ttfb, detail: `裸流 ${kind}` }
}

// ---------- RTMP ----------
// 只用 node:net 手写：握手 → connect → createStream → play，看有没有真的吐音视频数据。
// 旧版直接 skip 掉 rtmp，结果一批早就死透的 rtmp 源一直留在清单里。
const amfStr = (s) => { const b = Buffer.from(s, 'utf8'); const h = Buffer.alloc(3); h[0] = 0x02; h.writeUInt16BE(b.length, 1); return Buffer.concat([h, b]) }
const amfKey = (s) => { const b = Buffer.from(s, 'utf8'); const h = Buffer.alloc(2); h.writeUInt16BE(b.length, 0); return Buffer.concat([h, b]) }
const amfNum = (n) => { const b = Buffer.alloc(9); b.writeDoubleBE(n, 1); return b }
const amfBool = (v) => Buffer.from([0x01, v ? 1 : 0])
const amfNull = () => Buffer.from([0x05])
const amfObj = (pairs) => Buffer.concat([
  Buffer.from([0x03]), ...pairs.flatMap(([k, v]) => [amfKey(k), v]), Buffer.from([0x00, 0x00, 0x09]),
])

function rtmpChunk(csid, ts, mtype, msid, payload, chunkSize = 128) {
  const h = Buffer.alloc(12)
  h[0] = csid & 0x3f
  h.writeUIntBE(ts, 1, 3)
  h.writeUIntBE(payload.length, 4, 3)
  h[7] = mtype
  h.writeUInt32LE(msid, 8)
  const parts = [h, payload.subarray(0, chunkSize)]
  for (let o = chunkSize; o < payload.length; o += chunkSize) {
    parts.push(Buffer.from([0xc0 | (csid & 0x3f)]), payload.subarray(o, o + chunkSize))
  }
  return Buffer.concat(parts)
}

function probeRtmpOnce(url) {
  return new Promise((resolve) => {
    let u
    try { u = new URL(url) } catch { return resolve({ status: 'dead', code: 'badurl', detail: 'rtmp 地址无法解析' }) }
    const path = u.pathname.replace(/^\/+|\/+$/g, '')
    const app = path.split('/')[0]
    const stream = path.slice(app.length + 1)
    if (!app || !stream) return resolve({ status: 'dead', code: 'badurl', detail: 'rtmp 缺少 app/stream' })

    const t0 = performance.now()
    let phase = 'handshake', hs = Buffer.alloc(0), body = Buffer.alloc(0), settled = false
    const sock = net.createConnection({ host: u.hostname, port: Number(u.port) || 1935 })
    const done = (r) => { if (settled) return; settled = true; clearTimeout(timer); sock.destroy(); resolve(r) }
    const timer = setTimeout(() => done(verdict()), TIMEOUT_MS)

    function verdict() {
      const txt = body.toString('latin1')
      if (phase === 'handshake') return { status: 'dead', code: 'handshake', detail: `RTMP 握手无响应（收到 ${hs.length}B）` }
      if (/NetConnection\.Connect\.(Rejected|Failed)/.test(txt)) return { status: 'dead', code: 'rejected', detail: 'connect 被拒绝' }
      if (/NetStream\.Play\.(StreamNotFound|Failed)/.test(txt)) return { status: 'dead', code: 'notfound', detail: '流不存在 (StreamNotFound)' }
      if (!txt.includes('NetConnection.Connect.Success')) return { status: 'dead', code: 'noreply', detail: `握手过了但 connect 无响应（收到 ${body.length}B）` }
      if (body.length < 60_000) return { status: 'dead', code: 'nomedia', detail: `connect 成功但拉不到音视频（仅 ${body.length}B）` }
      return { status: 'alive', code: 'rtmp', ttfb: (performance.now() - t0) / 1000, detail: `rtmp ${Math.round(body.length / 1024)}KB` }
    }

    sock.setTimeout(TIMEOUT_MS, () => done(verdict()))
    sock.on('error', (e) => done({ status: 'dead', code: e?.code || 'error', detail: `连不上：${e?.code || e?.message}` }))
    sock.on('close', () => done(verdict()))
    sock.on('connect', () => {
      sock.write(Buffer.concat([Buffer.from([0x03]), Buffer.alloc(8), randomBytes(1528)])) // C0 + C1
    })
    sock.on('data', (d) => {
      if (phase === 'handshake') {
        hs = Buffer.concat([hs, d])
        if (hs.length < 1 + 1536 * 2) return
        sock.write(hs.subarray(1, 1537)) // C2 = S1
        const extra = hs.subarray(1 + 1536 * 2)
        phase = 'command'
        sock.write(rtmpChunk(3, 0, 20, 0, Buffer.concat([
          amfStr('connect'), amfNum(1), amfObj([
            ['app', amfStr(app)], ['flashVer', amfStr('LNX 9,0,124,2')],
            ['tcUrl', amfStr(`rtmp://${u.host}/${app}`)], ['fpad', amfBool(false)],
            ['capabilities', amfNum(15)], ['audioCodecs', amfNum(4071)],
            ['videoCodecs', amfNum(252)], ['videoFunction', amfNum(1)], ['objectEncoding', amfNum(0)],
          ]),
        ])))
        sock.write(rtmpChunk(3, 0, 20, 0, Buffer.concat([amfStr('createStream'), amfNum(2), amfNull()])))
        sock.write(rtmpChunk(8, 0, 20, 1, Buffer.concat([
          amfStr('play'), amfNum(3), amfNull(), amfStr(stream), amfNum(-2000),
        ])))
        if (extra.length) body = Buffer.concat([body, extra])
        return
      }
      body = Buffer.concat([body, d])
      if (body.length > 120_000) done(verdict())
    })
  })
}

// ---------- 重试 + 采样 ----------
const probeOnce = (url) => (/^rtmp:/i.test(url) ? probeRtmpOnce(url) : probeHttpOnce(url))

async function probe(url) {
  let last
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    last = await probeOnce(url)
    if (last.status === 'alive') {
      if (SAMPLES > 1) {
        const ts = [last.ttfb ?? 0]
        for (let s = 1; s < SAMPLES; s++) {
          await sleep(400)
          const r = await probeOnce(url)
          if (r.status === 'alive') ts.push(r.ttfb ?? 0)
        }
        last.samples = ts
        last.ttfb = median(ts)
      }
      return last
    }
    if (attempt < RETRIES) await sleep(RETRY_DELAY_MS * attempt) // 指数退避，躲代理/源站的瞬时 503
  }
  return last
}

// 简易并发池
async function runPool(arr, n, fn) {
  const out = new Array(arr.length)
  let idx = 0
  await Promise.all(Array.from({ length: Math.min(n, arr.length) }, async () => {
    while (idx < arr.length) { const cur = idx++; out[cur] = await fn(arr[cur]) }
  }))
  return out
}

let finished = 0
const results = await runPool(items, CONCURRENCY, async (it) => {
  const r = { ...it, ...(await probe(it.url)) }
  finished++
  const lat = r.ttfb != null ? `${r.ttfb.toFixed(2)}s` : '-'
  process.stderr.write(`[${String(finished).padStart(3)}/${items.length}] ${r.status === 'alive' ? '✅' : '❌'} ${r.name} ${lat} ${r.detail || ''}\n`)
  return r
})

const alive = results.filter((r) => r.status === 'alive')
// MAX_LATENCY_MS 开启时才按延迟剔除。默认关闭：延迟高常常是整个 CDN 的基线而非单频道问题，
// 一刀切会误伤一批其实能正常播的主流台。要用的话务必配 SAMPLES>=3，否则是在按噪声删频道。
const slow = MAX_LATENCY_MS > 0 ? alive.filter((r) => (r.ttfb ?? 0) * 1000 > MAX_LATENCY_MS) : []
const slowSet = new Set(slow)
const healthy = alive.filter((r) => !slowSet.has(r))
const dead = results.filter((r) => r.status === 'dead')
const drops = [...dead, ...slow]

const lat = alive.filter((r) => r.ttfb != null).map((r) => r.ttfb).sort((a, b) => a - b)
const pct = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] : 0)

const md = []
md.push(`# IPTV.m3u 探活报告（${DRY_RUN ? 'dry-run · 未修改文件' : '已剔除死链'}）`)
md.push('')
md.push(`- 运行时间(UTC): ${new Date().toISOString()}`)
md.push(`- 运行环境: ${process.env.GITHUB_ACTIONS ? 'GitHub Actions runner（海外）' : '本地'}`)
md.push(`- 探活模式: ${DEEP ? '深度（验清单 + 真下分片；rtmp 走真实握手/play）' : '快速（仅状态码）'}`)
md.push(`- 重试次数: ${RETRIES}（指数退避，任一次通即判活）｜延迟采样: ${SAMPLES} 次取中位数`)
md.push(`- 总频道: **${items.length}**`)
md.push(`- ✅ 存活: **${alive.length}**`)
md.push(`- ❌ 失效: **${dead.length}**`)
if (MAX_LATENCY_MS > 0) md.push(`- 🐢 超过延迟阈值 ${MAX_LATENCY_MS}ms（一并剔除）: **${slow.length}**`)
if (lat.length) md.push(`- 首帧延迟: 中位 ${pct(0.5).toFixed(2)}s ｜ p90 ${pct(0.9).toFixed(2)}s ｜ 最慢 ${lat[lat.length - 1].toFixed(2)}s`)
md.push('')
md.push('> ⚠️ 务必在「真实使用网络」下探活：无外网环境会把外网源判失效（属预期）；在有外网的机器上跑则外网源会「假活」、删除判断偏乐观。')
md.push('')
md.push('## ❌ 失效明细')
for (const d of dead) md.push(`- \`[${d.code}]\` ${d.group ? `${d.group} · ` : ''}${d.name} — ${d.detail || ''}\n  - ${d.url}`)
if (!dead.length) md.push('- （无）')
md.push('')
if (MAX_LATENCY_MS > 0) {
  md.push(`## 🐢 超过延迟阈值 ${MAX_LATENCY_MS}ms`)
  for (const s of slow) md.push(`- \`${s.ttfb.toFixed(2)}s\` ${s.name} — ${s.url}`)
  if (!slow.length) md.push('- （无）')
  md.push('')
}
if (lat.length) {
  md.push('## ⏱️ 首帧延迟排行（最慢 20）')
  md.push('')
  md.push('| 延迟 | 分组 | 频道 | 采样 |')
  md.push('| --- | --- | --- | --- |')
  for (const r of [...alive].sort((a, b) => (b.ttfb ?? 0) - (a.ttfb ?? 0)).slice(0, 20)) {
    md.push(`| ${(r.ttfb ?? 0).toFixed(2)}s | ${r.group || '-'} | ${r.name} | ${r.samples ? r.samples.map((t) => t.toFixed(1)).join(' / ') : '-'} |`)
  }
  md.push('')
}

const report = md.join('\n')
writeFileSync('probe-report.md', report + '\n')
console.log(report)
console.log(`\nSUMMARY: total=${items.length} alive=${alive.length} dead=${dead.length} slow=${slow.length}`)

if (!DRY_RUN) {
  if (healthy.length < items.length * MIN_KEEP_RATIO) {
    console.error(`⚠️ 存活比例过低 (${healthy.length}/${items.length})，疑似探活环境异常（如断网 / 代理抽风 / 探错了网络），跳过写回以免误删`)
    process.exit(2)
  }
  const drop = new Set()
  for (const d of drops) { drop.add(d.extinfIdx); drop.add(d.urlIdx) }
  const kept = lines.filter((_, i) => !drop.has(i))
  // 折叠删除后可能产生的连续空行
  const clean = []
  for (const l of kept) {
    if (l.trim() === '' && clean.length && clean[clean.length - 1].trim() === '') continue
    clean.push(l)
  }
  writeFileSync(FILE, clean.join('\n').replace(/\n+$/, '\n'))
  console.log(`已写回 ${FILE}：剔除 ${drops.length} 个（死链 ${dead.length} + 超时长 ${slow.length}），保留 ${healthy.length} 个`)
}
