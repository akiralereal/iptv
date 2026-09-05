#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Response } from 'node-fetch'

import asianLive from '../extractors/asian-live/index.js'
import {
  allowUrl,
  createResolver,
  fetchText,
  parseYtn,
  readCookies,
  STREAM_URL_TTL_MS,
  validateHls,
} from '../extractors/asian-live/api.js'
import { buildGroups, claimsRef, sourceFromRef, SOURCES } from '../extractors/asian-live/channels.js'
import { getModule, resolverFor } from '../extractors/registry.js'
import { pruneUnclaimedCachedChannels } from '../utils/extractorManager.js'

assert.deepEqual(SOURCES.map(source => source.id), ['ytn', 'nhk-world'])
assert.equal(new Set(SOURCES.map(source => source.id)).size, SOURCES.length, '频道 id 必须唯一')
assert.ok(SOURCES.every(source => source.kind && !source.streamUrl), '模块只应保留动态解析频道')
assert.ok(SOURCES.every(source => source.rules.length > 0), '每个频道都必须声明媒体主机边界')

const groups = buildGroups()
assert.deepEqual(groups.map(group => group.name), ['韩国', '日本'])
assert.equal(groups.reduce((sum, group) => sum + group.dataList.length, 0), 2)
assert.ok(groups.flatMap(group => group.dataList).every(channel => channel.deferredRef.startsWith('asian-live-')))

assert.equal(claimsRef('asian-live-ytn'), true)
assert.equal(claimsRef('asian-live-ytn/extra'), false)
assert.equal(claimsRef('asian-live-missing'), false)
assert.equal(sourceFromRef('asian-live-nhk-world')?.name, 'NHK World')

const oldModuleCache = [
  {
    name: '韩国',
    dataList: [
      { name: 'YTN News', deferredRef: 'asian-live-ytn' },
      { name: 'Arirang', deferredRef: 'asian-live-arirang' },
    ],
  },
  {
    name: '国际',
    dataList: [{ name: 'Reuters', deferredRef: 'asian-live-reuters' }],
  },
]
const prunedCache = pruneUnclaimedCachedChannels(asianLive, oldModuleCache)
assert.equal(prunedCache.removed, 2, '升级时应移除旧模块中已迁入 IPTV.m3u 的缓存频道')
assert.deepEqual(prunedCache.groups, [
  { name: '韩国', dataList: [{ name: 'YTN News', deferredRef: 'asian-live-ytn' }] },
])

const playlist = readFileSync(new URL('../IPTV.m3u', import.meta.url), 'utf8')
const directBlock = playlist.match(/# === BEGIN 亚洲直播实验台已处理直连源 ===([\s\S]*?)# === END 亚洲直播实验台已处理直连源 ===/)
assert.ok(directBlock, 'IPTV.m3u 必须保留实验台直连源的独立标记区块')
const directEntries = [...directBlock[1].matchAll(/^#EXTINF:[^\n]*,([^\n]+)\n([^#\n][^\n]*)$/gm)]
  .map(([, name, url]) => ({ name: name.trim(), url: url.trim() }))
assert.equal(directEntries.length, 50, '实验台固定直连源应完整同步到 IPTV.m3u')
assert.equal(new Set(directEntries.map(entry => entry.name)).size, directEntries.length, '直连区块频道名不得重复')
assert.equal(new Set(directEntries.map(entry => entry.url)).size, directEntries.length, '直连区块 URL 不得重复')
assert.ok(directEntries.every(entry => /^https?:\/\//.test(entry.url)), '直连区块只接受原始 HTTP(S) 地址')
assert.ok(SOURCES.every(source => !directEntries.some(entry => entry.name === source.name)), '动态模块不得与直连区块重复')

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

assert.deepEqual(readCookies({
  getSetCookie: () => [
    'session=abc; Path=/live; Secure',
    'wide=reject; Domain=.ytn.co.kr; Path=/',
    'broken cookie',
  ],
}, 'https://ytnlive.ytn.co.kr/live/master.m3u8'), [
  { pair: 'session=abc', domain: 'ytnlive.ytn.co.kr', path: '/live' },
])

{
  const fetchImpl = async () => new Response('', { status: 302, headers: { location: 'https://evil.example/live.m3u8' } })
  await assert.rejects(
    fetchText('https://safe.example/live.m3u8', { rules: ['safe.example'], fetchImpl }),
    /不允许访问媒体地址/,
  )
}

{
  const calls = []
  const fetchImpl = async url => {
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
  assert.equal(first.relayHls, true)
  assert.equal(calls.filter(url => url.startsWith('https://www.ytn.co.kr/')).length, 1, '短时复用动态地址')
  assert.equal(calls.filter(url => url === first.url).length, 2, '直播清单每次请求都应刷新')
  assert.throws(() => first.upstreamUrlTransform('https://evil.example/segment.ts'))
  resolver.clear()
  await resolver.resolve('asian-live-ytn', { now: now + 1000 })
  assert.equal(calls.filter(url => url.startsWith('https://www.ytn.co.kr/')).length, 2, '清缓存后重新解析动态地址')
}

{
  const fetchImpl = async url => {
    if (url === 'https://livepl.nhkworld.jp/hlslive_web.json') {
      return new Response(JSON.stringify({ main: { jstrm: 'https://masterpl.hls.nhkworld.jp/live/master.m3u8' } }))
    }
    if (url === 'https://masterpl.hls.nhkworld.jp/live/master.m3u8') {
      return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nhttps://media-test.hls.nhkworld.jp/live/child.m3u8\n')
    }
    throw new Error(`unexpected fetch ${url}`)
  }
  const result = await createResolver({ fetchImpl }).resolve('asian-live-nhk-world')
  assert.equal(result.url, 'https://masterpl.hls.nhkworld.jp/live/master.m3u8')
  assert.equal(result.relayHls, true)
  assert.doesNotThrow(() => result.upstreamUrlTransform('https://media-test.hls.nhkworld.jp/live/segment.ts'))
}

{
  const fetchImpl = async url => {
    if (url === 'https://livepl.nhkworld.jp/hlslive_web.json') {
      return new Response(JSON.stringify({ main: { jstrm: 'https://masterpl.hls.nhkworld.jp/live/master.m3u8' } }))
    }
    return new Response('#EXTM3U\n#EXTINF:6,\nhttps://evil.example/segment.ts\n')
  }
  const result = await createResolver({ fetchImpl }).resolve('asian-live-nhk-world')
  assert.equal(result.url, '')
  assert.match(result.desc, /不允许访问媒体地址/)
}

assert.equal(asianLive.channelHlsMode, 'proxy')
assert.equal(asianLive.capabilities.resolve, true)
assert.equal((await asianLive.fetch()).groups.length, 2)
assert.equal(getModule('asian-live')?.id, 'asian-live')
assert.equal(resolverFor('asian-live-ytn')?.id, 'asian-live')

console.log('✓ 亚洲与国际直播模块仅保留动态源，直连源独立同步且解析边界测试通过')
