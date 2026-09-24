#!/usr/bin/env node
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'

import xinjiang from '../extractors/xinjiang/index.js'
import {
  CHANNELS,
  XINJIANG_CHANNEL_ENDPOINT,
  XINJIANG_PAGE,
  XINJIANG_TIMESTAMP_URL,
  buildChannels,
  claimsRef,
  createResolver,
  officialAssetUrl,
  officialHlsUrl,
  parseChannelList,
  upstreamHeadersFor,
  validateHls,
} from '../extractors/xinjiang/api.js'
import {
  createSignedParams,
  extractSigningMaterial,
  scriptUrls,
  shanghaiDate,
} from '../extractors/xinjiang/signing.js'
import { getModule, resolverFor } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }
const response = (body, status = 200, headers = {}) => new Response(
  typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers },
)

const now = Date.parse('2029-01-01T00:00:00Z')
const expiry = Math.floor(Date.parse('2030-01-01T00:00:00Z') / 1000)
const uuid = '123e4567-e89b-42d3-a456-426614174000'
const authFor = suffix => `${expiry}-3-3-${String(suffix).padStart(32, '0')}`
const apiPayload = () => ({
  success: true,
  data: [
    ...CHANNELS.map((channel, index) => ({
      Id: Number(channel.channelId),
      SimpleName: channel.callSign,
      IsForbidden: false,
      PlayStreamUrl: `https://slstplay.xjtvs.com.cn${channel.path}?auth_key=${authFor(index + 1)}&aliyun_uuid=${uuid}`,
    })),
    // 官网另有的频道（如 XJTV-6）不认
    { Id: 19, SimpleName: 'XJTV-6', IsForbidden: true, PlayStreamUrl: null },
  ],
})

const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pem = publicKey.export({ type: 'spki', format: 'pem' }).trim()
const signingBundle = `
function Seeds(){const t=["noise","random_string","2029-01-01","date","abcdefghijklmnopqrstuvwxyzABCDEFGH","random_number"];return Seeds=function(){return t},Seeds()}
function decode(x,y){return x=x-400,Seeds()[x]}
const T=decode;
const row={};row[T(403)]=T(402);row[T(401)]=T(404);row[T(405)]=4;
const rows=[row],endpoint="TVChannelList",key=\`${pem}\`;
`

console.log('新疆广电模块测试')

check('模块注册为免账号的新疆清单中继模块', () => {
  assert.equal(getModule('xinjiang'), xinjiang)
  assert.equal(xinjiang.name, '新疆')
  assert.equal(xinjiang.category, undefined)
  assert.equal(xinjiang.channelHlsMode, 'relay')
  assert.equal(xinjiang.relayProxyCompatible, true)
  assert.equal(xinjiang.capabilities.catchup, false)
  assert.equal(xinjiang.catalogVersion, 2)
  assert.deepEqual(xinjiang.configSchema, [])
  assert.equal(resolverFor('xjtv-1'), xinjiang)
  assert.equal(resolverFor('xjtv-8'), xinjiang)
  assert.equal(resolverFor('xjtv-1/extra'), null)
})

await checkAsync('官网七路公开频道固定输出为独立新疆分组', async () => {
  assert.deepEqual(CHANNELS.map(channel => [channel.channelId, channel.callSign]), [
    ['1', 'XJTV-1'],
    ['3', 'XJTV-2'],
    ['4', 'XJTV-3'],
    ['16', 'XJTV-4'],
    ['17', 'XJTV-5'],
    ['21', 'XJTV-7'],
    ['23', 'XJTV-8'],
  ])
  assert.deepEqual(CHANNELS.map(channel => channel.name), [
    '新疆卫视', '维吾尔语新闻综合', '哈萨克语新闻综合', '新疆汉语综艺', '维吾尔语影视', '新疆体育健康', '新疆少儿',
  ])
  const channels = buildChannels()
  assert.deepEqual(channels.map(channel => channel.deferredRef), [
    'xjtv-1', 'xjtv-2', 'xjtv-3', 'xjtv-4', 'xjtv-5', 'xjtv-7', 'xjtv-8',
  ])
  assert.ok(channels.every(channel => channel.catchup === 'none'))
  assert.equal(claimsRef('xjtv-4'), true)
  assert.equal(claimsRef('xjtv-6'), false)
  const result = await xinjiang.fetch()
  assert.deepEqual(result.groups, [{ name: '新疆', dataList: channels }])
})

check('静态解析当天签名配置，不执行官网脚本', () => {
  const material = extractSigningMaterial(signingBundle, '2029-01-01')
  assert.equal(material.date, '2029-01-01')
  assert.equal(material.random_string, 'abcdefghijklmnopqrstuvwxyzABCDEFGH')
  assert.equal(material.random_number, 4)
  assert.equal(material.publicKey, pem)
  assert.throws(() => extractSigningMaterial(signingBundle, '2029-01-02'), /没有 2029-01-02/)
})

check('接口签名、上海日期和 Nuxt 脚本发现均受严格约束', () => {
  const material = extractSigningMaterial(signingBundle, '2029-01-01')
  const signed = createSignedParams(XINJIANG_CHANNEL_ENDPOINT, '1861920000000', material, {
    now, random: () => 0.25,
  })
  assert.match(signed.guid, /^[a-z0-9]+-[a-z0-9]{7}$/)
  assert.match(signed.sign, /^[a-f0-9]{32}[A-Za-z0-9+/]+=*$/)
  assert.equal(shanghaiDate(Date.parse('2028-12-31T16:01:00Z')), '2029-01-01')
  assert.deepEqual(scriptUrls(
    '<script src="/_nuxt/live_A-1.js"></script><script src="https://evil.test/_nuxt/no.js"></script><script src="/plain.js"></script>',
    XINJIANG_PAGE,
  ), ['https://www.xjtvs.com.cn/_nuxt/live_A-1.js'])
})

check('频道接口逐路校验：标禁播、缺席或台号对不上的只跳过那一路，一路都没有才报错', () => {
  const parsed = parseChannelList(apiPayload(), { now })
  assert.equal(parsed.urls.size, 7)
  assert.match(parsed.urls.get('1'), /xjtv1stream\.m3u8/)
  assert.match(parsed.urls.get('16'), /xjtv4stream\.m3u8/)
  const forbidden = apiPayload()
  Object.assign(forbidden.data.find(item => String(item.Id) === '16'), { IsForbidden: true, PlayStreamUrl: null })
  const partial = parseChannelList(forbidden, { now })
  assert.equal(partial.urls.size, 6)
  assert.equal(partial.urls.has('16'), false, '重新标禁播的一路不连累其余六路')
  const incomplete = apiPayload()
  incomplete.data = incomplete.data.filter(item => String(item.Id) !== '23')
  assert.equal(parseChannelList(incomplete, { now }).urls.has('23'), false)
  const swapped = apiPayload()
  swapped.data.find(item => String(item.Id) === '3').SimpleName = 'XJTV-3'
  assert.equal(parseChannelList(swapped, { now }).urls.has('3'), false, '台号对不上的不认')
  assert.throws(() => parseChannelList({ success: true, data: [] }, { now }), /没有返回任何可播放频道/)
  assert.throws(() => parseChannelList('{broken', { now }), /有效 JSON/)
})

check('媒体白名单覆盖签名清单和分片并拒绝外部地址', () => {
  const channel = CHANNELS[0]
  const stream = `https://slstplay.xjtvs.com.cn${channel.path}?auth_key=${authFor(1)}&aliyun_uuid=${uuid}`
  const segment = `https://slstplay.xjtvs.com.cn/xjtv1/segment.ts?auth_key=${authFor(2)}`
  assert.equal(officialHlsUrl(stream, channel, now).url, stream)
  assert.equal(officialAssetUrl(segment), segment)
  assert.deepEqual(upstreamHeadersFor(segment), {
    Origin: 'https://www.xjtvs.com.cn',
    Referer: XINJIANG_PAGE,
  })
  assert.equal(validateHls(`#EXTM3U\n#EXTINF:6,\n${segment}\n`, stream).startsWith('#EXTM3U'), true)
  for (const bad of [
    `http://slstplay.xjtvs.com.cn/xjtv1/a.ts?auth_key=${authFor(1)}`,
    `https://slstplay.xjtvs.com.cn.evil.test/xjtv1/a.ts?auth_key=${authFor(1)}`,
    `https://user:pass@slstplay.xjtvs.com.cn/xjtv1/a.ts?auth_key=${authFor(1)}`,
    `https://slstplay.xjtvs.com.cn/private/a.ts?auth_key=${authFor(1)}`,
    'https://slstplay.xjtvs.com.cn/xjtv1/a.ts',
  ]) assert.throws(() => officialAssetUrl(bad))
  assert.throws(() => validateHls('#EXTM3U\nhttps://evil.test/a.ts\n', stream))
})

await checkAsync('首次播放完成签名发现，各路共享短效入口缓存但每次刷新清单', async () => {
  let pageRequests = 0
  let scriptRequests = 0
  let timestampRequests = 0
  let channelRequests = 0
  let manifestRequests = 0
  const fetchImpl = async raw => {
    const url = new URL(raw)
    if (url.href === XINJIANG_PAGE) {
      pageRequests++
      return response('<script src="/_nuxt/live_A-1.js"></script>')
    }
    if (url.href === 'https://www.xjtvs.com.cn/_nuxt/live_A-1.js') {
      scriptRequests++
      return response(signingBundle)
    }
    if (url.href === XINJIANG_TIMESTAMP_URL) {
      timestampRequests++
      return response({ success: true, data: '1861920000000' })
    }
    if (url.origin === 'https://slstapi.xjtvs.com.cn' && url.pathname === XINJIANG_CHANNEL_ENDPOINT) {
      channelRequests++
      assert.equal(url.searchParams.get('type'), '1')
      assert.equal(url.searchParams.get('json'), 'true')
      assert.equal(url.searchParams.get('stamp'), '1861920000000')
      assert.match(url.searchParams.get('sign') || '', /^[a-f0-9]{32}[A-Za-z0-9+/]+=*$/)
      return response(apiPayload())
    }
    if (url.hostname === 'slstplay.xjtvs.com.cn') {
      manifestRequests++
      const directory = url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1)
      return response(`#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${manifestRequests}\n#EXTINF:6,\n${directory.slice(1)}segment.ts?auth_key=${authFor(manifestRequests + 10)}\n`)
    }
    throw new Error(`unexpected URL: ${url.href}`)
  }
  const resolver = createResolver({ fetchImpl })
  const satellite = await resolver.resolve('xjtv-1', { now, random: () => 0.25 })
  const kids = await resolver.resolve('xjtv-8', { now: now + 1000, random: () => 0.25 })
  assert.equal(pageRequests, 1)
  assert.equal(scriptRequests, 1)
  assert.equal(timestampRequests, 1)
  assert.equal(channelRequests, 1)
  assert.equal(manifestRequests, 2)
  assert.match(satellite.manifestText, /MEDIA-SEQUENCE:1/)
  assert.match(kids.manifestText, /MEDIA-SEQUENCE:2/)
  assert.equal(satellite.relayHls, true)
  assert.equal(satellite.upstreamUrlTransform(
    `https://slstplay.xjtvs.com.cn/xjtv1/a.ts?auth_key=${authFor(99)}`,
  ).includes('/xjtv1/a.ts'), true)
})

await checkAsync('清缓存后会重新发现官网当天脚本和短效入口', async () => {
  let pageRequests = 0
  const fetchImpl = async raw => {
    const url = new URL(raw)
    if (url.href === XINJIANG_PAGE) {
      pageRequests++
      return response('<script src="/_nuxt/live_A-1.js"></script>')
    }
    if (url.pathname === '/_nuxt/live_A-1.js') return response(signingBundle)
    if (url.href === XINJIANG_TIMESTAMP_URL) return response({ data: '1861920000000' })
    if (url.pathname === XINJIANG_CHANNEL_ENDPOINT) return response(apiPayload())
    if (url.hostname === 'slstplay.xjtvs.com.cn') {
      return response(`#EXTM3U\n#EXTINF:6,\nsegment.ts?auth_key=${authFor(7)}\n`)
    }
    throw new Error(`unexpected URL: ${url.href}`)
  }
  const resolver = createResolver({ fetchImpl })
  assert.notEqual((await resolver.resolve('xjtv-1', { now })).url, '')
  resolver.clear()
  assert.notEqual((await resolver.resolve('xjtv-1', { now })).url, '')
  assert.equal(pageRequests, 2)
})

console.log(`\n全部通过：${passed}/8 ✅`)
