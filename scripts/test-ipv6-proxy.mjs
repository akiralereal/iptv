#!/usr/bin/env node
/** IPv4 客户端 → 本机 HLS 代理 → 仅 IPv6 上游；验证真实 TCP、HEAD、Range、跳转、嵌套清单。 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { directFamilyFetch } from '../utils/systemProxy.js'
import { register, lookup, toProxyManifest, pipeUpstream, probeUpstream, fetchNested, fetchUpstreamResponse } from '../utils/hlsProxy.js'

const body = Buffer.alloc(188 * 20, 0x47)
const families = []
const origin = http.createServer((req, res) => {
  families.push(req.socket.remoteFamily)
  if (req.url === '/redirect') { res.writeHead(302, { Location: '/live.m3u8' }).end(); return }
  if (req.url === '/live.m3u8') { res.end('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:10,\na.ts\n'); return }
  const ranged = Boolean(req.headers.range)
  const bytes = ranged ? body.subarray(0, 188) : body
  res.writeHead(ranged ? 206 : 200, { 'Content-Type': 'video/MP2T', 'Content-Length': bytes.length,
    'Accept-Ranges': 'bytes', ...(ranged ? { 'Content-Range': `bytes 0-187/${body.length}` } : {}) })
  res.end(req.method === 'HEAD' ? undefined : bytes)
})
origin.listen(0, '::1'); await once(origin, 'listening')
const url = `http://localhost:${origin.address().port}/a.ts`
const normalKey = register(url, 'v6-test')
const key = register(url, 'v6-test', undefined, undefined, undefined, 6)
assert.notEqual(key, normalKey, '地址相同但网络模式不同的播放会话不能覆盖彼此')
assert.equal(lookup(key).upstreamFamily, 6)
assert.equal(lookup(normalKey).upstreamFamily, undefined)
const manifest = toProxyManifest(`#EXTM3U\n#EXTINF:10,\n${url}\n`, 'v6-test', undefined, undefined, undefined, 6)
assert.ok(manifest.includes(key))
const legacyRelay = toProxyManifest(`#EXTM3U\n#EXTINF:10,\n${url}\n`, 'v6-test', undefined, undefined, undefined, 6, '../proxy/')
const legacyRef = legacyRelay.split('\n').find(line => line && !line.startsWith('#'))
assert.equal(new URL(legacyRef, 'http://player.example/password/relay/bestv-fj-219.m3u8').pathname, `/password/proxy/${key}.ts`)
const oldPlain = toProxyManifest(`#EXTM3U\n#EXTINF:10,\n${url}\n`, 'v6-test', undefined, undefined, undefined, 6, 'proxy/')
assert.equal(new URL(oldPlain.split('\n').find(line => line && !line.startsWith('#')), 'http://player.example/password/bestv-fj-219').pathname, `/password/proxy/${key}.ts`)

const proxy = http.createServer(async (req, res) => {
  const target = lookup(key)
  if (req.method === 'HEAD') await probeUpstream(target.url, req, res, target.transform, target.upstreamHeaders, target.upstreamFamily)
  else await pipeUpstream(target.url, req, res, target.transform, target.upstreamHeaders, target.upstreamFamily)
})
proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening')
const endpoint = `http://127.0.0.1:${proxy.address().port}/proxy/${key}.ts`
try {
  const get = await fetch(endpoint)
  assert.equal(get.status, 200)
  assert.deepEqual(Buffer.from(await get.arrayBuffer()), body)
  const head = await fetch(endpoint, { method: 'HEAD' })
  assert.equal(head.headers.get('content-length'), String(body.length))
  const range = await fetch(endpoint, { headers: { Range: 'bytes=0-187' } })
  assert.equal(range.status, 206)
  assert.equal((await range.arrayBuffer()).byteLength, 188)
  const nested = await fetchNested(`http://localhost:${origin.address().port}/redirect`, {}, 6)
  assert.ok(nested.text.startsWith('#EXTM3U'))
  assert.ok(nested.finalUrl.endsWith('/live.m3u8'))
  assert.ok(families.length >= 5 && families.every(f => f === 'IPv6'))

  const v4 = http.createServer((req, res) => res.end('IPv4 only'))
  v4.listen(0, '127.0.0.1'); await once(v4, 'listening')
  try {
    const only4 = `http://localhost:${v4.address().port}/`
    assert.equal((await directFamilyFetch(only4, {}, 4)).status, 200)
    await assert.rejects(directFamilyFetch(only4, {}, 6), '强制 IPv6 不应静默回退 IPv4')
  } finally { v4.closeAllConnections(); v4.close() }
  console.log('IPv6 全代理：IPv4 客户端、IPv6 上游、流式字节、HEAD、Range、跳转、嵌套清单与模式隔离均通过')
} finally {
  proxy.closeAllConnections(); proxy.close()
  origin.closeAllConnections(); origin.close()
}
