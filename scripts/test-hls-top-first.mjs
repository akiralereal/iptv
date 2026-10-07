#!/usr/bin/env node
/**
 * 最高档前置：utils/hlsTopFirst.js 的主清单调序与拼主清单、m3u 的 x-top-first 标记、
 * 模块接手精选频道时收掉同组同名的精选条目（channelMerger.dropSupersededFeatured）。
 * 夹具按 2026-10-06 各台官方主清单裁剪。
 *
 * 运行： node scripts/test-hls-top-first.mjs
 */
import assert from 'node:assert/strict'

import { buildMasterPlaylist, topVariantFirst, variantRank } from '../utils/hlsTopFirst.js'
import { parsePlaylistContent } from '../utils/externalSources.js'
import { dropSupersededFeatured } from '../utils/channelMerger.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const uris = text => text.split(/\r?\n/).filter(line => line && !line.startsWith('#'))

console.log('最高档前置测试')

check('最低档在前的主清单：按分辨率、码率从高到低重排，独立字幕 / 音轨标签原样保留', () => {
  const thai = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    '',
    '# Subtitle renditions',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="TH",DEFAULT=YES,URI="subtitles/subtitle.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=128000,RESOLUTION=256x144,SUBTITLES="subs"',
    'variant_144p.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,SUBTITLES="subs"',
    'variant_720p.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=7000000,RESOLUTION=1920x1080,SUBTITLES="subs"',
    'variant_1080p.m3u8',
    '',
  ].join('\n')
  const out = topVariantFirst(thai)
  assert.deepEqual(uris(out), ['variant_1080p.m3u8', 'variant_720p.m3u8', 'variant_144p.m3u8'])
  assert.ok(out.startsWith('#EXTM3U\n#EXT-X-VERSION:6\n\n# Subtitle renditions\n#EXT-X-MEDIA:TYPE=SUBTITLES'), '主清单头部与字幕标签不动')
  // 每档的 STREAM-INF 跟着自己的地址走
  const lines = out.split('\n')
  assert.match(lines[lines.indexOf('variant_1080p.m3u8') - 1], /RESOLUTION=1920x1080/)
  assert.match(lines[lines.indexOf('variant_144p.m3u8') - 1], /RESOLUTION=256x144/)
})

check('同分辨率按码率排（NHK 两条 720p）；AVERAGE-BANDWIDTH 不当 BANDWIDTH', () => {
  const nhk = '#EXTM3U\n'
    + '#EXT-X-STREAM-INF:PROGRAM-ID=0,BANDWIDTH=1856404,AVERAGE-BANDWIDTH=1790800,RESOLUTION=1280x720,AUDIO="a0"\nv3.m3u8\n'
    + '#EXT-X-STREAM-INF:PROGRAM-ID=0,BANDWIDTH=3572008,AVERAGE-BANDWIDTH=3440800,RESOLUTION=1280x720,AUDIO="a0"\nv2.m3u8\n'
    + '#EXT-X-STREAM-INF:PROGRAM-ID=0,BANDWIDTH=369547,AVERAGE-BANDWIDTH=9999999,RESOLUTION=320x180,AUDIO="a1"\nv5.m3u8\n'
  assert.deepEqual(uris(topVariantFirst(nhk)), ['v2.m3u8', 'v3.m3u8', 'v5.m3u8'])
  assert.deepEqual(variantRank('#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=9,BANDWIDTH=5,RESOLUTION=2x3'), [1, 6, 5])
})

check('纯音频档排最后；同档的备用线路保持在主线路后面', () => {
  const nasa = '#EXTM3U\n'
    + '#EXT-X-STREAM-INF:CODECS="mp4a.40.2",BANDWIDTH=104000\nNASAPlus/9.m3u8\n'
    + '#EXT-X-STREAM-INF:CODECS="avc1.42c00d,mp4a.40.5",RESOLUTION=416x234,BANDWIDTH=275000\nNASAPlus/1.m3u8\n'
    + '#EXT-X-STREAM-INF:CODECS="avc1.64001e,mp4a.40.2",RESOLUTION=1920x1080,BANDWIDTH=9227000\nNASAPlus/8.m3u8\n'
  assert.deepEqual(uris(topVariantFirst(nasa)), ['NASAPlus/8.m3u8', 'NASAPlus/1.m3u8', 'NASAPlus/9.m3u8'])
  const dw = '#EXTM3U\n'
    + '#EXT-X-STREAM-INF:BANDWIDTH=1061313,RESOLUTION=480x270\nhttps://a/2015525/stream01.m3u8\n'
    + '#EXT-X-STREAM-INF:BANDWIDTH=1061313,RESOLUTION=480x270\nhttps://a/2015525-b/stream01.m3u8\n'
    + '#EXT-X-STREAM-INF:BANDWIDTH=6221313,RESOLUTION=1920x1080\nhttps://a/2015525/stream05.m3u8\n'
    + '#EXT-X-STREAM-INF:BANDWIDTH=6221313,RESOLUTION=1920x1080\nhttps://a/2015525-b/stream05.m3u8\n'
  assert.deepEqual(uris(topVariantFirst(dw)), [
    'https://a/2015525/stream05.m3u8', 'https://a/2015525-b/stream05.m3u8',
    'https://a/2015525/stream01.m3u8', 'https://a/2015525-b/stream01.m3u8',
  ])
})

check('跟在各档后面的标签（Bloomberg 的 CLOSED-CAPTIONS）留在最后；CRLF 行尾保持', () => {
  const text = '#EXTM3U\r\n#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=480x272\r\nlow.m3u8\r\n'
    + '#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720\r\nhigh.m3u8\r\n'
    + '#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",INSTREAM-ID="SERVICE1"\r\n'
  assert.equal(topVariantFirst(text), '#EXTM3U\r\n#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720\r\nhigh.m3u8\r\n'
    + '#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=480x272\r\nlow.m3u8\r\n'
    + '#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",INSTREAM-ID="SERVICE1"\r\n')
})

check('不用动的原样返回：已是最高档在前、单档、媒体清单、格式看不懂', () => {
  const sorted = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=6324320,RESOLUTION=1920x1080\n01.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=428640,RESOLUTION=426x240\n06.m3u8\n'
  assert.equal(topVariantFirst(sorted), sorted)
  const single = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nonly.m3u8\n'
  assert.equal(topVariantFirst(single), single)
  const media = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\na.ts\n'
  assert.equal(topVariantFirst(media), media)
  const broken = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n#EXT-X-STREAM-INF:BANDWIDTH=2\nb.m3u8\n'
  assert.equal(topVariantFirst(broken), broken)
  assert.equal(topVariantFirst(undefined), undefined)
})

check('拼主清单：按给的顺序列出各档', () => {
  assert.equal(buildMasterPlaylist([
    { url: 'https://cdn/5000.m3u8', bandwidth: 5600000, resolution: '1920x1080' },
    { url: 'https://cdn/500.m3u8', bandwidth: 760000 },
  ]), '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=5600000,RESOLUTION=1920x1080\nhttps://cdn/5000.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=760000\nhttps://cdn/500.m3u8\n')
})

check('m3u 的 x-top-first 标记：解析成 topFirst，不混进台名', () => {
  const [flagged, plain] = parsePlaylistContent('#EXTM3U\n'
    + '#EXTINF:-1 x-top-first="1" group-title="国际",Thai PBS\nhttps://cdn/thai.m3u8\n'
    + '#EXTINF:-1 group-title="国际",TRT World\nhttps://cdn/trt.m3u8\n')
  assert.deepEqual(flagged, { name: 'Thai PBS', group: '国际', logo: '', url: 'https://cdn/thai.m3u8', topFirst: true })
  assert.equal(plain.topFirst, undefined)
})

check('模块接手的台：同组同名的精选频道条目收掉，用户订阅、别的组、没接手的都不动', () => {
  const groups = [
    { name: '国际', dataList: [
      { name: 'CNA', deferredRef: 'asian-live-cna', supersedesFeatured: true },
      { name: 'cna ', url: 'https://featured/cna.m3u8', builtInSubscription: true, source: 'external' },
      { name: 'CNA', url: 'https://mine/cna.m3u8', source: 'external' },
      { name: 'Reuters', url: 'https://featured/reuters.m3u8', builtInSubscription: true, source: 'external' },
    ] },
    { name: '新闻', dataList: [{ name: 'CNA', url: 'https://featured/cna.m3u8', builtInSubscription: true }] },
  ]
  const before = JSON.stringify(groups)
  const out = dropSupersededFeatured(groups)
  assert.deepEqual(out[0].dataList.map(channel => channel.url || channel.deferredRef),
    ['asian-live-cna', 'https://mine/cna.m3u8', 'https://featured/reuters.m3u8'])
  assert.equal(out[1], groups[1], '没有接手频道的组原样返回')
  assert.equal(JSON.stringify(groups), before, '不改输入')
})

console.log(`\n全部通过：${passed} ✅`)
