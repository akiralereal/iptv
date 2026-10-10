#!/usr/bin/env node
/** 台州模块离线测试；播放响应按 2026-10-09 官方实测裁剪，不含有效签名。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import taizhou from '../extractors/taizhou/index.js'
import { getModule, resolverFor } from '../extractors/registry.js'
import { inlineResolvedManifest } from '../utils/appUtils.js'
import {
  CHANNELS, PLAY_API, claimsRef, createResolver, officialManifestUrl,
  officialSegmentUrl, validateManifest,
} from '../extractors/taizhou/api.js'

const channel = CHANNELS[0]
const host = 'play-sh13.quklive.com'
const manifestUrl = token => `https://${host}/live/${channel.id}.m3u8?auth_key=${token}`
const segment = token => `${host}_${channel.id}-1791557904129.ts?auth_key=${token}`
const playlist = token => `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:10\n#EXT-X-TARGETDURATION:5\n#EXTINF:5.000,\n${segment(token)}\n`

test('已注册、默认开启，归入浙江分组并支持清单中继和全代理', () => {
  assert.equal(getModule('taizhou'), taizhou)
  assert.equal(taizhou.name, '台州')
  assert.notEqual(taizhou.defaultEnabled, false)
  assert.equal(taizhou.outputGroupName, '浙江')
  assert.equal(taizhou.channelHlsMode, 'relay')
  assert.equal(taizhou.relayProxyCompatible, true)
  assert.equal(taizhou.capabilities.catchup, false)
  assert.equal(resolverFor(channel.ref), taizhou)
  assert.equal(resolverFor(channel.ref + '/extra'), null)
})

test('目录仅收录已经确认的官方频道', async () => {
  const rows = (await taizhou.fetch()).groups[0].dataList
  assert.equal(rows.length, 1)
  assert.equal(rows[0].deferredRef, channel.ref)
  assert.equal(rows[0].name, '天台和合频道')
  assert.equal(rows[0].logo, undefined, '官方只有点击横幅，台标留空交内置库兜底')
  assert.equal(rows[0].catchup, 'none')
  assert.equal(rows[0].url, undefined)
  assert.equal(claimsRef('taizhou-tiantai-hehe'), true)
  assert.equal(claimsRef('taizhou-wenling-news'), false)
})

test('清单和分片必须来自同一频道的官方 CDN，并保留签名', () => {
  const url = manifestUrl('a')
  assert.equal(officialManifestUrl(url, channel), url)
  assert.equal(officialSegmentUrl(segment('b'), url, channel), `https://${host}/live/${segment('b')}`)
  assert.equal(validateManifest(playlist('a'), url, channel), playlist('a'))
  const alias = `https://hls.quklive.com/live/${host}/${channel.id}.m3u8?auth_key=a`
  assert.equal(officialSegmentUrl(segment('a'), alias, channel), `https://${host}/live/${segment('a')}`)
  for (const bad of [url.replace(channel.id, '123'), url.replace(host, 'evil.example'), url.replace('https:', 'http:'), url.split('?')[0]]) {
    assert.throws(() => officialManifestUrl(bad, channel))
  }
  for (const bad of ['https://evil.example/live/test.ts?auth_key=a', segment('a').replace(channel.id, '123'), '../test.ts?auth_key=a']) {
    assert.throws(() => officialSegmentUrl(bad, url, channel))
  }
  for (const tag of ['#EXT-X-KEY:METHOD=AES-128', '#EXT-X-STREAM-INF:BANDWIDTH=1', '#EXT-X-ENDLIST']) {
    assert.throws(() => validateManifest(playlist('a') + tag, url, channel))
  }
})

test('播放时重新取签名；停播或上游错误不会导出失效地址', async () => {
  let token = 'first', calls = 0
  const fetchImpl = async (url, init) => {
    if (url === PLAY_API) {
      calls++
      assert.equal(new URLSearchParams(init.body).get('liveId'), channel.id)
      return new Response(JSON.stringify({ code: 0, value: { playState: 0, url: manifestUrl(token) } }))
    }
    return new Response(playlist(token))
  }
  const resolver = createResolver({ fetchImpl })
  const first = await resolver.resolve(channel.ref)
  assert.equal(first.url, manifestUrl('first'))
  assert.equal(first.relayHls, true)
  token = 'second'
  assert.equal((await resolver.resolve(channel.ref)).url, manifestUrl('second'))
  assert.equal(calls, 2)
  const offline = createResolver({ fetchImpl: async () => new Response(JSON.stringify({ code: 0, value: { playState: 1 } })) })
  assert.equal((await offline.resolve(channel.ref)).url, '')
  const missing = createResolver({ fetchImpl: async () => new Response('stream not found', { status: 404 }) })
  assert.match((await missing.resolve(channel.ref)).desc, /HTTP 404/)
})

test('别名清单中的相对分片在实际 CDN 取回，签名在两种路由中保留', async () => {
  const alias = `https://hls.quklive.com/live/${host}/${channel.id}.m3u8?auth_key=manifest`
  const resolver = createResolver({ fetchImpl: async url => url === PLAY_API
    ? new Response(JSON.stringify({ code: 0, value: { playState: 0, url: alias } }))
    : new Response(playlist('segment')) })
  const result = await resolver.resolve(channel.ref)
  const expected = `https://${host}/live/${segment('segment')}`
  const relay = inlineResolvedManifest(result)
  assert.ok(relay.includes(expected))
  assert.ok(!relay.includes('https://hls.quklive.com/live/'))
  assert.equal(result.upstreamUrlTransform(expected), expected)
})
