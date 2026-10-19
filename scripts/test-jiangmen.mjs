import test from 'node:test'
import assert from 'node:assert/strict'
import jiangmen from '../extractors/jiangmen/index.js'
import { createResolver, claimsRef } from '../extractors/jiangmen/api.js'
import { resolverFor } from '../extractors/registry.js'
import { CHANNEL, ORIGIN, INFO_PATH, HEADERS, dailyKey, infoUrl, selectChannel, manifestUrl, segmentUrl,
  parseManifest, createCache, readOfficial } from '../extractors/jiangmen/protocol.js'

const now = Date.parse('2026-10-18T12:00:00Z')
const channel = { i: '4x3T0dO', n: '江门综合频道', t: '1', l: ORIGIN, r: [{ n: 993, t: 'HD' }] }
const info = { channels: [channel, { ...channel, i: 'BRXH74E', n: '江门综合送触电' }, { i: 'kenj3I1', n: 'FM93.3', t: '2' }], play: { dl: 1 } }
const manifest = `${ORIGIN}/lsdream/4x3T0dO/993/253cj00.m3u8`
const segment = '1792252800000/74277138D10.ts'
const m3u8 = `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:7393184\n#EXTINF:10,\n${segment}\n`
const row = { liveid: '4x3T0dO', name: '一代匠师 34', start_time: '2026-10-18 07:32:00', end_time: '2026-10-18 08:30:00' }

test('日切路径与官网原始播放器的两个日期样本一致，按上海零点切换', () => {
  assert.equal(dailyKey(CHANNEL.upstreamId, now), '253cj00')
  assert.equal(dailyKey(CHANNEL.upstreamId, Date.parse('2026-10-18T15:59:59Z')), '253cj00')
  assert.equal(dailyKey(CHANNEL.upstreamId, Date.parse('2026-10-18T16:00:00Z')), 'k63exsT')
  assert.equal(manifestUrl(selectChannel(info), now), manifest)
})

test('官方目录请求使用公开时间签名和官网来源头', async () => {
  const url = new URL(infoUrl(1792325075180))
  assert.equal(url.pathname, INFO_PATH)
  assert.equal(url.searchParams.get('token'), '44e1750580432017c24aa12ceee47f4c')
  assert.equal(parseInt(url.searchParams.get('t'), 16), 1792325075180)
  const result = await readOfficial(url, { fetchImpl: async (input, options) => {
    assert.equal(options.headers.Referer, HEADERS.Referer)
    assert.equal(options.headers.Origin, 'http://www.jmtv.cn')
    assert.equal(options.redirect, 'manual')
    return new Response('official data')
  } })
  assert.equal(result.toString(), 'official data')
})

test('只接官网正式电视 ID，内部送流、广播或未知媒体配置不能替代', () => {
  assert.deepEqual(selectChannel(info), { rate: 993, daily: true })
  for (const bad of [{ ...info, channels: info.channels.slice(1) }, { ...info, channels: [channel, channel] },
    { ...info, play: { dl: 9 } }, { ...info, channels: [{ ...channel, l: 'http://127.0.0.1' }] },
    { ...info, channels: [{ ...channel, r: [{ n: 800 }] }] }]) assert.throws(() => selectChannel(bad))
})

test('代理只接收当前江门频道 TS 路径，拒绝外域、跨频道、回放和外部 URI', () => {
  assert.equal(segmentUrl(segment, manifest), `${ORIGIN}/lsdream/4x3T0dO/993/${segment}`)
  assert.equal(parseManifest(m3u8, manifest), m3u8)
  for (const bad of ['http://localhost/private.ts', `${ORIGIN}/lsdream/kenj3I1/993/${segment}`, segment+'?url=http://localhost', '../'+segment, segment+'#extra']) assert.throws(() => segmentUrl(bad, manifest))
  for (const bad of [m3u8+'#EXT-X-ENDLIST', m3u8+'#EXT-X-KEY:METHOD=AES-128', m3u8+'#EXT-X-SESSION-KEY:URI="http://evil.example/key"', m3u8.replace(segment, 'http://evil.example/a.ts')]) assert.throws(() => parseManifest(bad, manifest))
})

test('缓存并发合并，过期、跨日和失败后均重新获取', async () => {
  let clock = Date.parse('2026-10-18T15:59:30Z'), calls = 0, fail = false
  const cached = createCache(async () => { calls++; if (fail) throw new Error('upstream'); return { calls } }, { now: () => clock, ttl: 60000 })
  const [a, b] = await Promise.all([cached(), cached()])
  assert.equal(a, b); assert.equal(calls, 1)
  clock += 30000; assert.notEqual(await cached(), a); assert.equal(calls, 2)
  clock += 60000; fail = true; await assert.rejects(cached(), /upstream/)
  fail = false; assert.equal((await cached()).calls, 4)
})

test('官方错误、重定向或过大响应不会当成可播媒体', async () => {
  for (const status of [302, 403, 500]) await assert.rejects(readOfficial(ORIGIN, { fetchImpl: async () => new Response('', { status }) }))
  await assert.rejects(readOfficial(ORIGIN, { maxBytes: 1, fetchImpl: async () => new Response('too big') }), /大小限制/)
})

test('主项目只输出广东一套正式电视，配官方台标、稳定 ref 与禁用回看', async () => {
  const result = await jiangmen.fetch({}, { fetchImpl: async () => Response.json(info) })
  assert.equal(result.groups[0].name, '广东')
  assert.equal(result.groups[0].dataList.length, 1)
  assert.equal(result.groups[0].dataList[0].name, '江门综合')
  assert.equal(result.groups[0].dataList[0].logo, 'http://www.jmtv.cn/images/pc/ic_logo.png')
  assert.equal(result.groups[0].dataList[0].deferredRef, 'jiangmen-1')
  assert.equal(result.groups[0].dataList[0].catchup, 'none')
  assert.equal(jiangmen.channelHlsMode, 'proxy')
  assert.equal(jiangmen.defaultEnabled ?? true, true)
  assert.equal(resolverFor('jiangmen-1'), jiangmen)
  assert.equal(claimsRef('jiangmen-BRXH74E'), false)
  await assert.rejects(jiangmen.fetch({}, { fetchImpl: async () => Response.json({ channels: info.channels.slice(1) }) }))
})

test('播放重新获取清单、代理头和分片校验，跨上海零点自动换路径', async () => {
  let clock = Date.parse('2026-10-18T15:59:59Z'), catalogCalls = 0
  const seen = []
  const resolver = createResolver({ now: () => clock, fetchImpl: async url => {
    seen.push(String(url))
    if (new URL(url).pathname === INFO_PATH) { catalogCalls++; return Response.json(info) }
    return new Response(m3u8)
  } })
  const first = await resolver.resolveChannel('jiangmen-1')
  assert.equal(first.url, manifest)
  assert.equal(first.upstreamHeaders.Referer, HEADERS.Referer)
  assert.equal(first.manifestText, m3u8)
  assert.equal(first.upstreamUrlTransform(new URL(segment, manifest).href), new URL(segment, manifest).href)
  assert.throws(() => first.upstreamUrlTransform('http://localhost/private'))
  await resolver.resolveChannel('jiangmen-1')
  assert.equal(catalogCalls, 1, '只缓存目录，不缓存滚动清单')
  clock += 1000
  const next = await resolver.resolveChannel('jiangmen-1')
  assert.equal(next.url, manifest.replace('253cj00', 'k63exsT'))
  assert.equal(catalogCalls, 2)
  assert.equal(seen.filter(url => url.endsWith('.m3u8')).length, 3)
})

test('解析异常按模块契约返回失败，不回退旧流、送流口或第三方地址', async () => {
  const resolver = createResolver({ fetchImpl: async () => new Response('', { status: 403 }) })
  assert.equal((await resolver.resolveChannel('jiangmen-1')).url, '')
  assert.equal((await resolver.resolveChannel('jiangmen-2')).url, '')
  const bad = createResolver({ fetchImpl: async url => new URL(url).pathname === INFO_PATH
    ? Response.json(info) : new Response(m3u8.replace(segment, 'http://evil.example/a.ts')) })
  assert.equal((await bad.resolveChannel('jiangmen-1')).url, '')
})
