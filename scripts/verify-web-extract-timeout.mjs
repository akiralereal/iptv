#!/usr/bin/env node
/**
 * 用真实 Chromium 验证网页抓取（extractM3u8FromWeb）的几条行为：
 *   1. 嗅到即走：页面里有请求一直挂着（到不了 networkidle2）时，仍拿到 m3u8，且不等导航超时；
 *   2. 站点不通（连接被拒）：快速放弃，把时间留给下一个入口；
 *   3. 主文档零响应：导航超时后立即放弃，不再白等 waitTime；
 *   4. 播放器在跨域 iframe 里、要点播放按钮才拉流：兜底触发要遍历所有 frame 才点得到。
 * 不在 npm test 里（需要机器上有 Chrome/Chromium），手动跑：
 *
 *   node scripts/verify-web-extract-timeout.mjs
 *   mchromePath=/usr/bin/chromium node scripts/verify-web-extract-timeout.mjs
 *
 * 全部走本机回环，零外网请求。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 本机回环不要走代理（部分环境设置了 HTTPS_PROXY，Chromium 会尊重）
process.env.NO_PROXY = process.env.no_proxy = '127.0.0.1,localhost'
process.env.mdataDir = mkdtempSync(join(tmpdir(), 'iptv-verify-extract-'))
process.env.mbuiltInSourcesUrl = ''

let unhandled = 0
process.on('unhandledRejection', (e) => { unhandled++; console.error('unhandledRejection:', e?.message || e) })

const { extractM3u8FromWeb } = await import('../utils/webSourceExtractor.js')

let passed = 0
const ok = (name) => { passed++; console.log(`  ✅ ${name}`) }
const M3U8 = '#EXTM3U\n#EXT-X-VERSION:3\n'
const hits = { m3u8: 0, hang: 0, iframeM3u8: 0 }
let playerPort = 0

// 两个服务：主页面一个、播放器一个，端口不同即跨域，逼真地模拟「播放器在别人家的 iframe 里」
const app = http.createServer((req, res) => {
  const path = req.url.split('?')[0]
  switch (path) {
    case '/hang-page':   // 清单很快就到，但另有 3 个请求永远挂着 → 页面到不了 networkidle2
      res.setHeader('content-type', 'text/html')
      return res.end(`<html><body><script>fetch('/live.m3u8'); for (let i = 0; i < 3; i++) fetch('/hang?' + i)</script></body></html>`)
    case '/iframe-page': // 主页面空空如也，播放器在跨域 iframe 里
      res.setHeader('content-type', 'text/html')
      return res.end(`<html><body><iframe src="http://127.0.0.1:${playerPort}/player"></iframe></body></html>`)
    case '/live.m3u8':
      hits.m3u8++
      res.setHeader('content-type', 'application/vnd.apple.mpegurl')
      return res.end(M3U8)
    case '/hang':
      hits.hang++
      return             // 永不响应
    case '/silent':
      return             // 主文档本身永不响应 → 导航超时且零响应
    default:
      res.statusCode = 404
      return res.end()
  }
})
const player = http.createServer((req, res) => {
  const path = req.url.split('?')[0]
  if (path === '/player') {
    res.setHeader('content-type', 'text/html')
    return res.end(`<html><body><div class="play-btn" onclick="fetch('/iframe.m3u8')">play</div></body></html>`)
  }
  if (path === '/iframe.m3u8') {
    hits.iframeM3u8++
    res.setHeader('content-type', 'application/vnd.apple.mpegurl')
    return res.end(M3U8)
  }
  res.statusCode = 404
  res.end()
})
await new Promise(r => app.listen(0, '127.0.0.1', r))
await new Promise(r => player.listen(0, '127.0.0.1', r))
playerPort = player.address().port
const base = `http://127.0.0.1:${app.address().port}`

console.log('网页抓取「嗅到即走 / 导航超时不丢链接 / 遍历 frame 触发播放」验证')

{
  const t0 = Date.now()
  const r = await extractM3u8FromWeb(`${base}/hang-page`, { waitTime: 3000, returnAll: true, timeout: 20000 })
  const elapsed = Date.now() - t0
  assert.deepEqual(r, [`${base}/live.m3u8`], '应拿到清单地址')
  assert.equal(hits.hang, 3, '三个挂着的请求确实发出去了')
  assert.ok(elapsed < 12000, `应在导航超时(20s)前就返回，实际 ${elapsed}ms`)
  ok(`页面有请求一直挂着：仍拿到 m3u8，${elapsed}ms 即返回，没有陪页面等到导航超时`)
}

{
  const dead = http.createServer(() => {})
  await new Promise(r => dead.listen(0, '127.0.0.1', r))
  const deadPort = dead.address().port
  await new Promise(r => dead.close(r))
  const t0 = Date.now()
  const r = await extractM3u8FromWeb(`http://127.0.0.1:${deadPort}/`, { waitTime: 3000, timeout: 20000 })
  const elapsed = Date.now() - t0
  assert.equal(r, null)
  assert.ok(elapsed < 8000, `连接被拒应快速失败，实际 ${elapsed}ms`)
  ok(`站点不通（连接被拒）：${elapsed}ms 即放弃`)
}

{
  const t0 = Date.now()
  const r = await extractM3u8FromWeb(`${base}/silent`, { waitTime: 5000, timeout: 3000 })
  const elapsed = Date.now() - t0
  assert.equal(r, null)
  assert.ok(elapsed < 3000 + 4000, `导航超时且零响应应立即放弃，不该再等 waitTime，实际 ${elapsed}ms`)
  ok(`主文档零响应：导航超时(3s)后立即放弃，${elapsed}ms`)
}

{
  const r = await extractM3u8FromWeb(`${base}/iframe-page`, { waitTime: 1000, returnAll: true, timeout: 20000 })
  assert.deepEqual(r, [`http://127.0.0.1:${playerPort}/iframe.m3u8`])
  assert.equal(hits.iframeM3u8, 1)
  ok('播放器在跨域 iframe 里：兜底触发点到了 iframe 里的播放按钮，拉到 m3u8')
}

assert.equal(unhandled, 0, '不应有未处理的 Promise 拒绝（导航被浏览器关闭打断时）')
ok('关闭浏览器时导航仍在进行也没有未处理的 Promise 拒绝')

app.closeAllConnections?.(); player.closeAllConnections?.()
app.close(); player.close()
console.log(`\n全部通过：${passed} 项`)
process.exit(0)
