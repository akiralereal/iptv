#!/usr/bin/env node
import assert from 'node:assert/strict'

import xizang from '../extractors/xizang/index.js'
import {
  CARD_GROUP,
  CATALOG_API,
  CATALOG_REFRESH_MS,
  CHANNELS,
  SIGN_REUSE_MS,
  SITE_ORIGIN,
  buildChannels,
  claimsRef,
  clearCache,
  officialAssetUrl,
  parseCatalog,
  requestCatalog,
  resolveChannel,
  signedLiveUrl,
  validateManifest,
} from '../extractors/xizang/api.js'
import { getModule, resolverFor } from '../extractors/registry.js'
import { inlineResolvedManifest } from '../utils/appUtils.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json;charset=utf-8' },
})

// 2026-09-25 03:00（上海）
const NOW = Date.parse('2026-09-24T19:00:00Z')
const MINUTE = 60 * 1000
const hexTime = ms => Math.floor(ms / 1000).toString(16)
const STREAMS = ['h701F9MpxzPDyE', 'r31M7Qa5hm7wrP', 'HcKTakNfcF6BBi']
const signed = (stream, issuedAt = NOW - 2 * MINUTE, secret = 'a'.repeat(32)) =>
  `https://tv.vtibet.cn/live/${stream}.m3u8?secret=${secret}&time=${hexTime(issuedAt)}`

// 形状照 cardgroups=LIVECAST 实际返回裁剪：第一组只有一张无 ID 的「正在播出」卡片，
// 地址与西藏卫视相同；第二组是三路频道卡片
function catalog({ issuedAt = NOW - 2 * MINUTE, secret = 'a'.repeat(32), patch = {} } = {}) {
  return {
    paged: { more: 0, count: 2 },
    cardgroups: [
      { id: '', title: '', cards: [{ id: '', title: '薄冰', date: '2026-09-25 02:19:02', enddate: '2026-09-25 03:04:02',
        link: '', video: { url: signed(STREAMS[0], issuedAt, secret) } }] },
      { id: CHANNELS[0].cardId, title: '', cards: CHANNELS.map((channel, index) => ({
        id: channel.cardId,
        title: ['西藏卫视', '藏语卫视', '影视文化'][index],
        link: `app://${channel.cardId}`,
        video: { url: signed(STREAMS[index], issuedAt, secret), url_hd: '', url_cd: '' },
        ...(patch[channel.ref] || {}),
      })) },
    ],
    error_desc: '',
    succeed: 1,
    error_code: 0,
  }
}

const MANIFEST = [
  '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-MEDIA-SEQUENCE:596758564', '#EXT-X-TARGETDURATION:3',
  '#EXTINF:3.000,', 'h701F9MpxzPDyE-596758564.ts?ctyun_app=live&ctyun_stream=h701F9MpxzPDyE&ctyun_rate=2564.000',
  '#EXTINF:3.000,', 'h701F9MpxzPDyE-596758565.ts?ctyun_app=live&ctyun_stream=h701F9MpxzPDyE&ctyun_rate=2564.000', '',
].join('\n')

/** 模拟官方接口 + CDN：接口按 issue() 签发，CDN 只放行 accept(url) 为真的清单。 */
function upstream({ issue = () => catalog(), accept = () => true, apiStatus = 200, cdnStatus = 403 } = {}) {
  const log = { api: 0, manifests: [] }
  const fetchImpl = async (url, init = {}) => {
    const target = String(url)
    if (target === CATALOG_API) {
      log.api++
      if (apiStatus !== 200) return new Response('<html>busy</html>', { status: apiStatus })
      return json(issue(log.api))
    }
    log.manifests.push(target)
    assert.equal(init.redirect, 'manual')
    return accept(target) ? new Response(MANIFEST, { status: 200 }) : new Response('{"exit":{"reason":20,"retcode":403}}', { status: cdnStatus })
  }
  return { fetchImpl, log }
}

console.log('西藏广电（珠峰云）模块测试')

check('模块注册为免账号的西藏 relay 模块', () => {
  assert.equal(getModule('xizang'), xizang)
  assert.equal(xizang.name, '西藏')
  assert.equal(xizang.outputGroupName, '西藏')
  assert.equal(xizang.channelHlsMode, 'relay')
  assert.equal(xizang.relayProxyCompatible, true, 'CDN 不验分片签名、不看来源头，服务端也能直取分片')
  assert.equal(xizang.capabilities.resolve, true)
  assert.equal(xizang.capabilities.epg, false)
  assert.equal(xizang.capabilities.catchup, false)
  assert.equal(xizang.epg, undefined)
  assert.equal(xizang.catalogVersion, 1)
  assert.deepEqual(xizang.configSchema, [])
  for (const channel of CHANNELS) assert.equal(resolverFor(channel.ref), xizang)
  assert.equal(resolverFor('xizang-satellite/extra'), null)
})

await checkAsync('三路固定频道并入唯一的西藏分组，各带官方频道卡片的台标', async () => {
  assert.deepEqual(CHANNELS.map(channel => [channel.ref, channel.name]), [
    ['xizang-satellite', '西藏卫视'],
    ['xizang-tibetan', '藏语卫视'],
    ['xizang-film-culture', '影视文化'],
  ])
  const channels = buildChannels()
  assert.ok(channels.every(channel => channel.groupTitle === '西藏' && channel.catchup === 'none'))
  // 台标取自频道卡片 photo.thumb：官方图片域名、完整地址、三路互不相同
  assert.ok(channels.every(channel => /^https:\/\/pic\.vtibet\.cn\/cms\/vrupload\/img\/\d{4}\/\d{1,2}\/\d{1,2}\/\d+_\d+_220x160\.(?:png|jpg)$/.test(channel.logo)))
  assert.equal(new Set(channels.map(channel => channel.logo)).size, 3)
  assert.deepEqual(channels.map(channel => channel.deferredRef), CHANNELS.map(channel => channel.ref))
  assert.deepEqual(await xizang.fetch(), {
    groups: [{ name: '西藏', dataList: channels }],
    meta: { skipped: [], warnings: [] },
  })
  assert.equal(claimsRef('xizang-tibetan'), true)
  assert.equal(claimsRef('xizang-economy'), false)
  assert.equal(claimsRef(''), false)
})

check('按卡片 ID 取三路，不把「正在播出」卡片算成频道', () => {
  const { urls, issuedAt } = parseCatalog(JSON.stringify(catalog()))
  assert.deepEqual([...urls.keys()], CHANNELS.map(channel => channel.ref))
  assert.equal(urls.get('xizang-tibetan'), signed(STREAMS[1]))
  assert.equal(issuedAt, Math.floor((NOW - 2 * MINUTE) / 1000) * 1000, 'time 是签发时刻（Unix 秒的十六进制）')
})

check('单路缺失或地址异常只影响这一路；三路都没有才报错', () => {
  const missing = catalog()
  missing.cardgroups[1].cards.pop()
  assert.deepEqual([...parseCatalog(missing).urls.keys()], ['xizang-satellite', 'xizang-tibetan'])

  const offsite = catalog({ patch: { 'xizang-satellite': { video: { url: 'https://tv.vtibet.cn.evil.test/live/x.m3u8?secret=' + 'a'.repeat(32) + '&time=6ab56940' } } } })
  assert.equal(parseCatalog(offsite).urls.has('xizang-satellite'), false)
  const unsigned = catalog({ patch: { 'xizang-tibetan': { video: { url: 'https://tv.vtibet.cn/live/r31M7Qa5hm7wrP.m3u8' } } } })
  assert.equal(parseCatalog(unsigned).urls.has('xizang-tibetan'), false)
  const duplicated = catalog()
  duplicated.cardgroups[0].cards.push({ ...duplicated.cardgroups[1].cards[2] })
  assert.equal(parseCatalog(duplicated).urls.has('xizang-film-culture'), false, '同一卡片 ID 出现两次说明结构变了，不猜')

  const empty = catalog()
  empty.cardgroups[1].cards = []
  assert.throws(() => parseCatalog(empty), /没有找到任何有效频道/)
  assert.throws(() => parseCatalog({ succeed: 0, error_code: 1, cardgroups: [] }), /返回失败或格式变化/)
  assert.throws(() => parseCatalog('<html>'), /有效 JSON/)
})

check('签名地址必须是直播目录下的 .m3u8，带 32 位 secret 与 8 位十六进制 time', () => {
  assert.deepEqual(signedLiveUrl(signed(STREAMS[0], NOW)), { url: signed(STREAMS[0], NOW), issuedAt: Math.floor(NOW / 1000) * 1000 })
  for (const bad of [
    'https://tv.vtibet.cn/live/x.m3u8',
    'https://tv.vtibet.cn/live/x.m3u8?secret=abc&time=6ab56940',
    `https://tv.vtibet.cn/live/x.m3u8?secret=${'a'.repeat(32)}&time=6ab5694`,
    `https://tv.vtibet.cn/live/x.ts?secret=${'a'.repeat(32)}&time=6ab56940`,
  ]) assert.throws(() => signedLiveUrl(bad), /西藏广电/)
})

check('媒体白名单只认 tv.vtibet.cn 的直播目录', () => {
  for (const good of [
    signed(STREAMS[0]),
    'https://tv.vtibet.cn/live/h701F9MpxzPDyE-596758564.ts?ctyun_app=live&ctyun_stream=h701F9MpxzPDyE&ctyun_rate=2564.000',
    'https://tv.vtibet.cn/live/h701F9MpxzPDyE-596758564.ts',
    'https://tv.vtibet.cn/live/key.key',
  ]) assert.equal(officialAssetUrl(good), good)
  for (const bad of [
    'http://tv.vtibet.cn/live/x.m3u8',
    'https://tv.vtibet.cn.evil.test/live/x.m3u8',
    'https://evil.test/live/x.ts',
    'https://tv.vtibet.cn/private/x.ts',
    'https://tv.vtibet.cn/live/../x.ts',
    'https://tv.vtibet.cn/live/a/b.ts',
    'https://tv.vtibet.cn/live/x.mp4',
    'https://user:pass@tv.vtibet.cn/live/x.ts',
    'https://tv.vtibet.cn:8443/live/x.ts',
    'https://api.vtibet.cn/live/x.ts',
    'not a url',
  ]) assert.throws(() => officialAssetUrl(bad), /西藏广电/)
})

check('清单相对分片与 KEY 引用必须落回官方直播目录，站外引用整份拒绝', () => {
  const base = signed(STREAMS[0])
  assert.equal(validateManifest(MANIFEST, base), MANIFEST)
  assert.doesNotThrow(() => validateManifest('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.key"\n#EXTINF:3,\nseg.ts\n', base))
  assert.throws(() => validateManifest('#EXTM3U\n#EXTINF:3,\nhttps://evil.test/x.ts\n', base), /非官方媒体地址/)
  assert.throws(() => validateManifest('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://evil.test/k"\n', base), /非官方媒体地址/)
  assert.throws(() => validateManifest('#EXTM3U\n#EXTINF:3,\n../private/x.ts\n', base), /非官方媒体地址/)
  assert.throws(() => validateManifest('{"exit":{"reason":20,"retcode":403}}', base), /不是 HLS/)
})

await checkAsync('频道接口：表单只提交 json 一个字段，照官网页面带 Origin；非 200 与超大响应报错', async () => {
  let request
  const result = await requestCatalog({
    fetchImpl: async (url, init) => {
      request = { url: String(url), init }
      return json(catalog())
    },
  })
  assert.equal(result.urls.size, 3)
  assert.equal(request.url, CATALOG_API)
  assert.equal(request.init.method, 'POST')
  assert.equal(request.init.redirect, 'manual')
  const body = new URLSearchParams(request.init.body)
  assert.deepEqual([...body.keys()], ['json'])
  assert.deepEqual(JSON.parse(body.get('json')), { cardgroups: CARD_GROUP })
  assert.equal(CARD_GROUP, 'LIVECAST')
  assert.match(request.init.headers['Content-Type'], /^application\/x-www-form-urlencoded/)
  assert.equal(request.init.headers.Origin, SITE_ORIGIN)

  await assert.rejects(requestCatalog({ fetchImpl: async () => new Response('busy', { status: 502 }) }), /HTTP 502/)
  await assert.rejects(requestCatalog({
    fetchImpl: async () => new Response('x'.repeat(10), { headers: { 'content-length': String(10 * 1024 * 1024) } }),
  }), /响应过大/)
  await assert.rejects(requestCatalog({ fetchImpl: async () => new Response('x'.repeat(300 * 1024)) }), /响应过大/)
})

await checkAsync('resolve 交回本轮清单：相对分片由外壳改成官方绝对地址，分片不带签名', async () => {
  clearCache()
  const { fetchImpl, log } = upstream()
  const result = await resolveChannel('xizang-satellite', { fetchImpl, now: NOW })
  assert.equal(result.url, signed(STREAMS[0]))
  assert.equal(result.manifestUrl, result.url)
  assert.equal(result.manifestText, MANIFEST)
  assert.equal(result.relayHls, true)
  assert.equal(result.upstreamHeaders, undefined, 'CDN 不看来源头与 UA，不发')
  assert.equal(result.upstreamUrlTransform, officialAssetUrl)
  assert.deepEqual(log.manifests, [signed(STREAMS[0])])

  const relayed = inlineResolvedManifest({ ...result, playURL: result.url })
  const refs = relayed.split('\n').filter(line => line && !line.startsWith('#'))
  assert.deepEqual(refs, [
    'https://tv.vtibet.cn/live/h701F9MpxzPDyE-596758564.ts?ctyun_app=live&ctyun_stream=h701F9MpxzPDyE&ctyun_rate=2564.000',
    'https://tv.vtibet.cn/live/h701F9MpxzPDyE-596758565.ts?ctyun_app=live&ctyun_stream=h701F9MpxzPDyE&ctyun_rate=2564.000',
  ])
  for (const ref of refs) assert.equal(officialAssetUrl(ref), ref)
})

await checkAsync('频道表五分钟内复用、并发共用一次请求，到期重取', async () => {
  clearCache()
  const { fetchImpl, log } = upstream()
  await Promise.all(CHANNELS.map(channel => resolveChannel(channel.ref, { fetchImpl, now: NOW })))
  assert.equal(log.api, 1, '三路同时起播只取一次频道表')
  await resolveChannel('xizang-tibetan', { fetchImpl, now: NOW + CATALOG_REFRESH_MS - 1 })
  assert.equal(log.api, 1, '播放器三秒一次的清单轮询不打接口')
  assert.equal(log.manifests.length, 4, '清单每次都取当前的')
  await resolveChannel('xizang-tibetan', { fetchImpl, now: NOW + CATALOG_REFRESH_MS })
  assert.equal(log.api, 2)
})

await checkAsync('接口交回签发已久的地址时提前重取，但两次至少隔 30 秒', async () => {
  clearCache()
  // 接口缓存了 19 分钟前签发的地址：离 20 分钟上限只剩 1 分钟
  const { fetchImpl, log } = upstream({ issue: () => catalog({ issuedAt: NOW - 19 * MINUTE }) })
  await resolveChannel('xizang-satellite', { fetchImpl, now: NOW })
  await resolveChannel('xizang-satellite', { fetchImpl, now: NOW + MINUTE - 1 })
  assert.equal(log.api, 1)
  await resolveChannel('xizang-satellite', { fetchImpl, now: NOW + MINUTE })
  assert.equal(log.api, 2)

  // 接口一直交回超过上限的旧地址：不跟着轮询每次都打
  clearCache()
  const stale = upstream({ issue: () => catalog({ issuedAt: NOW - 40 * MINUTE }) })
  for (const offset of [0, 3000, 6000, 29_000]) {
    await resolveChannel('xizang-satellite', { fetchImpl: stale.fetchImpl, now: NOW + offset })
  }
  assert.equal(stale.log.api, 1)
  await resolveChannel('xizang-satellite', { fetchImpl: stale.fetchImpl, now: NOW + 30_000 })
  assert.equal(stale.log.api, 2)
  assert.ok(SIGN_REUSE_MS < 60 * MINUTE, '复用上限远低于实测有效期')
})

await checkAsync('清单 403 时立即重取频道表、换新签名再试一次', async () => {
  clearCache()
  // 第一次签发的已被 CDN 拒绝，重取后换成新 secret
  const { fetchImpl, log } = upstream({
    issue: call => catalog({ secret: (call === 1 ? 'a' : 'b').repeat(32) }),
    accept: url => url.includes('secret=' + 'b'.repeat(32)),
  })
  const result = await resolveChannel('xizang-film-culture', { fetchImpl, now: NOW })
  assert.equal(log.api, 2)
  assert.equal(log.manifests.length, 2)
  assert.equal(result.url, signed(STREAMS[2], NOW - 2 * MINUTE, 'b'.repeat(32)))
  assert.match(result.manifestText, /^#EXTM3U/)
  // 新地址进了缓存：后续轮询直接用它
  await resolveChannel('xizang-film-culture', { fetchImpl, now: NOW + 3000 })
  assert.equal(log.api, 2)
  assert.equal(log.manifests.at(-1), result.url)
})

await checkAsync('重取后仍被拒就照实报错；十秒内不再为 403 重取频道表', async () => {
  clearCache()
  const { fetchImpl, log } = upstream({ accept: () => false })
  const first = await resolveChannel('xizang-satellite', { fetchImpl, now: NOW })
  assert.equal(first.url, '')
  assert.match(first.desc, /西藏广电链接请求失败：西藏广电直播清单 HTTP 403/)
  assert.equal(log.api, 2)
  const polled = await resolveChannel('xizang-satellite', { fetchImpl, now: NOW + 3000 })
  assert.equal(polled.url, '')
  assert.equal(log.api, 2, '播放器连环重试时不跟着打接口')
  await resolveChannel('xizang-satellite', { fetchImpl, now: NOW + 10_000 })
  assert.equal(log.api, 3)
})

await checkAsync('清单 5xx 不是地址失效，不重取频道表', async () => {
  clearCache()
  const { fetchImpl, log } = upstream({ accept: () => false, cdnStatus: 503 })
  const result = await resolveChannel('xizang-satellite', { fetchImpl, now: NOW })
  assert.equal(result.url, '')
  assert.match(result.desc, /HTTP 503/)
  assert.equal(log.api, 1)
})

await checkAsync('接口故障时在签名有效期内沿用上次的地址并退避，过期后照实报错', async () => {
  clearCache()
  let apiUp = true
  const log = { api: 0 }
  const fetchImpl = async url => {
    if (String(url) === CATALOG_API) {
      log.api++
      return apiUp ? json(catalog()) : new Response('busy', { status: 502 })
    }
    return new Response(MANIFEST)
  }
  const good = await resolveChannel('xizang-tibetan', { fetchImpl, now: NOW })
  apiUp = false
  const degraded = await resolveChannel('xizang-tibetan', { fetchImpl, now: NOW + CATALOG_REFRESH_MS })
  assert.equal(degraded.url, good.url)
  assert.equal(log.api, 2)
  await resolveChannel('xizang-tibetan', { fetchImpl, now: NOW + CATALOG_REFRESH_MS + 5000 })
  assert.equal(log.api, 2, '退避期内不再打接口')
  // 签发（NOW - 2 分钟）后一小时：不再沿用
  const expired = await resolveChannel('xizang-tibetan', { fetchImpl, now: NOW - 2 * MINUTE + 3 * SIGN_REUSE_MS })
  assert.equal(expired.url, '')
  assert.match(expired.desc, /珠峰云频道接口 HTTP 502/)
})

await checkAsync('resolve 只返回说明，不向请求处理器抛异常', async () => {
  clearCache()
  const malformed = await resolveChannel('xizang-economy', { fetchImpl: async () => { throw new Error('不应请求') } })
  assert.deepEqual(malformed, { url: '', desc: '西藏频道引用格式错误' })

  const thrown = await resolveChannel('xizang-satellite', { fetchImpl: async () => { throw new Error('socket hang up') } })
  assert.equal(thrown.url, '')
  assert.match(thrown.desc, /西藏广电链接请求失败：socket hang up/)

  clearCache()
  const aborted = await resolveChannel('xizang-satellite', {
    timeoutMs: 20,
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    }),
  })
  assert.equal(aborted.url, '')
  assert.match(aborted.desc, /超时 20ms/)

  clearCache()
  const missing = catalog()
  missing.cardgroups[1].cards = missing.cardgroups[1].cards.filter(card => card.id !== CHANNELS[1].cardId)
  const absent = await resolveChannel('xizang-tibetan', { fetchImpl: async () => json(missing), now: NOW })
  assert.equal(absent.url, '')
  assert.match(absent.desc, /藏语卫视当前不在珠峰云直播列表中/)

  clearCache()
  const html = await resolveChannel('xizang-satellite', {
    now: NOW,
    fetchImpl: async url => (String(url) === CATALOG_API ? json(catalog()) : new Response('<html>error</html>')),
  })
  assert.equal(html.url, '')
  assert.match(html.desc, /不是 HLS 清单/)
  clearCache()
})

console.log(`\n全部通过：${passed} ✅`)
