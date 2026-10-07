#!/usr/bin/env node
/**
 * 宁德模块离线测试：两路固定频道与官方台标、详情接口解出官方 HLS（只认电视、只认官方 CDN）、
 * 请求与分享页一致、某一路失败只记警告、全部失败抛错（沿用上一轮结果）。
 * 详情夹具按 2026-09-30 app.0593tv.cn/jhxtapi/jhxt/Live/detail 的真实响应裁剪（字段、转义原样保留）。
 *
 * 运行： node scripts/test-ningde.mjs
 */
import assert from 'node:assert/strict'

import ningde from '../extractors/ningde/index.js'
import { CHANNELS, DETAIL_API, fetchChannels, officialStreamUrl, parseDetail } from '../extractors/ningde/api.js'
import { getModule } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

const STREAMS = { 19: 'aedcnbnyl2jd', 20: 'd1znvar7tabf', 21: 'cyy3umnwlhna' }
const TITLES = { 19: '\\u65b0\\u95fb\\u7efc\\u5408\\u9891\\u9053', 20: '\\u6587\\u5316\\u65c5\\u6e38\\u9891\\u9053', 21: 'FM101.7\\u5b81\\u5fb7\\u7efc\\u5408\\u5e7f\\u64ad' }
const detail = (id, { typeId = id === 21 ? 4 : 3, stream = STREAMS[id] } = {}) => `{"code":200,"message":"","data":{"id":${id},"typeId":${typeId},`
  + `"sourceId":0,"title":"${TITLES[id]}","link":"https:\\/\\/live.0593tv.cn\\/live\\/${stream}.m3u8","videoLink":"",`
  + `"thumb":"https:\\/\\/app.0593tv.cn\\/files\\/jhxt\\/image\\/20251027\\/13ad1c04e01f9f254ff66ce2e6d42b2f.jpg","type":2,`
  + `"status":1,"siteid":1,"htmllink":"https:\\/\\/app.0593tv.cn\\/jhxtapi\\/jhxt\\/Live\\/newsShow\\/id\\/${id}",`
  + `"type_info":{"id":${typeId},"name":"\\u7535\\u89c6"},"time_now":1790777404,"is_praised":-1}}`
const hls = id => `https://live.0593tv.cn/live/${STREAMS[id]}.m3u8`
const lidOf = init => Number(new URLSearchParams(init.body).get('lid'))

console.log('宁德模块测试')

check('模块注册为免账号、归入福建的直链模块，没有节目单', () => {
  assert.equal(getModule('ningde'), ningde)
  assert.equal(ningde.name, '宁德')
  assert.equal(ningde.outputGroupName, '福建')
  assert.equal(ningde.capabilities.resolve, false)
  assert.equal(ningde.capabilities.epg, false)
  assert.equal(ningde.capabilities.catchup, false)
  assert.equal(ningde.epg, undefined)
  assert.equal(ningde.catalogVersion, 1)
  assert.deepEqual(ningde.configSchema, [])
  assert.deepEqual(CHANNELS.map(channel => [channel.id, channel.name]), [[19, '宁德新闻综合'], [20, '宁德文化旅游']])
  assert.ok(CHANNELS.every(channel => /^https:\/\/app\.0593tv\.cn\/files\/jhxt\/image\/20251027\/[0-9a-f]{32}\.jpg$/.test(channel.logo)))
})

check('详情解出官方 HLS；接口拒绝、频道对不上、广播都抛错', () => {
  assert.equal(parseDetail(JSON.parse(detail(19)), CHANNELS[0]), hls(19))
  assert.equal(parseDetail(JSON.parse(detail(20)), CHANNELS[1]), hls(20))
  assert.throws(() => parseDetail(JSON.parse(detail(20)), CHANNELS[0]), /频道与请求不一致/)
  assert.throws(() => parseDetail(JSON.parse(detail(19, { typeId: 4 })), CHANNELS[0]), /不是电视频道/)
  assert.throws(() => parseDetail({ code: 404, message: '直播不存在', data: [] }, CHANNELS[0]), /接口拒绝：直播不存在/)
  assert.throws(() => parseDetail([], CHANNELS[0]), /结构不符合预期/)
})

check('只接受官方 CDN 上不带参数的 /live/<流名>.m3u8，统一成 https', () => {
  assert.equal(officialStreamUrl(hls(19)), hls(19))
  assert.equal(officialStreamUrl(hls(19).replace('https:', 'http:')), hls(19))
  assert.throws(() => officialStreamUrl(hls(19).replace('live.0593tv.cn', 'evil.example')), /不在官方 CDN/)
  assert.throws(() => officialStreamUrl(`${hls(19)}?hls_ctx=25t90158`), /不在官方 CDN/)
  assert.throws(() => officialStreamUrl('https://live.0593tv.cn/vod/aedcnbnyl2jd.m3u8'), /不在官方 CDN/)
  assert.throws(() => officialStreamUrl('https://live.0593tv.cn/live/aedcnbnyl2jd.flv'), /不在官方 CDN/)
  assert.throws(() => officialStreamUrl(''), /地址无效/)
})

await checkAsync('逐路 POST 详情接口（与分享页同款表单），两路直链带官方台标', async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    assert.equal(url, DETAIL_API)
    assert.equal(init.method, 'POST')
    assert.equal(init.redirect, 'manual')
    assert.match(init.headers['Content-Type'], /^application\/x-www-form-urlencoded/)
    const form = new URLSearchParams(init.body)
    assert.deepEqual([...form.keys()], ['uid', 'device', 'nid', 'lid', 'siteid'])
    assert.equal(form.get('siteid'), '1')
    assert.equal(init.headers.Referer, `https://app.0593tv.cn/jhxtapi/jhxt/Live/newsShow/id/${lidOf(init)}`)
    seen.push(lidOf(init))
    return new Response(detail(lidOf(init)))
  }
  const { groups, meta } = await ningde.fetch({}, { fetchImpl, timeoutMs: 5000 })
  assert.deepEqual(seen, [19, 20])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].name, '福建')
  assert.deepEqual(groups[0].dataList, CHANNELS.map(channel => ({
    name: channel.name, url: hls(channel.id), logo: channel.logo, opts: ['network-caching=3000'], catchup: 'none',
  })))
  assert.deepEqual(meta.warnings, [])
})

await checkAsync('某一路失败只记警告，其余照常；全部失败抛错', async () => {
  const partial = await fetchChannels({
    fetchImpl: async (_url, init) => lidOf(init) === 20
      ? new Response('<html>502 Bad Gateway</html>', { status: 502 })
      : new Response(detail(19)),
  })
  assert.deepEqual(partial.channels.map(channel => channel.name), ['宁德新闻综合'])
  assert.deepEqual(partial.warnings, ['宁德文化旅游取流失败：HTTP 502'])

  const renamed = await fetchChannels({
    fetchImpl: async (_url, init) => new Response(detail(lidOf(init), { stream: 'x/../../evil' })),
  }).catch(error => error)
  assert.match(renamed.message, /本轮全部失败：宁德新闻综合取流失败：宁德直播地址不在官方 CDN；宁德文化旅游/)

  await assert.rejects(
    fetchChannels({ fetchImpl: async () => new Response('<html>维护中</html>') }),
    /本轮全部失败：宁德新闻综合取流失败：返回的不是 JSON/,
  )
})

console.log(`\n全部通过：${passed} ✅`)
