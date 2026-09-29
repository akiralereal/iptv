#!/usr/bin/env node
/**
 * 泉州模块离线测试：新闻综合、闽南语两路延迟解析频道归入福建，每路只接受自己的官方签名清单与 TS 路径；
 * 签名接口遇人机验证时依次走备用接口和 control-center 播放页，下次先试上次签到的入口；
 * 签名在有效期内被所有刷新共用，被官网 WAF 拦下后冷却、不再连打。
 * 夹具按 2026-09-25、09-29 的真实响应裁剪。
 *
 * 运行： node scripts/test-quanzhou-minnan.mjs
 */
import assert from 'node:assert/strict'

import quanzhou from '../extractors/quanzhou-minnan/index.js'
import {
  CHANNELS, PAGE_ORIGIN, PLAY_APIS, claimsRef, createResolver, officialManifestUrl,
  officialSegmentUrl, requestPlayUrl, signedReuseUntil, validateManifest,
} from '../extractors/quanzhou-minnan/api.js'
import { playerPage } from '../extractors/quanzhou-minnan/channels.js'
import { getModule, resolverFor } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

const [NEWS, MNY] = CHANNELS
const manifestUrl = (token, key = 'mny') => `https://live.qztv.cn/live/${key}20260520_lld.m3u8?auth_key=1790319137-0-0-${token.repeat(32)}`
const segmentOf = key => `live.qztv.cn_${key}20260520_lld-1790318264430.ts`
const playlistOf = key => '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:123\n#EXT-X-TARGETDURATION:5\n#EXTINF:5.000,\n' + segmentOf(key) + '\n'
const segment = segmentOf('mny')
const playlist = playlistOf('mny')
const PAGES = CHANNELS.map(channel => playerPage(channel, PAGE_ORIGIN))
const WAF = '<meta name="aliyun_waf_aa">'
// control-center 播放页里的那一段（真实页面约 150 KB，前后是播放器与节目表）
const pageWith = url => `<script>\n    var player;\n    var urls = "${url}";\n    function initPlayer(){}\n</script>`

console.log('泉州模块测试')

check('模块注册为免账号、归入福建的全代理模块', () => {
  assert.equal(getModule('quanzhou-minnan'), quanzhou)
  assert.equal(quanzhou.name, '泉州')
  assert.equal(quanzhou.outputGroupName, '福建')
  assert.equal(quanzhou.channelHlsMode, 'proxy')
  assert.equal(quanzhou.relayProxyCompatible, undefined)
  assert.equal(quanzhou.capabilities.resolve, true)
  assert.equal(quanzhou.capabilities.epg, true)
  assert.equal(quanzhou.capabilities.catchup, false)
  assert.equal(quanzhou.catalogVersion, 2)
  assert.deepEqual(quanzhou.configSchema, [])
  assert.equal(resolverFor(MNY.ref), quanzhou)
  assert.equal(resolverFor(NEWS.ref), quanzhou)
  assert.equal(resolverFor(`${MNY.ref}/extra`), null)
})

await checkAsync('新闻综合、闽南语两路固定频道带官网频道卡，走延迟解析；闽南语的引用不变', async () => {
  const { groups } = await quanzhou.fetch()
  assert.equal(groups.length, 1)
  assert.equal(groups[0].name, '福建')
  assert.deepEqual(groups[0].dataList, [
    {
      name: '泉州新闻综合',
      deferredRef: 'quanzhou-news-tv',
      logo: 'https://www.qztv.cn/index/images/home/crad-01.jpg',
      opts: ['network-caching=3000'],
      catchup: 'none',
    },
    {
      name: '泉州闽南语',
      deferredRef: 'quanzhou-minnan-tv',
      logo: 'https://www.qztv.cn/index/images/home/crad-02.jpg',
      opts: ['network-caching=3000'],
      catchup: 'none',
    },
  ])
  assert.equal(claimsRef('quanzhou-minnan-tv'), true)
  assert.equal(claimsRef('quanzhou-news-tv'), true)
  assert.equal(claimsRef('other'), false)
})

check('每路只接受自己频道的签名清单和 TS 分片', () => {
  const url = manifestUrl('a')
  assert.equal(officialManifestUrl(url, MNY), url)
  assert.equal(officialSegmentUrl(segment, url, MNY), `https://live.qztv.cn/live/${segment}`)
  assert.equal(validateManifest(playlist, url, MNY), playlist)
  assert.throws(() => officialManifestUrl(url.replace('live.qztv.cn', 'evil.example'), MNY))
  assert.throws(() => officialManifestUrl(url.replace('/live/mny', '/live/news'), MNY))
  assert.throws(() => officialManifestUrl(`${url}&extra=1`, MNY))
  assert.throws(() => officialManifestUrl(url, { ref: 'other' }), /频道无效/)
  assert.throws(() => officialSegmentUrl('https://evil.example/live/a.ts', url, MNY))
  assert.throws(() => officialSegmentUrl(segmentOf('news'), url, MNY))
  assert.throws(() => validateManifest('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128\n' + playlist, url, MNY))
  assert.throws(() => validateManifest('#EXTM3U\n#EXTINF:5,\n' + segment, url, MNY))
  const news = manifestUrl('a', 'news')
  assert.equal(officialManifestUrl(news, NEWS), news)
  assert.equal(validateManifest(playlistOf('news'), news, NEWS), playlistOf('news'))
  assert.throws(() => officialManifestUrl(url, NEWS))
  assert.throws(() => validateManifest(playlist, news, NEWS))
})

await checkAsync('签名接口按频道传 media_id、带同域播放页作来源；播放页入口从页面脚本里取地址', async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push({ url, init })
    if (url === PLAY_APIS[0]) return new Response(JSON.stringify({ error_code: 0, data: manifestUrl('e', 'news') }))
    return new Response(pageWith(manifestUrl('f', 'news')))
  }
  assert.deepEqual(await requestPlayUrl(NEWS, { fetchImpl }), { url: manifestUrl('e', 'news'), entry: 0 })
  assert.equal(new URLSearchParams(seen[0].init.body).get('media_id'), NEWS.mediaId)
  assert.equal(seen[0].init.headers.Referer, playerPage(NEWS, 'https://wxqz2.qztv.cn'))
  assert.deepEqual(await requestPlayUrl(NEWS, { fetchImpl, startAt: 2 }), { url: manifestUrl('f', 'news'), entry: 2 })
  assert.equal(seen[1].url, PAGES[0])
  assert.equal(seen[1].init.method, 'GET')
  assert.equal(seen[1].init.headers.Referer, `${PAGE_ORIGIN}/`)
  // 页面和接口给的地址都按频道校验：新闻综合拿到闽南语地址不收
  const wrong = async url => new Response(PAGES.includes(url) ? pageWith(manifestUrl('a')) : JSON.stringify({ error_code: 0, data: manifestUrl('a') }))
  await assert.rejects(requestPlayUrl(NEWS, { fetchImpl: wrong, startAt: 2 }), /签名频道路径/)
})

await checkAsync('签名在有效期内复用、过期才重签；主入口遇人机验证时走备用入口，分片以浏览器标识全代理', async () => {
  let token = 'a'
  let clock = Date.parse('2026-09-26T12:00:00Z')
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push(url)
    if (url === PLAY_APIS[0]) {
      assert.equal(init.method, 'POST')
      assert.equal(new URLSearchParams(init.body).get('media_id'), MNY.mediaId)
      return new Response(WAF)
    }
    if (url === PLAY_APIS[1]) {
      assert.equal(new URLSearchParams(init.body).get('media_id'), MNY.mediaId)
      return new Response(JSON.stringify({ error_code: 0, data: manifestUrl(token) }))
    }
    assert.ok([manifestUrl('a'), manifestUrl('b')].includes(url))
    return new Response(playlist)
  }
  const resolver = createResolver({ fetchImpl, now: () => clock })
  const first = await resolver.resolve(MNY.ref)
  assert.equal(first.url, manifestUrl('a'))
  assert.equal(first.manifestText, playlist)
  assert.equal(first.manifestUrl, manifestUrl('a'))
  assert.equal(first.relayHls, undefined)
  const headers = first.upstreamHeaders(`https://live.qztv.cn/live/${segment}`)
  assert.equal(headers.Referer, playerPage(MNY))
  assert.match(headers['User-Agent'], /Chrome/)
  assert.equal(first.upstreamUrlTransform(segment), `https://live.qztv.cn/live/${segment}`)
  // 播放器每几秒刷一次清单：有效期内不再打官网，只重新取 CDN 清单
  token = 'b'
  clock += 9 * 60_000
  const again = await resolver.resolve(MNY.ref)
  assert.equal(again.url, manifestUrl('a'))
  assert.equal(again.manifestText, playlist)
  assert.equal(calls.filter(url => url === PLAY_APIS[1]).length, 1)
  // 夹具时间戳早于现在（按签发时间算），10 分钟后重签；上次是备用接口签到的，这次先试它，主入口不再陪跑
  clock += 2 * 60_000
  assert.equal((await resolver.resolve(MNY.ref)).url, manifestUrl('b'))
  assert.equal(calls.filter(url => url === PLAY_APIS[0]).length, 1)
  assert.equal(calls.filter(url => url === PLAY_APIS[1]).length, 2)
})

await checkAsync('两个签名接口都要求验证时走 control-center 播放页，之后先试播放页', async () => {
  let clock = Date.parse('2026-09-29T00:00:00Z')
  const calls = []
  const fetchImpl = async url => {
    calls.push(url)
    if (PLAY_APIS.includes(url)) return new Response(WAF)
    if (url === PAGES[0]) return new Response(pageWith(manifestUrl('c', 'news')))
    return new Response(playlistOf('news'))
  }
  const resolver = createResolver({ fetchImpl, now: () => clock })
  const first = await resolver.resolve(NEWS.ref)
  assert.match(first.url, /\/live\/news20260520_lld\.m3u8/)
  assert.deepEqual(calls.slice(0, 3), [...PLAY_APIS, PAGES[0]])
  assert.equal(first.upstreamHeaders().Referer, playerPage(NEWS))
  clock += 11 * 60_000
  calls.length = 0
  assert.match((await resolver.resolve(NEWS.ref)).url, /news/)
  assert.equal(calls.filter(url => PLAY_APIS.includes(url)).length, 0, '签名接口被拦过，这次直接从播放页取')
})

check('签名复用期：时间戳在未来按过期时间提前 1 分钟换、最多 30 分钟；否则按签发时间用 10 分钟', () => {
  const now = Date.parse('2026-09-26T12:00:00Z')
  const at = seconds => `https://live.qztv.cn/live/mny20260520_lld.m3u8?auth_key=${seconds}-0-0-${'a'.repeat(32)}`
  assert.equal(signedReuseUntil(at(now / 1000 + 20 * 60), now), now + 19 * 60_000)
  assert.equal(signedReuseUntil(at(now / 1000 + 3 * 3600), now), now + 30 * 60_000)
  assert.equal(signedReuseUntil(at(now / 1000 - 5), now), now + 10 * 60_000)
  assert.equal(signedReuseUntil(at(now / 1000 + 60), now), now + 10 * 60_000, '快过期的不当过期时间用')
  assert.equal(signedReuseUntil('not a url', now), now + 10 * 60_000)
})

await checkAsync('CDN 不认缓存的签名就立刻重签；同一频道同时到达的请求只签一次，两个频道各签各的', async () => {
  let token = 'a'
  let rejectA = false
  let signs = 0
  const fetchImpl = async (url, init) => {
    if (PLAY_APIS.includes(url)) {
      signs++
      await new Promise(resolve => setTimeout(resolve, 20))
      const key = new URLSearchParams(init.body).get('media_id') === NEWS.mediaId ? 'news' : 'mny'
      return new Response(JSON.stringify({ error_code: 0, data: manifestUrl(token, key) }))
    }
    if (url === manifestUrl('a') && rejectA) return new Response('forbidden', { status: 403 })
    return new Response(playlistOf(url.includes('/news') ? 'news' : 'mny'))
  }
  const resolver = createResolver({ fetchImpl })
  const both = await Promise.all([resolver.resolve(MNY.ref), resolver.resolve(MNY.ref)])
  assert.deepEqual(both.map(item => item.url), [manifestUrl('a'), manifestUrl('a')])
  assert.equal(signs, 1, '并发的两次只打一次官网')
  assert.equal((await resolver.resolve(NEWS.ref)).url, manifestUrl('a', 'news'))
  assert.equal(signs, 2, '新闻综合有自己的签名')
  rejectA = true
  token = 'b'
  assert.equal((await resolver.resolve(MNY.ref)).url, manifestUrl('b'))
  assert.equal(signs, 3)
  assert.equal((await resolver.resolve(NEWS.ref)).url, manifestUrl('a', 'news'), '闽南语重签不影响新闻综合')
})

await checkAsync('三个入口都被拦后冷却：两个频道共用，冷却中一枪不打，时长 5→10→20→30 分钟递增，签到后清零', async () => {
  let clock = Date.parse('2026-09-26T12:00:00Z')
  let blocked = true
  let calls = 0
  const fetchImpl = async url => {
    calls++
    if (PLAY_APIS.includes(url) || PAGES.includes(url)) {
      if (blocked) return new Response(WAF)
      return PAGES.includes(url) ? new Response(pageWith(manifestUrl('c'))) : new Response(JSON.stringify({ error_code: 0, data: manifestUrl('c') }))
    }
    return new Response(playlist)
  }
  const resolver = createResolver({ fetchImpl, now: () => clock })
  const first = await resolver.resolve(MNY.ref)
  assert.equal(first.url, '')
  assert.match(first.desc, /泉州闽南语.*人机验证.*约 5 分钟后自动重试/)
  assert.equal(calls, 3, '三个入口各试一次')
  clock += 4 * 60_000
  assert.match((await resolver.resolve(NEWS.ref)).desc, /泉州新闻综合.*约 1 分钟后/, '另一个频道也在冷却')
  assert.equal(calls, 3, '冷却中不打官网')
  clock += 60_000
  assert.match((await resolver.resolve(MNY.ref)).desc, /约 10 分钟后/)
  assert.equal(calls, 6)
  clock += 10 * 60_000
  assert.match((await resolver.resolve(MNY.ref)).desc, /约 20 分钟后/)
  clock += 20 * 60_000
  assert.match((await resolver.resolve(MNY.ref)).desc, /约 30 分钟后/)
  clock += 30 * 60_000
  assert.match((await resolver.resolve(MNY.ref)).desc, /约 30 分钟后/, '封顶 30 分钟')
  clock += 30 * 60_000
  blocked = false
  assert.equal((await resolver.resolve(MNY.ref)).url, manifestUrl('c'))
  // 清零后再被拦，从 5 分钟重新算（先让缓存的签名失效）
  clock += 31 * 60_000
  blocked = true
  assert.match((await resolver.resolve(MNY.ref)).desc, /约 5 分钟后/)
})

await checkAsync('非法引用、官网全部要求验证或接口异常时只返回说明', async () => {
  const waf = createResolver({ fetchImpl: async () => new Response(WAF) })
  const malformed = await waf.resolve('other')
  assert.equal(malformed.url, '')
  assert.match(malformed.desc, /引用格式错误/)
  const blocked = await waf.resolve(MNY.ref)
  assert.equal(blocked.url, '')
  assert.match(blocked.desc, /人机验证/)
  const down = createResolver({ fetchImpl: async () => new Response('down', { status: 502 }) })
  assert.match((await down.resolve(NEWS.ref)).desc, /泉州新闻综合取流失败.*HTTP 502/)
  const empty = createResolver({
    fetchImpl: async url => new Response(PAGES.includes(url) ? '<html>改版</html>' : JSON.stringify({ error_code: 1, data: null })),
  })
  assert.match((await empty.resolve(MNY.ref)).desc, /播放页没有泉州闽南语直播地址/)
  const noSign = createResolver({
    fetchImpl: async url => (PAGES.includes(url) ? new Response('x', { status: 502 }) : new Response(JSON.stringify({ error_code: 1, data: null }))),
  })
  assert.match((await noSign.resolve(MNY.ref)).desc, /HTTP 502/)
})

console.log(`\n全部通过：${passed} ✅`)
