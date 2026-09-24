#!/usr/bin/env node
/**
 * 台标本机托管回归测试（utils/logoCache.js）
 *
 * 不变量：
 * 1. 只收真图片（按文件头认），只代取公网 http(s)，局域网 / 本机地址一律不碰；
 * 2. 候选按优先级取第一个已托管的：源自带的坏了（404、不是图片）自动换台标库的；
 * 3. 没托管上但不确定坏掉的（网络出错、还没下过）沿用原地址——与托管前一样，不会凭空变空；
 * 4. 全部确认坏掉才留空；
 * 5. 已托管的到期重取，失败保留旧图；坏掉的隔一天再试；一轮下载有时长上限；
 * 6. 一个月没用到的清掉；后台按地址里的 from 区分「源自带 / 库兜底」；
 * 7. 图床每次重签的 CDN 鉴权参数（sign=时间戳-随机串-uid-md5）不算新图，一张图只托管一份。
 *
 * 全程离线：注入假 fetch。
 *
 * 运行： node scripts/test-logo-cache.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DATA_DIR = mkdtempSync(join(tmpdir(), 'iptv-logo-cache-'))
process.env.mdataDir = DATA_DIR
process.env.mblank = 'true'

const {
  cachedLogoFile, detectImage, finishLogoCache, hostableUrl, hostedLogoUrl, logoCacheKey, prefetchLogos, resetLogoCacheForTest,
} = await import('../utils/logoCache.js')
const { classifyLogo } = await import('../utils/playlistConfig.js')

let passed = 0
const check = (n, fn) => { fn(); passed++; console.log('  ✅ ' + n) }
const checkAsync = async (n, fn) => { await fn(); passed++; console.log('  ✅ ' + n) }

const png = (tag = 'a') => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(80, tag)])
const jpg = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.alloc(80)])
const HTML = Buffer.from(`<!doctype html><html><body>${'x'.repeat(100)}</body></html>`)
const DAY = 24 * 60 * 60 * 1000
const T0 = Date.parse('2026-09-25T00:00:00Z')

const OWN = 'https://static.example.cn/logo/henan.png'
const LIB = 'https://gcore.jsdelivr.net/gh/taksssss/tv@main/icon/%E6%B2%B3%E5%8D%97%E5%8D%AB%E8%A7%86.png'
const candidates = [{ url: OWN, from: 'source' }, { url: LIB, from: 'auto' }]

// 按地址回预设响应；function 值每次调用重新求
function fakeFetch(routes) {
  const calls = []
  const impl = async url => {
    calls.push(String(url))
    const route = routes[String(url)]
    const value = typeof route === 'function' ? route() : route
    if (value instanceof Error) throw value
    if (!value) return new Response('not found', { status: 404 })
    return new Response(value.body, { status: value.status ?? 200, headers: value.headers || {} })
  }
  impl.calls = calls
  return impl
}
const reset = () => {
  rmSync(join(DATA_DIR, 'logo-cache'), { recursive: true, force: true })
  resetLogoCacheForTest()
}

console.log('台标本机托管回归测试')

check('按文件头认图片，网页、太小的一律不算', () => {
  assert.equal(detectImage(png()), 'png')
  assert.equal(detectImage(jpg), 'jpg')
  assert.equal(detectImage(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(80)])), 'gif')
  assert.equal(detectImage(Buffer.concat([Buffer.from('RIFF1234WEBPVP8 '), Buffer.alloc(80)])), 'webp')
  assert.equal(detectImage(Buffer.from(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg">${' '.repeat(60)}</svg>`)), 'svg')
  assert.equal(detectImage(HTML), null)
  assert.equal(detectImage(Buffer.from('89504e47', 'hex')), null)
})

check('只代取公网 http(s)，局域网与本机地址不碰', () => {
  assert.equal(hostableUrl(OWN), true)
  assert.equal(hostableUrl('http://8.8.8.8/a.png'), true)
  for (const bad of [
    'http://localhost/a.png', 'http://127.0.0.1/a.png', 'http://192.168.1.2/a.png', 'http://10.0.0.1/a.png',
    'http://172.20.0.1/a.png', 'http://100.64.1.1/a.png', 'http://[::1]/a.png', 'http://nas.local/a.png',
    'https://user:pw@example.com/a.png', 'ftp://example.com/a.png', '${replace}/logos/a.png', '',
  ]) assert.equal(hostableUrl(bad), false, bad)
})

await checkAsync('源自带的坏了自动换台标库的；写进订阅的是本机地址并带来源标记', async () => {
  reset()
  const fetchImpl = fakeFetch({ [OWN]: null, [LIB]: { body: png(), headers: { 'content-type': 'image/png' } } })
  const result = await prefetchLogos([OWN, LIB], { now: T0, fetchImpl })
  assert.deepEqual(result, { fetched: 1, dead: 1, errors: 0, pending: 0 })
  const url = hostedLogoUrl(candidates, { now: T0 })
  assert.match(url, /^\$\{replace\}\/logo-cache\/[0-9a-f]{20}\.png\?v=\d+&from=auto$/)
  assert.equal(classifyLogo(url), 'auto')
  const file = url.match(/logo-cache\/([^?]+)/)[1]
  assert.ok(existsSync(join(DATA_DIR, 'logo-cache', file)))
  assert.equal(cachedLogoFile(file).mime, 'image/png')
})

await checkAsync('源自带返回的不是图片也算坏；源自带好的优先于库', async () => {
  reset()
  await prefetchLogos([OWN, LIB], { now: T0, fetchImpl: fakeFetch({ [OWN]: { body: HTML }, [LIB]: { body: png() } }) })
  assert.match(hostedLogoUrl(candidates, { now: T0 }), /from=auto$/)
  reset()
  await prefetchLogos([OWN, LIB], { now: T0, fetchImpl: fakeFetch({ [OWN]: { body: jpg }, [LIB]: { body: png() } }) })
  const url = hostedLogoUrl(candidates, { now: T0 })
  assert.match(url, /\.jpg\?v=\d+&from=source$/)
  assert.equal(classifyLogo(url), 'source')
})

await checkAsync('没托管上但不确定坏掉的，沿用原地址；全都确认坏了才留空', async () => {
  reset()
  // 源自带坏了、库网络出错：用库的原地址，和托管前一样
  await prefetchLogos([OWN, LIB], { now: T0, fetchImpl: fakeFetch({ [OWN]: null, [LIB]: new Error('ECONNRESET') }) })
  assert.equal(hostedLogoUrl(candidates, { now: T0 }), LIB)
  // 还没下过的也一样
  assert.equal(hostedLogoUrl([{ url: 'https://new.example.com/x.png', from: 'source' }], { now: T0 }), 'https://new.example.com/x.png')
  // 5xx 当网络问题，不算坏
  reset()
  await prefetchLogos([OWN], { now: T0, fetchImpl: fakeFetch({ [OWN]: { body: 'busy', status: 503 } }) })
  assert.equal(hostedLogoUrl([{ url: OWN, from: 'source' }], { now: T0 }), OWN)
  // 全坏
  reset()
  await prefetchLogos([OWN, LIB], { now: T0, fetchImpl: fakeFetch({}) })
  assert.equal(hostedLogoUrl(candidates, { now: T0 }), '')
  // 不归托管管的地址原样用
  assert.equal(hostedLogoUrl([{ url: '${replace}/logos/x.png', from: 'source' }]), '${replace}/logos/x.png')
})

await checkAsync('已托管的一周后重取，失败保留旧图；坏掉的一天后再试；过大的算坏', async () => {
  reset()
  let libBody = png('a')
  const fetchImpl = fakeFetch({ [OWN]: null, [LIB]: () => (libBody instanceof Error ? libBody : { body: libBody }) })
  await prefetchLogos([OWN, LIB], { now: T0, fetchImpl })
  const first = hostedLogoUrl(candidates, { now: T0 })

  fetchImpl.calls.length = 0
  await prefetchLogos([OWN, LIB], { now: T0 + 2 * 60 * 60 * 1000, fetchImpl })
  assert.deepEqual(fetchImpl.calls, [], '两小时内：已托管的不重取，坏掉的也不重试')

  libBody = new Error('timeout')
  await prefetchLogos([OWN, LIB], { now: T0 + 8 * DAY, fetchImpl })
  assert.ok(fetchImpl.calls.includes(OWN), '一天后重试坏掉的')
  assert.ok(fetchImpl.calls.includes(LIB), '一周后重取已托管的')
  assert.equal(hostedLogoUrl(candidates, { now: T0 + 8 * DAY }), first, '重取失败保留旧图')

  reset()
  const big = fakeFetch({ [OWN]: { body: png(), headers: { 'content-length': String(3 * 1024 * 1024) } } })
  assert.equal((await prefetchLogos([OWN], { now: T0, fetchImpl: big })).dead, 1)
})

await checkAsync('图床每次重签的 CDN 鉴权不算新图：一张图只托管一份，重取用当轮的新签名地址', async () => {
  reset()
  const base = 'https://cdn-bt.example.cn/saas/image/2025-05/a.png'
  const signed = ts => `${base}?sign=${ts}-abc123-0-0123456789abcdef0123456789abcdef`
  const [day1, day2, day9] = [signed(1790278209), signed(1790364609), signed(1790969409)]
  const fetchImpl = fakeFetch({ [day1]: { body: png('a') }, [day9]: { body: png('b') } })
  await prefetchLogos([day1, day2], { now: T0, fetchImpl })
  assert.deepEqual(fetchImpl.calls, [day1], '同一张图一轮只取一次')
  const first = hostedLogoUrl([{ url: day1, from: 'source' }], { now: T0 })

  // 第二天模块给了新签名：不重下，还是同一个托管文件
  fetchImpl.calls.length = 0
  await prefetchLogos([day2], { now: T0 + DAY, fetchImpl })
  assert.deepEqual(fetchImpl.calls, [])
  assert.equal(hostedLogoUrl([{ url: day2, from: 'source' }], { now: T0 + DAY }), first)

  // 一周后重取，用的是当轮拿到的地址；文件名不变，版本号跟着重取时间走
  await prefetchLogos([day9], { now: T0 + 8 * DAY, fetchImpl })
  assert.deepEqual(fetchImpl.calls, [day9])
  const refreshed = hostedLogoUrl([{ url: day9, from: 'source' }], { now: T0 + 8 * DAY })
  assert.equal(refreshed.split('?')[0], first.split('?')[0])
  assert.notEqual(refreshed, first)
  assert.equal(readdirSync(join(DATA_DIR, 'logo-cache')).filter(name => name.endsWith('.png')).length, 1)

  // 只认这种签名格式，别的查询参数照常区分
  assert.equal(logoCacheKey(day1), base)
  assert.equal(logoCacheKey(`${base}?w=100&sign=1790278209-abc123-0-0123456789abcdef0123456789abcdef`), `${base}?w=100`)
  for (const other of [`${base}?sign=abc`, `${base}?v=2`, OWN, '${replace}/logos/a.png']) assert.equal(logoCacheKey(other), other)
})

await checkAsync('一轮下载有时长上限，没轮到的下一轮接着下；局域网地址不下', async () => {
  reset()
  const fetchImpl = fakeFetch({ [OWN]: { body: png() } })
  const result = await prefetchLogos([OWN, 'http://192.168.1.2/a.png'], { now: T0, fetchImpl, budgetMs: 0 })
  assert.deepEqual(result, { fetched: 0, dead: 0, errors: 0, pending: 1 })
  assert.deepEqual(fetchImpl.calls, [])
})

await checkAsync('一个月没用到的清掉，目录里的无主文件一并删', async () => {
  reset()
  await prefetchLogos([OWN, LIB], { now: T0, fetchImpl: fakeFetch({ [OWN]: { body: jpg }, [LIB]: { body: png() } }) })
  hostedLogoUrl([{ url: OWN, from: 'source' }], { now: T0 + 20 * DAY })
  writeFileSync(join(DATA_DIR, 'logo-cache', 'ffffffffffffffffffff.png'), png())
  finishLogoCache({ now: T0 + 31 * DAY })
  const files = readdirSync(join(DATA_DIR, 'logo-cache')).sort()
  assert.equal(files.length, 2, files.join(','))
  assert.ok(files.includes('index.json'))
  assert.ok(files.some(name => name.endsWith('.jpg')), '最近用过的留着')
})

await checkAsync('下载时不声明 WebP / AVIF，按 Accept 转码的图床给原图', async () => {
  reset()
  let accept = null
  await prefetchLogos([OWN], {
    now: T0,
    fetchImpl: async (_url, init) => { accept = init.headers.Accept; return new Response(png()) },
  })
  assert.ok(accept && !/webp|avif/i.test(accept), accept)
  assert.match(accept, /image\/png/)
})

check('托管路由只认 20 位小写哈希加图片扩展名', () => {
  assert.equal(cachedLogoFile('0123456789abcdef0123.webp').mime, 'image/webp')
  for (const bad of ['index.json', '../x.png', '0123456789ABCDEF0123.png', '0123456789abcdef012.png', '0123456789abcdef0123.exe']) {
    assert.equal(cachedLogoFile(bad), null, bad)
  }
})

rmSync(DATA_DIR, { recursive: true, force: true })
console.log(`\n全部通过：${passed} ✅`)
