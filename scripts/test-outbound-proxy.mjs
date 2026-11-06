#!/usr/bin/env node
/**
 * 后台「网络代理」（utils/outboundProxy.js）：只给 YouTube 与 Telegram 推送用。
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
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true, host: req.headers.host, path: req.url }))
})
origin.listen(0, '127.0.0.1'); await once(origin, 'listening')
const originPort = origin.address().port

const connects = []
const httpProxy = http.createServer((req, res) => { res.writeHead(405).end() })
httpProxy.on('connect', (req, socket, head) => {
  connects.push(req.url)
  if (req.headers['proxy-authorization'] !== undefined && req.headers['proxy-authorization'] !== 'Basic ' + Buffer.from('u:p@ss').toString('base64')) {
    socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
    return
  }
  const port = Number(req.url.split(':').pop()) === 443 ? tlsPort : originPort
  const upstream = net.connect(port, '127.0.0.1', () => {
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
      const upstream = net.connect(port === 443 ? tlsPort : originPort, '127.0.0.1', () => {
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

for (const server of [origin, httpProxy, socksProxy]) server.close()
rmSync(DATA_DIR, { recursive: true, force: true })
console.log('✓ test-outbound-proxy')
process.exit(0)
