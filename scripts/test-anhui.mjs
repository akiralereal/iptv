#!/usr/bin/env node
import assert from 'node:assert/strict'

import anhui from '../extractors/anhui/index.js'
import {
  ANHUI_CONFIG_API,
  APP_TOKEN_LIFETIME_MS,
  AUTH_KEY_TTL_MS,
  CHANNELS,
  MEDIA_USER_AGENT,
  STREAM_URL_TTL_MS,
  buildChannels,
  claimsRef,
  createResolver,
  officialHlsUrl,
  officialMediaUrl,
  parseConfig,
  requestManifest,
  signedStreamUrl,
  upstreamHeadersFor,
  validateHls,
} from '../extractors/anhui/api.js'
import { getModule, resolverFor } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

// 与实验台 anhui-live-lab/checks/ahtv.js 同一组样本：解码与签名必须逐字节一致
const AUTH_KEY = 'HH4yREESft3frRsYtDC8'
const TX_TIME = '6a9d3faf'
const SIGNING_NOW = Number.parseInt(TX_TIME, 16) * 1000 - APP_TOKEN_LIFETIME_MS
const SIGNED_STREAM = `https://live.ahsx.ahtv.cn/live//jjshtv.m3u8?txSecret=ebe12b842d9e34fdea05921ffedf2864&txTime=${TX_TIME}`
const ENCRYPTED_KEY_CONFIG = 'tSc9pa4JudEll4aSE//RYIAGwN8IB6cYYi+H0iaXaX/1/V+O9xgZHn8i9FRGs8jjlVmJe6QYmVmyTnLVF3EuSw=='
const CONFIG_PAYLOAD = JSON.stringify({ state: true, data: { is_encrypt: 1, key: ENCRYPTED_KEY_CONFIG } })
const PLAIN_CONFIG_PAYLOAD = JSON.stringify({ state: true, data: { is_encrypt: 0, key: { tx_auth_key: AUTH_KEY } } })

// 官方真实形态：媒体清单直出，3 个 2 秒分片、相对地址带各自查询串
const mediaManifest = sequence => [
  '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-ALLOW-CACHE:NO', `#EXT-X-MEDIA-SEQUENCE:${sequence}`, '#EXT-X-TARGETDURATION:2',
  '#EXTINF:2,', `jjshtv-${sequence}.ts?txspiseq=1`, '#EXTINF:2,', `jjshtv-${sequence + 1}.ts?txspiseq=1`, '#EXTINF:2,', `jjshtv-${sequence + 2}.ts?txspiseq=1`, '',
].join('\n')

const response = (body, status = 200, headers = {}) => new Response(body, { status, headers })

/** 记录每次请求的地址与请求头，按路径回放配置接口与清单。 */
function fakeUpstream({ manifestStatuses = [], configPayload = CONFIG_PAYLOAD } = {}) {
  const calls = []
  let sequence = 100
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), headers: options.headers || {} })
    if (String(url).startsWith(ANHUI_CONFIG_API)) return response(configPayload, 200, { 'content-type': 'application/json' })
    if (/\/live\/\/[a-z\d]+\.m3u8\?txSecret=/.test(String(url))) {
      // 2026-10-21 CDN 已拒绝旧 ijkplayer UA；清单回源必须用浏览器标识且不附加防盗链头。
      if (!/Chrome\//.test(options.headers?.['User-Agent'] || '')
          || Object.keys(options.headers || {}).some(key => /^(referer|origin)$/i.test(key))) {
        return response('ua rejected', 403)
      }
      const status = manifestStatuses.shift() ?? 200
      if (status !== 200) return response('forbidden', status)
      return response(mediaManifest(sequence++), 200, { 'content-type': 'application/vnd.apple.mpegurl' })
    }
    throw new Error(`unexpected fetch ${url}`)
  }
  return { calls, fetchImpl, configCalls: () => calls.filter(call => call.url.startsWith(ANHUI_CONFIG_API)), manifestCalls: () => calls.filter(call => call.url.includes('.m3u8')) }
}

console.log('安徽广电模块测试')

check('模块注册为免账号的安徽全代理模块', () => {
  assert.equal(getModule('anhui'), anhui)
  assert.equal(anhui.name, '安徽')
  assert.equal(anhui.category, undefined)
  assert.equal(anhui.outputGroupName, '安徽')
  assert.equal(anhui.channelHlsMode, 'proxy', 'CDN 按播放器标识放行，播放器不能直连分片')
  assert.equal(anhui.relayProxyCompatible, undefined)
  assert.equal(anhui.capabilities.cache, 'disk')
  assert.equal(anhui.capabilities.resolve, true)
  assert.equal(anhui.capabilities.catchup, false)
  assert.equal(anhui.catalogVersion, 1)
  assert.equal(anhui.refreshConfigurable, false)
  assert.deepEqual(anhui.configSchema, [])
  assert.equal(resolverFor('anhui-ahwssx'), anhui)
  assert.equal(resolverFor('anhui-gjtv'), anhui)
  assert.equal(resolverFor('anhui-ahwssx/extra'), null)
  assert.equal(resolverFor('anhui-radio'), null)
})

await checkAsync('安徽视讯 App 七路电视固定输出为独立安徽分组', async () => {
  assert.deepEqual(CHANNELS.map(channel => [channel.liveId, channel.rawName]), [
    ['ahwssx', '安徽卫视'], ['jjshtv', '经济生活'], ['ystv', '影视频道'], ['ggtv', '公共频道'],
    ['nykjtv', '农业科教'], ['zytytv', '综艺体育'], ['gjtv', '国际频道'],
  ])
  assert.deepEqual(CHANNELS.map(channel => channel.name), [
    '安徽卫视', '安徽经济生活', '安徽影视', '安徽公共', '安徽农业科教', '安徽综艺体育', '安徽国际',
  ])
  assert.ok(CHANNELS.every(channel => channel.ref === `anhui-${channel.liveId}`), 'ref 直接由 App liveId 构成')
  assert.ok(CHANNELS.every(channel => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(channel.ref)), 'ref 必须是单个安全路径段')
  const channels = buildChannels()
  assert.deepEqual(channels.map(channel => channel.deferredRef), CHANNELS.map(channel => channel.ref))
  assert.ok(channels.every(channel => channel.catchup === 'none'))
  assert.ok(channels.every(channel => channel.logo.startsWith('https://image.ahsx.ahtv.cn/0/')))
  assert.ok(channels.every(channel => channel.opts.includes('network-caching=3000')))
  assert.ok(channels.every(channel => !('liveId' in channel) && !('rawName' in channel)), '内部字段不进播放列表缓存')
  assert.equal(claimsRef('anhui-ahwssx'), true)
  assert.equal(claimsRef('anhui-zhgb'), false, '广播不在电视列表里')
  assert.equal(claimsRef(''), false)
  const result = await anhui.fetch()
  assert.deepEqual(result.groups, [{ name: '安徽', dataList: channels }])
  assert.deepEqual(result.meta, { skipped: [], warnings: [] })
})

check('解码官方 App 加密配置，并兼容明文配置', () => {
  assert.equal(parseConfig(CONFIG_PAYLOAD), AUTH_KEY)
  assert.equal(parseConfig(PLAIN_CONFIG_PAYLOAD), AUTH_KEY)
  assert.throws(() => parseConfig('{bad json'), /无效 JSON/)
  assert.throws(() => parseConfig(JSON.stringify({ state: false, data: {} })), /没有返回配置/)
  assert.throws(() => parseConfig(JSON.stringify({ state: true, data: { is_encrypt: 1, key: 'bad' } })), /无法解码/)
  assert.throws(() => parseConfig(JSON.stringify({ state: true, data: { is_encrypt: 0, key: { tx_auth_key: 'short' } } })), /鉴权密钥/)
  assert.throws(() => parseConfig(JSON.stringify({ state: true, data: { is_encrypt: 0, key: '[]' } })), /密钥配置/)
})

check('逐频道生成与 App 运行时完全一致的腾讯云签名', () => {
  assert.equal(signedStreamUrl('jjshtv', AUTH_KEY, SIGNING_NOW), SIGNED_STREAM)
  assert.notEqual(signedStreamUrl('ahwssx', AUTH_KEY, SIGNING_NOW), SIGNED_STREAM, '签名随 liveId 变化')
  assert.throws(() => signedStreamUrl('../wrong', AUTH_KEY, SIGNING_NOW), /liveId/)
  assert.throws(() => signedStreamUrl('jjshtv', '', SIGNING_NOW), /鉴权密钥/)
})

check('只放行官方媒体域名，拒绝下线占位与外域', () => {
  assert.equal(officialMediaUrl(SIGNED_STREAM), SIGNED_STREAM)
  assert.equal(officialHlsUrl(SIGNED_STREAM), SIGNED_STREAM)
  assert.doesNotThrow(() => officialMediaUrl('https://live.ahsx.ahtv.cn/live//ahwssx-1784385067.ts?txspiseq=1'))
  assert.doesNotThrow(() => officialMediaUrl('https://lives.ahsx.ahtv.cn/live/x.ts'))
  assert.doesNotThrow(() => officialMediaUrl('https://nrtapush.ahsx.ahtv.cn/live/x.ts'))
  assert.throws(() => officialMediaUrl('http://live.ahsx.ahtv.cn/live//jjshtv.m3u8'), /非官方/)
  assert.throws(() => officialMediaUrl('https://live.ahsx.ahtv.cn:8443/live//jjshtv.m3u8'), /非官方/)
  assert.throws(() => officialMediaUrl('https://user:pw@live.ahsx.ahtv.cn/live//jjshtv.m3u8'), /非官方/)
  assert.throws(() => officialMediaUrl('https://live.ahsx.ahtv.cn.evil.example/live/x.ts'), /非官方/)
  assert.throws(() => officialMediaUrl('https://image.ahsx.ahtv.cn/live/x.ts'), /非官方/)
  assert.throws(() => officialMediaUrl('https://satellitepull.cnr.cn/live/wxahxxgb/playlist.m3u8'), /非官方/, '广播备用域名不在电视模块边界内')
  assert.throws(() => officialMediaUrl('https://live.ahsx.ahtv.cn/forbid/index.m3u8'), /下线占位/)
  assert.throws(() => officialMediaUrl('https://live.ahsx.ahtv.cn/live/..%2fforbid/x.ts'), /非官方/)
  assert.throws(() => officialHlsUrl('https://live.ahsx.ahtv.cn/live//jjshtv.ts'), /HLS 入口/)
  assert.throws(() => officialMediaUrl('not a url'), /无效媒体地址/)
})

check('上游请求头只带兼容的浏览器标识，不带 Referer 或 Origin', () => {
  assert.deepEqual(upstreamHeadersFor(SIGNED_STREAM), { 'User-Agent': MEDIA_USER_AGENT })
  assert.match(MEDIA_USER_AGENT, /^Mozilla\/5\.0 .*Chrome\//)
  assert.throws(() => upstreamHeadersFor('https://evil.example/segment.ts'), /非官方/)
  const manifest = mediaManifest(1)
  assert.equal(validateHls(manifest, SIGNED_STREAM), manifest)
  assert.throws(() => validateHls('#EXTM3U\n#EXTINF:2,\nhttps://evil.example/seg.ts\n', SIGNED_STREAM), /非官方/)
  assert.throws(() => validateHls('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://evil.example/key"\n', SIGNED_STREAM), /非官方/)
  assert.throws(() => validateHls('<html>', SIGNED_STREAM), /不是 HLS 清单/)
})

await checkAsync('全链路：拉配置、签名、以浏览器标识取清单；密钥与签名短期复用，清单每次重新拉取', async () => {
  const upstream = fakeUpstream()
  const resolver = createResolver({ fetchImpl: upstream.fetchImpl })
  const first = await resolver.resolve('anhui-jjshtv', { now: SIGNING_NOW })
  assert.equal(first.url, SIGNED_STREAM, '播放地址就是 App 同款签名地址')
  assert.equal(first.manifestUrl, SIGNED_STREAM)
  assert.match(first.manifestText, /^#EXTM3U/)
  assert.equal(first.relayHls, true)
  assert.equal(first.upstreamHeaders, upstreamHeadersFor, '函数形态请求头，代理层据此保留兼容 UA')
  assert.equal(first.upstreamUrlTransform, officialMediaUrl)
  assert.throws(() => first.upstreamUrlTransform('https://evil.example/segment.ts'))
  assert.equal(upstream.configCalls().length, 1)
  assert.equal(upstream.configCalls()[0].headers.Accept, 'application/json')
  assert.equal(upstream.manifestCalls().length, 1)
  assert.deepEqual(upstream.manifestCalls()[0].headers, { 'User-Agent': MEDIA_USER_AGENT }, '清单请求只带兼容浏览器标识')

  const second = await resolver.resolve('anhui-jjshtv', { now: SIGNING_NOW + AUTH_KEY_TTL_MS - 1 })
  assert.equal(second.url, SIGNED_STREAM, '复用期内沿用同一份签名')
  assert.notEqual(second.manifestText, first.manifestText, '滚动清单每次轮询都重新拉取')
  assert.equal(upstream.configCalls().length, 1, '密钥在有效期内不重复拉取')
  assert.equal(upstream.manifestCalls().length, 2)

  const third = await resolver.resolve('anhui-jjshtv', { now: SIGNING_NOW + STREAM_URL_TTL_MS - 1 })
  assert.equal(third.url, SIGNED_STREAM, '签名仍在复用期内，密钥到期也不必重拉配置')
  assert.equal(upstream.configCalls().length, 1)

  const fourth = await resolver.resolve('anhui-jjshtv', { now: SIGNING_NOW + STREAM_URL_TTL_MS })
  assert.notEqual(fourth.url, SIGNED_STREAM, '签名复用期过后按新时间重签')
  assert.equal(upstream.configCalls().length, 2, '重签时密钥已过期，重新拉配置')

  const other = await resolver.resolve('anhui-ahwssx', { now: SIGNING_NOW })
  assert.match(other.url, /\/live\/\/ahwssx\.m3u8\?txSecret=/)
  assert.equal(other.desc, '安徽卫视 官方直播地址获取成功')
  assert.equal(upstream.configCalls().length, 2, '其它频道共用缓存里的密钥')

  resolver.clear()
  await resolver.resolve('anhui-jjshtv', { now: SIGNING_NOW })
  assert.equal(upstream.configCalls().length, 3, '清缓存后重新拉配置')
})

await checkAsync('并发解析共享同一次配置请求', async () => {
  const upstream = fakeUpstream()
  const resolver = createResolver({ fetchImpl: upstream.fetchImpl })
  const results = await Promise.all(CHANNELS.map(channel => resolver.resolve(channel.ref, { now: SIGNING_NOW })))
  assert.ok(results.every(result => result.url))
  assert.equal(upstream.configCalls().length, 1)
  assert.equal(upstream.manifestCalls().length, CHANNELS.length)
})

await checkAsync('签名被拒时丢弃密钥重签一次，连续失败给出可读原因', async () => {
  const upstream = fakeUpstream({ manifestStatuses: [403] })
  const resolver = createResolver({ fetchImpl: upstream.fetchImpl })
  const result = await resolver.resolve('anhui-jjshtv', { now: SIGNING_NOW })
  assert.equal(result.url, SIGNED_STREAM)
  assert.equal(upstream.configCalls().length, 2, '被拒后重新拉一次配置')
  assert.equal(upstream.manifestCalls().length, 2)

  const failing = fakeUpstream({ manifestStatuses: [403, 403] })
  const failed = await createResolver({ fetchImpl: failing.fetchImpl }).resolve('anhui-jjshtv', { now: SIGNING_NOW })
  assert.equal(failed.url, '')
  assert.match(failed.desc, /安徽广电链接请求失败：安徽直播清单 HTTP 403/)
  assert.equal(failing.manifestCalls().length, 2, '只重试一次')
})

await checkAsync('配置接口异常与非法引用都返回可读失败，绝不抛出', async () => {
  const broken = await createResolver({ fetchImpl: async () => response('oops', 500) }).resolve('anhui-jjshtv')
  assert.equal(broken.url, '')
  assert.match(broken.desc, /配置接口 HTTP 500/)

  const redirected = await createResolver({
    fetchImpl: async () => response('', 302, { location: 'https://evil.example/config' }),
  }).resolve('anhui-jjshtv')
  assert.match(redirected.desc, /不安全的重定向/)

  const badRef = await createResolver({ fetchImpl: async () => { throw new Error('不该请求') } }).resolve('anhui-nope')
  assert.deepEqual(badRef, { url: '', desc: '安徽频道引用格式错误' })
})

await checkAsync('清单不是 HLS 或分片跳到外域时拒绝播放', async () => {
  const html = fakeUpstream()
  const htmlFetch = async (url, options) => /\.m3u8/.test(String(url)) ? response('<html>', 200) : html.fetchImpl(url, options)
  const notHls = await createResolver({ fetchImpl: htmlFetch }).resolve('anhui-jjshtv', { now: SIGNING_NOW })
  assert.equal(notHls.url, '')
  assert.match(notHls.desc, /不是 HLS 清单/)

  const foreign = fakeUpstream()
  const foreignFetch = async (url, options) => /\.m3u8/.test(String(url))
    ? response('#EXTM3U\n#EXTINF:2,\nhttps://evil.example/seg.ts\n', 200)
    : foreign.fetchImpl(url, options)
  const rejected = await createResolver({ fetchImpl: foreignFetch }).resolve('anhui-jjshtv', { now: SIGNING_NOW })
  assert.equal(rejected.url, '')
  assert.match(rejected.desc, /非官方媒体地址/)

  await assert.rejects(
    requestManifest(SIGNED_STREAM, { fetchImpl: async () => response('', 302, { location: 'https://evil.example/live.m3u8' }) }),
    /非官方媒体地址/,
  )
})

await checkAsync('上游挂起时按超时结束并说明原因', async () => {
  const hanging = (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
  })
  const result = await createResolver({ fetchImpl: hanging }).resolve('anhui-jjshtv', { timeoutMs: 20 })
  assert.equal(result.url, '')
  assert.match(result.desc, /超时 20ms/)
})

console.log(`\n全部通过：${passed} 项`)
