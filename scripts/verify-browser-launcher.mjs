#!/usr/bin/env node
/**
 * 用真实 Chromium 验证「浏览器并发上限 + 抓取失败退避 + 只嗅探不下载分片」的修复。
 * 不在 npm test 里（需要机器上有 Chrome/Chromium），手动跑：
 *
 *   node scripts/verify-browser-launcher.mjs
 *   mchromePath=/usr/bin/chromium node scripts/verify-browser-launcher.mjs   # 指定浏览器
 *
 * 做的事：
 *   1. 起一个本机 HTTP 服务，模拟一个「直播页」：页面用 fetch 轮询 m3u8 并不停拉 .ts 分片，
 *      同时引用图片；服务端统计每类请求的次数。
 *   2. 用网页抓取（extractM3u8FromWeb）抓这个页面：应当拿到 m3u8，而 .ts / 图片请求应为 0，
 *      抓完后不残留 Chromium 进程。
 *   3. 同时申请 3 个浏览器（默认上限 2）：第 3 个应排队，任何时刻存活的 Chromium 主进程 ≤ 上限；
 *      关掉一个后第 3 个立即拿到位子。
 *   4. 常驻会话空闲让位：持有者空闲时，排队方不必等它超时就能拿到位子。
 *   5. 模拟 5 分钟 tick 一小时：抓取一直失败的源，旧逻辑重试 12 次，新逻辑应只重试 3 次。
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import http from 'node:http'

// 本机回环不要走代理（部分环境设置了 HTTPS_PROXY，Chromium 会尊重）
process.env.NO_PROXY = process.env.no_proxy = '127.0.0.1,localhost'
process.env.mbrowserConcurrency = process.env.mbrowserConcurrency || '2'
process.env.mdataDir = `${process.env.TMPDIR || '/tmp'}/iptv-verify-${process.pid}`
process.env.mbuiltInSourcesUrl = ''

const { launchBrowser, closeBrowser, getBrowserPool, MAX_BROWSERS } = await import('../utils/browserLauncher.js')
const { extractM3u8FromWeb } = await import('../utils/webSourceExtractor.js')
const { default: builtInSourceManager } = await import('../utils/builtInSources.js')

let passed = 0
const ok = (name) => { passed++; console.log(`  ✅ ${name}`) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** 统计 Chromium 主进程数（命令行里没有 --type= 的才是主进程；renderer/gpu 是它的子进程） */
function chromiumMainProcesses() {
  let count = 0
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue
    let cmd = ''
    try { cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8') } catch { continue }
    if (/chrom(e|ium)/i.test(cmd) && cmd.includes('--remote-debugging') && !cmd.includes('--type=')) count++
  }
  return count
}

// ---------- 1. 模拟直播页 ----------
const hits = { html: 0, m3u8: 0, ts: 0, image: 0, other: 0 }
const server = http.createServer((req, res) => {
  const path = req.url.split('?')[0]
  if (path === '/live.html') {
    hits.html++
    res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' })
    res.end(`<!doctype html><html><body>
      <img src="/logo.png"><video id="v" muted></video>
      <script>
        let seq = 0
        async function loop() {
          try {
            await fetch('/live/index.m3u8?t=' + Date.now())
            await fetch('/live/seg-' + (seq++) + '.ts')
          } catch (e) {}
          setTimeout(loop, 200)
        }
        loop()
      </script></body></html>`)
    return
  }
  if (path.endsWith('.m3u8')) {
    hits.m3u8++
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
    res.end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nseg-0.ts\n')
    return
  }
  if (path.endsWith('.ts')) { hits.ts++; res.writeHead(200); res.end(Buffer.alloc(188 * 100)); return }
  if (path.endsWith('.png')) { hits.image++; res.writeHead(200); res.end(Buffer.alloc(10)); return }
  hits.other++
  res.writeHead(404); res.end()
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
console.log(`模拟直播页: ${base}/live.html（浏览器上限 ${MAX_BROWSERS}）`)

const pool = getBrowserPool()
const baselineProcs = chromiumMainProcesses()

// ---------- 2. 网页抓取：拿到 m3u8，但不下载分片 / 图片，抓完不残留进程 ----------
{
  const t0 = Date.now()
  const links = await extractM3u8FromWeb(`${base}/live.html`, { waitTime: 1500, returnAll: true, timeout: 15000 })
  const seconds = ((Date.now() - t0) / 1000).toFixed(1)
  assert.ok(Array.isArray(links) && links.some(u => u.includes('/live/index.m3u8')), `未抓到 m3u8：${JSON.stringify(links)}`)
  assert.ok(hits.m3u8 >= 1, 'm3u8 请求应放行')
  assert.equal(hits.ts, 0, `.ts 分片应被拦截，实际到达服务端 ${hits.ts} 次`)
  assert.equal(hits.image, 0, `图片应被拦截，实际到达服务端 ${hits.image} 次`)
  assert.equal(pool.size, 0, '抓完应归还浏览器位子')
  await sleep(500)
  assert.equal(chromiumMainProcesses(), baselineProcs, '抓完不应残留 Chromium 进程')
  ok(`网页抓取 ${seconds}s：拿到 m3u8（服务端收到 m3u8 ${hits.m3u8} 次），.ts 0 次、图片 0 次，进程无残留`)
}

// ---------- 3. 并发上限：第 3 个排队，主进程数从不超过上限 ----------
{
  const limit = MAX_BROWSERS
  const browsers = []
  for (let i = 0; i < limit; i++) browsers.push(await launchBrowser({ label: `占位${i + 1}`, waitMs: 5000 }))
  assert.equal(pool.size, limit)
  let peak = 0
  const sampler = setInterval(() => { peak = Math.max(peak, chromiumMainProcesses() - baselineProcs) }, 50)
  let granted = false
  const third = launchBrowser({ label: '排队者', waitMs: 10000 }).then(b => { granted = true; return b })
  await sleep(1500)
  assert.equal(granted, false, '超出上限时应排队而不是直接启动')
  assert.equal(pool.waiting, 1)
  await closeBrowser(browsers[0], { label: '占位1' })
  const thirdBrowser = await third
  clearInterval(sampler)
  assert.equal(granted, true)
  assert.ok(peak <= limit, `Chromium 主进程峰值 ${peak} 超过上限 ${limit}`)
  await Promise.all([...browsers.slice(1), thirdBrowser].map(b => closeBrowser(b)))
  await sleep(500)
  assert.equal(pool.size, 0)
  assert.equal(chromiumMainProcesses(), baselineProcs)
  ok(`并发上限 ${limit}：第 ${limit + 1} 个请求排队，释放一个后立即放行；主进程峰值 ${peak} ≤ ${limit}`)
}

// ---------- 4. 空闲让位 ----------
{
  const limit = MAX_BROWSERS
  const idle = []
  for (let i = 0; i < limit; i++) {
    const holder = { browser: null, busy: i === 0 } // 第一个装忙，其余空闲
    holder.browser = await launchBrowser({
      label: `常驻会话${i + 1}`,
      waitMs: 5000,
      onIdleRequest: async () => {
        if (holder.busy) return false
        await closeBrowser(holder.browser, { label: `常驻会话${i + 1}` })
        return true
      },
    })
    idle.push(holder)
  }
  const t0 = Date.now()
  const newcomer = await launchBrowser({ label: '抓取任务', waitMs: 8000 })
  const waited = Date.now() - t0
  assert.ok(waited < 5000, `让位应远快于排队超时，实际等了 ${waited}ms`)
  assert.equal(idle[0].browser.connected, true, '忙碌的持有者不应被关掉')
  await closeBrowser(newcomer)
  await closeBrowser(idle[0].browser)
  await sleep(500)
  assert.equal(pool.size, 0)
  ok(`空闲让位：位子占满时空闲会话 ${waited}ms 内让出，忙碌会话不受影响`)
}

// ---------- 5. 模拟一小时的 5 分钟 tick：一直失败的源 ----------
{
  const source = { id: 'verify-failing', name: '一直失败的源', mode: 'fetch', refreshInterval: 60 }
  const realNow = Date.now
  const start = realNow()
  let attemptsNew = 0
  let attemptsOld = 0
  try {
    for (let minute = 0; minute < 60; minute += 5) {
      Date.now = () => start + minute * 60 * 1000
      // 旧逻辑：失败后缓存被清，「没缓存」= 每个 tick 都抓
      attemptsOld++
      // 新逻辑：退避窗口内 needsRefresh 为假
      if (builtInSourceManager.needsRefresh(source)) {
        attemptsNew++
        builtInSourceManager.noteFailure(source, 'Navigation timeout')
      }
    }
  } finally {
    Date.now = realNow
    builtInSourceManager.backoff.clear(source.id)
  }
  assert.equal(attemptsOld, 12)
  assert.equal(attemptsNew, 3, `一小时内应只重试 3 次（0 / 10 / 30 分钟），实际 ${attemptsNew}`)
  ok(`失败退避：一小时 12 个 tick，旧逻辑起 ${attemptsOld} 次浏览器，新逻辑 ${attemptsNew} 次`)
}

server.close()
console.log(`\n全部通过：${passed} 项`)
process.exit(0)
