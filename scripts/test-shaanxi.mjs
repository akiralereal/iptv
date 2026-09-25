#!/usr/bin/env node
/**
 * 陕西广电模块回归测试：目录解密、媒体白名单、清单地址参数、目录复用与换名重读、
 * 故障沿用与退避、resolve 不抛异常。全程离线，夹具照 2026-09-25 官网实际返回的形状构造。
 *
 * 运行： node scripts/test-shaanxi.mjs
 */
import assert from 'node:assert/strict'
import { createCipheriv } from 'node:crypto'

import shaanxi from '../extractors/shaanxi/index.js'
import {
  CATALOG_URL,
  CHANNELS,
  buildChannels,
  claimsRef,
  clearCache,
  decodeCatalog,
  manifestRequestUrl,
  officialAssetUrl,
  resolveChannel,
} from '../extractors/shaanxi/api.js'
import { getModule, resolverFor } from '../extractors/registry.js'

// 离线：任何一条路径漏了注入的 fetchImpl 都直接失败
globalThis.fetch = async () => { throw new Error('离线测试不应访问网络') }

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { clearCache(); await fn(); passed++; console.log(`  ✅ ${name}`) }

const MEDIA = 'http://stream.snrtv.com'
const LOGO = 'http://res.cnwest.com/t/site/10001/a209bcf3e52b0593bd2c51ae47c9d6ab/assets/sxtvs2020/images/tv/'

/** 照官网 stream.js 的做法加密一份目录：两串各自的前 16 个字符是密钥和 IV，零填充。 */
function streamScript(sxbc, options) {
  return encrypted({ sxbc, default: sxbc }, options)
}
function encrypted(data, { key = 'acehruABIQRZ0138', iv = 'bghjuCKLOPXY2348' } = {}) {
  const plain = Buffer.from(JSON.stringify(data), 'utf8')
  const padded = Buffer.concat([plain, Buffer.alloc((16 - (plain.length % 16)) % 16)])
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(iv))
  cipher.setAutoPadding(false)
  const body = Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64')
  // sRadio 余下部分是广播目录，这里用不到，随便给一段
  return `var sTV="${key}${body}";\nvar sRadio="${iv}${Buffer.from('radio').toString('base64')}";`
}

const entry = (name, m3u8, playlist = '') => ({ name, m3u8, logo: '', playlist, poster: '' })
// 2026-09-25 02:44 实际下发的目录（节目单与封面字段从略）
const SUFFIXES = { star: 'opvI58', 1: 'ikmEZ7', 2: 'CDY167', 3: 'hjmFJM', 5: 'fCGLNS', 7: 'bfnrs3', nl: 'gtzHT1', 11: 'BIMSTW' }
const streamName = (key, suffix = SUFFIXES[key]) => `sxbc-${key === '11' ? 'yd' : key}-${suffix}`
const catalog = (overrides = {}) => ({
  1: entry('新闻资讯', `${MEDIA}/${streamName('1')}.m3u8`),
  2: entry('都市青春', `${MEDIA}/${streamName('2')}.m3u8`),
  3: entry('银龄频道', `${MEDIA}/${streamName('3')}.m3u8`),
  4: entry('影视频道', ''),
  5: entry('秦腔频道', `${MEDIA}/${streamName('5')}.m3u8`),
  6: entry('乐家购物', `${MEDIA}/snrtv-6.m3u8`),
  7: entry('体育休闲', `${MEDIA}/${streamName('7')}.m3u8`),
  11: entry('移动电视', `${MEDIA}/${streamName('11')}.m3u8`),
  24: entry('陕西卫视(备用线路)', 'http://alzbl.snrtv.com/live/sxtv.m3u8'),
  star: entry('陕西卫视', `${MEDIA}/${streamName('star')}.m3u8`),
  nl: entry('农林卫视', `${MEDIA}/${streamName('nl')}.m3u8`),
  ...overrides,
})
const manifest = name => '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-MEDIA-SEQUENCE:17012\n#EXT-X-TARGETDURATION:5\n'
  + `#EXTINF:5.000,\n${name}-17012.ts\n#EXTINF:5.000,\n${name}-17013.ts\n`
const NOT_FOUND = '<html>\r\n<head><title>404 Not Found</title></head>\r\n<body>\r\n<center><h1>404 Not Found</h1></center>\r\n<hr><center>nginx/1.18.0</center>\r\n</body>\r\n</html>\r\n'
const reply = (body, status = 200, type = 'application/javascript; charset=utf-8') => new Response(body, { status, headers: { 'content-type': type } })

/**
 * 模拟官网：目录按 state.sxbc 现加密下发；清单只有 state.live 里的名字回 200，其余 404。
 * log 记下每次请求的地址与请求头。
 */
function upstream(state, log = []) {
  return async (url, init = {}) => {
    const target = String(url)
    log.push({ url: target, init })
    if (target === CATALOG_URL) {
      if (state.catalogStatus && state.catalogStatus !== 200) return reply('<html>521</html>', state.catalogStatus, 'text/html')
      return reply(streamScript(state.sxbc))
    }
    const parsed = new URL(target)
    const name = parsed.pathname.slice(1).replace(/\.m3u8$/, '')
    if (parsed.host === 'stream.snrtv.com' && state.live.has(name)) {
      return reply(manifest(name), 200, 'application/vnd.apple.mpegurl')
    }
    return reply(NOT_FOUND, 404, 'text/html')
  }
}
const allLive = () => new Set(Object.keys(SUFFIXES).map(key => streamName(key)))
const catalogRequests = log => log.filter(item => item.url === CATALOG_URL).length
const manifestRequests = log => log.filter(item => item.url !== CATALOG_URL)

// 2026-09-25 10:00（上海）
const T0 = Date.parse('2026-09-25T02:00:00Z')
const news = CHANNELS.find(channel => channel.ref === 'shaanxi-news')
const mobile = CHANNELS.find(channel => channel.ref === 'shaanxi-mobile')

console.log('陕西广电模块测试')

check('模块注册为免账号的陕西 relay 模块，与山西互不认领', () => {
  assert.equal(getModule('shaanxi'), shaanxi)
  assert.equal(shaanxi.name, '陕西')
  assert.equal(shaanxi.outputGroupName, '陕西')
  assert.equal(shaanxi.channelHlsMode, 'relay')
  assert.equal(shaanxi.relayProxyCompatible, true)
  assert.equal(shaanxi.capabilities.resolve, true)
  assert.equal(shaanxi.capabilities.catchup, false)
  assert.equal(shaanxi.catalogVersion, 1)
  assert.equal(shaanxi.refreshConfigurable, false)
  assert.deepEqual(shaanxi.configSchema, [])
  assert.equal(resolverFor('shaanxi-satellite'), shaanxi)
  assert.equal(resolverFor('shanxi-satellite')?.id, 'shanxi')
  assert.equal(resolverFor('shaanxi-satellite/extra'), null)
  assert.equal(claimsRef('shaanxi-mobile'), true)
  assert.equal(claimsRef('shaanxi-film'), false, '影视频道官网没有播放地址，不收')
})

await checkAsync('八套频道并入唯一的陕西分组，台名沿用咪咕原先的叫法', async () => {
  assert.deepEqual(CHANNELS.map(channel => [channel.name, channel.key]), [
    ['陕西卫视', 'star'], ['陕西新闻资讯频道', '1'], ['陕西都市青春频道', '2'], ['陕西银龄频道', '3'],
    ['陕西秦腔频道', '5'], ['陕西体育休闲频道', '7'], ['农林卫视', 'nl'], ['陕西移动电视', '11'],
  ])
  assert.equal(new Set(CHANNELS.map(channel => channel.ref)).size, CHANNELS.length)
  const channels = buildChannels()
  assert.ok(channels.every(channel => channel.groupTitle === '陕西' && channel.catchup === 'none' && channel.deferredRef && !channel.url))
  // 八路都给官网频道目录下发的台标，不留空等台标库兜底（LOGO.md 第 4 条）
  assert.deepEqual(channels.map(channel => channel.logo), [
    'star', '1', '2', '3-1', '5', '7', 'nl', 'yidong',
  ].map(file => `${LOGO}${file}.png`))
  assert.deepEqual(await shaanxi.fetch(), {
    groups: [{ name: '陕西', dataList: channels }],
    meta: { skipped: [], warnings: [] },
  })
})

check('目录现解：只收频道表里的八路，缺地址、非官方主机的跳过', () => {
  const urls = decodeCatalog(streamScript(catalog()))
  assert.deepEqual([...urls], CHANNELS.map(channel => [channel.key, `${MEDIA}/${streamName(channel.key)}.m3u8`]))
  // 密钥 / IV 每次下发都不同，按同一规则都能解
  assert.deepEqual(decodeCatalog(streamScript(catalog(), { key: 'ehpwDFHIPTWY5679', iv: 'enouxFGIOPQRSXZ6' })), urls)

  const partial = decodeCatalog(streamScript(catalog({
    3: entry('银龄频道', ''),
    5: entry('秦腔频道', 'http://evil.test/sxbc-5-fCGLNS.m3u8'),
    7: entry('体育休闲', `${MEDIA}/sxbc-7-bfnrs3-17012.ts`),
  })))
  assert.deepEqual([...partial.keys()], ['star', '1', '2', 'nl', '11'])
})

check('目录格式变了、解不开、一路都不能用时照实报错', () => {
  assert.throws(() => decodeCatalog('<html>521</html>'), /频道目录格式已变化/)
  assert.throws(() => decodeCatalog('var sTV="short";var sRadio="alsoshortbutlonger";'), /频道目录格式已变化/)
  // 密文不是整块（被截断）
  const truncated = streamScript(catalog()).replace(/(var sTV="[^"]{40})[^"]*"/, '$1"')
  assert.throws(() => decodeCatalog(truncated), /解密失败/)
  // 密钥对不上，解出来是乱码
  const script = streamScript(catalog())
  assert.throws(() => decodeCatalog(script.replace('acehruABIQRZ0138', 'ZZZZruABIQRZ0138')), /解密失败/)
  assert.throws(() => decodeCatalog(streamScript({})), /没有可用的电视频道/)
  assert.throws(() => decodeCatalog(encrypted({ default: catalog() })), /没有电视分组/)
})

check('媒体白名单只认 stream.snrtv.com 根目录下的清单与分片', () => {
  for (const good of [
    `${MEDIA}/sxbc-star-opvI58.m3u8`,
    `${MEDIA}/sxbc-yd-BIMSTW-17005.ts`,
    `${MEDIA}/sxbc-1-ikmEZ7.m3u8?_=1790276000`,
    'https://stream.snrtv.com/sxbc-1-ikmEZ7.m3u8',
    'http://stream.snrtv.com:80/sxbc-1-ikmEZ7.m3u8',
  ]) assert.equal(officialAssetUrl(good), new URL(good).href)
  for (const bad of [
    'http://stream.snrtv.com.evil.test/sxbc-1-ikmEZ7.m3u8',
    'http://alzbl.snrtv.com/live/sxtv.m3u8',
    'http://stream.snrtv.com/live/sxbc-1-ikmEZ7.m3u8',
    'http://stream.snrtv.com/..%2fsxbc-1.m3u8',
    'http://stream.snrtv.com/sxbc-1-ikmEZ7.mp4',
    'http://user:pass@stream.snrtv.com/sxbc-1-ikmEZ7.m3u8',
    'http://stream.snrtv.com:8080/sxbc-1-ikmEZ7.m3u8',
    'http://stream.snrtv.com/sxbc-1-ikmEZ7.m3u8#x',
    'ftp://stream.snrtv.com/sxbc-1-ikmEZ7.m3u8',
    'not a url',
  ]) assert.throws(() => officialAssetUrl(bad), /陕西广电/)
})

check('清单请求带秒级时间戳参数，重试时换一个值', () => {
  assert.equal(manifestRequestUrl(`${MEDIA}/sxbc-2-CDY167.m3u8`, 1_790_276_000_999), `${MEDIA}/sxbc-2-CDY167.m3u8?_=1790276000`)
  assert.equal(manifestRequestUrl(`${MEDIA}/sxbc-2-CDY167.m3u8`, 1_790_276_000_999, 2), `${MEDIA}/sxbc-2-CDY167.m3u8?_=1790276000-2`)
  assert.equal(manifestRequestUrl(`${MEDIA}/sxbc-2-CDY167.m3u8?x=1`, 1_790_276_000_000), `${MEDIA}/sxbc-2-CDY167.m3u8?_=1790276000`)
  assert.throws(() => manifestRequestUrl('http://evil.test/x.m3u8'), /非官方媒体地址/)
})

await checkAsync('播放时现解目录、自取清单交给代理层；目录五分钟复用', async () => {
  const log = []
  const fetchImpl = upstream({ sxbc: catalog(), live: allLive() }, log)
  const first = await resolveChannel(news.ref, { fetchImpl, now: T0 })
  const expected = `${MEDIA}/sxbc-1-ikmEZ7.m3u8?_=${T0 / 1000}`
  assert.equal(first.url, expected)
  assert.equal(first.manifestUrl, expected)
  assert.match(first.manifestText, /^#EXTM3U[\s\S]*sxbc-1-ikmEZ7-17012\.ts/)
  assert.equal(first.relayHls, true)
  assert.equal(first.upstreamUrlTransform, officialAssetUrl)
  assert.equal(first.upstreamHeaders, undefined, 'CDN 不校验来源头，不发')
  assert.match(first.desc, /陕西新闻资讯频道当前直播地址获取成功/)
  assert.equal(log[0].url, CATALOG_URL)
  assert.equal(log[0].init.redirect, 'manual')
  assert.equal(log[0].init.headers.Referer, 'http://live.snrtv.com/')

  await resolveChannel(mobile.ref, { fetchImpl, now: T0 + 60_000 })
  await resolveChannel(news.ref, { fetchImpl, now: T0 + 4 * 60_000 })
  assert.equal(catalogRequests(log), 1, '五分钟内各频道共用一份目录')
  assert.deepEqual(manifestRequests(log).map(item => new URL(item.url).pathname), [
    '/sxbc-1-ikmEZ7.m3u8', '/sxbc-yd-BIMSTW.m3u8', '/sxbc-1-ikmEZ7.m3u8',
  ], '清单每次都取新的')
  await resolveChannel(news.ref, { fetchImpl, now: T0 + 5 * 60_000 })
  assert.equal(catalogRequests(log), 2, '到期重读')
})

await checkAsync('清单地址分到卡住的节点：短超时后换参数值重试，不去重读目录', async () => {
  const log = []
  const serveLive = upstream({ sxbc: catalog(), live: allLive() }, log)
  const hang = (init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
  })
  // 实测同一地址次次卡住：这里让第一个参数值一直不回
  const stuck = `_=${T0 / 1000}`
  const fetchImpl = (url, init) => (String(url).endsWith(stuck) ? (log.push({ url: String(url), init }), hang(init)) : serveLive(url, init))
  const started = Date.now()
  const result = await resolveChannel(mobile.ref, { fetchImpl, now: T0, timeoutMs: 100 })
  assert.ok(Date.now() - started < 1000)
  assert.equal(result.url, `${MEDIA}/sxbc-yd-BIMSTW.m3u8?_=${T0 / 1000}-1`)
  assert.match(result.manifestText, /sxbc-yd-BIMSTW-17012\.ts/)
  assert.deepEqual(log.map(item => new URL(item.url).search), ['', `?${stuck}`, `?_=${T0 / 1000}-1`])
  assert.equal(catalogRequests(log), 1)

  // 三个值都卡：照实报超时
  clearCache()
  const allStuck = (url, init) => (String(url) === CATALOG_URL ? serveLive(url, init) : hang(init))
  const failed = await resolveChannel(mobile.ref, { fetchImpl: allStuck, now: T0, timeoutMs: 30 })
  assert.equal(failed.url, '')
  assert.match(failed.desc, /超时 30ms/)
})

await checkAsync('随机串换了：旧名 404 立刻重读目录，换到新名再取一次', async () => {
  const log = []
  const state = { sxbc: catalog(), live: allLive() }
  const fetchImpl = upstream(state, log)
  assert.match((await resolveChannel(news.ref, { fetchImpl, now: T0 })).url, /sxbc-1-ikmEZ7\.m3u8/)

  // 一分钟后官网换名，旧名当即 404
  state.sxbc = catalog({ 1: entry('新闻资讯', `${MEDIA}/sxbc-1-cfqGIU.m3u8`) })
  state.live = new Set([...allLive()].filter(name => name !== 'sxbc-1-ikmEZ7').concat('sxbc-1-cfqGIU'))
  log.length = 0
  const renamed = await resolveChannel(news.ref, { fetchImpl, now: T0 + 60_000 })
  assert.equal(renamed.url, `${MEDIA}/sxbc-1-cfqGIU.m3u8?_=${(T0 + 60_000) / 1000}`)
  assert.match(renamed.manifestText, /sxbc-1-cfqGIU-17012\.ts/)
  assert.deepEqual(log.map(item => new URL(item.url).pathname), [
    '/sxbc-1-ikmEZ7.m3u8', '/static/v1/group/stream.js', '/sxbc-1-cfqGIU.m3u8',
  ])
  // 新目录顶替旧的：别的频道接着用，不再多读
  await resolveChannel(mobile.ref, { fetchImpl, now: T0 + 90_000 })
  assert.equal(catalogRequests(log), 1)
})

await checkAsync('整台停播时不因播放器连环重试去猛打目录接口', async () => {
  const log = []
  const state = { sxbc: catalog(), live: new Set() }
  const fetchImpl = upstream(state, log)
  const down = await resolveChannel(news.ref, { fetchImpl, now: T0 })
  assert.equal(down.url, '')
  assert.match(down.desc, /陕西广电链接请求失败：陕西广电直播清单 HTTP 404/)
  for (let i = 1; i <= 10; i++) await resolveChannel(news.ref, { fetchImpl, now: T0 + i * 1000 })
  assert.equal(catalogRequests(log), 1, '刚读过的目录不会因清单失败再重读')
  // 过了退避窗口，清单失败才会再触发一次重读
  await resolveChannel(news.ref, { fetchImpl, now: T0 + 31_000 })
  assert.equal(catalogRequests(log), 2)
  assert.equal(manifestRequests(log).length, 12, '地址没变就不重复取同一份清单')
})

await checkAsync('目录接口故障沿用上次成功的目录并退避，一天后照实报错', async () => {
  const log = []
  const state = { sxbc: catalog(), live: allLive() }
  const fetchImpl = upstream(state, log)
  const good = await resolveChannel(news.ref, { fetchImpl, now: T0 })
  state.catalogStatus = 521
  const degraded = await resolveChannel(news.ref, { fetchImpl, now: T0 + 6 * 60_000 })
  assert.equal(new URL(degraded.url).pathname, new URL(good.url).pathname)
  assert.equal(catalogRequests(log), 2)
  await resolveChannel(news.ref, { fetchImpl, now: T0 + 6 * 60_000 + 10_000 })
  assert.equal(catalogRequests(log), 2, '失败后 30 秒内不重试')
  await resolveChannel(news.ref, { fetchImpl, now: T0 + 6 * 60_000 + 31_000 })
  assert.equal(catalogRequests(log), 3)
  const expired = await resolveChannel(news.ref, { fetchImpl, now: T0 + 25 * 60 * 60_000 })
  assert.equal(expired.url, '')
  assert.match(expired.desc, /频道目录 HTTP 521/)
})

await checkAsync('目录里暂时没有某一路：只说明这一路，不连累其它频道', async () => {
  const fetchImpl = upstream({ sxbc: catalog({ 11: entry('移动电视', '') }), live: allLive() })
  const missing = await resolveChannel(mobile.ref, { fetchImpl, now: T0 })
  assert.equal(missing.url, '')
  assert.match(missing.desc, /陕西移动电视当前不在官网直播目录里/)
  assert.match((await resolveChannel(news.ref, { fetchImpl, now: T0 })).url, /sxbc-1-ikmEZ7/)
})

await checkAsync('清单不是 HLS、非法引用、网络异常、超时：只返回说明，不向请求处理器抛错', async () => {
  const html = async url => (String(url) === CATALOG_URL ? reply(streamScript(catalog())) : reply('<html></html>'))
  const notHls = await resolveChannel(news.ref, { fetchImpl: html, now: T0 })
  assert.equal(notHls.url, '')
  assert.match(notHls.desc, /直播清单不是 HLS/)

  const malformed = await resolveChannel('shaanxi-film', { fetchImpl: async () => { throw new Error('不应请求') } })
  assert.deepEqual(malformed, { url: '', desc: '陕西频道引用格式错误' })

  clearCache()
  const thrown = await resolveChannel(news.ref, { fetchImpl: async () => { throw new Error('socket hang up') }, now: T0 })
  assert.equal(thrown.url, '')
  assert.match(thrown.desc, /陕西广电链接请求失败：socket hang up/)

  clearCache()
  const hang = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
  })
  const timedOut = await resolveChannel(news.ref, { fetchImpl: hang, now: T0, timeoutMs: 20 })
  assert.equal(timedOut.url, '')
  assert.match(timedOut.desc, /超时 20ms/)
})

console.log(`\n全部通过：${passed} ✅`)
