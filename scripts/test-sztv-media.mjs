import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import sztv from '../extractors/sztv/index.js'
import { createMediaFetcher } from '../extractors/sztv/media.js'
import { pipeUpstream } from '../utils/hlsProxy.js'

test('深圳媒体：正常 Range、响应头和正文原样通过模块回源入口', async () => {
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.range, 'bytes=0-3')
    assert.equal(req.headers.referer, 'https://www.sztv.com.cn/pindao/')
    res.writeHead(206, { 'Content-Type': 'video/mp2t', 'Content-Range': 'bytes 0-3/10' })
    res.end('test')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await sztv.fetchProxyMedia('sztv-7867', {}, `http://127.0.0.1:${server.address().port}/test.ts`, {
      headers: { range: 'bytes=0-3' }, upstreamHeaders: { Referer: 'https://www.sztv.com.cn/pindao/' },
    })
    assert.equal(response.status, 206)
    assert.equal(response.headers.get('content-range'), 'bytes 0-3/10')
    assert.equal(await response.text(), 'test')
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

for (const drip of [false, true]) {
  test(`深圳媒体：收到 200 后${drip ? '持续慢发' : '停发'}的正文仍会超时`, { timeout: 3000 }, async () => {
    let closed
    const disconnected = new Promise(resolve => { closed = resolve })
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'video/mp2t' })
      res.write('partial')
      const timer = drip ? setInterval(() => res.write('x'), 10) : null
      res.on('close', () => { clearInterval(timer); closed() })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const fetchMedia = createMediaFetcher({ timeoutMs: 150 })
      // 直到整片读完才返回 Response，失败时调用方没有机会发送部分 200 正文。
      await assert.rejects(fetchMedia(`http://127.0.0.1:${server.address().port}/slow.ts`),
        error => ['TimeoutError', 'AbortError'].includes(error.name))
      await disconnected
    } finally {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
  })
}

test('深圳媒体：切台取消优先于传输期限，并保留回源选项', async () => {
  const controller = new AbortController()
  let signal
  const options = { signal: controller.signal, method: 'HEAD', upstreamFamily: 4, headers: { range: 'bytes=0-3' } }
  const fetchMedia = createMediaFetcher({ fetchImpl: async (url, passed) => {
    assert.equal(url, 'https://sztv-live.sztv.com.cn/a.ts')
    assert.equal(passed.method, options.method)
    assert.equal(passed.upstreamFamily, options.upstreamFamily)
    assert.equal(passed.headers, options.headers)
    signal = passed.signal
    return new Response(null)
  } })
  await fetchMedia('https://sztv-live.sztv.com.cn/a.ts', options)
  assert.equal(signal.aborted, false)
  const reason = new Error('切台')
  controller.abort(reason)
  assert.equal(signal.aborted, true)
  assert.equal(signal.reason, reason)
})

test('深圳媒体：真实转发终止卡住的正文，随后仍可取得下一片', { timeout: 3000 }, async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'video/mp2t' })
    if (req.url === '/stall.ts') res.write('partial')
    else res.end('next-segment')
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const fetchMedia = createMediaFetcher({ timeoutMs: 150 })
  let finishStalled
  const stalled = new Promise(resolve => { finishStalled = resolve })
  const proxy = http.createServer(async (req, res) => {
    const result = await pipeUpstream(`http://127.0.0.1:${upstream.address().port}${req.url}`, req, res,
      undefined, {}, undefined, fetchMedia)
    if (req.url === '/stall.ts') finishStalled(result)
  })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  try {
    const base = `http://127.0.0.1:${proxy.address().port}`
    // VLC 边收边解码，所以连半个分片的第一个字节都不能发出去。
    const partial = await fetch(`${base}/stall.ts`)
    assert.equal(partial.status, 502)
    assert.equal(await partial.text(), '上游分片获取失败')
    assert.equal((await stalled).ok, false)
    assert.equal(await (await fetch(`${base}/next.ts`)).text(), 'next-segment')
  } finally {
    proxy.closeAllConnections()
    upstream.closeAllConnections()
    await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => upstream.close(resolve))])
  }
})

test('深圳媒体：首轮残片全部丢弃，重试取回完整的同一片后才成功', { timeout: 3000 }, async () => {
  let requests = 0
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'video/mp2t' })
    if (++requests === 1) res.write('must-not-reach-player')
    else res.end('complete-audio-and-video')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const fetchMedia = createMediaFetcher({ timeoutMs: 600, attemptTimeoutMs: 100 })
    const response = await fetchMedia(`http://127.0.0.1:${server.address().port}/segment.ts`)
    assert.equal(requests, 2)
    assert.equal(await response.text(), 'complete-audio-and-video')
    assert.equal(response.headers.get('content-length'), '24')
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

test('深圳媒体：读取正文时切台会取消上游，且不重试', { timeout: 3000 }, async () => {
  let requests = 0
  const controller = new AbortController()
  const server = http.createServer((_req, res) => {
    requests++
    res.writeHead(200)
    res.write('partial')
    setTimeout(() => controller.abort(new Error('切台')), 20)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const fetchMedia = createMediaFetcher({ timeoutMs: 1000 })
    await assert.rejects(fetchMedia(`http://127.0.0.1:${server.address().port}/segment.ts`, { signal: controller.signal }))
    assert.equal(requests, 1)
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

test('深圳媒体：完整分片缓存有大小上限，超限不重复下载', async () => {
  let requests = 0
  const fetchMedia = createMediaFetcher({ maxSegmentBytes: 4, fetchImpl: async () => {
    requests++
    return new Response('too-large')
  } })
  await assert.rejects(fetchMedia('https://sztv-live.sztv.com.cn/a.ts'), { code: 'SEGMENT_TOO_LARGE' })
  assert.equal(requests, 1)
})
