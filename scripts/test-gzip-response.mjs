#!/usr/bin/env node
/**
 * 节目单 gzip 输出（utils/gzipResponse.js）：播放器声明接受才压、同一份文件只压一次、
 * 文件变了重压、压失败不留着。全程离线。
 *
 * 运行： node scripts/test-gzip-response.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

import { acceptsGzip, createGzipFileCache } from '../utils/gzipResponse.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('节目单 gzip 输出测试')

const dir = mkdtempSync(join(tmpdir(), 'gzip-response-'))
try {
  check('声明了 gzip 才算接受；q=0 是明确不要；没带请求头不压', () => {
    for (const value of ['gzip', 'gzip, deflate, br', 'GZIP', 'deflate, gzip;q=0.5', 'x-gzip', '*', 'br;q=1.0, gzip;q=0.8']) {
      assert.equal(acceptsGzip({ 'accept-encoding': value }), true, value)
    }
    for (const value of ['', 'identity', 'deflate, br', 'gzip;q=0', 'gzip; q=0.0, br', 'notgzip']) {
      assert.equal(acceptsGzip({ 'accept-encoding': value }), false, value)
    }
    assert.equal(acceptsGzip({}), false)
    assert.equal(acceptsGzip(undefined), false)
  })

  await checkAsync('压出来的解开与原文一致，重复度高的节目单能压到一成以内', async () => {
    const file = join(dir, 'playback.xml')
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n' + Array.from({ length: 5000 }, (_, i) =>
      `    <programme channel="东方卫视" start="2026111${i % 10}200000 +0800" stop="2026111${i % 10}210000 +0800">\n`
      + `        <title lang="zh">东方剧场 ${i}</title>\n    </programme>\n`).join('') + '</tv>\n'
    writeFileSync(file, xml)
    const zipped = await createGzipFileCache()(file)
    assert.equal(gunzipSync(zipped).toString('utf8'), xml)
    assert.ok(zipped.length < Buffer.byteLength(xml) / 10, `压缩后 ${zipped.length} 字节`)
  })

  await checkAsync('文件没变只压一次，并发请求共用同一次；文件变了（修改时间或大小）重压', async () => {
    const file = join(dir, 'count.xml')
    writeFileSync(file, '<tv>一</tv>')
    let compressed = 0
    const gzipFile = createGzipFileCache({ compress: async buffer => { compressed++; return Buffer.from(`gz:${buffer}`) } })
    const [a, b] = await Promise.all([gzipFile(file), gzipFile(file)])
    assert.equal(String(a), 'gz:<tv>一</tv>')
    assert.equal(a, b)
    await gzipFile(file)
    assert.equal(compressed, 1)
    // 大小变了
    writeFileSync(file, '<tv>一二</tv>')
    assert.equal(String(await gzipFile(file)), 'gz:<tv>一二</tv>')
    assert.equal(compressed, 2)
    // 大小没变、修改时间变了
    writeFileSync(file, '<tv>三四</tv>')
    utimesSync(file, new Date('2026-11-20T00:10:00Z'), new Date('2026-11-20T00:10:00Z'))
    assert.equal(String(await gzipFile(file)), 'gz:<tv>三四</tv>')
    assert.equal(compressed, 3)
  })

  await checkAsync('先看签名再读内容：读到的比签名新也只是下次重压，不会把旧内容记在新签名下', async () => {
    const order = []
    let version = 1
    const gzipFile = createGzipFileCache({
      stat: () => { order.push('stat'); return { mtimeMs: version, size: 1 } },
      read: () => { order.push('read'); return `内容${version}` },
      compress: async text => `gz:${text}`,
    })
    assert.equal(await gzipFile('x'), 'gz:内容1')
    assert.deepEqual(order, ['stat', 'read'])
    version = 2
    assert.equal(await gzipFile('x'), 'gz:内容2')
  })

  await checkAsync('文件不存在：抛出让调用方退回老路；压失败不留着，下个请求重来', async () => {
    const gzipFile = createGzipFileCache()
    assert.throws(() => gzipFile(join(dir, '没有这个文件.xml')), /ENOENT/)
    let calls = 0
    const flaky = createGzipFileCache({
      stat: () => ({ mtimeMs: 1, size: 1 }),
      read: () => 'x',
      compress: async () => { if (++calls === 1) throw new Error('压缩失败'); return 'gz' },
    })
    await assert.rejects(() => flaky('x'), /压缩失败/)
    assert.equal(await flaky('x'), 'gz')
  })
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n通过 ${passed} 项`)
