#!/usr/bin/env node
/**
 * 全代理模式回归测试（issue #98 续）
 *
 * 核心不变量：
 *   1) 下发的清单里**没有任何绝对地址**——只有「同目录、不含斜杠」的相对地址（CDN 自己下发、
 *      且极影视实测能播的那种形态），相对解析后正好落回本机分片路由；
 *   2) 分片后缀保留（.ts / .m3u8 / .key），按后缀识别流格式的播放器才认；
 *   3) 同一条上游地址反复登记得到同一 key——直播清单每 6 秒刷新一次，key 变动会把地址表撑爆；
 *   4) 端到端：播放器按清单里的相对地址请求本机，拿到的字节与 CDN 原分片一致。
 *
 * 运行： node scripts/test-hls-proxy.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 数据目录必须在 import 之前定好：paths.js 在模块加载时就读 mdataDir
const DATA_DIR = mkdtempSync(join(tmpdir(), 'iptv-proxy-test-'))
process.env.mdataDir = DATA_DIR

const { toProxyManifest, lookup, register, pipeUpstream, probeUpstream, fetchUpstreamResponse, manifestCooling, markManifestResult, MANIFEST_FAIL_COOLDOWN_MS } = await import('../utils/hlsProxy.js')
const { fetchManifestDirect, interfaceStr, rewriteManifest } = await import('../utils/appUtils.js')

let passed = 0
const check = (n, fn) => { fn(); passed++; console.log('  ✅ ' + n) }
const checkAsync = async (n, fn) => { await fn(); passed++; console.log('  ✅ ' + n) }

console.log('全代理模式回归测试 (issue #98)')

// ---------- 1. 清单改写 ----------
check('绝对分片地址 → 同目录相对地址（不含斜杠），后缀保留', () => {
  const src = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:6',
    '#EXTINF:6.000000,',
    'http://cdn.example.com:8080/live/a-1.ts?token=abc&x=1',
  ].join('\n')
  const out = toProxyManifest(src, '608807420').split('\n')
  assert.equal(out[0], '#EXTM3U')
  assert.equal(out[1], '#EXT-X-TARGETDURATION:6')
  assert.match(out[3], /^s[0-9a-f]{16}\.ts$/)
  assert.ok(!out.some(l => l.includes('http://')), '清单里不允许残留任何绝对地址')
})

check('EXT-X-KEY 的 URI 属性同样代理（默认 .key 后缀）', () => {
  const src = '#EXT-X-KEY:METHOD=AES-128,URI="http://cdn.example.com/k.php?id=1",IV=0x12\n'
  const out = toProxyManifest(src, '1')
  assert.match(out, /URI="s[0-9a-f]{16}\.key"/)
  assert.ok(!out.includes('http://'))
})

check('master 清单里的子清单保留 .m3u8 后缀（拍平失败时的回退形态）', () => {
  const src = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nhttp://cdn.example.com/live/01.m3u8?t=1'
  const out = toProxyManifest(src, '7').split('\n')
  assert.match(out[2], /^s[0-9a-f]{16}\.m3u8$/)
})

check('顶层清单与嵌套子清单的分片地址落到同一条路由（同目录，无需按层区分）', () => {
  const seg = 'http://cdn.example.com/live/a-1.ts'
  const top = toProxyManifest(seg, '608807420').trim()
  const nested = toProxyManifest(seg, '608807420').trim()
  assert.equal(new URL(top, 'http://nas:1905/proxy/608807420.m3u8').pathname,
               new URL(nested, 'http://nas:1905/proxy/sabcdef0123456789.m3u8').pathname)
})

check('分片 key 带 s 前缀：与数字/命名空间频道引用的清单路由不相交', () => {
  const key = register('http://cdn.example.com/live/x.ts')
  assert.match(key, /^s[0-9a-f]{16}$/)
  assert.ok(!/^\d+$/.test(key))
})

check('同一上游地址登记结果稳定；非绝对地址原样保留', () => {
  const url = 'http://cdn.example.com/live/a-9.ts?token=zzz'
  assert.equal(register(url, '608807420'), register(url, '608807420'))
  assert.deepEqual(lookup(register(url, '608807420')), { url, pid: '608807420' })
  assert.equal(lookup('sffffffffffffffff'), null)
  assert.equal(toProxyManifest('a-1.ts', '1').trim(), 'a-1.ts')   // 改写漏网的相对地址不该被弄坏
})

check('平台防盗链请求头随分片地址登记，不暴露到播放列表文本', () => {
  const url = 'http://cdn.example.com/live/protected.ts'
  const upstreamHeaders = { Origin: 'https://live.example.com', Referer: 'https://live.example.com/' }
  const key = register(url, 'jstv-670', undefined, upstreamHeaders)
  assert.deepEqual(lookup(key), { url, pid: 'jstv-670', upstreamHeaders })
  const manifest = toProxyManifest(url, 'jstv-670', undefined, upstreamHeaders)
  assert.ok(!manifest.includes('Origin') && !manifest.includes('Referer'))
})

check('逐路径签名器在登记前改写上游地址，同时分片 key 仍按未签名路径保持稳定', () => {
  let generation = 0
  const signer = raw => `${raw}?sign=v${++generation}`
  const unsigned = 'https://sztv-live.sztv.com.cn/R77mK1v/500/123/456.ts'
  const firstRef = toProxyManifest(unsigned, 'sztv-24725', undefined, undefined, signer).trim()
  const first = lookup(firstRef.replace(/\.ts$/, ''))
  assert.equal(first.url, `${unsigned}?sign=v1`)
  assert.equal(first.upstreamUrlTransform, signer)

  const secondRef = toProxyManifest(unsigned, 'sztv-24725', undefined, undefined, signer).trim()
  const second = lookup(secondRef.replace(/\.ts$/, ''))
  assert.equal(secondRef, firstRef, '短效签名变化不能让代理地址表 key 跟着变化')
  assert.equal(second.url, `${unsigned}?sign=v2`, '重复登记应把上游短签名刷新为最新值')
})

check('CRLF/BOM 上游清单归一化：改写后无 \\r 残留、分片相对地址干净', () => {
  const src = '\uFEFF#EXTM3U\r\n#EXT-X-TARGETDURATION:6\r\n#EXTINF:6.000000,\r\nseg-1.ts?t=1\r\n'
  const abs = rewriteManifest(src, 'http://cdn.example.com/live/index.m3u8')
  assert.ok(!abs.includes('\r') && !abs.includes('\uFEFF'), JSON.stringify(abs))
  const out = toProxyManifest(abs, '608807420')
  assert.ok(!out.includes('\r'), '混合行尾会让严格按 \\r\\n 分行的播放器拿到脏 URI：' + JSON.stringify(out))
  const segLine = out.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'))
  assert.match(segLine, /^s[0-9a-f]{16}\.ts$/)
})

// ---------- 2. 订阅输出 ----------
check('?relay=2 订阅频道地址输出 /proxy/<pid>.m3u8（relay=1 仍是 /relay/）', () => {
  writeFileSync(join(DATA_DIR, 'interface.txt'), [
    '#EXTM3U x-tvg-url="${replace}/playback.xml"',
    '#EXTINF:-1 tvg-id="CCTV1综合" group-title="央视",CCTV1综合',
    '${replace}/608807420',
    '',
  ].join('\n'))
  const headers = { host: '192.168.3.37:1905' }
  const proxied = interfaceStr('/interface.m3u', headers, '', '', '', '', '2').content.toString()
  assert.ok(proxied.includes('http://192.168.3.37:1905/proxy/608807420.m3u8'), proxied)
  const relayed = interfaceStr('/interface.m3u', headers, '', '', '', '', '1').content.toString()
  assert.ok(relayed.includes('http://192.168.3.37:1905/relay/608807420.m3u8'), relayed)
  const plain = interfaceStr('/interface.m3u', headers, '', '', '', '', '').content.toString()
  assert.ok(plain.includes('http://192.168.3.37:1905/608807420') && !plain.includes('/proxy/'), plain)
})

check('模块可直接写入命名空间全代理地址，replace 后保持单段安全 ref', () => {
  writeFileSync(join(DATA_DIR, 'interface.txt'), [
    '#EXTM3U x-tvg-url="${replace}/playback.xml"',
    '#EXTINF:-1 tvg-id="广西卫视" group-title="广西电视台",广西卫视',
    '${replace}/proxy/gxtv-gxws.m3u8',
    '',
  ].join('\n'))
  const out = interfaceStr('/interface.m3u', { host: '192.168.3.37:1905' }, '', '', '', '', '').content.toString()
  assert.ok(out.includes('http://192.168.3.37:1905/proxy/gxtv-gxws.m3u8'), out)
})

// ---------- 3. 端到端：假 CDN → 本机全代理 → 播放器 ----------
const SEG_BODY = Buffer.from('FAKE-TS-PAYLOAD-0123456789', 'utf-8')

let cdnHits = 0   // 上游被打了几次；探活回归测试据此断言「一次都没打」
let redirectTargetHits = 0

const cdn = http.createServer((req, res) => {
  cdnHits++
  const path = req.url.split('?')[0]
  if (path === '/redirect-outside') {
    res.writeHead(302, { Location: `http://localhost:${cdn.address().port}/redirect-target` })
    res.end(); return
  }
  if (path === '/redirect-target') {
    redirectTargetHits++
    res.writeHead(200, { 'Content-Type': 'video/mp2t' })
    res.end(SEG_BODY); return
  }
  if (path === '/live/no-head.ts') {
    if (req.method === 'HEAD') { res.writeHead(405); res.end(); return }
    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': SEG_BODY.length })
    res.end(SEG_BODY)
    return
  }
  if (path === '/live/zero-head.ts') {
    // 部分 CDN 对流媒体路径的 HEAD 回 200 但长度为 0
    if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': 0 }); res.end(); return }
    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': SEG_BODY.length })
    res.end(SEG_BODY)
    return
  }
  if (path.startsWith('/protected/')) {
    if (req.headers.origin !== 'https://live.jstv.com' || req.headers.referer !== 'https://live.jstv.com/') {
      res.writeHead(403); res.end('missing anti-hotlink headers'); return
    }
    if (path === '/protected/index.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
      res.end('#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:3,\nprotected.ts\n')
      return
    }
    if (path === '/protected/protected.ts') {
      res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': SEG_BODY.length })
      res.end(SEG_BODY)
      return
    }
  }
  if (path === '/cookie-protected/segment.ts') {
    if (req.headers.cookie !== 'tvb_session=secret') {
      res.writeHead(403); res.end('missing cookie'); return
    }
    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': SEG_BODY.length })
    res.end(SEG_BODY)
    return
  }
  if (path === '/live/index.m3u8') {
    // 咪咕真实形态：master 里一条**相对**子清单
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
    res.end('#EXTM3U\n#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2084544\n01.m3u8?token=abc\n')
    return
  }
  if (path === '/live/01.m3u8') {
    // 媒体清单：**相对**分片名（带各自的查询串）
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
    res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:6.000000,\nseg-100.ts?token=abc\n')
    return
  }
  if (path === '/live/seg-100.ts') {
    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': SEG_BODY.length, 'Accept-Ranges': 'bytes' })
    res.end(SEG_BODY)
    return
  }
  res.writeHead(404); res.end()
})

// 本机：清单路由 /proxy/<pid>.m3u8 与分片路由 /proxy/<pid>/<key>.<ext>（与 app.js 同构）
const nas = http.createServer(async (req, res) => {
  const seg = req.url.match(/^\/proxy\/(s[0-9a-f]{16})\.[a-z0-9]{1,8}$/)
  if (seg) {
    const target = lookup(seg[1])
    if (!target) { res.writeHead(404); res.end('分片地址已过期'); return }
    if (req.method === 'HEAD') {
      await probeUpstream(target.url, req, res, target.transform, target.upstreamHeaders)
      return
    }
    await pipeUpstream(target.url, req, res, target.transform, target.upstreamHeaders)
    return
  }
  const man = req.url.match(/^\/proxy\/([a-z0-9][a-z0-9_-]{0,63})\.m3u8$/i)
  if (man) {
    // 与 app.js 同构：HEAD/OPTIONS 本地收口，绝不触发上游解析链（见 app.js 的
    // 「OPTIONS 与 HEAD 一律本地回答」）。播放器打开订阅会逐频道探活，走真实生成链
    // 会瞬间打出上百个上游请求并撞上平台限速。
    if (req.method === 'HEAD' || req.method === 'OPTIONS') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
      res.end()
      return
    }
    const abs = await fetchManifestDirect(`http://127.0.0.1:${cdn.address().port}/live/index.m3u8?token=abc`)
    const body = Buffer.from(toProxyManifest(abs, man[1]), 'utf-8')
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': body.length })
    res.end(body)
    return
  }
  res.writeHead(404); res.end()
})

await new Promise(r => cdn.listen(0, '127.0.0.1', r))
await new Promise(r => nas.listen(0, '127.0.0.1', r))
const nasBase = `http://127.0.0.1:${nas.address().port}`

await checkAsync('动态请求头在每次重定向前复验目标，不向白名单外地址发请求', async () => {
  const source = `http://127.0.0.1:${cdn.address().port}/redirect-outside`
  const upstreamHeaders = url => {
    if (new URL(url).hostname !== '127.0.0.1') throw new Error('目标不在媒体白名单')
    return {}
  }
  await assert.rejects(fetchUpstreamResponse(source, { upstreamHeaders }), /目标不在媒体白名单/)
  assert.equal(redirectTargetHits, 0)
})

check('清单取回失败进入熔断：播放器的连环重试不再逐次打上游', () => {
  // 实测 AptvPlayer 取不到清单后 1 秒内重试 9 次；逐次转发会把平台限速越推越深。
  const t0 = 1_000_000
  assert.equal(manifestCooling('ysp-cctv1', t0), false, '未失败过时不得熔断')

  markManifestResult('ysp-cctv1', false, t0)
  let upstreamCalls = 0
  for (let i = 0; i < 9; i++) {                       // 复刻 100ms 一次的重试风暴
    if (!manifestCooling('ysp-cctv1', t0 + i * 110)) upstreamCalls++
  }
  assert.equal(upstreamCalls, 0, '熔断窗口内一次上游都不该打')

  // 窗口过后放行一次，让真正恢复了的频道能立刻回到清单直出
  assert.equal(manifestCooling('ysp-cctv1', t0 + MANIFEST_FAIL_COOLDOWN_MS), false)

  // 熔断按频道隔离：一个频道挂了不能连累别的
  markManifestResult('ysp-cctv1', false, t0)
  assert.equal(manifestCooling('ysp-cctv13', t0), false)

  // 成功一次立即解除，不必等窗口自然到期
  markManifestResult('ysp-cctv1', true, t0)
  assert.equal(manifestCooling('ysp-cctv1', t0 + 1), false)
})

await checkAsync('清单 HEAD/OPTIONS 探活本地收口：按 HLS 类型应答，且一次上游都不打', async () => {
  // 播放器打开订阅时会逐频道探活（APTV 实测约 2 秒内 HEAD 了 29 个频道）。若每次探活都
  // 取票 + 拉清单，几十个频道瞬间打出上百个上游请求，撞上平台按 IP 的频率限制后，连用户
  // 正在看的那个频道的分片也会被一起打成 403。
  const before = cdnHits
  for (const method of ['HEAD', 'OPTIONS']) {
    for (const pid of ['ysp-cctv1', 'ysp-cctv13', 'gxtv-gxws']) {
      const resp = await fetch(`${nasBase}/proxy/${pid}.m3u8`, { method })
      assert.equal(resp.status, 200)
      // issue #98：回 application/json 会被播放器判定「不可播」，这条必须保住
      assert.equal(resp.headers.get('content-type'), 'application/vnd.apple.mpegurl')
      assert.equal(await resp.text(), '', 'HEAD/OPTIONS 不得发送正文')
    }
  }
  assert.equal(cdnHits, before, '探活不得触发任何上游请求')
})

await checkAsync('端到端：清单直出后播放器按相对地址取分片，字节与 CDN 一致', async () => {
  const manifestUrl = `${nasBase}/proxy/gxtv-gxws.m3u8`
  const resp = await fetch(manifestUrl)
  assert.equal(resp.status, 200)
  assert.equal(resp.headers.get('content-type'), 'application/vnd.apple.mpegurl')
  const text = await resp.text()

  // 拍平：不该再有嵌套子清单；且全篇没有绝对地址
  assert.ok(!text.includes('#EXT-X-STREAM-INF'), '应已拍平为媒体清单：\n' + text)
  assert.ok(!text.includes('http://'), '清单里不允许出现绝对地址：\n' + text)
  assert.ok(text.includes('#EXTINF:6.000000,'), text)

  const segRef = text.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'))
  assert.match(segRef, /^s[0-9a-f]{16}\.ts$/, '分片地址应为同目录相对地址、不含斜杠')

  // 播放器的解析方式：相对于清单地址解析
  const segUrl = new URL(segRef, manifestUrl).href
  assert.equal(segUrl, `${nasBase}/proxy/${segRef}`)

  // 严格播放器会先 HEAD 第一片：代理必须带回 CDN 的长度与 Range 能力，但不能发送正文。
  const headResp = await fetch(segUrl, { method: 'HEAD' })
  assert.equal(headResp.status, 200)
  assert.equal(headResp.headers.get('content-type'), 'video/mp2t')
  assert.equal(headResp.headers.get('content-length'), String(SEG_BODY.length))
  assert.equal(headResp.headers.get('accept-ranges'), 'bytes')
  assert.equal((await headResp.arrayBuffer()).byteLength, 0)

  const segResp = await fetch(segUrl)
  assert.equal(segResp.status, 200)
  assert.equal(segResp.headers.get('content-type'), 'video/mp2t')
  assert.deepEqual(Buffer.from(await segResp.arrayBuffer()), SEG_BODY)
})

await checkAsync('平台防盗链请求头同时用于清单和分片回源', async () => {
  const upstreamHeaders = { Origin: 'https://live.jstv.com', Referer: 'https://live.jstv.com/' }
  const source = `http://127.0.0.1:${cdn.address().port}/protected/index.m3u8`
  const manifest = await fetchManifestDirect(source, upstreamHeaders)
  assert.match(manifest, /protected\.ts/)
  const proxied = toProxyManifest(manifest, 'jstv-670', undefined, upstreamHeaders)
  const segRef = proxied.split('\n').map(x => x.trim()).find(x => x && !x.startsWith('#'))
  const response = await fetch(`${nasBase}/proxy/${segRef}`)
  assert.equal(response.status, 200)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), SEG_BODY)
})

await checkAsync('按目标地址生成请求头，Cookie 可限定到对应 CDN 路径', async () => {
  const source = `http://127.0.0.1:${cdn.address().port}/cookie-protected/segment.ts`
  const calls = []
  const upstreamHeaders = url => {
    calls.push(url)
    return { Cookie: new URL(url).pathname.startsWith('/cookie-protected/') ? 'tvb_session=secret' : '' }
  }
  const key = register(source, 'asian-live-tvb-news', undefined, upstreamHeaders)
  const response = await fetch(`${nasBase}/proxy/${key}.ts`)
  assert.equal(response.status, 200)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), SEG_BODY)
  assert.deepEqual(calls, [source])
})

await checkAsync('分片变换函数随清单地址登记，并在回给播放器前执行', async () => {
  const transform = body => Buffer.from(body.toString('utf8').toUpperCase())
  const url = `http://127.0.0.1:${cdn.address().port}/live/seg-100.ts`
  const key = register(url, 'gxtv-test', transform)
  assert.equal(lookup(key).transform, transform)
  const resp = await fetch(`${nasBase}/proxy/${key}.ts`)
  assert.equal(resp.status, 200)
  assert.equal(await resp.text(), SEG_BODY.toString('utf8').toUpperCase())

  // 变换后长度不保证与上游一致，HEAD 维持合成 200，不能误报上游 Content-Length。
  const head = await fetch(`${nasBase}/proxy/${key}.ts`, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('content-type'), 'video/mp2t')
  assert.equal(head.headers.get('content-length'), null)
})

await checkAsync('上游不支持 HEAD 时回退合成 200，后续 GET 仍能完整转发', async () => {
  const key = register(`http://127.0.0.1:${cdn.address().port}/live/no-head.ts`, 'head-fallback')
  const head = await fetch(`${nasBase}/proxy/${key}.ts`, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('content-type'), 'video/mp2t')
  assert.equal(head.headers.get('content-length'), null)

  const get = await fetch(`${nasBase}/proxy/${key}.ts`)
  assert.equal(get.status, 200)
  assert.deepEqual(Buffer.from(await get.arrayBuffer()), SEG_BODY)
})

await checkAsync('上游 HEAD 长度为 0 视为不可信：回退合成 200，不误报空分片', async () => {
  const key = register(`http://127.0.0.1:${cdn.address().port}/live/zero-head.ts`, 'zero-head')
  const head = await fetch(`${nasBase}/proxy/${key}.ts`, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('content-type'), 'video/mp2t')
  assert.equal(head.headers.get('content-length'), null, '长度为 0 的上游应答不能透传给播放器')

  const get = await fetch(`${nasBase}/proxy/${key}.ts`)
  assert.equal(get.status, 200)
  assert.deepEqual(Buffer.from(await get.arrayBuffer()), SEG_BODY)
})

await checkAsync('嵌套子清单 key 的 HEAD 走合成应答：GET 会改写清单，上游长度不可透传', async () => {
  const key = register(`http://127.0.0.1:${cdn.address().port}/live/01.m3u8`, 'nested-head')
  const head = await fetch(`${nasBase}/proxy/${key}.m3u8`, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('content-type'), 'application/vnd.apple.mpegurl')
  assert.equal(head.headers.get('content-length'), null, '透传上游长度会与改写后的 GET 正文自相矛盾')
})

await checkAsync('未登记 / 已过期的分片地址回 404，播放器会重新拉清单', async () => {
  const resp = await fetch(`${nasBase}/proxy/s00112233445566ff.ts`)
  assert.equal(resp.status, 404)
})

await checkAsync('上游分片 4xx 原样透传状态码，pipeUpstream 报告转发失败', async () => {
  const key = register(`http://127.0.0.1:${cdn.address().port}/live/missing.ts`, 'fail-test')
  const resp = await fetch(`${nasBase}/proxy/${key}.ts`)
  assert.equal(resp.status, 404)
})

// 放在所有会 lookup 既有 key 的用例之后：本用例灌入 5000+ 条登记，会把早前的测试 key 挤掉
check('注册表超上限从最久未登记端淘汰：反复续期的活跃频道 key 不被误伤', () => {
  const activeUrl = 'http://cdn.example.com/live/active-channel.ts'
  const active = register(activeUrl, 'evict-test')
  for (let i = 0; i < 5100; i++) {
    register(`http://cdn.example.com/live/bulk-${i}.ts`, 'evict-test')
    // 直播清单每 6 秒一刷，活跃 key 会被反复重新登记
    if (i % 500 === 0) register(activeUrl, 'evict-test')
  }
  register(activeUrl, 'evict-test')
  assert.ok(lookup(active), '活跃 key 不应先于一次性垃圾条目被淘汰')
})

await new Promise(r => cdn.close(r))
await new Promise(r => nas.close(r))

console.log(`\n全部通过：${passed} 项`)
