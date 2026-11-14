import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLiveRelay, parseLiveManifest, validateTransportStream } from '../extractors/sztv/live.js'

const base = 'https://sztv-live.sztv.com.cn/test/500/key.m3u8'
const ts = id => {
  const bytes = Buffer.alloc(188 * 5, id)
  for (let i = 0; i < bytes.length; i += 188) bytes[i] = 0x47
  return bytes
}
const manifest = (first, last, { discontinuityAt, sourceSequence = first } = {}) =>
  `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${sourceSequence}\n`
  + Array.from({ length: last - first + 1 }, (_, i) => `${first + i === discontinuityAt ? '#EXT-X-DISCONTINUITY\n' : ''}#EXTINF:2.000,\n${first + i}.ts\n`).join('')
const uris = text => text.split('\n').filter(line => line && !line.startsWith('#'))
const seq = text => Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text)[1])
const disc = text => Number(/#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)/.exec(text)[1])

function fixture(options = {}) {
  let time = 100_000, text = manifest(0, 5)
  const requests = []
  const bad = new Set()
  const relay = createLiveRelay({ autoRefresh: false, now: () => time, log: () => {},
    signUrl: url => url,
    fetchPlaylist: async () => new Response(text),
    fetchSegment: async url => {
      const id = Number(new URL(url).pathname.split('/').at(-1).split('.')[0])
      requests.push(id)
      if (bad.has(id)) throw new Error('永久坏片')
      return new Response(ts(id))
    }, ...options })
  return { relay, requests, bad, setText: value => { text = value }, advance: ms => { time += ms },
    async read(ref = 'sztv-7868') { return (await relay.fetch(ref, base)).text() },
    async warm() { await this.read(); await relay.drain() } }
}

test('深圳直播：完整缓存后才发布，多个客户端共用一次下载，支持 Range 和 HEAD', async () => {
  const f = fixture()
  try {
    await Promise.all([f.read(), f.read(), f.read()]); await f.relay.drain()
    assert.deepEqual(f.requests.sort(), [0, 1, 2, 3, 4, 5])
    const text = await f.read()
    assert.equal(seq(text), 0)
    assert.equal(uris(text).length, 6)
    const url = uris(text)[1] + '?sign=new&t=later'
    const body = await f.relay.fetch('sztv-7868', url)
    assert.deepEqual(Buffer.from(await body.arrayBuffer()), ts(1))
    const head = await f.relay.fetch('sztv-7868', url, { method: 'HEAD' })
    assert.equal(head.headers.get('content-length'), '940'); assert.equal(await head.text(), '')
    const range = await f.relay.fetch('sztv-7868', url, { headers: { range: 'bytes=188-375' } })
    assert.equal(range.status, 206); assert.equal(range.headers.get('content-range'), 'bytes 188-375/940')
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), ts(1).subarray(188, 376))
    const invalid = await f.relay.fetch('sztv-7868', url, { headers: { range: 'bytes=9999-' } })
    assert.equal(invalid.status, 416)
    assert.equal(f.requests.length, 6)
  } finally { await f.relay.close() }
})

test('深圳直播：永久坏片不进入清单，后续完整片保持连续本地序号并重置音视频时间线', async () => {
  const f = fixture()
  try {
    await f.warm()
    f.bad.add(6); f.bad.add(7); f.setText(manifest(4, 9))
    await f.relay.refresh('sztv-7868'); await f.relay.drain()
    const text = await f.read()
    assert.deepEqual(uris(text).map(url => new URL(url).pathname.split('/').at(-1)), ['2.ts', '3.ts', '4.ts', '5.ts', '8.ts', '9.ts'])
    assert.equal(seq(text), 2)
    assert.match(text, /#EXT-X-DISCONTINUITY\n#EXTINF:2.000,\nhttps:.*\/8.ts/)
    const entries = f.relay.inspect().sessions[0].published
    assert.deepEqual(entries.map(e => e.sequence), [0, 1, 2, 3, 4, 5, 6, 7])
    assert.deepEqual(entries.map(e => e.discontinuityNumber), [0, 0, 0, 0, 0, 0, 1, 1])
    // 轮询相同清单不会再次拉取永久坏片，也不会重写已经公布的序号。
    await f.relay.refresh('sztv-7868'); await f.relay.drain()
    assert.equal(f.requests.filter(n => n === 6).length, 1)
    assert.equal(await f.read(), text)
  } finally { await f.relay.close() }
})

test('深圳直播：窗口移出断点时递增 DISCONTINUITY-SEQUENCE，旧分片保留到安全期限', async () => {
  const f = fixture({ retentionMs: 1000, idleMs: 10_000, sessionTtlMs: 20_000 })
  try {
    await f.warm(); const old = uris(await f.read())[0]
    f.bad.add(6); f.setText(manifest(4, 9)); await f.relay.refresh('sztv-7868'); await f.relay.drain()
    f.setText(manifest(8, 13)); await f.relay.refresh('sztv-7868'); await f.relay.drain()
    const text = await f.read()
    assert.equal(seq(text), 7); assert.equal(disc(text), 1)
    assert.equal(text.includes('#EXT-X-DISCONTINUITY\n'), false)
    assert.deepEqual(Buffer.from(await (await f.relay.fetch('sztv-7868', old)).arrayBuffer()), ts(0))
    const before = f.relay.inspect().bytesOnDisk
    f.advance(1500); await f.relay.sweep()
    assert.equal(f.relay.inspect().bytesOnDisk, 6 * 940)
    assert.ok(before > f.relay.inspect().bytesOnDisk)
    // 正在清单中的分片不会被时间清理删除。
    for (const url of uris(text)) assert.equal((await (await f.relay.fetch('sztv-7868', url)).arrayBuffer()).byteLength, 940)
  } finally { await f.relay.close() }
})

test('深圳直播：一个客户端取消起播不会取消其它观众的共享下载', async () => {
  let release
  const pending = new Promise(resolve => { release = resolve })
  let upstreamSignal
  const f = fixture({ fetchSegment: async (_url, options) => { upstreamSignal = options.signal; await pending; return new Response(ts(1)) } })
  const controller = new AbortController()
  try {
    const cancelled = f.relay.fetch('sztv-7868', base, { signal: controller.signal })
    const rejection = assert.rejects(cancelled, /切台/)
    const viewer = f.read()
    await new Promise(resolve => setImmediate(resolve))
    controller.abort(new Error('切台'))
    await rejection
    assert.equal(upstreamSignal.aborted, false)
    release(); assert.ok((await viewer).includes('#EXTINF:'))
  } finally { release(); await f.relay.close() }
})

test('深圳直播：坏 TS、源序号断档及源时间线变化都触发一次解码重置', async () => {
  const f = fixture({ fetchSegment: async url => new Response(url.endsWith('/6.ts') ? Buffer.alloc(940) : ts(1)) })
  try {
    await f.warm()
    f.setText(manifest(6, 10)); await f.relay.refresh('sztv-7868'); await f.relay.drain()
    assert.ok(!(await f.read()).includes('/6.ts'))
    assert.equal(f.relay.inspect().sessions[0].published.at(-1).discontinuityNumber, 1)
    f.setText(manifest(15, 20)); await f.relay.refresh('sztv-7868'); await f.relay.drain()
    assert.equal(f.relay.inspect().sessions[0].published.at(-1).discontinuityNumber, 2)
    f.setText(manifest(19, 24, { discontinuityAt: 21 })); await f.relay.refresh('sztv-7868'); await f.relay.drain()
    assert.equal(f.relay.inspect().sessions[0].published.at(-1).discontinuityNumber, 3)
  } finally { await f.relay.close() }
})

test('深圳直播：源跨日重启序号后本地序号继续前进，两个频道互不串流', async () => {
  const f = fixture()
  try {
    await f.warm()
    await f.read('sztv-7880'); await f.relay.drain()
    f.setText(manifest(100, 105, { sourceSequence: 0 }))
    await f.relay.refresh('sztv-7868'); await f.relay.drain()
    const first = await f.read()
    assert.equal(seq(first), 6); assert.match(first, /#EXT-X-DISCONTINUITY\n/)
    assert.ok(uris(first)[0].endsWith('/100.ts'))
    assert.ok(uris(await f.read('sztv-7880'))[0].endsWith('/0.ts'))
  } finally { await f.relay.close() }
})

test('深圳直播：缓存总量有上限，不能淘汰已公布窗口来容纳新片', async () => {
  const f = fixture({ maxCacheBytes: 6 * 940 })
  try {
    await f.warm(); const old = await f.read()
    f.setText(manifest(4, 9)); await f.relay.refresh('sztv-7868'); await f.relay.drain()
    assert.equal(f.relay.inspect().bytesOnDisk, 6 * 940)
    assert.equal(await f.read(), old)
    for (const url of uris(old)) assert.equal((await (await f.relay.fetch('sztv-7868', url)).arrayBuffer()).byteLength, 940)
    f.advance(200_000); await f.relay.sweep()
    assert.equal(f.relay.inspect().bytesOnDisk, 0)
    assert.equal(f.relay.inspect().sessions.length, 0)
  } finally { await f.relay.close() }
})

test('深圳直播：拒绝未知音轨、加密或缺失时长格式，避免静默丢弃音频', () => {
  for (const tag of ['#EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m3u8"', '#EXT-X-KEY:METHOD=AES-128,URI="key"', '#EXT-X-MAP:URI="init.mp4"', '#EXT-X-ENDLIST']) {
    assert.throws(() => parseLiveManifest(manifest(0, 5) + tag, base))
  }
  assert.equal(parseLiveManifest(manifest(0, 5), base).segments.length, 6)
  assert.throws(() => validateTransportStream(ts(1).subarray(0, 939)))
  assert.throws(() => validateTransportStream(Buffer.alloc(940)))
})

test('深圳直播：上游长期停止更新不会把同一段节目重新追加到播放时间线', async () => {
  const f = fixture()
  try {
    await f.warm()
    const original = await f.read()
    f.advance(11 * 60_000)
    // 客户端仍轮询，刷新 activity 后清理历史去重记录。
    await f.read(); await f.relay.sweep()
    await f.relay.refresh('sztv-7868'); await f.relay.drain()
    assert.equal(await f.read(), original)
    assert.equal(f.requests.length, 6)
  } finally { await f.relay.close() }
})

test('深圳直播：冷启动坏片不会耗尽清单等待预算，健康分片仍完整缓存后发布', { timeout: 2000 }, async () => {
  let cancelled = false
  const f = fixture({ coldSegmentTimeoutMs: 40, fetchSegment: async (url, { signal }) => {
    if (url.endsWith('/0.ts')) {
      await new Promise((_, reject) => signal.addEventListener('abort', () => { cancelled = true; reject(signal.reason) }, { once: true }))
    }
    return new Response(ts(1))
  } })
  try {
    const response = await f.relay.fetch('sztv-7868', base, { signal: AbortSignal.timeout(400) })
    const text = await response.text()
    assert.equal(response.status, 200)
    assert.equal(cancelled, true)
    assert.ok(uris(text).length >= 3)
    assert.ok(!text.includes('/0.ts'))
    for (const url of uris(text)) assert.deepEqual(Buffer.from(await (await f.relay.fetch('sztv-7868', url)).arrayBuffer()), ts(1))
  } finally { await f.relay.close() }
})

test('深圳直播：已起播的预取保留重试预算，不受冷启动短期限影响', async () => {
  const f = fixture({ coldSegmentTimeoutMs: 20, fetchSegment: async (url, { signal }) => {
    if (url.endsWith('/6.ts')) await new Promise(resolve => setTimeout(resolve, 50))
    signal.throwIfAborted()
    return new Response(ts(1))
  } })
  try {
    await f.warm(); f.setText(manifest(1, 6))
    await f.relay.refresh('sztv-7868'); await f.relay.drain()
    assert.ok((await f.read()).includes('/6.ts'))
    assert.equal(f.relay.inspect().sessions[0].published.at(-1).discontinuityNumber, 0)
  } finally { await f.relay.close() }
})

test('深圳直播：切回闲置频道先取得当前窗口，首份清单不含几分钟前的节目', async () => {
  const f = fixture()
  try {
    await f.warm(); const old = uris(await f.read())[0]
    f.advance(60_000); f.setText(manifest(30, 35))
    // 某些播放器恢复时会先重取一个旧分片，这不能掩盖后台已经停止刷新。
    await (await f.relay.fetch('sztv-7868', old)).arrayBuffer()
    const first = await f.read()
    assert.ok(uris(first).every(url => Number(new URL(url).pathname.split('/').at(-1).split('.')[0]) >= 30))
    assert.equal(seq(first), 6)
    assert.match(first, /#EXT-X-DISCONTINUITY\n/)
    // 已发出的旧片仍遵守保留期限，不能用新片替换它的内容。
    assert.deepEqual(Buffer.from(await (await f.relay.fetch('sztv-7868', old)).arrayBuffer()), ts(0))
    await f.relay.drain()
    assert.equal(uris(await f.read()).length, 6)
  } finally { await f.relay.close() }
})

test('深圳直播：闲置后官网窗口未变化可复用已有完整缓存，无需重新下载', async () => {
  const f = fixture()
  try {
    await f.warm(); const first = await f.read()
    f.advance(60_000)
    assert.equal(await f.read(), first)
    assert.equal(f.requests.length, 6)
  } finally { await f.relay.close() }
})

test('深圳直播：首个清单请求停住时，在起播预算内重试并成功返回', { timeout: 2000 }, async () => {
  let attempts = 0
  const f = fixture({ playlistAttemptTimeoutMs: 30, fetchPlaylist: async (_url, { signal }) => {
    if (++attempts === 1) await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    return new Response(manifest(0, 5))
  } })
  try {
    const response = await f.relay.fetch('sztv-7881', base, { signal: AbortSignal.timeout(500) })
    assert.equal(response.status, 200)
    assert.ok((await response.text()).includes('#EXTINF:'))
    assert.equal(attempts, 2)
  } finally { await f.relay.close() }
})

test('深圳直播：上一次清单失败不影响下一次起播请求等待新的成功结果', async () => {
  let attempts = 0
  const f = fixture({ fetchPlaylist: async () => {
    if (++attempts <= 2) throw new Error('清单暂不可用')
    await new Promise(resolve => setTimeout(resolve, 20))
    return new Response(manifest(0, 5))
  } })
  try {
    await assert.rejects(f.read(), /清单暂不可用/)
    assert.ok((await f.read()).includes('#EXTINF:'))
    assert.equal(attempts, 3)
  } finally { await f.relay.close() }
})
