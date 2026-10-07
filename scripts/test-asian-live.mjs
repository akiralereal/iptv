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

assert.deepEqual(SOURCES.map(source => source.id), ['ytn', 'nhk-world', 'cna', 'france24-en', 'france24-fr', 'world-poker-tour'])
assert.equal(new Set(SOURCES.map(source => source.id)).size, SOURCES.length, '频道 id 必须唯一')
assert.ok(SOURCES.every(source => source.kind && !source.streamUrl), '每个频道都要声明取址方式')
assert.ok(SOURCES.every(source => source.rules.length > 0), '每个频道都必须声明媒体主机边界')
// 只转发主清单的几台：固定官方地址，不走动态接口；也只有它们接手精选列表里的同名条目
assert.deepEqual(SOURCES.filter(source => source.direct).map(source => [source.id, source.kind]), [['cna', 'master'], ['france24-en', 'ladder'], ['france24-fr', 'ladder'], ['world-poker-tour', 'master']])
assert.deepEqual(SOURCES.filter(source => source.supersedesFeatured).map(source => source.id), ['cna', 'france24-en', 'france24-fr', 'world-poker-tour'])

const groups = buildGroups()
assert.deepEqual(groups.map(group => group.name), ['韩国', '日本', '国际', '体育'])
assert.equal(groups.reduce((sum, group) => sum + group.dataList.length, 0), 6)
assert.ok(groups.flatMap(group => group.dataList).every(channel => channel.deferredRef.startsWith('asian-live-')))
// YTN、NHK 清单与媒体全代理；其余只转发主清单，写成普通入口，并标明接手精选列表的同名条目
assert.deepEqual(groups.flatMap(group => group.dataList).map(channel => [channel.name, channel.proxyHls === true, channel.supersedesFeatured === true]), [
  ['YTN News', true, false], ['NHK World', true, false], ['CNA', false, true], ['France 24 English', false, true], ['France 24 Français', false, true],
  ['World Poker Tour', false, true],
])
// 台标取官网自有的频道标，每台一张完整地址（CNA、France 24 的官方台标在内置台标库）；频道表改动要带着 catalogVersion 走，老缓存才会重建
assert.deepEqual(groups.flatMap(group => group.dataList).map(channel => [channel.name, channel.logo]), [
  ['YTN News', 'https://m.ytn.co.kr/img/common/ytnlogo_2024.jpg'],
  ['NHK World', 'https://www3.nhk.or.jp/nhkworld/common/site_images/nw_logo_270x270.png'],
  ['CNA', ''],
  ['France 24 English', ''],
  ['France 24 Français', ''],
  ['World Poker Tour', ''],
])
const logoPack = JSON.parse(readFileSync(new URL('../logo-pack/index.json', import.meta.url), 'utf8')).logos
assert.ok(['CNA', 'France 24 English', 'France 24 Français', 'World Poker Tour'].every(name => logoPack[name]), '留空台标的几台要在内置台标库里有图')
assert.equal(asianLive.catalogVersion, 2)

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
// 不写死条数：IPTV.m3u 本就是「改文件 push 即生效」的清单，探活剔死链、补新源都不该让测试红。
// 只守结构——区块非空，且每条 #EXTINF 紧跟一行地址（中间夹注释或漏行都会让播放器把整份列表读错位）
assert.ok(directEntries.length > 0, '实验台直连区块不能为空')
const extinfCount = (directBlock[1].match(/^#EXTINF:/gm) || []).length
assert.equal(directEntries.length, extinfCount, '直连区块里每条 #EXTINF 后都必须紧跟一行地址')
assert.equal(new Set(directEntries.map(entry => entry.name)).size, directEntries.length, '直连区块频道名不得重复')
assert.equal(new Set(directEntries.map(entry => entry.url)).size, directEntries.length, '直连区块 URL 不得重复')
assert.ok(directEntries.every(entry => /^https?:\/\//.test(entry.url)), '直连区块只接受原始 HTTP(S) 地址')
// 模块频道不得与直连区块重复；接手精选列表的几台例外——过渡期留在区块里给没升级的部署（新镜像按 supersedesFeatured 收掉）
assert.ok(SOURCES.filter(source => !source.supersedesFeatured).every(source => !directEntries.some(entry => entry.name === source.name)), '动态模块不得与直连区块重复')
assert.ok(SOURCES.filter(source => source.supersedesFeatured).every(source => directEntries.some(entry => entry.name === source.name)), '过渡期精选列表要留着被接手的条目')

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

{
  // NHK：主清单里同为 720p 的高码率档排第二，转发时挪到最前；独立音轨标签原样保留
  const master = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="program_audio_0",URI="https://media-tyo.hls.nhkworld.jp/live/a1.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1856404,RESOLUTION=1280x720,AUDIO="program_audio_0"',
    'https://media-tyo.hls.nhkworld.jp/live/v3.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=3572008,RESOLUTION=1280x720,AUDIO="program_audio_0"',
    'https://media-tyo.hls.nhkworld.jp/live/v2.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=369547,RESOLUTION=320x180,AUDIO="program_audio_0"',
    'https://media-tyo.hls.nhkworld.jp/live/v5.m3u8',
    '',
  ].join('\n')
  const fetchImpl = async url => url === 'https://livepl.nhkworld.jp/hlslive_web.json'
    ? new Response(JSON.stringify({ main: { jstrm: 'https://masterpl.hls.nhkworld.jp/hls/w/live/master.m3u8' } }))
    : new Response(master)
  const result = await createResolver({ fetchImpl }).resolve('asian-live-nhk-world')
  assert.equal(result.relayHls, true)
  assert.deepEqual(result.manifestText.split('\n').filter(line => line.startsWith('https://')).map(line => line.split('/').pop()), ['v2.m3u8', 'v3.m3u8', 'v5.m3u8'])
  assert.match(result.manifestText, /^#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO/)
}

{
  // CNA：取一次官方主清单，最高档挪到最前，不带代理请求头；子清单仍是官方地址，由播放器直连
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push([url, init.headers.Referer])
    return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=816640,RESOLUTION=480x270\nindex_1.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=8004449,RESOLUTION=1920x1080\nindex_5.m3u8\n')
  }
  const result = await createResolver({ fetchImpl }).resolve('asian-live-cna')
  assert.equal(result.relayHls, true)
  assert.equal(result.url, 'https://d2e1asnsl7br7b.cloudfront.net/7782e205e72f43aeb4a48ec97f66ebbe/index.m3u8')
  assert.equal(result.manifestUrl, result.url)
  assert.deepEqual(result.manifestText.split('\n').filter(line => line.endsWith('.m3u8')), ['index_5.m3u8', 'index_1.m3u8'])
  assert.equal(result.upstreamHeaders, undefined)
  assert.deepEqual(calls, [[result.url, undefined]])
  // 主清单取不到、或子清单跑出官方主机：退回官方原地址（不带 relayHls，app.js 302），照样能播
  for (const body of [new Response('', { status: 503 }), new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://evil.example/x.m3u8\n')]) {
    const fallback = await createResolver({ fetchImpl: async () => body }).resolve('asian-live-cna')
    assert.equal(fallback.url, result.url)
    assert.equal(fallback.relayHls, undefined)
    assert.match(fallback.desc, /改由播放器直连/)
  }
}

{
  // France 24 English：官方只有两条单档清单，不发请求，拼成 1080p 在前、360p 兜底的主清单
  const result = await createResolver({ fetchImpl: async () => { throw new Error('不该发请求') } }).resolve('asian-live-france24-en')
  assert.equal(result.relayHls, true)
  assert.equal(result.url, 'https://live.france24.com/hls/live/2037218-b/F24_EN_HI_HLS/master_5000.m3u8')
  assert.equal(result.manifestText, [
    '#EXTM3U', '#EXT-X-VERSION:3',
    '#EXT-X-STREAM-INF:BANDWIDTH=5600000,RESOLUTION=1920x1080', 'https://live.france24.com/hls/live/2037218-b/F24_EN_HI_HLS/master_5000.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=760000,RESOLUTION=640x360', 'https://live.france24.com/hls/live/2037218-b/F24_EN_HI_HLS/master_500.m3u8',
    '',
  ].join('\n'))
  const french = await createResolver({ fetchImpl: async () => { throw new Error('不该发请求') } }).resolve('asian-live-france24-fr')
  assert.deepEqual(french.manifestText.split('\n').filter(line => line.startsWith('https://')), [
    'https://live.france24.com/hls/live/2037179-b/F24_FR_HI_HLS/master_5000.m3u8',
    'https://live.france24.com/hls/live/2037179-b/F24_FR_HI_HLS/master_500.m3u8',
  ])
}

assert.equal(asianLive.channelHlsMode, undefined, '代理改按频道声明')
assert.equal(asianLive.capabilities.resolve, true)
assert.equal((await asianLive.fetch()).groups.length, 4)
assert.equal(getModule('asian-live')?.id, 'asian-live')
assert.equal(resolverFor('asian-live-ytn')?.id, 'asian-live')

console.log('✓ 亚洲与国际直播模块：动态源、最高档前置的几台、直连区块与解析边界测试通过')
