#!/usr/bin/env node
/**
 * 泉州模块离线测试：一路延迟解析频道归入福建，只接受官方签名清单与本频道的 TS 路径，
 * 主入口触发人机验证时走备用入口；签名在有效期内被所有刷新共用，被官网 WAF 拦下后冷却、不再连打。
 * 夹具按 2026-09-25 的真实响应裁剪。
 *
 * 运行： node scripts/test-quanzhou-minnan.mjs
 */
import assert from 'node:assert/strict'

import quanzhou from '../extractors/quanzhou-minnan/index.js'
import {
  CHANNEL, PLAYER_PAGE, PLAY_APIS, claimsRef, createResolver, officialManifestUrl,
  officialSegmentUrl, signedReuseUntil, validateManifest,
} from '../extractors/quanzhou-minnan/api.js'
import { getModule, resolverFor } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

const manifestUrl = token => `https://live.qztv.cn/live/mny20260520_lld.m3u8?auth_key=1790319137-0-0-${token.repeat(32)}`
const segment = 'live.qztv.cn_mny20260520_lld-1790318264430.ts'
const playlist = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:123\n#EXT-X-TARGETDURATION:5\n#EXTINF:5.000,\n' + segment + '\n'
const MEDIA_ID = 'wq95wqbDnMKyd8KiwqzChnt0w5nChcKofcKh'

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
  assert.equal(quanzhou.catalogVersion, 1)
  assert.deepEqual(quanzhou.configSchema, [])
  assert.equal(resolverFor(CHANNEL.ref), quanzhou)
  assert.equal(resolverFor(`${CHANNEL.ref}/extra`), null)
})

await checkAsync('一路固定频道带官网频道卡，走延迟解析', async () => {
  const { groups } = await quanzhou.fetch()
  assert.equal(groups.length, 1)
  assert.equal(groups[0].name, '福建')
  assert.deepEqual(groups[0].dataList, [{
    name: '泉州闽南语',
    deferredRef: CHANNEL.ref,
    logo: 'https://www.qztv.cn/index/images/home/crad-02.jpg',
    opts: ['network-caching=3000'],
    catchup: 'none',
  }])
  assert.equal(claimsRef(CHANNEL.ref), true)
  assert.equal(claimsRef('other'), false)
})

check('只接受泉州官方频道的签名清单和 TS 分片', () => {
  const url = manifestUrl('a')
  assert.equal(officialManifestUrl(url), url)
  assert.equal(officialSegmentUrl(segment, url), `https://live.qztv.cn/live/${segment}`)
  assert.equal(validateManifest(playlist, url), playlist)
  assert.throws(() => officialManifestUrl(url.replace('live.qztv.cn', 'evil.example')))
  assert.throws(() => officialManifestUrl(url.replace('/live/mny', '/live/news')))
  assert.throws(() => officialManifestUrl(`${url}&extra=1`))
  assert.throws(() => officialSegmentUrl('https://evil.example/live/a.ts', url))
  assert.throws(() => officialSegmentUrl('live.qztv.cn_news-1.ts', url))
  assert.throws(() => validateManifest('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128\n' + playlist, url))
  assert.throws(() => validateManifest('#EXTM3U\n#EXTINF:5,\n' + segment, url))
})

await checkAsync('签名在有效期内复用、过期才重签；主入口遇人机验证时走备用入口，分片以浏览器标识全代理', async () => {
  let token = 'a'
  let clock = Date.parse('2026-09-26T12:00:00Z')
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push(url)
    if (url === PLAY_APIS[0]) {
      assert.equal(init.method, 'POST')
      assert.equal(new URLSearchParams(init.body).get('media_id'), MEDIA_ID)
      return new Response('<meta name="aliyun_waf_aa">')
    }
    if (url === PLAY_APIS[1]) {
      assert.equal(new URLSearchParams(init.body).get('media_id'), MEDIA_ID)
      return new Response(JSON.stringify({ error_code: 0, data: manifestUrl(token) }))
    }
    assert.ok([manifestUrl('a'), manifestUrl('b')].includes(url))
    return new Response(playlist)
  }
  const resolver = createResolver({ fetchImpl, now: () => clock })
  const first = await resolver.resolve(CHANNEL.ref)
  assert.equal(first.url, manifestUrl('a'))
  assert.equal(first.manifestText, playlist)
  assert.equal(first.manifestUrl, manifestUrl('a'))
  assert.equal(first.relayHls, undefined)
  const headers = first.upstreamHeaders(`https://live.qztv.cn/live/${segment}`)
  assert.equal(headers.Referer, PLAYER_PAGE)
  assert.match(headers['User-Agent'], /Chrome/)
  assert.equal(first.upstreamUrlTransform(segment), `https://live.qztv.cn/live/${segment}`)
  // 播放器每几秒刷一次清单：有效期内不再打官网，只重新取 CDN 清单
  token = 'b'
  clock += 9 * 60_000
  const again = await resolver.resolve(CHANNEL.ref)
  assert.equal(again.url, manifestUrl('a'))
  assert.equal(again.manifestText, playlist)
  assert.equal(calls.filter(url => url === PLAY_APIS[1]).length, 1)
  // 夹具时间戳早于现在（按签发时间算），10 分钟后重签
  clock += 2 * 60_000
  assert.equal((await resolver.resolve(CHANNEL.ref)).url, manifestUrl('b'))
  assert.equal(calls.filter(url => url === PLAY_APIS[0]).length, 2)
  assert.equal(calls.filter(url => url === PLAY_APIS[1]).length, 2)
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

await checkAsync('CDN 不认缓存的签名就立刻重签；同时到达的请求只签一次', async () => {
  let token = 'a'
  let rejectA = false
  let signs = 0
  const fetchImpl = async url => {
    if (PLAY_APIS.includes(url)) {
      signs++
      await new Promise(resolve => setTimeout(resolve, 20))
      return new Response(JSON.stringify({ error_code: 0, data: manifestUrl(token) }))
    }
    if (url === manifestUrl('a') && rejectA) return new Response('forbidden', { status: 403 })
    return new Response(playlist)
  }
  const resolver = createResolver({ fetchImpl })
  const both = await Promise.all([resolver.resolve(CHANNEL.ref), resolver.resolve(CHANNEL.ref)])
  assert.deepEqual(both.map(item => item.url), [manifestUrl('a'), manifestUrl('a')])
  assert.equal(signs, 1, '并发的两次只打一次官网')
  rejectA = true
  token = 'b'
  assert.equal((await resolver.resolve(CHANNEL.ref)).url, manifestUrl('b'))
  assert.equal(signs, 2)
})

await checkAsync('官网弹滑块后冷却：冷却中一枪不打，时长 5→10→20→30 分钟递增，签到后清零', async () => {
  let clock = Date.parse('2026-09-26T12:00:00Z')
  let blocked = true
  let calls = 0
  const fetchImpl = async url => {
    calls++
    if (PLAY_APIS.includes(url)) {
      return blocked ? new Response('<meta name="aliyun_waf_aa">') : new Response(JSON.stringify({ error_code: 0, data: manifestUrl('c') }))
    }
    return new Response(playlist)
  }
  const resolver = createResolver({ fetchImpl, now: () => clock })
  const first = await resolver.resolve(CHANNEL.ref)
  assert.equal(first.url, '')
  assert.match(first.desc, /人机验证.*约 5 分钟后自动重试/)
  assert.equal(calls, 2, '两个入口各试一次')
  clock += 4 * 60_000
  assert.match((await resolver.resolve(CHANNEL.ref)).desc, /约 1 分钟后/)
  assert.equal(calls, 2, '冷却中不打官网')
  clock += 60_000
  assert.match((await resolver.resolve(CHANNEL.ref)).desc, /约 10 分钟后/)
  assert.equal(calls, 4)
  clock += 10 * 60_000
  assert.match((await resolver.resolve(CHANNEL.ref)).desc, /约 20 分钟后/)
  clock += 20 * 60_000
  assert.match((await resolver.resolve(CHANNEL.ref)).desc, /约 30 分钟后/)
  clock += 30 * 60_000
  assert.match((await resolver.resolve(CHANNEL.ref)).desc, /约 30 分钟后/, '封顶 30 分钟')
  clock += 30 * 60_000
  blocked = false
  assert.equal((await resolver.resolve(CHANNEL.ref)).url, manifestUrl('c'))
  // 清零后再被拦，从 5 分钟重新算（先让缓存的签名失效）
  clock += 31 * 60_000
  blocked = true
  assert.match((await resolver.resolve(CHANNEL.ref)).desc, /约 5 分钟后/)
})

await checkAsync('非法引用、官网全部要求验证或接口异常时只返回说明', async () => {
  const waf = createResolver({ fetchImpl: async () => new Response('<meta name="aliyun_waf_aa">') })
  const malformed = await waf.resolve('other')
  assert.equal(malformed.url, '')
  assert.match(malformed.desc, /引用格式错误/)
  const blocked = await waf.resolve(CHANNEL.ref)
  assert.equal(blocked.url, '')
  assert.match(blocked.desc, /人机验证/)
  const down = createResolver({ fetchImpl: async () => new Response('down', { status: 502 }) })
  assert.match((await down.resolve(CHANNEL.ref)).desc, /取流失败.*HTTP 502/)
  const empty = createResolver({ fetchImpl: async () => new Response(JSON.stringify({ error_code: 1, data: null })) })
  assert.match((await empty.resolve(CHANNEL.ref)).desc, /没有签发/)
})

console.log(`\n全部通过：${passed} ✅`)
