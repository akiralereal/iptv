#!/usr/bin/env node
/**
 * 杭州模块离线测试：固定五路频道与官方台标、只取 hd 媒体清单、只接受本频道官方 CDN 上的清单与分片、
 * 签名缓存到过期前半小时、清单被拒时重签一次、全代理带官方来源头。夹具按 2026-10-06 的真实响应裁剪。
 *
 * 运行： node scripts/test-hangzhou.mjs
 */
import assert from 'node:assert/strict'

import hangzhou from '../extractors/hangzhou/index.js'
import {
  CHANNELS, CHANNEL_API, REFERER, authExpiry, claimsRef, createResolver, officialMediaUrl,
  officialPlaylistUrl, parseChannelDetail, validatePlaylist,
} from '../extractors/hangzhou/api.js'
import { getModule, resolverFor } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

const NOW = 1791280767000
const EXPIRES = 1791287967          // 签发后 2 小时
const channel = CHANNELS[0]          // 杭州综合 id 16 / hztv1
const sign = (exp, tag = 'a') => `${exp}-0-0-${tag.repeat(32).slice(0, 32)}`
const hdUrl = (exp = EXPIRES, tag = 'a', host = 'live.hoolo.tv') => `https://${host}/hztv1/hd/live.m3u8?auth_key=${sign(exp, tag)}`
const segment = n => `/hztv1_hd/1791279571/${n}.ts?auth_key=${sign(EXPIRES - 8, 'c')}`
const playlist = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-MEDIA-SEQUENCE:8243688\n#EXT-X-TARGETDURATION:6\n#EXTINF:4.347,\n${segment('1791280759775')}\n#EXTINF:4.837,\n${segment('1791280764108')}\n`
const detail = (exp = EXPIRES, tag = 'a', extra = {}) => [{
  id: 16, name: '杭州综合', code: 'hztv1', is_stopped: 0, time_shift_time: '168',
  logo: { square: { host: 'https://image.hoolo.tv/', filename: '2020081440758eac386ac9bb46ca2a07b16e5582.png' } },
  channel_stream: [
    { name: '标清', stream_name: 'sd', m3u8: `http://live.hoolo.tv/hztv1/sd/live.m3u8?auth_key=${sign(exp, 'b')}`, bitrate: '1500' },
    { name: '高清', stream_name: 'hd', m3u8: hdUrl(exp, tag).replace('https:', 'http:'), bitrate: '1500' },
  ],
  m3u8: `http://live.hoolo.tv/hztv1/playlist.m3u8?auth_key=${sign(exp, 'd')}`,
  cur_program: { program: '精彩节目' },
  ...extra,
}]

console.log('杭州模块测试')

check('模块注册为免账号、归入浙江的全代理模块', () => {
  assert.equal(getModule('hangzhou'), hangzhou)
  assert.equal(hangzhou.name, '杭州')
  assert.equal(hangzhou.outputGroupName, '浙江')
  assert.equal(hangzhou.channelHlsMode, 'proxy', 'CDN 按 Referer 放行，分片也得带来源头')
  assert.equal(hangzhou.capabilities.resolve, true)
  assert.equal(hangzhou.capabilities.epg, false)
  assert.equal(hangzhou.capabilities.catchup, false)
  assert.equal(hangzhou.catalogVersion, 1)
  assert.deepEqual(hangzhou.configSchema, [])
  assert.equal(resolverFor(channel.ref), hangzhou)
  assert.equal(resolverFor(`${channel.ref}/extra`), null)
})

await checkAsync('五路固定频道走延迟解析，台标是官方频道图，按 HTV1–5 排', async () => {
  const { groups } = await hangzhou.fetch()
  assert.equal(groups.length, 1)
  assert.equal(groups[0].name, '浙江')
  assert.deepEqual(groups[0].dataList.map(row => row.name), ['杭州综合', '西湖明珠', '杭州生活', '杭州影视', '杭州青少体育'])
  assert.deepEqual(CHANNELS.map(row => row.code), ['hztv1', 'hztv2', 'hztv3', 'hztv4', 'hztv5'])
  assert.deepEqual(groups[0].dataList.map(row => row.deferredRef), CHANNELS.map(row => row.ref))
  for (const row of groups[0].dataList) {
    assert.ok(!row.url)
    assert.equal(row.catchup, 'none')
    assert.match(row.logo, /^https:\/\/image\.hoolo\.tv\/2020081[0-9a-f]{4,}[0-9a-f]+\.(png|jpg)$/)
  }
  assert.equal(new Set(groups[0].dataList.map(row => row.logo)).size, 5, '每路一张图')
  assert.equal(claimsRef(channel.ref), true)
  assert.equal(claimsRef('hangzhou-unknown'), false)
})

check('频道接口：只取本频道的 hd 媒体清单，统一成 https；停播、缺 hd、别的频道都拒绝', () => {
  assert.equal(parseChannelDetail(detail(), channel), hdUrl())
  assert.equal(authExpiry(new URL(hdUrl())), EXPIRES * 1000)
  assert.throws(() => parseChannelDetail(detail(EXPIRES, 'a', { is_stopped: '1' }), channel), /停播/)
  assert.throws(() => parseChannelDetail(detail(EXPIRES, 'a', { channel_stream: [] }), channel), /高清/)
  assert.throws(() => parseChannelDetail(detail(), CHANNELS[1]), /没有返回这一路/)
  assert.throws(() => parseChannelDetail({}, channel))
})

check('只接受本频道官方 CDN 上带签名的清单与分片', () => {
  assert.equal(officialPlaylistUrl(hdUrl(EXPIRES, 'a', 'live3.hoolo.tv'), channel), hdUrl(EXPIRES, 'a', 'live3.hoolo.tv'))
  assert.throws(() => officialPlaylistUrl(hdUrl().replace('hztv1/hd', 'hztv2/hd'), channel))
  assert.throws(() => officialPlaylistUrl(hdUrl().replace('/hd/', '/sd/'), channel))
  assert.throws(() => officialPlaylistUrl(hdUrl().replace('live.hoolo.tv', 'evil.example'), channel))
  assert.throws(() => officialPlaylistUrl(hdUrl().replace(/\?.*$/, ''), channel), /签名/)
  const seg = `https://live.hoolo.tv${segment('1')}`
  assert.equal(officialMediaUrl(segment('1'), hdUrl(), channel), seg)
  assert.throws(() => officialMediaUrl(seg.replace('live.hoolo.tv', 'live3.hoolo.tv'), hdUrl(), channel), /不在/)
  assert.throws(() => officialMediaUrl('/hztv2_hd/1/2.ts', hdUrl(), channel))
  assert.equal(validatePlaylist(playlist, hdUrl(), channel), playlist)
  assert.throws(() => validatePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhd/live.m3u8\n', hdUrl(), channel), /格式已变化/)
  assert.throws(() => validatePlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://evil.example/k"\n' + playlist, hdUrl(), channel))
  assert.throws(() => validatePlaylist('#EXTM3U\n', hdUrl(), channel), /没有分片/)
  assert.throws(() => validatePlaylist('<html>403</html>', hdUrl(), channel), /不是|没有返回/)
})

await checkAsync('签名缓存到过期前半小时，轮询只重取清单；全代理带官方来源头', async () => {
  let now = NOW
  let apiCalls = 0
  let playlistCalls = 0
  const fetchImpl = async (url, init) => {
    assert.equal(init.headers.Referer, REFERER, '接口和清单都要带官方来源头')
    if (url.startsWith(CHANNEL_API)) {
      apiCalls++
      assert.match(url, /\?channel_id=16&_=\d+$/)
      return new Response(JSON.stringify(detail(Math.floor(now / 1000) + 7200)))
    }
    playlistCalls++
    return new Response(playlist)
  }
  const resolver = createResolver({ fetchImpl, now: () => now })
  const first = await resolver.resolve(channel.ref)
  assert.equal(first.url, hdUrl())
  assert.equal(first.relayHls, true)
  assert.equal(first.manifestUrl, first.url)
  assert.equal(first.manifestText, playlist)
  assert.deepEqual(first.upstreamHeaders, { Referer: REFERER })
  assert.equal(first.upstreamUrlTransform(`https://live.hoolo.tv${segment('9')}`), `https://live.hoolo.tv${segment('9')}`)
  assert.throws(() => first.upstreamUrlTransform('https://evil.example/hztv1_hd/1/2.ts'))
  now += 89 * 60 * 1000
  await resolver.resolve(channel.ref)
  assert.equal(apiCalls, 1, '过期前半小时内不重签')
  now += 2 * 60 * 1000
  await resolver.resolve(channel.ref)
  assert.equal(apiCalls, 2, '进入最后半小时就重签')
  assert.equal(playlistCalls, 3, '每次轮询都重取清单')
})

await checkAsync('清单被拒时扔掉缓存重签一次；并发只签一次', async () => {
  let apiCalls = 0
  let rejectNext = false
  const fetchImpl = async url => {
    if (url.startsWith(CHANNEL_API)) {
      apiCalls++
      await new Promise(resolve => setTimeout(resolve, 5))
      return new Response(JSON.stringify(detail(EXPIRES, apiCalls === 1 ? 'a' : 'e')))
    }
    if (rejectNext && url.includes(sign(EXPIRES, 'a'))) return new Response('denied by Referer ACL', { status: 403 })
    return new Response(playlist)
  }
  const resolver = createResolver({ fetchImpl, now: () => NOW })
  const results = await Promise.all([resolver.resolve(channel.ref), resolver.resolve(channel.ref)])
  assert.ok(results.every(result => result.url === hdUrl()))
  assert.equal(apiCalls, 1)
  rejectNext = true
  const renewed = await resolver.resolve(channel.ref)
  assert.equal(renewed.url, hdUrl(EXPIRES, 'e'))
  assert.equal(apiCalls, 2)
})

await checkAsync('非法引用与上游异常只返回说明，失败后短时间内不连环打接口', async () => {
  let calls = 0
  const resolver = createResolver({
    fetchImpl: async () => { calls++; return new Response('<html>403 Forbidden</html>', { status: 403 }) },
    now: () => NOW,
  })
  const malformed = await resolver.resolve('other')
  assert.equal(malformed.url, '')
  assert.match(malformed.desc, /引用格式错误/)
  const failed = await resolver.resolve(channel.ref)
  assert.equal(failed.url, '')
  assert.match(failed.desc, /杭州综合 取流失败.*HTTP 403/)
  await resolver.resolve(channel.ref)
  assert.equal(calls, 1, '冷却期内回同一个错误')
  const stopped = createResolver({
    fetchImpl: async () => new Response(JSON.stringify(detail(EXPIRES, 'a', { is_stopped: 1 }))),
    now: () => NOW,
  })
  assert.match((await stopped.resolve(channel.ref)).desc, /停播/)
})

console.log(`\n全部通过：${passed} ✅`)
