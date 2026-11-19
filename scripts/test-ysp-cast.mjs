import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { CAST_SLUGS, createCastGateway, routesRef, UHD_REFS } from '../extractors/yangshipin/cast/gateway.js'
import { CHANNEL_BY_REF } from '../extractors/yangshipin/channels.js'
import { CastProcess } from '../extractors/yangshipin/cast/process.js'
import { createAudioVividFilter, filtersResponse, mpegCrc32 } from '../extractors/yangshipin/cast/ts-audio-filter.js'
import { sendLocalMediaResponse } from '../utils/localMediaResponse.js'

// Minimal TS shaped like the cast feed: HEVC, Audio Vivid (0xd5 "av3a"), AAC.
function psi(pid, body) {
  body[2] = body.length - 3 + 4
  const section = Buffer.concat([body, Buffer.alloc(4)])
  section.writeUInt32BE(mpegCrc32(section, 0, section.length - 4), section.length - 4)
  const packet = Buffer.alloc(188, 0xff)
  packet.set([0x47, 0x40 | (pid >> 8), pid & 0xff, 0x10, 0x00]); section.copy(packet, 5)
  return packet
}
const pat = pmtPid => psi(0, Buffer.from([0x00, 0xb0, 0, 0, 1, 0xc1, 0, 0, 0, 1, 0xe0 | (pmtPid >> 8), pmtPid & 0xff]))
const reg = tag => Buffer.from([0x05, 4, ...Buffer.from(tag)])
function pmt(pmtPid, pcrPid, streams) {
  const es = streams.map(({ type, pid, desc = Buffer.alloc(0) }) =>
    Buffer.concat([Buffer.from([type, 0xe0 | (pid >> 8), pid & 0xff, 0xf0, desc.length]), desc]))
  return psi(pmtPid, Buffer.concat([Buffer.from([0x02, 0xb0, 0, 0, 1, 0xc1, 0, 0, 0xe0 | (pcrPid >> 8), pcrPid & 0xff, 0xf0, 0]), ...es]))
}
function pes(pid, fill) {
  const packet = Buffer.alloc(188, fill)
  packet.set([0x47, 0x40 | (pid >> 8), pid & 0xff, 0x10, 0, 0, 1, 0xc0])
  return packet
}
const HEVC = { type: 0x24, pid: 0x100, desc: reg('HEVC') }, VIVID = { type: 0xd5, pid: 0x101, desc: reg('av3a') }, AAC = { type: 0x0f, pid: 0x102 }
const castTs = (streams = [HEVC, VIVID, AAC], pcr = 0x100) => Buffer.concat([pat(0x1000), pmt(0x1000, pcr, streams),
  pes(0x100, 1), pes(0x101, 2), pes(0x102, 3), pat(0x1000), pmt(0x1000, pcr, streams), pes(0x101, 2), pes(0x100, 1)])
const pidOf = (buf, off) => ((buf[off + 1] & 0x1f) << 8) | buf[off + 2]
function pmtStreams(buf, off) {
  const start = off + 5, end = start + 3 + (((buf[start + 1] & 0x0f) << 8) | buf[start + 2])
  assert.equal(mpegCrc32(buf, start, end), 0, 'PMT CRC')
  const list = []
  for (let i = start + 12; i < end - 4; i += 5 + buf[i + 4]) list.push([buf[i], ((buf[i + 1] & 0x1f) << 8) | buf[i + 2]])
  return list
}
async function filtered(input, sizes) {
  const chunks = []
  for (let at = 0, n = 0; at < input.length; n++) {
    const size = sizes[n % sizes.length]; chunks.push(Buffer.from(input.subarray(at, at + size))); at += size
  }
  const out = []
  await pipeline(Readable.from(chunks), createAudioVividFilter(), new Writable({ write(c, _e, done) { out.push(c); done() } }))
  return Buffer.concat(out)
}

async function fixture() {
  let starts = 0, originals = 0, calls = 0, mode = 'ok', at = Date.now(), closed = 0
  const headers = [], urls = []
  const bytes = Buffer.from('0123456789')
  const backend = http.createServer((req, res) => {
    calls++; headers.push(req.headers); urls.push(req.url)
    if (mode === 'fail') { res.writeHead(503); return res.end('private details') }
    if (req.url.startsWith('/proxy.ts')) {
      if (mode === 'slow') {
        res.writeHead(200); res.write(bytes); req.once('close', () => { closed++ }); return
      }
      if (mode === 'ts') {
        const ts = castTs()
        res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': ts.length }); return res.end(ts)
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
  return { gateway, base: 'http://127.0.0.1:' + server.address().port, bytes, headers, urls,
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
    // Ordinary castable channels are claimed by path, but stay on the original route unless 'all'.
    for (const ref of ['ysp-cctv1', 'ysp-cctv16']) {
      assert.equal(f.gateway.claims('/' + ref), true)
      for (const config of [{}, { uhdSource: 'cast' }, { uhdSource: 'main' }]) {
        assert.equal(await f.gateway.handle({ path: '/' + ref + '.m3u8', config }), null)
        assert.equal(await f.gateway.handle({ path: '/' + ref, method: 'HEAD', config }), null)
      }
    }
    for (const ref of ['ysp-cctv6', 'ysp-vip-cctvsjdl', 'ysp-gxpd', 'ysp-bjws']) assert.equal(f.gateway.claims('/' + ref), false)
    assert.equal((await f.gateway.handle({ path: '/ysp-cast/cast/ysp-cctv6.m3u8' })).status, 404)
    assert.equal((await f.gateway.handle({ path: '/ysp-cast/media/ysp-cctv8k' })).status, 404)
    const main = await f.gateway.handle({ path: '/ysp-cast/main/ysp-cctv8k.m3u8', config: { uhdSource: 'cast' } })
    assert(main.body.includes('https://official.test/main.ts'))
    assert.equal(f.counts().starts, 0); assert.equal(f.counts().originals, 1)
  } finally { await f.close() }
})

test('all mode: 26 castable channels, ids match the engine table, others untouched', async () => {
  // Our refs and the bundled engine's slugs must name the same official channel (pid + livePid).
  const engine = readFileSync(new URL('../extractors/yangshipin/cast/vendor/ysp-live.py', import.meta.url), 'utf8')
  const table = engine.slice(engine.indexOf('DEFAULT_CHANNELS =['), engine.indexOf(']', engine.indexOf('DEFAULT_CHANNELS =[') + 20))
  const engineIds = new Map([...table.matchAll(/\('([a-z0-9]+)','[^']*','(\d+)','(\d+)'/g)].map(m => [m[1], [m[2], m[3]]]))
  assert.equal(Object.keys(CAST_SLUGS).length, 26)
  assert.equal(new Set(Object.values(CAST_SLUGS)).size, 26)
  for (const [ref, slug] of Object.entries(CAST_SLUGS)) {
    const ours = CHANNEL_BY_REF.get(ref)
    assert(ours, ref); assert.deepEqual([ours.channelId, ours.livePid], engineIds.get(slug), `${ref} → ${slug}`)
  }
  for (const ref of UHD_REFS) assert(CAST_SLUGS[ref])
  const f = await fixture()
  try {
    for (const ref of Object.keys(CAST_SLUGS)) {
      assert.equal(routesRef(ref, { uhdSource: 'all' }), true)
      assert.equal(routesRef(ref, { uhdSource: 'cast' }), UHD_REFS.includes(ref))
      const entry = await f.gateway.handle({ path: '/' + ref + '.m3u8', config: { uhdSource: 'all' }, accessPrefix: '/pass' })
      assert(entry.body.includes('/pass/ysp-cast/cast/' + ref + '.m3u8'), ref)
      assert(entry.body.includes(UHD_REFS.includes(ref) ? 'BANDWIDTH=40000000' : 'BANDWIDTH=15000000'))
    }
    for (const ref of ['ysp-cctv6', 'ysp-bjws', 'ysp-cetv1', 'ysp-vip-cctvfyzq']) {
      assert.equal(routesRef(ref, { uhdSource: 'all' }), false)
      assert.equal(await f.gateway.handle({ path: '/' + ref + '.m3u8', config: { uhdSource: 'all' } }), null)
    }
    assert.deepEqual(f.counts(), { starts: 0, originals: 0, calls: 0, closed: 0 })
    // Engine names differ for CGTN language channels.
    const cgtn = await f.gateway.handle({ path: '/ysp-cast/cast/ysp-cgtnfy.m3u8', config: { uhdSource: 'all' } })
    assert.equal(cgtn.status, 200); assert.equal(f.urls.at(-1), '/cgtnfr.m3u8')
    // A playback opened under 'all' keeps working after the setting is changed back.
    const playing = await f.gateway.handle({ path: '/ysp-cast/cast/ysp-cctv1.m3u8', config: { uhdSource: 'cast' } })
    assert.equal(playing.status, 200); assert.equal(f.urls.at(-1), '/cctv1.m3u8')
    assert(playing.body.includes('/ysp-cast/media/'))
  } finally { await f.close() }
})

test('switching to all does not hand a master playlist to an original-route playback already reloading', async () => {
  // On the original route the entry itself is the media playlist the player keeps reloading.
  const f = await fixture()
  const tv = { key: '10.0.0.2|TV' }, phone = { key: '10.0.0.3|Phone' }
  const entry = (client, config, method) => f.gateway.handle({ path: '/ysp-cctv1.m3u8', config, client, method })
  try {
    assert.equal(await entry(tv, { uhdSource: 'cast' }), null)
    f.advance(8000)
    assert.equal(await entry(tv, { uhdSource: 'all' }), null, 'still reloading: stays on the original route')
    const fresh = await entry(phone, { uhdSource: 'all' })
    assert(fresh.body.includes('/ysp-cast/cast/ysp-cctv1.m3u8'), 'a new playback follows the setting')
    // Each reload extends it; HEAD neither extends nor breaks it.
    for (let i = 0; i < 5; i++) { f.advance(20000); assert.equal(await entry(tv, { uhdSource: 'all' }), null) }
    assert.equal(await entry(tv, { uhdSource: 'all' }, 'HEAD'), null)
    f.advance(31000)
    const reopened = await entry(tv, { uhdSource: 'all' })
    assert(reopened.body.includes('/ysp-cast/cast/ysp-cctv1.m3u8'), 'after half a minute idle it is a new playback')
    // Other channels from the same client are tracked separately.
    assert.equal(await f.gateway.handle({ path: '/ysp-cctv2.m3u8', config: { uhdSource: 'all' }, client: tv }).then(r => r.status), 200)
    assert.deepEqual(f.counts(), { starts: 0, originals: 0, calls: 0, closed: 0 })
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

test('Audio Vivid track is hidden with length and other packets unchanged, under any chunking', async () => {
  const input = castTs()
  for (const sizes of [[1], [7], [187], [188], [189], [1000], [5, 200, 3, 376]]) {
    const out = await filtered(input, sizes)
    assert.equal(out.length, input.length, `sizes ${sizes}`)
    for (let off = 0; off < out.length; off += 188) {
      const pid = pidOf(input, off)
      if (pid === 0x1000) assert.deepEqual(pmtStreams(out, off), [[0x24, 0x100], [0x0f, 0x102]])
      else if (pid === 0x101) assert.deepEqual(out.subarray(off, off + 188), Buffer.concat([Buffer.from([0x47, 0x1f, 0xff, 0x10]), Buffer.alloc(184, 0xff)]))
      else assert.deepEqual(out.subarray(off, off + 188), input.subarray(off, off + 188))
    }
  }
})

test('Audio Vivid kept when it is the only audio or carries PCR; non-TS and lost sync pass through', async () => {
  for (const input of [castTs([HEVC, VIVID]), castTs([HEVC, VIVID, AAC], 0x101), Buffer.from('0123456789'),
    Buffer.from('#EXTM3U\n#EXTINF:4,\nx.ts\n')]) {
    assert.deepEqual(await filtered(input, [64]), input)
  }
  // Sync lost before the PMT: nothing after it is touched.
  const broken = castTs(); broken[188] = 0
  assert.deepEqual(await filtered(broken, [188]), broken)
  assert.equal(filtersResponse({ statusCode: 200, headers: {} }), true)
  assert.equal(filtersResponse({ statusCode: 206, headers: { 'content-range': 'bytes 376-999/2000' } }), true)
  assert.equal(filtersResponse({ statusCode: 206, headers: { 'content-range': 'bytes 2-5/10' } }), false)
  assert.equal(filtersResponse({ statusCode: 404, headers: {} }), false)
})

test('cast media through the gateway drops Audio Vivid and keeps Content-Length', async () => {
  const f = await fixture()
  try {
    const playlist = await f.gateway.handle({ path: '/ysp-cast/cast/ysp-cctv4k.m3u8' })
    const path = playlist.body.split('\n').find(line => line.startsWith('/ysp-cast/media/'))
    f.mode('ts')
    const media = await fetch(f.base + path)
    const body = Buffer.from(await media.arrayBuffer())
    assert.equal(media.status, 200); assert.equal(Number(media.headers.get('content-length')), castTs().length)
    assert.equal(body.length, castTs().length)
    assert.deepEqual(pmtStreams(body, 188), [[0x24, 0x100], [0x0f, 0x102]])
    assert.equal(pidOf(body, 188 * 3), 0x1fff)
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
