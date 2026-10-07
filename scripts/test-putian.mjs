#!/usr/bin/env node
/**
 * 莆田模块离线测试：固定三路频道、频道接口解出签名地址（广播和直播间不收）、只接受本频道官方 CDN
 * 的地址与版权垫片、签名缓存到过期前半小时、人机验证拦下与取失败后短暂冷却。
 * 频道表夹具按 2026-09-30 mapi.ptbtv.com/api/v1/channel.php 的真实响应裁剪（字段、转义原样保留）。
 *
 * 运行： node scripts/test-putian.mjs
 */
import assert from 'node:assert/strict'

import putian from '../extractors/putian/index.js'
import {
  CHANNELS, CHANNEL_API, claimsRef, createResolver, officialMasterUrl, officialMediaUrl,
  parseChannelList, uptExpiry,
} from '../extractors/putian/api.js'
import { getModule, resolverFor } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

const EXPIRY = 1790787522
const master = (stream, expiry = EXPIRY, host = 'live1') => `https://${host}.ptbtv.com/${stream}/playlist.m3u8?_upt=120a1d46${expiry}`
const escaped = url => url.replaceAll('/', '\\/')
const row = (id, name, audio, stream, expiry, host) => {
  const url = escaped(master(stream, expiry, host))
  return `{"id":${id},"name":"${name}","aspect":"16:9","snap":{"host":"https:\\/\\/image.ptbtv.com\\/","filename":"20221110358fda7dbc912d00e8f4d900eebc46a5.jpg"},`
    + `"m3u8":"${url}","cur_program":{"start_time":"22:10:00","program":"\\u8386\\u7530\\u65b0\\u95fb\\u8054\\u64ad"},`
    + `"save_time":"168","audio_only":"${audio}","channel_stream":[{"url":"${url}","name":"\\u9ad8\\u6e05","stream_name":"hd","m3u8":"${url}","bitrate":"1500","stream_url":""}],"node_id":1,"origin_id":${id}}`
}
const TABLE = (expiry = EXPIRY) => '[' + [
  row(4, '\\u8386\\u7530\\u4e00\\u5957', 0, 'pttv1', expiry),
  row(5, '\\u8386\\u7530\\u4e8c\\u5957', 0, 'pttv2', expiry),
  row(6, '\\u4ed9\\u6e38\\u7535\\u89c6\\u53f0', 0, 'xytv', expiry),
  row(7, 'FM937', 1, 'aac_fm937', expiry),
  row(12, '\\u8386\\u7530TV\\u76f4\\u64ad', 0, 'ptbtv', expiry, 'live2'),
  row(11, '\\u76f4\\u64ad\\u672a\\u5f00\\u59cb', 0, 'ydpd1', expiry, 'live2'),
].join(',') + ']'
// 网宿人机验证：浏览器 UA 先 302 到 https、再给 JS 挑战页
const CHALLENGE = '<html>\n<head><script src="/_fec_sbu/fec_wrapper.js"></script>\n<title>302 Found</title></head>\n</html>'

const news = CHANNELS[0]

console.log('莆田模块测试')

check('模块注册为免账号、归入福建的清单中继模块，带官方节目单', () => {
  assert.equal(getModule('putian'), putian)
  assert.equal(putian.name, '莆田')
  assert.equal(putian.outputGroupName, '福建')
  assert.equal(putian.channelHlsMode, 'relay')
  assert.equal(putian.relayProxyCompatible, true)
  assert.equal(putian.capabilities.resolve, true)
  assert.equal(putian.capabilities.epg, true)
  assert.equal(putian.capabilities.catchup, false)
  assert.equal(putian.catalogVersion, 1)
  assert.deepEqual(putian.configSchema, [])
  assert.equal(typeof putian.clearResolveCache, 'function')
  assert.equal(resolverFor(news.ref), putian)
  assert.equal(resolverFor(`${news.ref}/extra`), null)
})

await checkAsync('三路固定频道走延迟解析；台标留给内置库（图床挡浏览器 UA）', async () => {
  const { groups } = await putian.fetch()
  assert.equal(groups.length, 1)
  assert.equal(groups[0].name, '福建')
  assert.deepEqual(groups[0].dataList.map(item => item.name), ['莆田新闻综合', '莆田文旅生活', '仙游电视台'])
  assert.deepEqual(groups[0].dataList.map(item => item.deferredRef), CHANNELS.map(channel => channel.ref))
  assert.ok(groups[0].dataList.every(item => item.catchup === 'none' && !item.url && !item.logo))
  assert.equal(claimsRef(news.ref), true)
  assert.equal(claimsRef('wuxi-news'), false)
})

check('频道表解出三路电视的签名主清单，广播、直播间、占位不收', () => {
  const urls = parseChannelList(JSON.parse(TABLE()))
  assert.deepEqual([...urls.keys()], ['pttv1', 'pttv2', 'xytv'])
  assert.equal(urls.get('pttv1'), master('pttv1'))
  // 顶层 m3u8 缺了，用 channel_stream 里的
  const noTop = JSON.parse(TABLE()).map(item => item.id === 6 ? { ...item, m3u8: '' } : item)
  assert.equal(parseChannelList(noTop).get('xytv'), master('xytv'))
  // 某一路地址不合格只丢这一路
  const oneBad = JSON.parse(TABLE().replaceAll('\\/pttv2\\/', '\\/pttv9\\/'))
  assert.deepEqual([...parseChannelList(oneBad).keys()], ['pttv1', 'xytv'])
  assert.throws(() => parseChannelList({ ErrorCode: '1', ErrorText: 'x' }), /结构不符合预期/)
  assert.throws(() => parseChannelList([]), /没有可用的电视直播地址/)
})

check('只接受本频道官方 CDN 上带 _upt 签名的地址；版权垫片放行', () => {
  assert.equal(officialMasterUrl(master('pttv1'), news), master('pttv1'))
  assert.equal(uptExpiry(new URL(master('pttv1'))), EXPIRY * 1000)
  assert.equal(officialMasterUrl(master('pttv1', EXPIRY, 'live3'), news), master('pttv1', EXPIRY, 'live3'))
  assert.throws(() => officialMasterUrl(master('pttv2'), news), /不在该频道/)
  assert.throws(() => officialMasterUrl(master('pttv1').replace('live1.ptbtv.com', 'evil.example'), news), /不在该频道/)
  assert.throws(() => officialMasterUrl(master('pttv1').replace('https:', 'http:'), news), /不在该频道/)
  assert.throws(() => officialMasterUrl(master('pttv1').split('?')[0], news), /缺少官方签名/)
  assert.throws(() => officialMasterUrl(master('pttv1').replace('120a1d46', 'nothex00'), news), /缺少官方签名/)
  const variant = 'https://live1.ptbtv.com/pttv1/hd/live.m3u8?_upt=f5721d401790785161'
  const segment = 'https://live1.ptbtv.com/pttv1_hd/1790776826/1790777949967.ts?_upt=2d7900be1790785149'
  const slate = 'https://live1.ptbtv.com/forbid/1143db55/pttv2_hd_1.ts?_upt=de2450481790785126'
  assert.equal(officialMediaUrl(variant, news), variant)
  assert.equal(officialMediaUrl(segment, news), segment)
  assert.equal(officialMediaUrl(slate, CHANNELS[1]), slate)
  assert.throws(() => officialMediaUrl(segment.replace('pttv1_hd', 'pttv2_hd'), news))
  assert.throws(() => officialMediaUrl(segment.replace('live1.ptbtv.com', 'evil.example'), news))
  assert.throws(() => officialMediaUrl(segment.split('?')[0], news))
})

await checkAsync('签名地址缓存到过期前半小时，三路共用一次频道表请求，用非浏览器 UA、不跟跳转', async () => {
  let clock = (EXPIRY - 2 * 60 * 60) * 1000
  let expiry = EXPIRY
  let calls = 0
  const fetchImpl = async (url, init) => {
    assert.equal(url, CHANNEL_API)
    assert.equal(init.redirect, 'manual')
    assert.doesNotMatch(init.headers['User-Agent'], /Mozilla/)
    calls++
    return new Response(TABLE(expiry))
  }
  const resolver = createResolver({ fetchImpl, now: () => clock })
  const first = await resolver.resolve(news.ref)
  assert.equal(first.url, master('pttv1'))
  assert.equal(first.relayHls, true)
  assert.equal(first.upstreamHeaders, undefined)
  const variant = 'https://live1.ptbtv.com/pttv1/hd/live.m3u8?_upt=f5721d401790785161'
  assert.equal(first.upstreamUrlTransform(variant), variant)
  assert.throws(() => first.upstreamUrlTransform('https://evil.example/pttv1_hd/1.ts?_upt=x'))
  assert.equal((await resolver.resolve('putian-xianyou')).url, master('xytv'))
  clock = (EXPIRY - 31 * 60) * 1000
  await resolver.resolve(news.ref)
  assert.equal(calls, 1)
  // 进入过期前半小时：重取，拿到新签名
  clock = (EXPIRY - 29 * 60) * 1000
  expiry = EXPIRY + 10000
  assert.equal((await resolver.resolve(news.ref)).url, master('pttv1', EXPIRY + 10000))
  assert.equal(calls, 2)
  // 同时来的请求只打一次上游
  resolver.clearCache()
  await Promise.all(CHANNELS.map(channel => resolver.resolve(channel.ref)))
  assert.equal(calls, 3)
})

await checkAsync('人机验证与上游失败只返回说明，冷却期内不重复打上游，非法引用不抛错', async () => {
  let clock = 1_000_000
  let calls = 0
  let reply = () => new Response(CHALLENGE, { status: 302 })
  const resolver = createResolver({
    fetchImpl: async () => { calls++; return reply() },
    now: () => clock,
  })
  const malformed = await resolver.resolve('other')
  assert.equal(malformed.url, '')
  assert.match(malformed.desc, /引用格式错误/)
  const failed = await resolver.resolve(news.ref)
  assert.equal(failed.url, '')
  assert.match(failed.desc, /莆田新闻综合 取流失败：上游 HTTP 302/)
  clock += 10 * 1000
  assert.match((await resolver.resolve(news.ref)).desc, /HTTP 302/)
  assert.equal(calls, 1)
  // 回 200 却是挑战页
  clock += 11 * 1000
  reply = () => new Response(CHALLENGE)
  assert.match((await resolver.resolve(news.ref)).desc, /不是有效 JSON/)
  assert.equal(calls, 2)
  clock += 21 * 1000
  reply = () => new Response(TABLE())
  assert.equal((await resolver.resolve(news.ref)).url, master('pttv1'))
  assert.equal(calls, 3)
  // 频道表里缺了某一路
  const partial = createResolver({
    fetchImpl: async () => new Response(JSON.stringify(JSON.parse(TABLE()).filter(item => item.id !== 5))),
    now: () => clock,
  })
  assert.match((await partial.resolve('putian-culture')).desc, /没有给出这路频道/)
  assert.equal((await partial.resolve(news.ref)).url, master('pttv1'))
})

console.log(`\n全部通过：${passed} ✅`)
