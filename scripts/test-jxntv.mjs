#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import jxntv from '../extractors/jxntv/index.js'
import {
  CHANNELS,
  JXNTV_AUTH_API,
  buildAuthRequest,
  buildChannels,
  claimsRef,
  clearCache,
  officialAssetUrl,
  officialHlsUrl,
  parseAuth,
  resolveChannel,
  upstreamHeadersFor,
} from '../extractors/jxntv/api.js'
import { getModule, resolverFor } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }
const response = (body, status = 200) => new Response(
  typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json' } },
)

const now = 1_700_000_000_000
const etag = 'Ab3D5f7H'
const authTime = '170000012345678'
const token = '0123456789abcdef0123456789abcdef'

console.log('江西广电模块测试')

check('模块已注册为免账号的江西全代理模块', () => {
  assert.equal(getModule('jxntv'), jxntv)
  assert.equal(jxntv.name, '江西')
  assert.equal(jxntv.category, undefined)
  assert.equal(jxntv.channelHlsMode, 'proxy')
  assert.equal(jxntv.capabilities.catchup, false)
  assert.equal(jxntv.catalogVersion, 2)
  assert.deepEqual(jxntv.configSchema, [])
  assert.equal(resolverFor('jxntv-satellite'), jxntv)
  assert.equal(resolverFor('jxntv-satellite/extra'), null)
})

await checkAsync('官网八路频道固定输出为独立江西分组', async () => {
  assert.deepEqual(CHANNELS.map(({ route, streamName }) => [route, streamName]), [
    ['jxtv1', 'tv_jxtv1.m3u8'],
    ['jxtv2', 'tv_jxtv2.m3u8'],
    ['jxtv3', 'tv_jxtv3_hd.m3u8'],
    ['jxtv5', 'tv_jxtv5.m3u8'],
    ['jxtv6', 'tv_jxtv6.m3u8'],
    ['jxtv7', 'tv_jxtv7.m3u8'],
    ['jxtv8', 'tv_jxtv8.m3u8'],
    ['tcpd', 'tv_taoci.m3u8'],
  ])
  assert.deepEqual(CHANNELS.map(channel => channel.name), [
    '江西卫视', '江西都市', '江西经济生活', '江西公共农业',
    '江西少儿', '江西新闻', '江西移动电视', '江西陶瓷',
  ])
  const channels = buildChannels()
  assert.deepEqual(channels.map(channel => channel.deferredRef), CHANNELS.map(channel => channel.ref))
  assert.ok(channels.every(channel => channel.catchup === 'none'))
  // 八路都给今视频 App 频道目录下发的官方频道标，写的是去掉 OSS 签名的稳定地址（LOGO.md 第 4 条）
  assert.deepEqual(channels.map(channel => channel.logo), [
    'ae00a8764c764390bb58094d46f5b2af', '67d8420f601b4b95bcb3f9c1d2aee40c',
    '4294b5a4be2c4958bcf2711430cc483b', '07e893cd94224d9ebcf4eb588d2a43d1',
    'aa18d5b48b63473591293aabd67c53be', '3d27952c09c44cf3b68cb19863605973',
    '167e9ebbb9f54cc787db75cbf0bc4aa8', '8eba1c8045384be1bed2f6aef90e4526',
  ].map(id => `https://image.jxgdw.com/material/${id}`))
  const result = await jxntv.fetch()
  assert.deepEqual(result.groups, [{ name: '江西', dataList: channels }])
  assert.equal(claimsRef('jxntv-ceramics'), true)
  assert.equal(claimsRef('jxntv-unknown'), false)
})

check('鉴权签名、请求体和公开响应格式严格固定', () => {
  const request = buildAuthRequest(CHANNELS[0], { now, etag })
  const body = JSON.parse(request.options.body)
  assert.equal(request.url, JXNTV_AUTH_API)
  assert.deepEqual({ t: body.t, stream: body.stream }, {
    t: '1700000000',
    stream: 'tv_jxtv1.m3u8',
  })
  assert.match(body.uuid, /^[a-f0-9]{12}$/)
  assert.equal(request.options.headers.Authorization, createHash('md5')
    .update('1700000000tv_jxtv1.m3u8Ab3D5f7HgXmNaQROStYfd').digest('hex'))
  assert.equal(request.options.headers.ETag, etag)
  assert.equal(request.options.headers.Origin, 'https://www.jxntv.cn')
  assert.equal(request.options.headers.Referer, 'https://www.jxntv.cn/live/')
  assert.deepEqual(parseAuth({ t: authTime, token }), { t: authTime, token })
  assert.throws(() => parseAuth('{"t":"x","token":"bad"}'), /有效直播凭证/)
  assert.throws(() => buildAuthRequest(CHANNELS[0], { now, etag: 'invalid!' }), /ETag/)
})

check('媒体白名单覆盖清单、密钥和分片，并拒绝任意外部回源', () => {
  const good = `https://yun-live.jxtvcn.com.cn/live-jxtv/tv_jxtv1.m3u8?token=${token}`
  assert.equal(officialHlsUrl(good), good)
  assert.match(officialAssetUrl('https://yun-live.jxtvcn.com.cn/live-jxtv/part.ts?token=x'), /part\.ts/)
  assert.match(officialAssetUrl('https://yun-live.jxtvcn.com.cn/live-jxtv/key.bin'), /key\.bin/)
  assert.deepEqual(upstreamHeadersFor(good), {
    Origin: 'https://www.jxntv.cn',
    Referer: 'https://www.jxntv.cn/live/',
  })
  for (const bad of [
    'http://yun-live.jxtvcn.com.cn/live-jxtv/a.ts',
    'https://yun-live.jxtvcn.com.cn.evil.test/live-jxtv/a.ts',
    'https://127.0.0.1/live-jxtv/a.ts',
    'https://user:pass@yun-live.jxtvcn.com.cn/live-jxtv/a.ts',
    'https://yun-live.jxtvcn.com.cn:444/live-jxtv/a.ts',
    'https://yun-live.jxtvcn.com.cn/private/a.ts',
  ]) assert.throws(() => officialAssetUrl(bad))
  assert.throws(() => officialHlsUrl('https://yun-live.jxtvcn.com.cn/live-jxtv/a.ts'), /不是 HLS/)
  assert.throws(() => upstreamHeadersFor('https://example.com/a.ts'), /非官方媒体地址/)
})

await checkAsync('播放时换取 token、短期复用，但不缓存三片式滚动清单', async () => {
  clearCache()
  let authRequests = 0
  const fetchImpl = async (raw, options = {}) => {
    assert.equal(String(raw), JXNTV_AUTH_API)
    authRequests++
    const body = JSON.parse(options.body)
    assert.equal(body.stream, 'tv_jxtv1.m3u8')
    const headers = new Headers(options.headers)
    assert.equal(headers.get('authorization'), createHash('md5')
      .update(`${body.t}${body.stream}${etag}gXmNaQROStYfd`).digest('hex'))
    assert.equal(headers.get('etag'), etag)
    return response({ t: authTime, token })
  }
  const first = await resolveChannel('jxntv-satellite', { fetchImpl, now, etag })
  const second = await resolveChannel('jxntv-satellite', { fetchImpl, now: now + 1000, etag })
  assert.equal(authRequests, 1)
  assert.equal(first.url, second.url)
  const url = new URL(first.url)
  assert.equal(url.origin + url.pathname, 'https://yun-live.jxtvcn.com.cn/live-jxtv/tv_jxtv1.m3u8')
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    source: 'pc', t: authTime, token, uuid: url.searchParams.get('uuid'),
  })
  assert.match(url.searchParams.get('uuid'), /^[a-f0-9]{12}$/)
  assert.equal('manifestText' in first, false)
  assert.equal('manifestUrl' in first, false)
  assert.match(first.upstreamUrlTransform('https://yun-live.jxtvcn.com.cn/live-jxtv/seg.ts'), /seg\.ts$/)

  await resolveChannel('jxntv-satellite', { fetchImpl, now: now + 46000, etag })
  assert.equal(authRequests, 2)
})

await checkAsync('非法引用、HTTP 错误和无效 token 只返回说明，不向请求处理器抛错', async () => {
  clearCache()
  const failed = await resolveChannel('jxntv-satellite', {
    fetchImpl: async () => response('upstream error', 500),
    now,
    etag,
  })
  assert.equal(failed.url, '')
  assert.match(failed.desc, /请求失败.*HTTP 500/)

  clearCache()
  const invalid = await resolveChannel('jxntv-satellite', {
    fetchImpl: async () => response({ t: 'x', token: 'bad' }),
    now,
    etag,
  })
  assert.equal(invalid.url, '')
  assert.match(invalid.desc, /请求失败.*凭证/)

  const malformed = await resolveChannel('jxntv-unknown', {
    fetchImpl: async () => { throw new Error('不应请求') },
  })
  assert.equal(malformed.url, '')
  assert.match(malformed.desc, /引用格式错误/)
})

console.log(`\n全部通过：${passed} ✅`)
