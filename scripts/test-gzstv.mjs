#!/usr/bin/env node
import assert from 'node:assert/strict'

import gzstv from '../extractors/gzstv/index.js'
import {
  CHANNELS,
  GZSTV_API_ORIGIN,
  buildChannels,
  buildStreamRequest,
  claimsRef,
  clearCache,
  officialAssetUrl,
  officialHlsUrl,
  parseStreamResponse,
  resolveChannel,
  upstreamHeadersFor,
} from '../extractors/gzstv/api.js'
import { getModule, resolverFor } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }
const response = (body, status = 200) => new Response(
  typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json' } },
)

const secret = '0123456789abcdef0123456789abcdef'
const signedUrl = channel => `https://9bwaz8y2.gzstv.com/live/${channel.streamName}?txSecret=${secret}&txTime=6A9D2257`

console.log('贵州广电模块测试')

check('模块注册为免账号的贵州全代理模块', () => {
  assert.equal(getModule('gzstv'), gzstv)
  assert.equal(gzstv.name, '贵州')
  assert.equal(gzstv.channelHlsMode, 'proxy')
  assert.equal(gzstv.capabilities.catchup, false)
  assert.equal(gzstv.catalogVersion, 2)
  assert.deepEqual(gzstv.configSchema, [])
  assert.equal(resolverFor('gzstv-satellite'), gzstv)
  assert.equal(resolverFor('gzstv-satellite/extra'), null)
})

await checkAsync('官网八路频道固定输出并明确排除购物频道', async () => {
  assert.deepEqual(CHANNELS.map(({ slug, streamName }) => [slug, streamName]), [
    ['ch01', 'CH01_lo.m3u8'],
    ['ch02', 'CH02_lo.m3u8'],
    ['ch03', 'CH03_lo.m3u8'],
    ['ch04', 'CH04_lo.m3u8'],
    ['ch05', 'CH05_lo.m3u8'],
    ['ch06', 'CH06_lo.m3u8'],
    ['ch09', 'CH09_lo.m3u8'],
    ['ch13', 'CH13_lo.m3u8'],
  ])
  assert.equal(CHANNELS.some(channel => channel.slug === 'ch10' || channel.name.includes('购物')), false)
  const channels = buildChannels()
  assert.deepEqual(channels.map(channel => channel.deferredRef), CHANNELS.map(channel => channel.ref))
  assert.ok(channels.every(channel => channel.catchup === 'none'))
  // 八路都给频道接口 image 字段下发的官方频道标，不留空（LOGO.md 第 4 条）
  assert.deepEqual(channels.map(channel => channel.logo), [
    'Wv8DYDU_DFQg', 'SoNtDtRcuDbR', 'kq09201cePrU', 'TlQgNo6srb2p',
    'fGTUM0FqTtzG', 'sz3062_R-Ma-', 'Y2UfPmdykgir', 'b9BSCCj5xEsx',
  ].map(file => `https://mstatic.gzstv.com/media/streams/images/2021/01/04/${file}.jpg`))
  const result = await gzstv.fetch()
  assert.deepEqual(result.groups, [{ name: '贵州', dataList: channels }])
  assert.equal(claimsRef('gzstv-mobile'), true)
  assert.equal(claimsRef('gzstv-shopping'), false)
})

check('频道接口、返回字段和媒体地址均严格校验', () => {
  const channel = CHANNELS[0]
  const request = buildStreamRequest(channel)
  assert.equal(request.url, `${GZSTV_API_ORIGIN}/v1/tv/ch01/?fields=title,stream_url`)
  assert.equal(request.options.headers.Origin, 'https://www.gzstv.com')
  assert.equal(request.options.headers.Referer, 'https://www.gzstv.com/tv/ch01')
  assert.equal(parseStreamResponse({ title: channel.rawName, stream_url: signedUrl(channel) }, channel), signedUrl(channel))
  assert.deepEqual(upstreamHeadersFor(signedUrl(channel)), {
    Origin: 'https://www.gzstv.com',
    Referer: 'https://www.gzstv.com/',
  })
  assert.match(officialAssetUrl('https://9bwaz8y2.gzstv.com/live/CH01_lo-1.ts?txspiseq=x'), /\.ts/)
  for (const bad of [
    'http://9bwaz8y2.gzstv.com/live/CH01_lo.m3u8',
    'https://9bwaz8y2.gzstv.com.evil.test/live/CH01_lo.m3u8',
    'https://127.0.0.1/live/CH01_lo.m3u8',
    'https://user:pass@9bwaz8y2.gzstv.com/live/CH01_lo.m3u8',
    'https://9bwaz8y2.gzstv.com:444/live/CH01_lo.m3u8',
    'https://9bwaz8y2.gzstv.com/private/CH01_lo.m3u8',
  ]) assert.throws(() => officialAssetUrl(bad))
  assert.throws(() => officialHlsUrl('https://9bwaz8y2.gzstv.com/live/CH01_lo.ts'))
  assert.throws(() => parseStreamResponse({ title: '公共频道', stream_url: signedUrl(channel) }, channel), /有效直播地址/)
  assert.throws(() => parseStreamResponse({ title: channel.rawName, stream_url: signedUrl(CHANNELS[1]) }, channel), /频道与请求不一致/)
})

await checkAsync('播放时刷新签名、短期复用地址且不缓存滚动清单', async () => {
  clearCache()
  const channel = CHANNELS[0]
  let requests = 0
  const fetchImpl = async (url, options) => {
    requests++
    assert.equal(url, `${GZSTV_API_ORIGIN}/v1/tv/ch01/?fields=title,stream_url`)
    assert.equal(options.redirect, 'manual')
    return response({ title: channel.rawName, stream_url: signedUrl(channel) })
  }
  const first = await resolveChannel(channel.ref, { fetchImpl, now: 1000 })
  const second = await resolveChannel(channel.ref, { fetchImpl, now: 2000 })
  const refreshed = await resolveChannel(channel.ref, { fetchImpl, now: 32000 })
  assert.equal(requests, 2)
  assert.equal(first.url, signedUrl(channel))
  assert.equal(second.url, first.url)
  assert.equal(refreshed.url, first.url)
  assert.equal('manifestText' in first, false)
  assert.equal('manifestUrl' in first, false)
  assert.match(first.upstreamUrlTransform('https://9bwaz8y2.gzstv.com/live/CH01_lo-1.ts'), /\.ts$/)
})

await checkAsync('非法引用及接口错误只返回说明，不向请求处理器抛错', async () => {
  clearCache()
  const malformed = await resolveChannel('gzstv-shopping', {
    fetchImpl: async () => { throw new Error('不应请求') },
  })
  assert.equal(malformed.url, '')
  assert.match(malformed.desc, /引用格式错误/)

  const failed = await resolveChannel('gzstv-satellite', {
    fetchImpl: async () => response('upstream error', 500),
  })
  assert.equal(failed.url, '')
  assert.match(failed.desc, /请求失败.*HTTP 500/)
})

console.log(`\n全部通过：${passed} ✅`)
