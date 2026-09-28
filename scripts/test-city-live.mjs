#!/usr/bin/env node
/** 广州花城+、南京牛咔 / Live 南京、青岛蓝睛城市直播回归测试。 */
import assert from 'node:assert/strict'

import { getModule, resolverFor } from '../extractors/registry.js'
import {
  buildChannels as buildGztvChannels,
  clearCache as clearGztvCache,
  normalizeRows as normalizeGztvRows,
  resolveChannel as resolveGztvChannel,
} from '../extractors/gztv/api.js'
import {
  fetchChannelGroups as fetchNjtvGroups,
  parseScenicPage,
  parseTvScript,
  SCENIC_CHANNELS,
  TV_CHANNELS,
} from '../extractors/njtv/api.js'
import { fetchChannels as fetchQtvChannels, parseStreamPage, QTV_CHANNELS } from '../extractors/qtv/api.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

const fakeJsonResponse = body => ({ ok: true, status: 200, json: async () => body })
const fakeTextResponse = body => ({ ok: true, status: 200, text: async () => body })

const gztvRows = () => [
  {
    code: '3001', name: '综合频道', httpUrl: 'https://tencentplaywebsite.gztv.com/live/zonghes.m3u8?txSecret=aaa1&txTime=bbb1',
    logo: 'https://load.gztv.com/logo/3001.jpg',
  },
  {
    code: '3002', name: '新闻频道', httpUrl: 'http://tencentplaywebsite.gztv.com/live/xinwen.m3u8?txSecret=aaa2&txTime=bbb2',
    logo: 'http://load.gztv.com/logo/3002.jpg',
  },
  {
    code: '3003', name: '4K南国都市频道', httpUrl: 'https://tencentplaywebsite.gztv.com/live/nanguodushi.m3u8?txSecret=aaa3&txTime=bbb3',
    logo: 'https://load.gztv.com/logo/3003.jpg',
  },
]

console.log('城市直播模块测试')

check('三个城市模块均已注册，只有广州短效流走延迟解析', () => {
  for (const id of ['gztv', 'njtv', 'qtv']) {
    const module = getModule(id)
    assert.ok(module, `${id} 未注册`)
    assert.equal(module.capabilities.cache, 'disk')
    assert.equal(module.refreshConfigurable, false)
    assert.deepEqual(module.configSchema, [])
  }
  assert.equal(getModule('gztv').capabilities.resolve, true)
  assert.equal(getModule('njtv').capabilities.resolve, false)
  assert.equal(getModule('qtv').capabilities.resolve, false)
  assert.equal(resolverFor('gztv-3001')?.id, 'gztv')
  assert.equal(resolverFor('gztv-3004'), null)
  assert.equal(resolverFor('gztv-3001/extra'), null)
})

check('广州：只接受代码与名称吻合的三路官方签名 HLS', () => {
  const rows = normalizeGztvRows([
    ...gztvRows(),
    { code: '3001', name: '综合频道', httpUrl: 'https://evil.example/live/a.m3u8?txSecret=1&txTime=2' },
    { code: '9999', name: '活动直播', httpUrl: 'https://tencentplaywebsite.gztv.com/live/event.m3u8?txSecret=1&txTime=2' },
    { code: '3002', name: '被复用的名称', httpUrl: 'https://tencentplaywebsite.gztv.com/live/bad.m3u8?txSecret=1&txTime=2' },
  ])
  assert.deepEqual(rows.map(row => row.name), ['广州综合', '广州新闻', '广州南国都市4K'])
  assert.ok(rows.every(row => row.url.startsWith('https://tencentplaywebsite.gztv.com/live/')))
  const channels = buildGztvChannels(rows)
  assert.deepEqual(channels.map(channel => channel.deferredRef), ['gztv-3001', 'gztv-3002', 'gztv-3003'])
  assert.ok(channels.every(channel => channel.opts?.[0] === 'network-caching=3000'))
})

await checkAsync('广州：模块抓频道后预热签名缓存，播放不会立刻重复联网', async () => {
  clearGztvCache()
  let calls = 0
  const fetchImpl = async () => {
    calls++
    return fakeJsonResponse({ code: 200, msg: '成功！', data: gztvRows() })
  }
  const module = getModule('gztv')
  const result = await module.fetch({}, { fetchImpl, now: 1720000000000 })
  assert.equal(result.groups[0].name, '广东')
  assert.equal(result.groups[0].dataList.length, 3)
  const resolved = await resolveGztvChannel('gztv-3001', {
    fetchImpl: async () => { throw new Error('一分钟缓存内不该联网') },
    now: 1720000001000,
  })
  assert.equal(calls, 1)
  assert.match(resolved.url, /zonghes\.m3u8/)
})

await checkAsync('广州：缓存到期后合并并发换签请求，错误引用不抛异常', async () => {
  clearGztvCache()
  let calls = 0
  const fetchImpl = async () => {
    calls++
    return fakeJsonResponse({ code: 200, msg: '成功！', data: gztvRows() })
  }
  const [first, second] = await Promise.all([
    resolveGztvChannel('gztv-3001', { fetchImpl, now: 1720000000000 }),
    resolveGztvChannel('gztv-3002', { fetchImpl, now: 1720000000000 }),
  ])
  assert.equal(calls, 1)
  assert.match(first.url, /zonghes/)
  assert.match(second.url, /xinwen/)
  assert.equal((await resolveGztvChannel('gztv-9999')).url, '')
})

const tvScriptFixture = () => `
  window.videosrc = '//nklive.nbs.cn/hls/d511bc9d-a694-4453-b3a2-4fc842cc97a1/index.m3u8';
  videosrc='//nklive.nbs.cn/hls/d511bc9d-a694-4453-b3a2-4fc842cc97a1/index.m3u8';
  videosrc='//nklive.nbs.cn/hls/75b3c462-b831-4de7-a34b-5d3221db2069/index.m3u8';
  videosrc='//nklive.nbs.cn/hls/1173a815-bfdb-4c3c-9f73-89ec37ae7716/index.m3u8';
  videosrc='//nklive.nbs.cn/hls/9b2005c4-046c-422f-ba45-e6adc4f4de07/index.m3u8 ';
  videosrc='https://evil.example/live/test.m3u8';
`

const scenicHtmlFixture = () => [
  ['5G Live', TV_CHANNELS[3].fallbackUrl],
  ...SCENIC_CHANNELS.map(channel => [channel.name, channel.fallbackUrl.replace(/^https:/, 'http:')]),
  ['伪造机位', 'https://evil.example/live/test.m3u8'],
].map(([name, url]) => `<div class="swiper-slide" data-url="${url}"><div></div><div style="text-align: center;">${name}</div></div>`).join('\n')

check('南京：电视脚本去掉首路重复项后按固定顺序生成四套频道', () => {
  const rows = parseTvScript(tvScriptFixture())
  assert.deepEqual(rows.map(row => row.name), TV_CHANNELS.map(channel => channel.name))
  assert.equal(new Set(rows.map(row => row.url)).size, 4)
  assert.ok(rows.every(row => row.url.startsWith('https://nklive.nbs.cn/')))
  // 台标是牛咔内容详情的 thumb 频道卡，四套各不相同
  assert.deepEqual(rows.map(row => row.logo), TV_CHANNELS.map(channel => channel.logo))
  assert.ok(rows.every(row => /^https:\/\/oss\.nbs\.cn\/M00\/[0-9A-F]{2}\/[0-9A-F]{2}\/[\w-]+\.jpg$/.test(row.logo)))
  assert.equal(new Set(rows.map(row => row.logo)).size, 4)
})

check('南京：景观页面收齐 13 路，排除 5G Live 电视重复流与非官方主机', () => {
  const rows = parseScenicPage(scenicHtmlFixture())
  assert.deepEqual(rows.map(row => row.name), SCENIC_CHANNELS.map(channel => channel.name))
  assert.equal(rows.length, 13)
  assert.equal(rows.some(row => row.name === '5G Live'), false)
  assert.equal(new Set(rows.map(row => row.url)).size, rows.length)
  assert.ok(rows.every(row => new URL(row.url).hostname.endsWith('.nbs.cn')))
})

await checkAsync('南京：官网两页独立同步并输出 4 路电视 + 13 路景观', async () => {
  const result = await fetchNjtvGroups({ fetchImpl: async url => {
    if (String(url).includes('/js/tv.js')) return fakeTextResponse(tvScriptFixture())
    return fakeTextResponse(scenicHtmlFixture())
  } })
  assert.deepEqual(result.groups.map(group => [group.name, group.dataList.length]), [
    ['南京电视台', 4],
    ['南京景观', 13],
  ])
  assert.deepEqual(result.warnings, [])
})

await checkAsync('南京：页面失败时两组各自回退已核验地址，不把频道清空', async () => {
  const result = await fetchNjtvGroups({ fetchImpl: async () => { throw new Error('官网维护') } })
  assert.deepEqual(result.groups.map(group => group.dataList.length), [4, 13])
  assert.equal(result.warnings.length, 2)
  assert.ok(result.groups.flatMap(group => group.dataList).every(channel => channel.url.startsWith('https://')))
  // 回退时电视频道仍带台标，景观机位照旧留空
  assert.deepEqual(result.groups[0].dataList.map(channel => channel.logo), TV_CHANNELS.map(channel => channel.logo))
  assert.ok(result.groups[1].dataList.every(channel => channel.logo === ''))
})

check('青岛：页面解析只接受 video10.qtv.com.cn 的 manifest.m3u8', () => {
  assert.equal(
    parseStreamPage('var playerOption={videoUrl:"http://video10.qtv.com.cn/sxt1/manifest.m3u8"}'),
    'https://video10.qtv.com.cn/sxt1/manifest.m3u8',
  )
  assert.throws(() => parseStreamPage('var playerOption={videoUrl:"https://evil.example/sxt1/manifest.m3u8"}'), /没有找到/)
})

await checkAsync('青岛：按用户指定顺序刷新五路，单页失败只回退该路', async () => {
  const result = await fetchQtvChannels({ fetchImpl: async url => {
    const definition = QTV_CHANNELS.find(channel => channel.pageUrl === String(url))
    assert.ok(definition)
    if (definition.name === '快速路大润发方向') throw new Error('页面临时维护')
    return fakeTextResponse(`var playerOption={videoUrl:"${definition.fallbackUrl.replace(/^https:/, 'http:')}"}`)
  } })
  assert.deepEqual(result.channels.map(channel => channel.name), QTV_CHANNELS.map(channel => channel.name))
  assert.equal(result.channels.length, 5)
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /快速路大润发方向/)
  assert.ok(result.channels.every(channel => channel.url.startsWith('https://video10.qtv.com.cn/')))
})

console.log(`\n全部通过：${passed} ✅`)
