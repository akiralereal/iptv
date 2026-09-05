#!/usr/bin/env node
/**
 * 播放器页沙箱解析（utils/playerPageSandbox.js）回归测试
 *
 * 背景：纬来体育所在的 jrs 系入口页把播放器放在跨域 iframe（cloud.yumixiu768.com）里，页内 jsjiami
 * 混淆脚本把 URL 参数 id 解密成 m3u8 再交给 xgplayer。NAS 容器里的无头 Chromium 抓这一页时 iframe
 * 渲染进程会卡死（frame 10 秒不响应脚本执行），而这段解密只是几十毫秒的纯 JS。沙箱解析把页面脚本
 * 放进 worker 线程的 node:vm 里跑，收集交给播放器 / 写进 DOM 的 m3u8，不起浏览器。
 *
 * 不变量：
 *  - 真实播放器页快照（scripts/fixtures/vl-sports-player-page.html）能解出已知的 m3u8；
 *  - 入口页本身没有地址时跟进它嵌的 iframe；
 *  - 跨域外链脚本一律不下载，同源的按文档顺序跑，document.write 写出的同源脚本再跑一轮；
 *  - 页面脚本拿不到宿主对象（每个沙箱函数的 constructor 都是沙箱 realm 的 Function）；
 *  - 同步死循环 / 吃内存的脚本不会拖死进程，之前已找到的地址照样返回；
 *  - 页面 HTTP 错误 / 连不上只返回空数组，不抛错。
 *
 * 运行： node scripts/test-player-page-sandbox.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { decodeM3u8FromWeb, decodeM3u8FromPage, extractScriptTags, extractIframeSrcs } from '../utils/playerPageSandbox.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8')

let passed = 0
const check = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('播放器页沙箱解析回归测试')

// ---------- 纯函数 ----------
await check('extractScriptTags：按文档顺序区分外链 / 内联，跳过模板 / JSON 类型', async () => {
  const tags = extractScriptTags(`
    <script src="a.js"></script>
    <script type="text/template"><div>x</div></script>
    <script type="application/json">{"a":1}</script>
    <script>var x = 1</script>
    <script type='text/javascript' src='b.js'></script>
    <script type="module">import 'c'</script>
  `)
  assert.deepEqual(tags.map(t => t.src || t.code.trim()), ['a.js', 'var x = 1', 'b.js', "import 'c'"])
})

await check('extractIframeSrcs：去重、跳过 about:blank / javascript:', async () => {
  assert.deepEqual(
    extractIframeSrcs(`<iframe src="about:blank"></iframe><iframe src='/p.html?id=1'></iframe><iframe src="/p.html?id=1"><iframe src=javascript:void(0)>`),
    ['/p.html?id=1'],
  )
})

// ---------- 本地站点 ----------
const REAL_ID = 'PWdHZDBCM2M2OHlMb3gyYzY1U2VxcDJZbWRuTGo5V2J2d1dhMlYyTDJ4bUx0TlRkNDhUWjRCWGF5VldQeGNETzJrRE40TXpOeVl5Y3BkbWI5SVRaMEVXTjJJR081WVdaMlFETmtKV00wY1ROMUlETXhFalo1Y2pNM0VETg=='
const REAL_M3U8 = 'https://hlsz.yjjcfw.com/live/vl.m3u8?expire=1786948372&sign=2e4a56b89fe644db147552011f972714'
const hits = []
const routes = {
  '/entry.html': `<html><body><iframe src="/player/pap.html?id=${REAL_ID}"></iframe></body></html>`,
  '/player/pap.html': fixture('vl-sports-player-page.html'),
  '/player/index.min.js': fixture('vl-sports-player-index.min.js'),
  '/xg.html': `<html><head><script src="/lib.js"></script><script src="http://127.0.0.1:1/never.js"></script></head><body>
    <script>let originalUrl = 'https://x.example/live/a.m3u8?sign=1'</script>
    <script>document.write('<scr' + 'ipt src="/t.js"></scr' + 'ipt>')</script>
    <script>new Player({ id: 'mse', url: originalUrl, plugins: [HlsPlayer] })</script></body></html>`,
  '/lib.js': 'window.__lib = 1',
  '/t.js': 'document.write("https://x.example/from-t.m3u8")',
  '/onload.html': `<html><script>window.addEventListener('load', function(){ var v = document.createElement('video'); v.src = 'https://x.example/late.m3u8'; setTimeout(function(){ document.write('https://x.example/timer.m3u8') }, 100); setTimeout(function(){ document.write('https://x.example/too-late.m3u8') }, 60000) })</script></html>`,
  '/loop.html': `<html><script>document.write('https://x.example/before.m3u8')</script><script>while(true){}</script><script>document.write('https://x.example/after.m3u8')</script></html>`,
  '/bomb.html': `<html><script>document.write('https://x.example/before-bomb.m3u8'); var a = []; while (a.length > -1) { a.push(a.length ^ 2) }</script></html>`,
  '/escape.html': `<html><script>
    var probes = [document.write, atob, btoa, setTimeout, Player, XMLHttpRequest, JSON.stringify, document.getElementById('x').play, $, Hls.prototype.loadSource, Object, Function]
    var out = probes.map(function (f) { try { return f.constructor('return typeof process')() } catch (e) { return 'threw' } })
    document.write('https://probe.example/' + out.join('_') + '.m3u8')
    document.write('https://probe.example/require-' + (typeof require) + '-global-' + (typeof globalThis.process) + '.m3u8')
  </script></html>`,
  '/500.html': null,
}
const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname
  hits.push(path)
  if (!(path in routes) || routes[path] === null) { res.statusCode = path in routes ? 500 : 404; return res.end('nope') }
  res.setHeader('Content-Type', path.endsWith('.js') ? 'application/javascript' : 'text/html; charset=utf-8')
  res.end(routes[path])
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

try {
  await check('真实播放器页快照：jsjiami 解密 id → 已知 m3u8（不下载跨域的 xgplayer）', async () => {
    const r = await decodeM3u8FromPage(`${base}/player/pap.html?id=${REAL_ID}`)
    assert.deepEqual(r.links, [REAL_M3U8])
    // 跳过：unpkg.byted-static.com 的两个 xgplayer 脚本 + document.write 写出的 //cloud.yumixiu768.com/player/t.js（对本地站点而言也是跨域）
    assert.equal(r.skipped, 3, `跨域脚本应跳过: ${JSON.stringify(r)}`)
    assert.ok(r.ran >= 4, `应跑了 index.min.js + 内联脚本，实际 ${r.ran}`)
    assert.ok(hits.includes('/player/index.min.js'), '同源 index.min.js 应下载')
  })

  await check('入口页没有地址 → 跟进 iframe 拿到', async () => {
    const links = await decodeM3u8FromWeb(`${base}/entry.html`)
    assert.deepEqual(links, [REAL_M3U8])
  })

  await check('new Player({url}) 捕获 + 跨域脚本不下载 + document.write 写出的同源脚本再跑一轮', async () => {
    hits.length = 0
    const links = await decodeM3u8FromWeb(`${base}/xg.html`)
    assert.deepEqual(links, ['https://x.example/live/a.m3u8?sign=1', 'https://x.example/from-t.m3u8'])
    assert.ok(hits.includes('/lib.js') && hits.includes('/t.js'), `同源脚本应下载: ${hits}`)
    assert.ok(!hits.includes('/never.js'))
  })

  await check('load 回调与短延时定时器里给的地址也能拿到，超长定时器不等', async () => {
    const links = await decodeM3u8FromWeb(`${base}/onload.html`)
    assert.deepEqual(links, ['https://x.example/late.m3u8', 'https://x.example/timer.m3u8'])
  })

  await check('同步死循环 3 秒截断：之前找到的保留、后面的脚本继续跑', async () => {
    const t = Date.now()
    const r = await decodeM3u8FromPage(`${base}/loop.html`)
    assert.deepEqual(r.links, ['https://x.example/before.m3u8', 'https://x.example/after.m3u8'])
    assert.equal(r.errors, 1)
    assert.ok(Date.now() - t < 8000, `不应等太久: ${Date.now() - t}ms`)
  })

  await check('无限占内存的脚本只挂掉沙箱线程，主进程照常、已找到的照样返回', async () => {
    const r = await decodeM3u8FromPage(`${base}/bomb.html`)
    assert.ok(r.error || r.errors, `应报错: ${JSON.stringify(r)}`)
    assert.ok(process.memoryUsage().rss < 2 * 1024 * 1024 * 1024)
  })

  await check('页面脚本够不到宿主：所有沙箱函数的 constructor 都在沙箱 realm 里', async () => {
    const r = await decodeM3u8FromPage(`${base}/escape.html`)
    assert.equal(r.links.length, 2, JSON.stringify(r))
    const [probe, direct] = r.links
    assert.ok(!/object|function/.test(probe), `某个沙箱函数漏出了宿主 Function: ${probe}`)
    assert.equal(direct, 'https://probe.example/require-undefined-global-undefined.m3u8')
  })

  await check('HTTP 错误 / 连不上 / 非法地址：返回空数组不抛错', async () => {
    assert.deepEqual(await decodeM3u8FromWeb(`${base}/500.html`), [])
    assert.deepEqual(await decodeM3u8FromWeb(`${base}/missing.html`), [])
    assert.deepEqual(await decodeM3u8FromWeb('http://127.0.0.1:1/dead.html'), [])
    assert.deepEqual(await decodeM3u8FromWeb('not a url'), [])
  })
} finally {
  server.close()
}

console.log(`\n全部通过 (${passed} 项)`)
