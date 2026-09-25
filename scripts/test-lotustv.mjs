#!/usr/bin/env node
/**
 * 澳门莲花卫视模块离线测试：只取官网 QPlayer 当前 URL、清单媒体必须是同一官方 CDN 的带签名 TS、
 * 入口短期缓存但每次取实时清单、签名失效立即重读官网。夹具按 2026-09-25 的官网页面裁剪。
 *
 * 运行： node scripts/test-lotustv.mjs
 */
import assert from 'node:assert/strict'

import lotustv from '../extractors/lotustv/index.js'
import {
  CHANNEL, LIVE_PAGE, claimsRef, createResolver, officialAssetUrl, parsePlayerUrl, validateManifest,
} from '../extractors/lotustv/api.js'
import { getModule, resolverFor } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

const stream = token => `https://play-sh13.quklive.com/live/1780907795235397.m3u8?auth_key=${token}`
const page = token => `<script>new QPlayer({
  //url: "//live-hls.macaulotustv.com/lotustv/lotustv.m3u8",
  url: "//play-sh13.quklive.com/live/1780907795235397.m3u8?auth_key=${token}",
  autoplay: true,
});</script>`
const media = token => `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:5.760,\nseg-123.ts?auth_key=${token}\n`

console.log('澳门莲花卫视模块测试')

check('模块注册为免账号、归入澳门的单路清单中继模块', () => {
  assert.equal(getModule('lotustv'), lotustv)
  assert.equal(lotustv.name, '澳门莲花卫视')
  assert.equal(lotustv.outputGroupName, '澳门')
  assert.equal(lotustv.channelHlsMode, 'relay')
  assert.equal(lotustv.relayProxyCompatible, true)
  assert.equal(lotustv.capabilities.resolve, true)
  assert.equal(lotustv.capabilities.epg, false)
  assert.equal(lotustv.capabilities.catchup, false)
  assert.equal(lotustv.catalogVersion, 1)
  assert.deepEqual(lotustv.configSchema, [])
  assert.equal(typeof lotustv.clearResolveCache, 'function')
  assert.equal(resolverFor(CHANNEL.ref), lotustv)
  assert.equal(resolverFor(`${CHANNEL.ref}/extra`), null)
})

await checkAsync('一路固定频道带官网台标，走延迟解析', async () => {
  const { groups } = await lotustv.fetch()
  assert.equal(groups.length, 1)
  assert.equal(groups[0].name, '澳门')
  assert.deepEqual(groups[0].dataList, [{
    name: '澳门莲花卫视',
    deferredRef: CHANNEL.ref,
    logo: 'https://www.lotustv.mo/view/assets/image/logo.png',
    groupTitle: '澳门',
    opts: ['network-caching=3000'],
    catchup: 'none',
  }])
  assert.equal(claimsRef(CHANNEL.ref), true)
  assert.equal(claimsRef('lotustv-other'), false)
})

check('只取 QPlayer 当前 URL，不误取注释掉的旧线路', () => {
  assert.equal(parsePlayerUrl(page('a')), stream('a'))
  assert.throws(() => parsePlayerUrl('<script>new QPlayer({ //url: "x" });</script>'))
  assert.throws(() => parsePlayerUrl(page('a').replace('  autoplay', '  url: "//play-sh13.quklive.com/live/2.m3u8?auth_key=b",\n  autoplay')))
  assert.throws(() => parsePlayerUrl('<html>no player</html>'))
})

check('清单里的媒体必须是同一官方 CDN 的带签名 TS', () => {
  assert.equal(validateManifest(media('a'), stream('a')), media('a'))
  assert.throws(() => validateManifest('#EXTM3U\n#EXTINF:6,\nhttps://evil.example/live/a.ts?auth_key=x', stream('a')))
  assert.throws(() => validateManifest('#EXTM3U\n#EXTINF:6,\nseg.ts', stream('a')))
  assert.throws(() => validateManifest('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nsub.m3u8?auth_key=a', stream('a')))
  assert.throws(() => officialAssetUrl('http://play-sh13.quklive.com/live/a.ts?auth_key=x'))
  assert.throws(() => officialAssetUrl('https://play-sh13.quklive.com/live/a.ts?auth_key=x', 'play-sh14.quklive.com'))
})

await checkAsync('入口缓存五分钟但每次取实时清单；签名失效后立即重读官网', async () => {
  let activeToken = 'a'
  let pages = 0
  let manifests = 0
  const fetchImpl = async url => {
    if (url === LIVE_PAGE) {
      pages++
      return new Response(page(activeToken), { status: 200 })
    }
    manifests++
    const token = new URL(url).searchParams.get('auth_key')
    return token === activeToken
      ? new Response(media(token), { status: 200 })
      : new Response('expired', { status: 403 })
  }
  const resolver = createResolver({ fetchImpl })
  const first = await resolver.resolve(CHANNEL.ref, { now: 1000 })
  assert.equal(first.url, stream('a'))
  assert.equal(first.relayHls, true)
  assert.equal(first.manifestText, media('a'))
  assert.deepEqual(first.upstreamHeaders, { Referer: 'https://www.lotustv.mo/' })
  assert.equal((await resolver.resolve(CHANNEL.ref, { now: 2000 })).url, stream('a'))
  assert.equal(pages, 1)
  assert.equal(manifests, 2)

  activeToken = 'b'
  const renewed = await resolver.resolve(CHANNEL.ref, { now: 3000 })
  assert.equal(renewed.url, stream('b'))
  assert.equal(pages, 2)
  assert.equal(manifests, 4)
  assert.throws(() => renewed.upstreamUrlTransform('https://evil.example/live/a.ts?auth_key=x'))

  resolver.clear()
  await resolver.resolve(CHANNEL.ref, { now: 4000 })
  assert.equal(pages, 3)
})

await checkAsync('非法引用与官网异常只返回说明，且不把签名写进说明', async () => {
  const resolver = createResolver({ fetchImpl: async () => new Response('down', { status: 503 }) })
  const malformed = await resolver.resolve('other')
  assert.equal(malformed.url, '')
  assert.match(malformed.desc, /引用格式错误/)
  const failed = await resolver.resolve(CHANNEL.ref)
  assert.equal(failed.url, '')
  assert.match(failed.desc, /取流失败.*HTTP 503/)
  assert.doesNotMatch(failed.desc, /auth_key/)
})

console.log(`\n全部通过：${passed} ✅`)
