#!/usr/bin/env node
import assert from 'node:assert/strict'
import { Response } from 'node-fetch'

import asianLive from '../extractors/asian-live/index.js'
import {
  allowUrl,
  createResolver,
  fetchText,
  parseNasaLive,
  parseTvb,
  parseYtn,
  STREAM_URL_TTL_MS,
  validateHls,
} from '../extractors/asian-live/api.js'
import { buildGroups, claimsRef, sourceFromRef, SOURCES } from '../extractors/asian-live/channels.js'
import { getModule, resolverFor } from '../extractors/registry.js'

assert.equal(SOURCES.length, 43)
assert.equal(SOURCES.some(source => source.id === 'nasa-tv-legacy'), false, '已断流的 NASA Legacy 不应进入生产模块')
assert.equal(new Set(SOURCES.map(source => source.id)).size, SOURCES.length, '频道 id 必须唯一')
assert.ok(SOURCES.every(source => source.rules.length > 0), '每个频道都必须声明媒体主机边界')

const groups = buildGroups()
assert.deepEqual(groups.map(group => group.name), ['香港', '韩国', '日本', '国际', '宠物', '文旅', '娱乐时尚', '体育', '台湾'])
assert.equal(groups.reduce((sum, group) => sum + group.dataList.length, 0), SOURCES.length)
assert.ok(groups.flatMap(group => group.dataList).every(channel => channel.deferredRef.startsWith('asian-live-')))
assert.equal(groups.find(group => group.name === '文旅').dataList.some(channel => channel.name === 'National Geographic'), true)
assert.equal(groups.find(group => group.name === '文旅').dataList.some(channel => channel.name === 'Love Nature 4K'), true)
assert.equal(groups.some(group => group.name === '新闻'), false, '国际新闻频道不应另建新闻分组')
assert.equal(SOURCES.find(source => source.name === 'Reuters')?.group, '国际')
assert.equal(SOURCES.find(source => source.name === 'NHK World')?.group, '日本')
assert.ok(SOURCES.filter(source => source.name.startsWith('France 24 ')).every(source => source.group === '国际'))

assert.equal(claimsRef('asian-live-ytn'), true)
assert.equal(claimsRef('asian-live-ytn/extra'), false)
assert.equal(claimsRef('asian-live-missing'), false)
assert.equal(sourceFromRef('asian-live-reuters')?.name, 'Reuters')

assert.equal(allowUrl('https://cdn.example/live.m3u8', ['cdn.example']), 'https://cdn.example/live.m3u8')
assert.throws(() => allowUrl('http://cdn.example/live.m3u8', ['cdn.example']))
assert.throws(() => allowUrl('https://cdn.example.evil.test/live.m3u8', ['cdn.example']))
assert.equal(
  allowUrl('http://23.237.104.106:8080/live.m3u8', [{ hostname: '23.237.104.106', protocol: 'http:', port: '8080' }]),
  'http://23.237.104.106:8080/live.m3u8',
)

const crossHostManifest = '#EXTM3U\n#EXTINF:6,\nhttps://media.example/segment.ts\n'
assert.equal(validateHls(crossHostManifest, 'https://manifest.example/live.m3u8', ['manifest.example', 'media.example']), crossHostManifest)
assert.throws(() => validateHls(crossHostManifest, 'https://manifest.example/live.m3u8', ['manifest.example']))

assert.equal(parseYtn('var liveUrl = {"hls":"https://ytnlive.ytn.co.kr/live.m3u8","live":"true"};'), 'https://ytnlive.ytn.co.kr/live.m3u8')
assert.throws(() => parseYtn('var liveUrl = process.env'))
assert.equal(parseTvb({ code: 200, data: { stream_url: 'https://live.tvb.example/index.m3u8', stream_type: 'video' } }), 'https://live.tvb.example/index.m3u8')
assert.throws(() => parseTvb({ code: 200, data: { stream_url: 'x', geo_blocked: true } }))

const events = [
  { meta: { 'video-url': 'https://ntv1.akamaized.net/future.m3u8', first_aired_date: '2000', end_aired_date: '3000' } },
  { meta: { 'video-url': 'https://ntv1.akamaized.net/live.m3u8', first_aired_date: '900', end_aired_date: '1100' } },
]
assert.equal(parseNasaLive(events, 1_000_000), 'https://ntv1.akamaized.net/live.m3u8')
assert.throws(() => parseNasaLive(events, 1_500_000))

{
  const fetchImpl = async () => new Response('', { status: 302, headers: { location: 'https://evil.example/live.m3u8' } })
  await assert.rejects(
    fetchText('https://safe.example/live.m3u8', { rules: ['safe.example'], fetchImpl }),
    /不允许访问媒体地址/,
  )
}

{
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (url.startsWith('https://www.ytn.co.kr/_hd/cdnurl.js')) {
      return new Response('var liveUrl = {"hls":"https://ytnlive.ytn.co.kr/live.m3u8","live":"true"};')
    }
    if (url === 'https://ytnlive.ytn.co.kr/live.m3u8') {
      return new Response('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nhttps://ytnlive.ytn.co.kr/segment.ts\n')
    }
    throw new Error(`unexpected fetch ${url}`)
  }
  const resolver = createResolver({ fetchImpl })
  const now = 1_800_000_000_000
  const first = await resolver.resolve('asian-live-ytn', { now })
  const second = await resolver.resolve('asian-live-ytn', { now: now + STREAM_URL_TTL_MS - 1 })
  assert.equal(first.url, 'https://ytnlive.ytn.co.kr/live.m3u8')
  assert.equal(second.url, first.url)
  assert.match(first.manifestText, /^#EXTM3U/)
  assert.equal(first.manifestUrl, first.url)
  assert.equal(first.relayHls, true)
  assert.equal(calls.filter(url => url.startsWith('https://www.ytn.co.kr/')).length, 1, '短时复用动态地址')
  assert.equal(calls.filter(url => url === first.url).length, 2, '直播清单每次请求都应刷新')
  assert.throws(() => first.upstreamUrlTransform('https://evil.example/segment.ts'))
  resolver.clear()
  await resolver.resolve('asian-live-ytn', { now: now + 1000 })
  assert.equal(calls.filter(url => url.startsWith('https://www.ytn.co.kr/')).length, 2, '清缓存后重新解析动态地址')
}

{
  const resolver = createResolver({
    fetchImpl: async () => new Response('#EXTM3U\n#EXTINF:6,\nhttps://evil.example/segment.ts\n'),
  })
  const result = await resolver.resolve('asian-live-reuters')
  assert.equal(result.url, '')
  assert.match(result.desc, /不允许访问媒体地址/)
}

assert.equal(asianLive.channelHlsMode, 'relay')
assert.equal(asianLive.capabilities.resolve, true)
assert.equal((await asianLive.fetch()).groups.length, groups.length)
assert.equal(getModule('asian-live')?.id, 'asian-live')
assert.equal(resolverFor('asian-live-ytn')?.id, 'asian-live')

console.log('✓ 亚洲与国际直播模块频道表、解析缓存、HLS 边界和注册测试通过')
