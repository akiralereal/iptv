import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { createCastGateway, UHD_REFS } from '../extractors/yangshipin/cast/gateway.js'
import { CastProcess } from '../extractors/yangshipin/cast/process.js'
import { sendLocalMediaResponse } from '../utils/localMediaResponse.js'

async function fixture() {
  let starts = 0, originals = 0, calls = 0, mode = 'ok', at = Date.now(), closed = 0
  const headers = []
  const bytes = Buffer.from('0123456789')
  const backend = http.createServer((req, res) => {
    calls++; headers.push(req.headers)
    if (mode === 'fail') { res.writeHead(503); return res.end('private details') }
    if (req.url.startsWith('/proxy.ts')) {
      if (mode === 'slow') {
        res.writeHead(200); res.write(bytes); req.once('close', () => { closed++ }); return
      }
      const range = req.headers.range === 'bytes=2-5'
      res.writeHead(range ? 206 : 200, { 'Content-Type': 'video/mp2t', ...(range ? { 'Content-Range': 'bytes 2-5/10' } : {}) })
      return res.end(range ? bytes.subarray(2, 6) : bytes)
    }
    const uri = mode === 'external' ? 'http://other.test/secret.ts' : 'http://' + req.headers.host + '/proxy.ts?url=private-ticket'
    res.end('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:5\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n' + uri + '\n')
  })
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening')
  const gateway = createCastGateway({
    worker: { ensure: async () => { starts++; return 'http://127.0.0.1:' + backend.address().port }, touch() {}, close: async () => {} },
    resolveMain: async () => { originals++; return { url: 'https://official.test/index.m3u8', manifestText: '#EXTM3U\n#EXTINF:4,\nmain.ts\n' } },
    log() {}, now: () => at,
  })
  const server = http.createServer(async (req, res) => {
    const local = await gateway.handle({ path: req.url, method: req.method, headers: req.headers })
    if (local) await sendLocalMediaResponse(res, req.method, local)
    else { res.writeHead(404); res.end() }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return { gateway, base: 'http://127.0.0.1:' + server.address().port, bytes, headers,
    counts: () => ({ starts, originals, calls, closed }), mode: value => { mode = value }, advance: n => { at += n },
    close: async () => { await gateway.close(); server.closeAllConnections(); backend.closeAllConnections();
      await Promise.all([new Promise(r => server.close(r)), new Promise(r => backend.close(r))]) },
  }
}

test('only three UHD entries, source is pinned, entry/HEAD do not resolve streams', async () => {
  const f = await fixture()
  try {
    assert.equal(UHD_REFS.length, 3)
    for (const ref of UHD_REFS) {
      const cast = await f.gateway.handle({ path: '/' + ref, accessPrefix: '/u/testtoken' })
      assert(cast.body.includes('/u/testtoken/ysp-cast/cast/' + ref + '.m3u8'))
      const main = await f.gateway.handle({ path: '/' + ref, config: { uhdSource: 'main' }, accessPrefix: '/pass' })
      assert(main.body.includes('/pass/ysp-cast/main/' + ref + '.m3u8'))
      assert.equal((await f.gateway.handle({ path: '/ysp-cast/cast/' + ref + '.m3u8', method: 'HEAD' })).status, 200)
    }
    assert.deepEqual(f.counts(), { starts: 0, originals: 0, calls: 0, closed: 0 })
    for (const ref of ['ysp-cctv1', 'ysp-cctv16', 'ysp-vip-cctvsjdl', 'ysp-gxpd']) assert.equal(f.gateway.claims('/' + ref), false)
    assert.equal((await f.gateway.handle({ path: '/ysp-cast/cast/ysp-cctv1.m3u8' })).status, 404)
    assert.equal((await f.gateway.handle({ path: '/ysp-cast/media/ysp-cctv8k' })).status, 404)
    const main = await f.gateway.handle({ path: '/ysp-cast/main/ysp-cctv8k.m3u8', config: { uhdSource: 'cast' } })
    assert(main.body.includes('https://official.test/main.ts'))
    assert.equal(f.counts().starts, 0); assert.equal(f.counts().originals, 1)
  } finally { await f.close() }
})

test('cast auth prefixes, credentials stripped, concurrent ticket deduplication, bytes and Range', async () => {
  const f = await fixture()
  try {
    const ctx = { path: '/ysp-cast/cast/ysp-cctv8k.m3u8', headers: { cookie: 'private', authorization: 'private' }, config: { uhdSource: 'main' } }
    const [a, b] = await Promise.all([f.gateway.handle({ ...ctx, accessPrefix: '/pass' }), f.gateway.handle({ ...ctx, accessPrefix: '/u/otheruser' })])
    assert.equal(f.counts().calls, 1); assert.equal(f.counts().starts, 1)
    assert.equal(f.headers[0].cookie, undefined); assert.equal(f.headers[0].authorization, undefined)
    assert(a.body.includes('/pass/ysp-cast/media/')); assert(b.body.includes('/u/otheruser/ysp-cast/media/'))
    assert(!a.body.includes('private-ticket'))
    const mediaPath = a.body.split('\n').find(line => line.startsWith('/pass/')).slice('/pass'.length)
    const media = await fetch(f.base + mediaPath, { headers: { Range: 'bytes=2-5' } })
    assert.equal(media.status, 206); assert.equal(media.headers.get('content-range'), 'bytes 2-5/10')
    assert.deepEqual(Buffer.from(await media.arrayBuffer()), f.bytes.subarray(2, 6))
    const calls = f.counts().calls
    assert.equal((await fetch(f.base + mediaPath, { method: 'HEAD' })).status, 200)
    assert.equal(f.counts().calls, calls)
    f.advance(31 * 60000)
    assert.equal((await fetch(f.base + mediaPath)).status, 404)
    assert.equal(f.counts().calls, calls)
  } finally { await f.close() }
})

test('cast failure never invokes original source; arbitrary returned targets rejected', async () => {
  const f = await fixture()
  try {
    for (const mode of ['fail', 'external']) {
      f.mode(mode)
      const result = await f.gateway.handle({ path: '/ysp-cast/cast/ysp-cctv8k.m3u8' })
      assert.equal(result.status, 503); assert(!result.body.includes('private'))
    }
    assert.equal(f.counts().originals, 0); assert.equal(f.counts().calls, 2)
  } finally { await f.close() }
})

test('disconnect closes the upstream media stream', async () => {
  const f = await fixture()
  try {
    const playlist = await f.gateway.handle({ path: '/ysp-cast/cast/ysp-cctv8k.m3u8' })
    const path = playlist.body.split('\n').find(line => line.startsWith('/ysp-cast/media/'))
    f.mode('slow')
    const controller = new AbortController()
    const response = await fetch(f.base + path, { signal: controller.signal })
    await response.body.getReader().read(); controller.abort()
    for (let i = 0; i < 100 && !f.counts().closed; i++) await new Promise(r => setTimeout(r, 10))
    assert.equal(f.counts().closed, 1)
  } finally { await f.close() }
})

test('worker lazy single launch, ephemeral loopback, idle exit, bounded failure and shutdown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ysp-worker-test-'))
  const script = join(dir, 'worker.cjs')
  writeFileSync(script, "const h=require('http').createServer((q,s)=>s.end(JSON.stringify({ready:true})));h.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({kind:'listening',port:h.address().port})));process.stdin.resume();process.stdin.on('end',()=>process.exit());")
  let launches = 0
  const manager = new CastProcess({ idleMs: 100, startupMs: 2000, stateDir: dir,
    spawnImpl: () => { launches++; return spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] }) } })
  try {
    assert.equal(launches, 0)
    const [a, b] = await Promise.all([manager.ensure(), manager.ensure()])
    assert.equal(a, b); assert.equal(launches, 1); assert(a.startsWith('http://127.0.0.1:'))
    for (let i = 0; i < 100 && manager.child; i++) await new Promise(r => setTimeout(r, 10))
    assert.equal(manager.child, null)
    await manager.ensure(); assert.equal(launches, 2)
    await manager.close(); assert.equal(manager.child, null)
    const missing = new CastProcess({ python: join(dir, 'missing'), startupMs: 50 })
    await assert.rejects(missing.ensure(), /Python 3/)
    await assert.rejects(missing.ensure(), /稍后重试/)
    await missing.close()
  } finally { await manager.close(); rmSync(dir, { recursive: true, force: true }) }
})
