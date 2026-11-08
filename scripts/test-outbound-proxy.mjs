#!/usr/bin/env node
/**
 * 后台「网络代理」：YouTube、澳门、海外频道与 Telegram；本地真实代理验证。
 * 本机起 HTTP CONNECT 代理和 SOCKS5 代理，目标用不存在的域名 —— 请求能到源站就说明确实走了代理，
 * SOCKS 还验证域名是交给代理解析的（大陆本地 DNS 对 YouTube / Telegram 是污染的）。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetch as undiciFetch } from 'undici'

const DATA_DIR = mkdtempSync(join(tmpdir(), 'iptv-outbound-proxy-'))
process.env.mdataDir = DATA_DIR
delete process.env.HTTPS_PROXY
delete process.env.https_proxy

const { reloadConfig } = await import('../config.js')
const proxyMod = await import('../utils/outboundProxy.js')
const { normalizeProxyUrl, maskProxyUrl, restoreMaskedProxy, settingProxyUrl, outboundProxySource, outboundProxyKey,
  ytDlpProxyArg, outboundFetch, createProxyDispatcher, testOutboundProxy, PROXY_MASK } = proxyMod
const { fetchUpstreamResponse } = await import('../utils/hlsProxy.js')
const { sendToChannel } = await import('../utils/notify.js')

const setProxy = value => {
  writeFileSync(join(DATA_DIR, 'system-config.json'), JSON.stringify(value === undefined ? {} : { proxy: value }))
  reloadConfig()
}

// ---- 地址规整 / 打码 ----
assert.equal(normalizeProxyUrl(''), '')
assert.equal(normalizeProxyUrl('  '), '')
assert.equal(normalizeProxyUrl('192.168.1.10:7890'), 'http://192.168.1.10:7890', '只写 ip:端口 补 http://')
assert.equal(normalizeProxyUrl('HTTP://192.168.1.10:7890/'), 'http://192.168.1.10:7890')
assert.equal(normalizeProxyUrl('socks5://u:p@nas.lan:7891'), 'socks5://u:p@nas.lan:7891')
assert.equal(normalizeProxyUrl('socks5h://[::1]:1080'), 'socks5h://[::1]:1080')
for (const value of ['http://proxy.example:80', 'https://proxy.example:443', 'http://u:p%25ss@[::1]:80']) {
  assert.equal(normalizeProxyUrl(value), value, '标准端口不丢失')
  assert.equal(normalizeProxyUrl(maskProxyUrl(value)), maskProxyUrl(value), '回显值可再次保存')
  assert.equal(normalizeProxyUrl(restoreMaskedProxy(maskProxyUrl(value), value)), value)
}
assert.equal(normalizeProxyUrl('proxy.example:80'), 'http://proxy.example:80')
for (const value of ['http://u:50%off@host:7890', 'socks5://bad%:pass@host:1080', 'http://u:%FF@host:7890']) {
  assert.throws(() => normalizeProxyUrl(value), /URL 编码无效/)
  assert.throws(() => restoreMaskedProxy(value, 'http://u:old@host:7890'), /URL 编码无效/)
  assert.throws(() => createProxyDispatcher(value), /URL 编码无效/)
}
assert.equal(normalizeProxyUrl('http://u:50%25off@host:7890'), 'http://u:50%25off@host:7890')
for (const bad of ['socks4://1.2.3.4:1080', 'http://1.2.3.4', 'http://1.2.3.4:7890/path', 'http://1.2.3.4:7890?x=1', 'http://1.2.3.4:7890 x', 'ftp://1.2.3.4:21', 'http://:7890']) {
  assert.throws(() => normalizeProxyUrl(bad), Error, bad)
}
assert.equal(maskProxyUrl('http://u:secret@1.2.3.4:7890'), `http://u:${PROXY_MASK}@1.2.3.4:7890`)
assert.equal(maskProxyUrl('http://1.2.3.4:7890'), 'http://1.2.3.4:7890')
assert.equal(maskProxyUrl(''), '')
const saved = 'socks5://u:s%40cret@1.2.3.4:7891'
assert.equal(restoreMaskedProxy(maskProxyUrl(saved), saved), saved, '没改密码保存时换回原密码')
assert.equal(restoreMaskedProxy(`socks5://u:${PROXY_MASK}@5.6.7.8:7891`, saved), 'socks5://u:s%40cret@5.6.7.8:7891', '只换主机时沿用密码')
assert.equal(restoreMaskedProxy(`socks5://other:${PROXY_MASK}@1.2.3.4:7891`, saved), `socks5://other:${PROXY_MASK}@1.2.3.4:7891`, '换了用户名不沿用')
assert.equal(restoreMaskedProxy('http://1.2.3.4:7890', saved), 'http://1.2.3.4:7890')
assert.equal(restoreMaskedProxy('', saved), '')

// ---- 配置读取 ----
setProxy(undefined)
assert.equal(settingProxyUrl(), '')
const directKey = outboundProxyKey()
setProxy('nas.lan:7890')
assert.equal(settingProxyUrl(), 'http://nas.lan:7890')
assert.equal(outboundProxySource(), 'setting')
assert.notEqual(outboundProxyKey(), directKey, '换代理要让 YouTube 的解析缓存作废')
setProxy('socks5://nas.lan:7891')
assert.equal(ytDlpProxyArg(), 'socks5h://nas.lan:7891', 'yt-dlp 的 SOCKS 由代理解析域名')
setProxy('not a url')
assert.equal(settingProxyUrl(), '', '配置文件里的坏值不生效')

// ---- 本机源站 / 代理 ----
const origin = http.createServer((req, res) => {
  if (req.url === '/catalog.m3u') {
    res.end('#EXTM3U\n#EXTINF:-1 group-title="国际",Proxy fixture\nhttp://media.example/module/top.m3u8\n')
    return
  }
  if (req.url === '/module/top.m3u8') {
    res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nmedia.m3u8\n')
    return
  }
  if (req.url === '/module/media.m3u8') {
    res.end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:6,\nsegment.ts\n')
    return
  }
  if (req.url === '/module/redirect.ts') {
    res.writeHead(302, { Location: 'http://redirect-cdn.example/module/segment.ts' }).end()
    return
  }
  if (req.url === '/module/segment.ts' || req.url === '/module/key.bin') {
    const body = Buffer.from('0123456789abcdef')
    const partial = req.headers.range === 'bytes=0-3'
    res.writeHead(partial ? 206 : 200, {
      'Content-Length': partial ? 4 : body.length,
      ...(partial ? { 'Content-Range': `bytes 0-3/${body.length}` } : {}),
    })
    res.end(req.method === 'HEAD' ? undefined : partial ? body.subarray(0, 4) : body)
    return
  }
  if (req.url === '/denied') { res.writeHead(403).end(); return }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true, host: req.headers.host, path: req.url }))
})
origin.listen(0, '127.0.0.1'); await once(origin, 'listening')
const originPort = origin.address().port

// 代理接通之后对方那一端的几种坏法：一连上就断（4443）、一直不答（4444）、CONNECT 被代理回 502（4445）、SOCKS 回「主机不可达」（4446）
const resetServer = net.createServer(socket => socket.destroy()).unref()
resetServer.listen(0, '127.0.0.1'); await once(resetServer, 'listening')
const hangServer = net.createServer(socket => socket.unref()).unref()
hangServer.listen(0, '127.0.0.1'); await once(hangServer, 'listening')
const upstreamPortFor = port => port === 443 ? tlsPort : port === 4443 ? resetServer.address().port : port === 4444 ? hangServer.address().port : originPort

const connects = []
const httpProxy = http.createServer((req, res) => { res.writeHead(405).end() })
httpProxy.on('connect', (req, socket, head) => {
  connects.push(req.url)
  if (req.headers['proxy-authorization'] !== undefined && req.headers['proxy-authorization'] !== 'Basic ' + Buffer.from('u:p@ss').toString('base64')) {
    socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
    return
  }
  const destPort = Number(req.url.split(':').pop())
  if (destPort === 4445) { socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return }
  const upstream = net.connect(upstreamPortFor(destPort), '127.0.0.1', () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    upstream.write(head)
    upstream.pipe(socket).pipe(upstream)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
})
httpProxy.listen(0, '127.0.0.1'); await once(httpProxy, 'listening')
const httpProxyUrl = `http://127.0.0.1:${httpProxy.address().port}`

const socksLog = []
const socksProxy = net.createServer(socket => {
  socket.once('data', greeting => {
    const methods = [...greeting.subarray(2, 2 + greeting[1])]
    const wantAuth = methods.includes(2)   // 客户端带了账号就必须验
    socket.write(Buffer.from([5, wantAuth ? 2 : 0]))
    const onRequest = req => {
      // VER CMD RSV ATYP ...
      let host, at
      if (req[3] === 3) { host = req.subarray(5, 5 + req[4]).toString(); at = 5 + req[4] }
      else if (req[3] === 1) { host = [...req.subarray(4, 8)].join('.'); at = 8 }
      else { socket.destroy(); return }
      const port = req.readUInt16BE(at)
      socksLog.push({ atyp: req[3], host, port })
      if (port === 4446) { socket.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0])); return }   // HostUnreachable
      const upstream = net.connect(upstreamPortFor(port), '127.0.0.1', () => {
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
        upstream.pipe(socket).pipe(upstream)
      })
      upstream.on('error', () => socket.destroy())
      socket.on('error', () => upstream.destroy())
    }
    if (!wantAuth) { socket.once('data', onRequest); return }
    socket.once('data', auth => {
      const user = auth.subarray(2, 2 + auth[1]).toString()
      const pass = auth.subarray(3 + auth[1], 3 + auth[1] + auth[2 + auth[1]]).toString()
      const ok = user === 'u' && pass === 'p@ss'
      socket.write(Buffer.from([1, ok ? 0 : 1]))
      if (ok) socket.once('data', onRequest)
      else socket.end()
    })
  })
})
socksProxy.listen(0, '127.0.0.1'); await once(socksProxy, 'listening')
const socksPort = socksProxy.address().port

// 自签证书（只在有 openssl 时测 HTTPS 隧道，不往仓库里放私钥）
let tlsPort = 0, ca
try {
  const dir = mkdtempSync(join(tmpdir(), 'iptv-outbound-tls-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2',
    '-subj', '/CN=youtube.example', '-addext', 'subjectAltName=DNS:youtube.example',
    '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' })
  ca = readFileSync(join(dir, 'cert.pem'))
  const tlsServer = https.createServer({ key: readFileSync(join(dir, 'key.pem')), cert: ca }, (req, res) => {
    res.end(JSON.stringify({ tls: true, host: req.headers.host }))
  })
  tlsServer.listen(0, '127.0.0.1'); await once(tlsServer, 'listening')
  tlsPort = tlsServer.address().port
  rmSync(dir, { recursive: true, force: true })
  process.on('exit', () => tlsServer.close())
} catch {
  console.log('  （没有 openssl，跳过 HTTPS 隧道测试）')
}

const json = async res => { assert.equal(res.status, 200); return res.json() }

// ---- HTTP 代理 ----
setProxy(httpProxyUrl.replace('http://', ''))   // 只填 ip:端口
let body = await json(await outboundFetch('http://youtube.example/watch?v=1'))
assert.equal(body.host, 'youtube.example')
assert.deepEqual(connects, ['youtube.example:80'], '走了后台设置的代理')

// HLS 转发那一路（YouTube 的清单 / 分片）也按模块给的 fetch 走
const upstream = await fetchUpstreamResponse('http://rr1---sn-abc.example/videoplayback', { fetchImpl: outboundFetch })
assert.equal((await json(upstream)).path, '/videoplayback')
assert.equal(connects.at(-1), 'rr1---sn-abc.example:80')

// 本机回环（Telegram 填了本机反代）不绕代理
connects.length = 0
await json(await outboundFetch(`http://127.0.0.1:${originPort}/local`))
assert.equal(connects.length, 0)

// 代理要密码
setProxy(`http://u:${encodeURIComponent('p@ss')}@127.0.0.1:${httpProxy.address().port}`)
await json(await outboundFetch('http://youtube.example/auth'))

// ---- SOCKS5 ----
setProxy(`socks5://127.0.0.1:${socksPort}`)
body = await json(await outboundFetch('http://youtube.example/socks'))
assert.equal(body.path, '/socks')
assert.deepEqual(socksLog.at(-1), { atyp: 3, host: 'youtube.example', port: 80 }, '域名交给代理解析，不在本地解析')
setProxy(`socks5://u:${encodeURIComponent('p@ss')}@127.0.0.1:${socksPort}`)
await json(await outboundFetch('http://api.telegram.example/bot/sendMessage'))
assert.equal(socksLog.at(-1).host, 'api.telegram.example')

if (tlsPort) {
  for (const proxy of [`socks5://127.0.0.1:${socksPort}`, httpProxyUrl]) {
    const dispatcher = createProxyDispatcher(proxy, { requestTls: { ca } })
    const res = await undiciFetch('https://youtube.example/', { dispatcher })
    assert.deepEqual(await res.json(), { tls: true, host: 'youtube.example' }, `HTTPS 经 ${proxy.split(':')[0]} 隧道，按域名校验证书`)
    await dispatcher.close()
  }
}

// ---- 测试按钮 ----
{
  const { proxyTestTargets } = await import('../utils/systemConfigAPI.js')
  assert.deepEqual(proxyTestTargets().map(t => t.name), ['澳门（澳广视）', 'YouTube', 'Red Bull TV 官网', 'Xumo 官方直播指南', '海外频道（DW）', 'Telegram'],
    '测试目标从模块的 proxyProbe 声明派生，Telegram 固定在最后')
  assert.ok(proxyTestTargets().every(t => /^https:\/\/\S+$/.test(t.url)))
  assert.ok(proxyTestTargets().every(t => Array.isArray(t.hosts) && t.hosts.length && t.hosts.every(h => /^[a-z0-9.-]+\.[a-z]+$/.test(h))),
    '每个测试目标带上要在代理规则里放行的域名后缀')
  assert.deepEqual(proxyTestTargets().at(-1).hosts, ['telegram.org'])
}

// ---- 保存：「网络代理」标签只提交 proxy，系统配置标签不提交 proxy，互不覆盖 ----
//（测合并逻辑本身：saveSystemConfigAPI 写盘后还会触发一轮播放列表刷新，测试里不能跑）
{
  const { mergeSystemConfig } = await import('../utils/systemConfigAPI.js')
  const existing = { port: 2345, host: 'http://nas.lan:2345', pass: 'pw', programInfoUpdateInterval: '12', userId: 'u1' }
  const proxyOnly = mergeSystemConfig(existing, { proxy: '192.168.1.10:7890' })
  assert.deepEqual(proxyOnly, { ...existing, proxy: 'http://192.168.1.10:7890' }, '只提交 proxy 时端口、地址、密码、更新间隔原样保留')
  const systemTab = mergeSystemConfig(proxyOnly, { port: 2346, host: '', pass: '', adminPath: 'admin', programInfoUpdateInterval: '8', enableDisplayNameUnify: false })
  assert.equal(systemTab.proxy, 'http://192.168.1.10:7890', '系统配置标签保存不带 proxy，已存的代理不被清空')
  assert.deepEqual([systemTab.port, systemTab.host, systemTab.pass, systemTab.programInfoUpdateInterval], [2346, '', '', '8'])
  assert.equal(mergeSystemConfig({ port: 2345 }, { port: 'abc' }).port, 1905, '提交了非法端口仍按原规则回退 1905')
  assert.throws(() => mergeSystemConfig(existing, { proxy: 'socks4://127.0.0.1:1080' }), /只支持/)
}
const targets = [{ name: 'YouTube', url: 'http://youtube.example/generate_204' }]
let result = await testOutboundProxy(`socks5://127.0.0.1:${socksPort}`, { targets })
assert.equal(result.via, 'input')
assert.equal(result.results[0].ok, true)
result = await testOutboundProxy(`http://127.0.0.1:${httpProxy.address().port}`, { targets })
assert.equal(result.results[0].ok, true)
const dead = net.createServer(); dead.listen(0, '127.0.0.1'); await once(dead, 'listening')
const deadPort = dead.address().port; dead.close(); await once(dead, 'close')
result = await testOutboundProxy(`127.0.0.1:${deadPort}`, { targets, timeoutMs: 3000 })
assert.equal(result.results[0].ok, false)
assert.match(result.results[0].message, /连不上代理/)
result = await testOutboundProxy(`http://u:wrong-secret@127.0.0.1:${httpProxy.address().port}`, { targets })
assert.match(result.results[0].message, /407/)
assert.doesNotMatch(result.results[0].message, /wrong-secret/)
result = await testOutboundProxy(`socks5://u:wrong-secret@127.0.0.1:${socksPort}`, { targets, timeoutMs: 3000 })
assert.equal(result.results[0].ok, false)
assert.doesNotMatch(result.results[0].message, /wrong-secret/)
await assert.rejects(testOutboundProxy('socks4://1.2.3.4:1080', { targets }), /只支持/)
result = await testOutboundProxy(httpProxyUrl, { targets: [{ name: 'Denied', url: 'http://youtube.example/denied' }] })
assert.equal(result.results[0].ok, false)
assert.match(result.results[0].message, /HTTP 403/)
assert.equal(result.results[0].stage, 'target', '对方答了 HTTP 状态：隧道已经通了')

// ---- 分段：连代理就失败 vs 代理接通后对方那一步失败（截图里「YouTube 通、澳门 ECONNRESET」）----
result = await testOutboundProxy(`127.0.0.1:${deadPort}`, { targets, timeoutMs: 3000 })
assert.equal(result.proxyReachable, false)
assert.equal(result.results[0].stage, 'proxy')
result = await testOutboundProxy('', { targets: [{ name: 'Dead', url: `http://127.0.0.1:${deadPort}/` }] })
assert.equal(result.proxyReachable, null, '直连测试不分段')
assert.equal(result.results[0].stage, '')
assert.doesNotMatch(result.results[0].message, /代理/)
const good = { name: 'YouTube', url: 'http://youtube.example/generate_204' }
const farEnd = [{ name: '澳门', url: 'https://tdm.example:4443/', hosts: ['tdm.example'] }, { name: 'DW', url: 'https://dw.example:4444/' }]
for (const [proxyUrl, extra, expected] of [
  [httpProxyUrl, { name: 'Gateway', url: 'https://gw.example:4445/' }, /^代理已接通，但它连不上对方站点（代理回 HTTP 502）$/],
  [`socks5://127.0.0.1:${socksPort}`, { name: 'Unreachable', url: 'https://far.example:4446/' }, /^代理已接通，但它连不上对方站点（主机不可达）$/],
]) {
  result = await testOutboundProxy(proxyUrl, { targets: [good, ...farEnd, extra], timeoutMs: 1500 })
  const [yt, mo, dw, other] = result.results
  assert.equal(result.proxyReachable, true, proxyUrl)
  assert.equal(yt.ok, true, proxyUrl)
  assert.equal(mo.stage, 'target', proxyUrl)
  assert.match(mo.message, /^代理已接通，往对方站点的连接被断开（ECONNRESET）$/, proxyUrl)
  assert.deepEqual(mo.hosts, ['tdm.example'], '目标声明的放行域名原样带回，后台写在失败项旁边')
  assert.equal(yt.hosts, undefined, '没声明的不带')
  assert.equal(dw.stage, 'target', proxyUrl)
  assert.equal(dw.message, '代理已接通，对方站点超时没有响应', proxyUrl)
  assert.equal(other.stage, 'target', proxyUrl)
  assert.match(other.message, expected, proxyUrl)
}
result = await testOutboundProxy(httpProxyUrl, { targets: [farEnd[1]], timeoutMs: 1500 })
assert.equal(result.proxyReachable, null, '只有超时、没有别的证据：分不清')
assert.equal(result.results[0].message, '超时没有响应')

// ---- 推送：只有 Telegram 走这个代理 ----
setProxy(`socks5://127.0.0.1:${socksPort}`)
socksLog.length = 0
const message = { raised: [{ level: 'error', title: '测试', text: '测试' }], resolved: [], host: '' }
const telegram = { id: 't', type: 'telegram', name: 'tg', botToken: '1:abc', chatId: '1', apiBase: 'http://api.telegram.example' }
assert.deepEqual(await sendToChannel(telegram, message), { ok: true, message: '' })
assert.equal(socksLog.at(-1)?.host, 'api.telegram.example', 'Telegram 走后台设置的代理')
socksLog.length = 0
await sendToChannel({ id: 'b', type: 'bark', name: 'bark', url: 'http://bark.example/key' }, message)
assert.equal(socksLog.length, 0, 'Bark 等其他渠道不走这个设置')

// 澳门、海外频道的主清单及后续请求都沿用模块代理，不能仅在取址时使用它。
const { default: tdm } = await import('../extractors/tdm/index.js')
const { default: overseas, loadChannels } = await import('../extractors/overseas/index.js')
const { fetchManifestDirect } = await import('../utils/appUtils.js')
const { fetchNested, toProxyManifest, lookup } = await import('../utils/hlsProxy.js')
for (const proxyUrl of [httpProxyUrl, `socks5://127.0.0.1:${socksPort}`]) {
  setProxy(proxyUrl)
  const catalog = await loadChannels({ url: 'http://catalog.example/catalog.m3u' })
  assert.equal(catalog.from, 'remote')
  assert.equal(catalog.channels[0].name, 'Proxy fixture', '仓库目录也走配置代理')
  for (const module of [tdm, overseas]) {
    assert.equal(module.channelHlsModeForConfig(), 'proxy')
    const ref = module.id === 'tdm' ? 'tdm-ctvp' : 'overseas-proxy-fixture'
    const fetchMedia = (url, options) => module.fetchProxyMedia(ref, {}, url, options)
    const manifest = await fetchManifestDirect('http://media.example/module/top.m3u8', {}, {}, undefined, fetchMedia)
    assert.match(manifest, /http:\/\/media.example\/module\/segment.ts/)
    const proxied = toProxyManifest(manifest, ref)
    assert.doesNotMatch(proxied, /https?:\/\//, '客户端清单不暴露需要海外网络的上游地址')
    const segmentKey = proxied.split('\n').find(line => line.endsWith('.ts')).slice(0, -3)
    const segment = lookup(segmentKey)
    assert.equal(segment.pid, ref)
    assert.equal(await (await fetchMedia(segment.url, {})).text(), '0123456789abcdef')
    const key = proxied.match(/URI="(s[0-9a-f]+)\.key"/)[1]
    assert.equal(await (await fetchMedia(lookup(key).url, {})).text(), '0123456789abcdef')
    const nested = await fetchNested('http://media.example/module/media.m3u8', {}, undefined, fetchMedia)
    assert.match(nested.text, /segment.ts/)
    const head = await fetchMedia(segment.url, { method: 'HEAD' })
    assert.equal(head.headers.get('content-length'), '16')
    const range = await fetchMedia(segment.url, { headers: { Range: 'bytes=0-3' } })
    assert.equal(range.status, 206)
    assert.equal(await range.text(), '0123')
    assert.equal(await (await fetchMedia('http://media.example/module/redirect.ts', {})).text(), '0123456789abcdef')
  }
}

// 环境代理与后台设置共用传输层；失败不能缓存成“已检测到，但实际直连”。
process.env.HTTPS_PROXY = `socks5://127.0.0.1:${socksPort}`
const envSocks = await import('../utils/systemProxy.js?test=env-socks')
assert.equal((await json(await envSocks.proxyAwareFetch('http://system-proxy.example/env'))).path, '/env')
assert.equal(socksLog.at(-1).host, 'system-proxy.example')
process.env.HTTPS_PROXY = 'socks4://127.0.0.1:1080'
const invalidEnv = await import('../utils/systemProxy.js?test=env-invalid')
assert.equal(invalidEnv.systemProxyUrl(), process.env.HTTPS_PROXY, '读取配置不因连接初始化失败而打断管理页')
for (let attempt = 0; attempt < 2; attempt++) {
  assert.throws(() => invalidEnv.systemProxyDispatcher(), /只支持/)
  assert.throws(() => invalidEnv.proxyAwareFetch('http://must-not-connect.example/'), /只支持/)
}
process.env.HTTPS_PROXY = 'http://u:bad%@host:7890'
const invalidAuth = await import('../utils/systemProxy.js?test=env-auth')
for (let attempt = 0; attempt < 2; attempt++) assert.throws(() => invalidAuth.systemProxyDispatcher(), /URL 编码无效/)
delete process.env.HTTPS_PROXY

for (const server of [origin, httpProxy, socksProxy]) server.close()
rmSync(DATA_DIR, { recursive: true, force: true })
console.log('✓ test-outbound-proxy')
process.exit(0)
