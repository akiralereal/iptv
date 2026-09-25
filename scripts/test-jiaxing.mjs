#!/usr/bin/env node
/**
 * 嘉兴模块离线测试：固定三路频道、趣看签名算法、只接受本频道官方 CDN 的清单与分片、
 * 每次播放都重新取签名。夹具按 2026-09-25 的真实响应裁剪。
 *
 * 运行： node scripts/test-jiaxing.mjs
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import jiaxing from '../extractors/jiaxing/index.js'
import {
  CHANNELS, PLAY_API, channelSign, claimsRef, createResolver, officialManifestUrl,
  officialSegmentUrl, validateManifest,
} from '../extractors/jiaxing/api.js'
import { getModule, resolverFor } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

const channel = CHANNELS[0]
const manifestUrl = token => `https://hls.quklive.com/live/play-sh-21.quklive.com/${channel.id}.m3u8?auth_key=${token}`
const segmentUrl = token => `https://play-sh-21.quklive.com/live/play-sh-21.quklive.com_${channel.id}-1790315608395.ts?auth_key=${token}`
const playlist = token => `#EXTM3U\n#EXT-X-TARGETDURATION:8\n#EXTINF:8.000,\n${segmentUrl(token)}\n`

console.log('嘉兴模块测试')

check('模块注册为免账号、归入浙江的清单中继模块', () => {
  assert.equal(getModule('jiaxing'), jiaxing)
  assert.equal(jiaxing.name, '嘉兴')
  assert.equal(jiaxing.outputGroupName, '浙江')
  assert.equal(jiaxing.channelHlsMode, 'relay')
  assert.equal(jiaxing.relayProxyCompatible, true)
  assert.equal(jiaxing.capabilities.resolve, true)
  assert.equal(jiaxing.capabilities.epg, false)
  assert.equal(jiaxing.capabilities.catchup, false)
  assert.equal(jiaxing.catalogVersion, 1)
  assert.deepEqual(jiaxing.configSchema, [])
  assert.equal(resolverFor(channel.ref), jiaxing)
  assert.equal(resolverFor(`${channel.ref}/extra`), null)
})

await checkAsync('三路固定频道走延迟解析，签名算法与趣看网页一致', async () => {
  const { groups } = await jiaxing.fetch()
  assert.equal(groups.length, 1)
  assert.equal(groups[0].name, '浙江')
  assert.deepEqual(groups[0].dataList.map(row => row.name), ['嘉兴新闻综合', '嘉兴文化影视', '嘉兴公共频道'])
  assert.deepEqual(groups[0].dataList.map(row => row.deferredRef), CHANNELS.map(row => row.ref))
  assert.ok(groups[0].dataList.every(row => row.catchup === 'none' && !row.url))
  assert.equal(claimsRef(channel.ref), true)
  assert.equal(claimsRef('not-jiaxing'), false)
  assert.equal(channelSign(channel.id), createHash('md5').update(`${channel.id}NoFeelings`).digest('hex'))
  assert.throws(() => channelSign('1'))
})

check('只接受对应频道的官方签名清单与 TS', () => {
  assert.equal(officialManifestUrl(manifestUrl('a'), channel), manifestUrl('a'))
  assert.equal(officialSegmentUrl(segmentUrl('a'), manifestUrl('a'), channel), segmentUrl('a'))
  assert.equal(validateManifest(playlist('a'), manifestUrl('a'), channel), playlist('a'))
  assert.throws(() => officialManifestUrl(manifestUrl('a').replace(channel.id, CHANNELS[1].id), channel))
  assert.throws(() => officialManifestUrl(manifestUrl('a').replace('?auth_key=a', ''), channel))
  assert.throws(() => officialSegmentUrl(segmentUrl('a').replace('play-sh-21.quklive.com', 'evil.example'), manifestUrl('a'), channel))
  assert.throws(() => validateManifest('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128\n' + playlist('a'), manifestUrl('a'), channel))
  assert.throws(() => validateManifest('#EXTM3U\n', manifestUrl('a'), channel))
})

await checkAsync('每次播放都请求新签名并中继实时清单', async () => {
  let token = 'a'
  let apiCalls = 0
  let manifestCalls = 0
  const fetchImpl = async (url, init) => {
    if (url === PLAY_API) {
      apiCalls++
      assert.equal(init.method, 'POST')
      const body = new URLSearchParams(init.body)
      assert.equal(body.get('liveId'), channel.id)
      assert.equal(body.get('sign'), channelSign(channel.id))
      return new Response(JSON.stringify({ code: 0, value: { playState: 0, url: manifestUrl(token) } }))
    }
    manifestCalls++
    return new Response(playlist(token))
  }
  const resolver = createResolver({ fetchImpl })
  const first = await resolver.resolve(channel.ref)
  assert.equal(first.url, manifestUrl('a'))
  assert.equal(first.relayHls, true)
  assert.equal(first.manifestUrl, manifestUrl('a'))
  assert.equal(first.manifestText, playlist('a'))
  assert.deepEqual(first.upstreamHeaders, { Referer: 'https://www.qukanvideo.com/' })
  assert.equal(first.upstreamUrlTransform(segmentUrl('a')), segmentUrl('a'))
  assert.throws(() => first.upstreamUrlTransform('https://evil.example/live/x.ts?auth_key=a'))
  token = 'b'
  assert.equal((await resolver.resolve(channel.ref)).url, manifestUrl('b'))
  assert.equal(apiCalls, 2)
  assert.equal(manifestCalls, 2)
})

await checkAsync('非法引用与上游异常只返回说明，不向请求处理器抛错', async () => {
  const resolver = createResolver({ fetchImpl: async () => new Response('blocked', { status: 403 }) })
  const malformed = await resolver.resolve('other')
  assert.equal(malformed.url, '')
  assert.match(malformed.desc, /引用格式错误/)
  const failed = await resolver.resolve(channel.ref)
  assert.equal(failed.url, '')
  assert.match(failed.desc, /取流失败.*HTTP 403/)
  const offline = createResolver({
    fetchImpl: async () => new Response(JSON.stringify({ code: 0, value: { playState: 1, url: '' } })),
  })
  assert.match((await offline.resolve(channel.ref)).desc, /没有可用直播信号/)
})

console.log(`\n全部通过：${passed} ✅`)
