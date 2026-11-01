#!/usr/bin/env node
import assert from 'node:assert/strict'

import anhui from '../extractors/anhui/index.js'
import {
  ANHUI_CONFIG_API,
  ANHUI_TV_CATALOG_API,
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
  parseTvCatalog,
  channelConfigFromCatalog,
  tvCatalogUrl,
  TV_CATALOG_TTL_MS,
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

const channelRecord = (channel, movie = {}, meta = {}) => ({
  id: channel.articleId, title: channel.rawName, status: 30, PayType: 0,
  AppCustomParams: { movie: { txFlag: '1', liveId: channel.liveId, liveDomain: 'https://live.ahsx.ahtv.cn/live/', ...movie } },
  ...meta,
})
const catalogPayload = records => JSON.stringify({ state: true, data: { components: [{ widget: 132, element: records }] } })
const channelPayload = (channel, movie = {}, meta = {}) => catalogPayload([channelRecord(channel, movie, meta)])
const readChannel = (text, channel) => channelConfigFromCatalog(parseTvCatalog(text), channel)

/** 记录每次请求的地址与请求头，按路径回放配置接口、电视栏目与清单。 */
function fakeUpstream({ manifestStatuses = [], configPayload = CONFIG_PAYLOAD, channelConfig = () => ({}), channelMeta = () => ({}) } = {}) {
  const calls = []
  let sequence = 100
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), headers: options.headers || {} })
    if (String(url).startsWith(ANHUI_CONFIG_API)) return response(configPayload, 200, { 'content-type': 'application/json' })
    if (String(url).startsWith(ANHUI_TV_CATALOG_API)) {
      return response(catalogPayload(CHANNELS.map(channel => channelRecord(channel, channelConfig(channel), channelMeta(channel)))))
    }
    if (/\/live\/\/[a-z\d]+\.m3u8\?txSecret=/.test(String(url))) {
      // 两个官方 CDN 的 UA 规则不同；清单回源不附加防盗链头。
      const accepted = new URL(url).hostname === 'seclive.ahsx.ahtv.cn'
        ? options.headers?.['User-Agent'] === 'ijkplayer'
        : /Chrome\//.test(options.headers?.['User-Agent'] || '')
      if (!accepted
          || Object.keys(options.headers || {}).some(key => /^(referer|origin)$/i.test(key))) {
        return response('ua rejected', 403)
      }
      const status = manifestStatuses.shift() ?? 200
      if (status !== 200) return response('forbidden', status)
      return response(mediaManifest(sequence++), 200, { 'content-type': 'application/vnd.apple.mpegurl' })
    }
    throw new Error(`unexpected fetch ${url}`)
  }
  return { calls, fetchImpl, configCalls: () => calls.filter(call => call.url.startsWith(ANHUI_CONFIG_API)), catalogCalls: () => calls.filter(call => call.url.startsWith(ANHUI_TV_CATALOG_API)), manifestCalls: () => calls.filter(call => call.url.includes('.m3u8')) }
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

check('取址使用 App 看电视首屏栏目请求，仅提取电视组件中的已收录频道', () => {
  const url = new URL(tvCatalogUrl())
  assert.equal(url.origin + url.pathname, ANHUI_TV_CATALOG_API)
  assert.equal(url.searchParams.get('no_content'), '1')
  assert.equal(url.searchParams.get('page'), '1')
  assert.equal(url.searchParams.get('perPage'), '50')
  assert.equal(url.searchParams.get('client'), 'android')
  const channel = CHANNELS[0]
  const current = channelRecord(channel, { liveId: 'lailai', liveDomain: 'https://seclive.ahsx.ahtv.cn/live/' })
  const payload = JSON.stringify({ state: true, data: { components: [
    { widget: 127, element: [channelRecord(channel)] }, // 纪录片等组件中同名内容不能当作直播。
    { widget: '132', element: [{ id: 9710, title: '广播' }, current] },
  ] } })
  const records = parseTvCatalog(payload)
  assert.equal(records.length, 1)
  assert.equal(channelConfigFromCatalog(records, channel).liveId, 'lailai')
  assert.throws(() => channelConfigFromCatalog([...records, current], channel), /重复/)
  assert.throws(() => channelConfigFromCatalog(records, CHANNELS[1]), /缺少/)
  for (const invalid of ['<html>WAF</html>', JSON.stringify({ state: false, data: { components: [] } }),
    JSON.stringify({ state: true, data: { components: [{ widget: 132, element: null }] } }),
    JSON.stringify({ state: true, data: { components: [{ widget: 127, element: [current] }] } })]) {
    assert.throws(() => parseTvCatalog(invalid), /栏目|电视组件/)
  }
})

check('官方栏目决定当前域名与流 ID，校验频道身份、发布状态与免费权限', () => {
  const channel = CHANNELS[0]
  const movie = { liveDomain: 'https://seclive.ahsx.ahtv.cn/live/', liveId: 'lailai' }
  assert.deepEqual(readChannel(channelPayload(channel, movie), channel), movie)
  const changedPath = { ...movie, liveDomain: 'https://seclive.ahsx.ahtv.cn/new/edge' }
  assert.deepEqual(readChannel(channelPayload(channel, changedPath), channel), changedPath)
  assert.match(signedStreamUrl(changedPath.liveId, AUTH_KEY, SIGNING_NOW, changedPath.liveDomain), /\/new\/edge\/lailai\.m3u8\?/)
  const stringPayload = JSON.parse(channelPayload(channel, movie))
  stringPayload.data.components[0].element[0].AppCustomParams = JSON.stringify(stringPayload.data.components[0].element[0].AppCustomParams)
  assert.deepEqual(readChannel(JSON.stringify(stringPayload), channel), movie)
  for (const meta of [{ id: '7363' }, { title: '其他台' }, { status: 10 }, { PayType: 1 }]) {
    assert.throws(() => readChannel(channelPayload(channel, movie, meta), channel), /不符|缺少|未发布|免费/)
  }
  for (const config of [{ liveDomain: 'https://evil.example/live/' }, { liveDomain: 'https://seclive.ahsx.ahtv.cn/forbid/' },
    { liveDomain: 'https://seclive.ahsx.ahtv.cn/live/?redirect=evil' }, { liveId: '../other' }, { txFlag: '0' }]) {
    assert.throws(() => readChannel(channelPayload(channel, config), channel))
  }
})

await checkAsync('公开栏目省略 status 时免费频道仍可解析，明确下架或权限不明仍拒绝', async () => {
  const channel = CHANNELS[0]
  const movie = { liveDomain: 'https://seclive.ahsx.ahtv.cn/live/', liveId: 'lailai' }
  for (const PayType of [0, '0']) {
    assert.deepEqual(readChannel(channelPayload(channel, movie, { status: undefined, PayType }), channel), movie)
  }
  for (const meta of [
    { status: 10, PayType: 0 }, { status: null, PayType: 0 },
    { status: undefined, PayType: 1 }, { status: undefined, PayType: undefined },
    { status: undefined, PayType: null }, { status: undefined, PayType: false },
  ]) {
    assert.throws(() => readChannel(channelPayload(channel, movie, meta), channel), /未发布|免费/)
  }
  const upstream = fakeUpstream({ channelConfig: () => movie, channelMeta: () => ({ status: undefined }) })
  const result = await createResolver({ fetchImpl: upstream.fetchImpl }).resolve(channel.ref)
  assert.match(result.url, /^https:\/\/seclive\.ahsx\.ahtv\.cn\/live\/\/lailai\.m3u8/)
  assert.match(result.manifestText, /^#EXTM3U/)
  assert.equal(upstream.manifestCalls().length, 1, '合法的公开栏目必须能继续走到媒体清单')
})

check('只放行官方媒体域名，拒绝下线占位与外域', () => {
  assert.equal(officialMediaUrl(SIGNED_STREAM), SIGNED_STREAM)
  assert.equal(officialHlsUrl(SIGNED_STREAM), SIGNED_STREAM)
  assert.doesNotThrow(() => officialMediaUrl('https://live.ahsx.ahtv.cn/live//ahwssx-1784385067.ts?txspiseq=1'))
  assert.doesNotThrow(() => officialMediaUrl('https://lives.ahsx.ahtv.cn/live/x.ts'))
  assert.doesNotThrow(() => officialMediaUrl('https://nrtapush.ahsx.ahtv.cn/live/x.ts'))
  assert.doesNotThrow(() => officialMediaUrl('http://seclive.ahsx.ahtv.cn/live/x.ts'))
  assert.throws(() => officialMediaUrl('http://lives.ahsx.ahtv.cn/live/x.ts'), /非官方/)
  assert.throws(() => officialMediaUrl('http://seclive.ahsx.ahtv.cn:8080/live/x.ts'), /非官方/)
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
  assert.deepEqual(upstreamHeadersFor('https://seclive.ahsx.ahtv.cn/live/x.ts'), { 'User-Agent': 'ijkplayer' })
  assert.deepEqual(upstreamHeadersFor('http://seclive.ahsx.ahtv.cn/live/x.ts'), { 'User-Agent': 'ijkplayer' })
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
  assert.equal(upstream.catalogCalls().length, 1)
  assert.equal(upstream.configCalls()[0].headers.Accept, 'application/json')
  assert.equal(upstream.manifestCalls().length, 1)
  assert.deepEqual(upstream.manifestCalls()[0].headers, { 'User-Agent': MEDIA_USER_AGENT }, '清单请求只带兼容浏览器标识')

  const second = await resolver.resolve('anhui-jjshtv', { now: SIGNING_NOW + AUTH_KEY_TTL_MS - 1 })
  assert.equal(second.url, SIGNED_STREAM, '复用期内沿用同一份签名')
  assert.notEqual(second.manifestText, first.manifestText, '滚动清单每次轮询都重新拉取')
  assert.equal(upstream.configCalls().length, 1, '密钥在有效期内不重复拉取')
  assert.equal(upstream.manifestCalls().length, 2)
  assert.equal(upstream.catalogCalls().length, 1, '签名复用期内不重复拉频道配置')

  const third = await resolver.resolve('anhui-jjshtv', { now: SIGNING_NOW + STREAM_URL_TTL_MS - 1 })
  assert.equal(third.url, SIGNED_STREAM, '签名仍在复用期内，密钥到期也不必重拉配置')
  assert.equal(upstream.configCalls().length, 1)

  const fourth = await resolver.resolve('anhui-jjshtv', { now: SIGNING_NOW + STREAM_URL_TTL_MS })
  assert.notEqual(fourth.url, SIGNED_STREAM, '签名复用期过后按新时间重签')
  assert.equal(upstream.configCalls().length, 2, '重签时密钥已过期，重新拉配置')
  assert.equal(upstream.catalogCalls().length, 2, '重签时重新读取官方域名与流 ID')

  const other = await resolver.resolve('anhui-ahwssx', { now: SIGNING_NOW })
  assert.match(other.url, /\/live\/\/ahwssx\.m3u8\?txSecret=/)
  assert.equal(other.desc, '安徽卫视 官方直播地址获取成功')
  assert.equal(upstream.configCalls().length, 2, '其它频道共用缓存里的密钥')

  resolver.clear()
  await resolver.resolve('anhui-jjshtv', { now: SIGNING_NOW })
  assert.equal(upstream.configCalls().length, 3, '清缓存后重新拉配置')
})

await checkAsync('源被拒后重新读取官方配置，卫视换域名与流 ID 不改变 ref', async () => {
  let migrated = false
  const upstream = fakeUpstream({ channelConfig: () => migrated
    ? { liveDomain: 'https://seclive.ahsx.ahtv.cn/live/', liveId: 'lailai' } : {} })
  const fetchImpl = async (url, options) => {
    if (migrated && new URL(url).hostname === 'live.ahsx.ahtv.cn') return response('', 403)
    return upstream.fetchImpl(url, options)
  }
  const resolver = createResolver({ fetchImpl })
  assert.match((await resolver.resolve('anhui-ahwssx')).url, /live\.ahsx.*ahwssx\.m3u8/)
  migrated = true
  const current = await resolver.resolve('anhui-ahwssx')
  assert.match(current.url, /^https:\/\/seclive\.ahsx\.ahtv\.cn\/live\/\/lailai\.m3u8/)
  assert.deepEqual(current.upstreamHeaders(current.url), { 'User-Agent': 'ijkplayer' })
  assert.equal(upstream.catalogCalls().length, 2)
})

await checkAsync('seclive 证书主机名不匹配时仅回退到同域 HTTP，成功入口被缓存', async () => {
  const upstream = fakeUpstream({ channelConfig: () => ({ liveDomain: 'https://seclive.ahsx.ahtv.cn/live/' }) })
  let tlsCalls = 0
  const fetchImpl = async (url, options) => {
    if (String(url).startsWith('https://seclive.')) {
      tlsCalls++
      throw new TypeError('fetch failed', { cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' } })
    }
    return upstream.fetchImpl(url, options)
  }
  const resolver = createResolver({ fetchImpl })
  const first = await resolver.resolve('anhui-jjshtv')
  assert.match(first.url, /^http:\/\/seclive\.ahsx\.ahtv\.cn\/live\/\/jjshtv\.m3u8/)
  const second = await resolver.resolve('anhui-jjshtv')
  assert.equal(second.url, first.url)
  assert.equal(tlsCalls, 1, '后续清单轮询复用成功入口')
  assert.equal(upstream.catalogCalls().length, 1)
  assert.notEqual(first.manifestText, second.manifestText, '仍实时拉取清单')
})

await checkAsync('正常 HTTPS、HTTP 403 与其他 TLS 错误不会触发 HTTP 回退', async () => {
  const secure = fakeUpstream({ channelConfig: () => ({ liveDomain: 'https://seclive.ahsx.ahtv.cn/live/' }) })
  const normal = await createResolver({ fetchImpl: secure.fetchImpl }).resolve('anhui-jjshtv')
  assert.ok(normal.url.startsWith('https://seclive.'))
  for (const [host, code] of [['seclive.ahsx.ahtv.cn', 'CERT_HAS_EXPIRED'], ['live.ahsx.ahtv.cn', 'ERR_TLS_CERT_ALTNAME_INVALID']]) {
    const calls = []
    await assert.rejects(requestManifest(`https://${host}/live/x.m3u8`, { fetchImpl: async url => {
      calls.push(url)
      throw new TypeError('fetch failed', { cause: { code } })
    } }))
    assert.equal(calls.length, 1)
    assert.ok(calls[0].startsWith('https:'))
  }
  const calls = []
  await assert.rejects(requestManifest('https://seclive.ahsx.ahtv.cn/live/x.m3u8', { fetchImpl: async url => {
    calls.push(url); return response('', 403)
  } }), /HTTP 403/)
  assert.equal(calls.length, 1)
})

await checkAsync('官方栏目失败不回退到旧域名或固定流 ID', async () => {
  const upstream = fakeUpstream()
  const fetchImpl = async (url, options) => String(url).startsWith(ANHUI_TV_CATALOG_API)
    ? response('', 503) : upstream.fetchImpl(url, options)
  const result = await createResolver({ fetchImpl }).resolve('anhui-ahwssx')
  assert.equal(result.url, '')
  assert.match(result.desc, /电视栏目 HTTP 503/)
  assert.equal(upstream.manifestCalls().length, 0)
})

await checkAsync('缺失的单个频道明确失败，其余频道继续从同一电视组件播放', async () => {
  const upstream = fakeUpstream()
  const fetchImpl = async (url, options) => String(url).startsWith(ANHUI_TV_CATALOG_API)
    ? response(catalogPayload(CHANNELS.slice(1).map(c => channelRecord(c)))) : upstream.fetchImpl(url, options)
  const resolver = createResolver({ fetchImpl })
  const missing = await resolver.resolve('anhui-ahwssx')
  assert.equal(missing.url, '')
  assert.match(missing.desc, /缺少频道配置/)
  const economy = await resolver.resolve('anhui-jjshtv')
  assert.ok(economy.url)
  assert.equal(upstream.manifestCalls().length, 1)
})

await checkAsync('栏目配置短期共享，过期后新频道读取当前配置，活跃清单不重复拉栏目', async () => {
  const upstream = fakeUpstream()
  const resolver = createResolver({ fetchImpl: upstream.fetchImpl })
  await resolver.resolve('anhui-jjshtv', { now: SIGNING_NOW })
  await resolver.resolve('anhui-ahwssx', { now: SIGNING_NOW + TV_CATALOG_TTL_MS - 1 })
  assert.equal(upstream.catalogCalls().length, 1)
  await resolver.resolve('anhui-ystv', { now: SIGNING_NOW + TV_CATALOG_TTL_MS })
  assert.equal(upstream.catalogCalls().length, 2)
  await resolver.resolve('anhui-jjshtv', { now: SIGNING_NOW + TV_CATALOG_TTL_MS * 2 })
  assert.equal(upstream.catalogCalls().length, 2, '有效签名的滚动清单仍直接取媒体')
  assert.equal(upstream.configCalls().length, 1)
  resolver.clear()
  await resolver.resolve('anhui-jjshtv', { now: SIGNING_NOW + TV_CATALOG_TTL_MS * 2 })
  assert.equal(upstream.catalogCalls().length, 3, '清缓存也会重新读取栏目')
})

await checkAsync('七路并发解析共享一次密钥和一次栏目请求，不再访问详情接口', async () => {
  const upstream = fakeUpstream()
  const resolver = createResolver({ fetchImpl: upstream.fetchImpl })
  const results = await Promise.all(CHANNELS.map(channel => resolver.resolve(channel.ref, { now: SIGNING_NOW })))
  assert.ok(results.every(result => result.url))
  assert.equal(upstream.configCalls().length, 1)
  assert.equal(upstream.catalogCalls().length, 1)
  assert.equal(upstream.manifestCalls().length, CHANNELS.length)
  assert.ok(upstream.calls.every(call => !call.url.includes('/content/show/')))
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
  const upstream = fakeUpstream()
  const broken = await createResolver({ fetchImpl: async (url, options) => String(url).startsWith(ANHUI_CONFIG_API)
    ? response('oops', 500) : upstream.fetchImpl(url, options) }).resolve('anhui-jjshtv')
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
