#!/usr/bin/env node
/**
 * 无锡模块离线测试：固定五路频道与官方台标、两种分享页渲染格式都能解出签名地址、
 * 只接受本频道官方 CDN 的地址、签名缓存到过期前半小时、取失败后短暂冷却。
 * 分享页夹具按 2026-09-29 两台源站的真实响应裁剪（字段、转义、空白原样保留）。
 *
 * 运行： node scripts/test-wuxi.mjs
 */
import assert from 'node:assert/strict'

import wuxi from '../extractors/wuxi/index.js'
import {
  CHANNELS, SHARE_PAGE, authExpiry, claimsRef, createResolver, officialMasterUrl,
  officialMediaUrl, parseSharePage,
} from '../extractors/wuxi/api.js'
import { getModule, resolverFor } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

const EXPIRY = 1790689857
const HASH = '52dd250e8046899663c83a4401a916ff'
const master = (stream, expiry = EXPIRY) =>
  `http:\\/\\/bb-live.wifiwx.com\\/${stream}\\/playlist.m3u8?auth_key=${expiry}-0-0-${HASH}`
const row = (id, name, audio, stream, expiry) => `{"id":${id},"name":"${name}","audio_only":${audio},`
  + `"m3u8":"${master(stream, expiry)}","cur_program":{"start_time":"21:27:58","program":"\\u9521\\u4f01"},`
  + `"page_url":"https:\\/\\/bb-share.wifiwx.com\\/wxbb\\/morenlanmu\\/c\\/${id}.html"}`
const TABLE = (expiry = EXPIRY) => '[' + [
  row(7, '\\u65b0\\u95fb\\u5e7f\\u64ad', 1, 'aac_937', expiry),
  row(4, '\\u65b0\\u95fb\\u7efc\\u5408\\u9891\\u9053', 0, 'wxtv1', expiry),
  row(9, '\\u90fd\\u5e02\\u8d44\\u8baf\\u9891\\u9053', 0, 'wxtv3', expiry),
  row(8, '\\u5a31\\u4e50\\u9891\\u9053', 0, 'wxtv2', expiry),
  row(11, '\\u7ecf\\u6d4e\\u9891\\u9053', 0, 'wxtv5', expiry),
  row(10, '\\u751f\\u6d3b\\u9891\\u9053', 0, 'wxtv4', expiry),
].join(',') + ']'
// 两台源站的两种写法：紧凑的，以及带缩进、换行的
const COMPACT = (expiry) => `<title>直播_无锡博报</title>\n<script>window['LIVE_CHANNELS' ] =${TABLE(expiry)};</script>\n`
  + `<script>window['PROGRAM_TV' ] =[{"id":16}];</script>\n`
const INDENTED = (expiry) => `<body>\n  <script>\n    window[ 'LIVE_CHANNELS' ] = ${TABLE(expiry)};\n</script>\n`
  + `  <script>\n    window[ 'PROGRAM_TV' ] = [{"id":16}];\n</script>\n`

const news = CHANNELS[0]
const https = (stream, expiry = EXPIRY) => `https://bb-live.wifiwx.com/${stream}/playlist.m3u8?auth_key=${expiry}-0-0-${HASH}`

console.log('无锡模块测试')

check('模块注册为免账号、归入江苏的清单中继模块，带官方节目单', () => {
  assert.equal(getModule('wuxi'), wuxi)
  assert.equal(wuxi.name, '无锡')
  assert.equal(wuxi.outputGroupName, '江苏')
  assert.equal(wuxi.channelHlsMode, 'relay')
  assert.equal(wuxi.relayProxyCompatible, true)
  assert.equal(wuxi.capabilities.resolve, true)
  assert.equal(wuxi.capabilities.epg, true)
  assert.equal(wuxi.capabilities.catchup, false)
  assert.equal(wuxi.catalogVersion, 1)
  assert.deepEqual(wuxi.configSchema, [])
  assert.equal(typeof wuxi.clearResolveCache, 'function')
  assert.equal(resolverFor(news.ref), wuxi)
  assert.equal(resolverFor(`${news.ref}/extra`), null)
})

await checkAsync('五路固定频道走延迟解析，带官方频道图', async () => {
  const { groups } = await wuxi.fetch()
  assert.equal(groups.length, 1)
  assert.equal(groups[0].name, '江苏')
  assert.deepEqual(groups[0].dataList.map(item => item.name), ['无锡新闻综合', '无锡娱乐', '无锡都市资讯', '无锡生活', '无锡经济'])
  assert.deepEqual(groups[0].dataList.map(item => item.deferredRef), CHANNELS.map(channel => channel.ref))
  assert.ok(groups[0].dataList.every(item => item.catchup === 'none' && !item.url))
  assert.ok(groups[0].dataList.every(item => /^https:\/\/bb-img\.wifiwx\.com\/2022080[0-9a-f]+\.png$/.test(item.logo)))
  assert.equal(claimsRef(news.ref), true)
  assert.equal(claimsRef('jiaxing-news'), false)
})

check('两种分享页写法都能解出五路电视的签名主清单，统一成 https，广播不收', () => {
  for (const html of [COMPACT(EXPIRY), INDENTED(EXPIRY)]) {
    const urls = parseSharePage(html)
    assert.deepEqual([...urls.keys()].sort(), ['wxtv1', 'wxtv2', 'wxtv3', 'wxtv4', 'wxtv5'])
    assert.equal(urls.get('wxtv1'), https('wxtv1'))
  }
  assert.throws(() => parseSharePage('<html>云防护</html>'), /没有频道表/)
  assert.throws(() => parseSharePage("<script>window['LIVE_CHANNELS'] = [{];</script>"), /不是有效 JSON/)
  assert.throws(() => parseSharePage("<script>window['LIVE_CHANNELS'] = [];</script>"), /没有可用的电视直播地址/)
  // 某一路地址不合格只丢这一路
  const oneBad = COMPACT(EXPIRY).replace('wxtv3\\/playlist.m3u8', 'wxtv9\\/playlist.m3u8')
  assert.deepEqual([...parseSharePage(oneBad).keys()].sort(), ['wxtv1', 'wxtv2', 'wxtv4', 'wxtv5'])
})

check('只接受本频道官方 CDN 上带 A 型签名的地址', () => {
  assert.equal(officialMasterUrl(https('wxtv1'), news), https('wxtv1'))
  assert.equal(authExpiry(new URL(https('wxtv1'))), EXPIRY * 1000)
  assert.throws(() => officialMasterUrl(https('wxtv2'), news), /不在该频道/)
  assert.throws(() => officialMasterUrl(https('wxtv1').replace('bb-live.wifiwx.com', 'evil.example'), news), /不在该频道/)
  assert.throws(() => officialMasterUrl(https('wxtv1').split('?')[0], news), /缺少官方签名/)
  assert.throws(() => officialMasterUrl(https('wxtv1').replace(HASH, 'nothex'), news), /缺少官方签名/)
  const variant = `https://bb-live.wifiwx.com/wxtv1/hd/live.m3u8?auth_key=1790689874-0-0-${HASH}`
  const segment = `https://bb-live.wifiwx.com/wxtv1_hd/1790681862/1790682664508.ts?auth_key=1790689864-0-0-${HASH}`
  assert.equal(officialMediaUrl(variant, news), variant)
  assert.equal(officialMediaUrl(segment, news), segment)
  assert.throws(() => officialMediaUrl(segment.replace('wxtv1_hd', 'wxtv2_hd'), news))
  assert.throws(() => officialMediaUrl(segment.replace('bb-live.wifiwx.com', 'evil.example'), news))
  assert.throws(() => officialMediaUrl(segment.split('?')[0], news))
})

await checkAsync('签名地址缓存到过期前半小时，五路共用一次分享页请求', async () => {
  let clock = (EXPIRY - 2 * 60 * 60) * 1000
  let expiry = EXPIRY
  let pageCalls = 0
  const fetchImpl = async url => {
    assert.equal(url, SHARE_PAGE)
    pageCalls++
    return new Response(pageCalls % 2 ? COMPACT(expiry) : INDENTED(expiry))
  }
  const resolver = createResolver({ fetchImpl, now: () => clock })
  const first = await resolver.resolve(news.ref)
  assert.equal(first.url, https('wxtv1'))
  assert.equal(first.relayHls, true)
  assert.equal(first.upstreamHeaders, undefined)
  assert.equal(first.upstreamUrlTransform(`https://bb-live.wifiwx.com/wxtv1/hd/live.m3u8?auth_key=1-0-0-${HASH}`),
    `https://bb-live.wifiwx.com/wxtv1/hd/live.m3u8?auth_key=1-0-0-${HASH}`)
  assert.throws(() => first.upstreamUrlTransform('https://evil.example/wxtv1_hd/1.ts?auth_key=x'))
  assert.equal((await resolver.resolve('wuxi-economy')).url, https('wxtv5'))
  clock = (EXPIRY - 31 * 60) * 1000
  await resolver.resolve(news.ref)
  assert.equal(pageCalls, 1)
  // 进入过期前半小时：重取，拿到新签名
  clock = (EXPIRY - 29 * 60) * 1000
  expiry = EXPIRY + 7200
  assert.equal((await resolver.resolve(news.ref)).url, https('wxtv1', EXPIRY + 7200))
  assert.equal(pageCalls, 2)
  // 同时来的请求只打一次上游
  resolver.clearCache()
  await Promise.all(CHANNELS.map(channel => resolver.resolve(channel.ref)))
  assert.equal(pageCalls, 3)
})

await checkAsync('上游失败只返回说明，冷却期内不重复打上游，非法引用不抛错', async () => {
  let clock = 1_000_000
  let calls = 0
  let status = 403
  const resolver = createResolver({
    fetchImpl: async () => { calls++; return new Response(status === 200 ? COMPACT(EXPIRY) : 'blocked', { status }) },
    now: () => clock,
  })
  const malformed = await resolver.resolve('other')
  assert.equal(malformed.url, '')
  assert.match(malformed.desc, /引用格式错误/)
  const failed = await resolver.resolve(news.ref)
  assert.equal(failed.url, '')
  assert.match(failed.desc, /无锡新闻综合 取流失败：上游 HTTP 403/)
  clock += 10 * 1000
  assert.match((await resolver.resolve(news.ref)).desc, /HTTP 403/)
  assert.equal(calls, 1)
  clock += 11 * 1000
  status = 200
  assert.equal((await resolver.resolve(news.ref)).url, https('wxtv1'))
  assert.equal(calls, 2)
  // 分享页里缺了某一路
  const partial = createResolver({
    fetchImpl: async () => new Response(COMPACT(EXPIRY).replace('"m3u8":"http:\\/\\/bb-live.wifiwx.com\\/wxtv4', '"m3u8x":"')),
    now: () => clock,
  })
  assert.match((await partial.resolve('wuxi-life')).desc, /没有给出这路频道/)
  assert.equal((await partial.resolve(news.ref)).url, https('wxtv1'))
})

console.log(`\n全部通过：${passed} ✅`)
