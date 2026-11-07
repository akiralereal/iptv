#!/usr/bin/env node
/**
 * 澳门莲花卫视模块离线测试：从官网首页内嵌的趣看直播间页取当前 HLS 入口、清单媒体必须是同一官方 CDN 的带签名 TS、
 * 入口短期缓存但每次取实时清单、签名失效立即重读官网。夹具按 2026-11-07 的官网首页与直播间页裁剪。
 *
 * 运行： node scripts/test-lotustv.mjs
 */
import assert from 'node:assert/strict'

import lotustv from '../extractors/lotustv/index.js'
import {
  CHANNEL, HOME_PAGE, claimsRef, createResolver, officialAssetUrl, parseEmbedEntry, parseEmbedUrl, validateManifest,
} from '../extractors/lotustv/api.js'
import { getModule, resolverFor } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

const ROOM = '1793853943346050'
const EMBED = `https://cloud.quklive.com/cloud/a/embed/${ROOM}`
const stream = (token, room = ROOM) => `https://play-sh-qudao.quklive.com/live/${room}.m3u8?token=t&auth_key=${token}`
const home = (src = EMBED) => `<div class="live"><iframe id="onlive" src="${src}" width="100%" height="100%" frameborder="0" scrolling="no"></iframe></div>`
const activity = (token, { id = ROOM, hlsUrl = stream(token) } = {}) => JSON.stringify({
  id: Number(id), name: 'lotustvlive', state: 1,
  urlGroup: { hlsUrl, hdlUrl: hlsUrl.replace('.m3u8', '.flv'), playUrl: EMBED },
  watchUrls: [{ cdnName: 'V2_阿里_上海_渠道', hlsUrl: hlsUrl.replace('https:', 'http:') }],
})
const embedPage = (token, opts) => `<script>
    var hlsUrl = getHttpsUrl('${stream(token)}');
</script>
<script>
        var activity = ${activity(token, opts)};
        var transportProtocol = activity.transportProtocol;
</script>`
const media = token => `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:5.760,\nseg-123.ts?auth_key=${token}\n`

console.log('澳门莲花卫视模块测试')

check('模块注册为免账号、归入澳门的单路清单中继模块', () => {
  assert.equal(getModule('lotustv'), lotustv)
  assert.equal(lotustv.name, '澳门莲花卫视')
  assert.equal(lotustv.outputGroupName, '澳门')
  assert.equal(lotustv.channelHlsMode, 'relay')
  assert.equal(lotustv.relayProxyCompatible, true)
  assert.equal(lotustv.capabilities.resolve, true)
  assert.equal(lotustv.capabilities.epg, true)
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

check('从首页 iframe#onlive 找到当前趣看直播间页', () => {
  assert.deepEqual(parseEmbedUrl(home()), { url: EMBED, id: ROOM })
  assert.deepEqual(parseEmbedUrl(home(`//cloud.quklive.com/cloud/a/embed/${ROOM}`)), { url: EMBED, id: ROOM })
  assert.deepEqual(parseEmbedUrl(`<iframe src="https://evil.example/"></iframe>${home()}`), { url: EMBED, id: ROOM })
  assert.throws(() => parseEmbedUrl(home('https://evil.example/cloud/a/embed/1')), /已变化/)
  assert.throws(() => parseEmbedUrl(home('/live')), /已变化/)
  assert.throws(() => parseEmbedUrl('<html>no player</html>'), /没有直播播放器/)
})

check('直播间页只取 activity 里的当前 HLS 入口，且必须是同一直播间', () => {
  assert.equal(parseEmbedEntry(embedPage('a'), ROOM), stream('a'))
  assert.throws(() => parseEmbedEntry(embedPage('a', { id: '1780907795235397' }), ROOM), /不一致/)
  assert.throws(() => parseEmbedEntry(embedPage('a', { hlsUrl: stream('a', '1780907795235397') }), ROOM), /意外的直播入口/)
  assert.throws(() => parseEmbedEntry(embedPage('a', { hlsUrl: `https://evil.example/live/${ROOM}.m3u8?auth_key=a` }), ROOM))
  assert.throws(() => parseEmbedEntry('<script>var activity = {broken};</script>', ROOM), /无法解析/)
  assert.throws(() => parseEmbedEntry('<html>no activity</html>', ROOM), /没有播放配置/)
})

check('清单里的媒体必须是同一官方 CDN 的带签名 TS', () => {
  assert.equal(validateManifest(media('a'), stream('a')), media('a'))
  assert.throws(() => validateManifest('#EXTM3U\n#EXTINF:6,\nhttps://evil.example/live/a.ts?auth_key=x', stream('a')))
  assert.throws(() => validateManifest('#EXTM3U\n#EXTINF:6,\nseg.ts', stream('a')))
  assert.throws(() => validateManifest('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nsub.m3u8?auth_key=a', stream('a')))
  assert.throws(() => officialAssetUrl('http://play-sh-qudao.quklive.com/live/a.ts?auth_key=x'))
  assert.throws(() => officialAssetUrl('https://play-sh-qudao.quklive.com/live/a.ts?auth_key=x', 'play-sh13.quklive.com'))
})

await checkAsync('入口缓存五分钟但每次取实时清单；签名失效后立即重读官网', async () => {
  let activeToken = 'a'
  let pages = 0
  let embeds = 0
  let manifests = 0
  const fetchImpl = async url => {
    if (url === HOME_PAGE) {
      pages++
      return new Response(home(), { status: 200 })
    }
    if (url === EMBED) {
      embeds++
      return new Response(embedPage(activeToken), { status: 200 })
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
  assert.equal(embeds, 1)
  assert.equal(manifests, 2)

  activeToken = 'b'
  const renewed = await resolver.resolve(CHANNEL.ref, { now: 3000 })
  assert.equal(renewed.url, stream('b'))
  assert.equal(pages, 2)
  assert.equal(embeds, 2)
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
