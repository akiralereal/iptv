#!/usr/bin/env node
/** 按 2026-10-17 看度官方响应裁剪；签名均为离线假值。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import chengdu from '../extractors/chengdu/index.js'
import { getModule, resolverFor } from '../extractors/registry.js'
import { API_BASE, CHANNELS, claimsRef, createResolver, officialPlayUrl } from '../extractors/chengdu/api.js'
import { packLogoUrl } from '../utils/logoPack.js'

const main = CHANNELS[0]
const county = CHANNELS.find(channel => channel.id === 'jy')
// 2026-10-17 官方响应里的主机与路径形态；模块本身只校验 cditv.cn 域与频道标识。
const sampleHost = channel => channel.main ? 'cdn1.cditv.cn' : channel.id === 'jn' ? 'jntv.pull.cditv.cn' : 'quxian.pull.cditv.cn'
const samplePaths = channel => {
  const [key, high] = channel.streamKeys
  const file = key === 'dangjiao' ? key : key.toUpperCase()
  return channel.main
    ? [`/${high}/${file}High.flv/playlist.m3u8`, `/${key}/${file}.flv/playlist.m3u8`]
    : [`/live/${key}.flv/playlist.m3u8`]
}
const urlFor = (channel, token = 'fake', path = samplePaths(channel)[0], protocol = 'https:', host = sampleHost(channel)) =>
  `${protocol}//${host}${path}?wsSecret=${token}&wsTime=ffffffff`
const payload = (data, extra = {}) => ({ state: true, result: 1, code: 0, data, ...extra })
const response = data => new Response(JSON.stringify(payload(data)))

test('成都独立注册，默认开启、归入四川，27 路只持久化频道引用', async () => {
  assert.equal(getModule('chengdu'), chengdu)
  assert.equal(chengdu.name, '成都')
  assert.notEqual(chengdu.defaultEnabled, false)
  assert.equal(chengdu.outputGroupName, '四川')
  assert.equal(chengdu.capabilities.catchup, false)
  assert.equal(chengdu.channelHlsMode, undefined, '默认使用 302，媒体不经过 NAS')
  const result = await chengdu.fetch()
  assert.equal(result.groups[0].name, '四川')
  assert.equal(result.groups[0].dataList.length, 27)
  assert.equal(new Set(CHANNELS.map(channel => channel.code)).size, 27)
  assert.equal(CHANNELS.filter(channel => channel.main).length, 7)
  assert.equal(CHANNELS.find(channel => channel.id === 'cdtv4').code, 45)
  for (const row of result.groups[0].dataList) {
    assert.equal(row.catchup, 'none')
    assert.equal(row.url, undefined)
    assert.equal(resolverFor(row.deferredRef), chengdu)
  }
  assert.ok(!JSON.stringify(result).includes('wsSecret'))
})

test('只认领确切频道引用，裸短名与其它模块不冲突', async () => {
  let calls = 0
  const resolver = createResolver({ fetchImpl: async () => { calls++; throw new Error('unexpected') } })
  for (const ref of ['cdtv1', 'jy', 'chengdu-lq', 'chengdu-unknown', 'chengdu-cdtv1/extra', 'chengdu-cdtv1?x=1', '__proto__', null]) {
    assert.equal(claimsRef(ref), false)
    assert.equal((await resolver.resolve(ref)).url, '')
  }
  assert.equal(calls, 0)
  assert.equal(resolverFor('chengdu-lq'), null, '旧龙泉入口不再触发上游解析')
})

test('新版官网频道图进入目录，27 路均有本机内置台标兜底', async () => {
  assert.equal(chengdu.catalogVersion, 1, '模块未发布过，目录版本从 1 起')
  const rows = (await chengdu.fetch()).groups[0].dataList
  assert.equal(rows.filter(row => row.logo).length, 24)
  for (const row of rows) {
    if (row.logo) assert.equal(new URL(row.logo).hostname, 'cmsimg.cditv.cn')
    const packed = packLogoUrl({ ...row, sourceId: 'xt:chengdu' }, '四川')
    assert.ok(packed.includes(`/logo-pack/${encodeURIComponent(row.name)}.png?v=`), row.name)
  }
  for (const id of ['cz', 'djy', 'xj']) {
    assert.equal(CHANNELS.find(row => row.id === id).logo, '', '资料库图片只进内置包，不作为外部图链下发')
  }
})

test('主频道优先高清并升级 HTTPS；缺高清时用标清；每次播放重新获取签名', async () => {
  let token = 'first', hd = true, calls = 0
  const resolver = createResolver({ fetchImpl: async (url, options) => {
    calls++
    assert.equal(url, `${API_BASE}192-1.html`)
    assert.equal(options.redirect, 'manual')
    assert.ok(options.signal instanceof AbortSignal)
    return response({
      android_HDlive_url: hd ? urlFor(main, token, samplePaths(main)[0], 'http:') : '',
      android_url: urlFor(main, token, samplePaths(main)[1], 'http:'),
    })
  } })
  const first = await resolver.resolve(main.ref)
  assert.equal(first.url, urlFor(main, 'first'))
  assert.equal(first.manifestText, undefined)
  assert.equal(first.relayHls, undefined)
  token = 'second'
  assert.equal((await resolver.resolve(main.ref)).url, urlFor(main, 'second'))
  hd = false
  assert.equal((await resolver.resolve(main.ref)).url, urlFor(main, token, samplePaths(main)[1]))
  assert.equal(calls, 3, '只请求 JSON 接口，不预取调度清单或媒体')
})

test('区县使用 android_url 并保留官方协议；蓉城先锋与金牛使用各自路径', async () => {
  const resolver = createResolver({ fetchImpl: async () => response({
    android_HDlive_url: urlFor(main), android_url: urlFor(county, 'county', undefined, 'http:'),
  }) })
  assert.equal((await resolver.resolve(county.ref)).url, urlFor(county, 'county', undefined, 'http:'))
  for (const channel of CHANNELS) {
    for (const path of samplePaths(channel)) assert.equal(officialPlayUrl(urlFor(channel, 'x', path), channel), urlFor(channel, 'x', path))
  }
  assert.equal(samplePaths(CHANNELS.find(channel => channel.id === 'cdrcxf'))[0], '/dangjiaohigh/dangjiaoHigh.flv/playlist.m3u8')
})

test('官方换 CDN 子域或路径形态仍可用，只要在 cditv.cn 域内且频道标识一致', () => {
  for (const host of ['cditv.cn', 'cdn2.cditv.cn', 'new.pull.cditv.cn', 'CDN1.CDITV.CN']) {
    const url = urlFor(main, 'x', undefined, 'https:', host)
    assert.equal(officialPlayUrl(url, main), new URL(url).href)
  }
  assert.ok(officialPlayUrl(urlFor(main, 'x', '/cdtv1high/index.m3u8'), main))
  assert.ok(officialPlayUrl(urlFor(county, 'x', '/live/jianyang.flv/playlist.m3u8', 'https:'), county))
})

test('高清地址不合规时退回标清，两者都不合规才报错', async () => {
  const resolve = data => createResolver({ fetchImpl: async () => response(data) }).resolve(main.ref)
  const sd = urlFor(main, 'sd', samplePaths(main)[1], 'http:')
  for (const badHd of ['https://evil.example/cdtv1high/CDTV1High.flv/playlist.m3u8?wsSecret=x&wsTime=1',
    urlFor(main, 'hd').split('?')[0], 'not a url']) {
    const result = await resolve({ android_HDlive_url: badHd, android_url: sd })
    assert.equal(result.url, urlFor(main, 'sd', samplePaths(main)[1]))
  }
  const failed = await resolve({ android_HDlive_url: 'https://evil.example/a.m3u8', android_url: 'https://evil.example/b.m3u8' })
  assert.equal(failed.url, '')
  assert.match(failed.desc, /不符合频道配置/)
})

test('拒绝非官方、跨频道、无签名与非 HTTP 地址', () => {
  const good = urlFor(main)
  for (const bad of [
    good.replace('cdn1.cditv.cn', 'evil.example'), good.replace('cdn1.cditv.cn', 'cdn1.cditv.cn.evil.example'),
    good.replace('cdn1.cditv.cn', 'evilcditv.cn'), good.replace('cdn1.cditv.cn', 'cditv.cn.evil.example'),
    good.replace('https:', 'file:'), good.replace('https:', 'ftp:'), good.replace('cdn1.cditv.cn', 'user:pass@cdn1.cditv.cn'),
    good.replace('cdn1.cditv.cn', 'cdn1.cditv.cn:8080'), good + '#fragment', good.split('?')[0],
    good.replace('wsTime=ffffffff', 'x=1'), good.replace('wsSecret=fake&', ''),
    good.replace('playlist.m3u8', 'playlist.mp4'), good.replace('cdtv1high', 'cdtv2high'),
    urlFor(main, 'x', '/live/playlist.m3u8'), urlFor(main, 'x', '/playlist.m3u8'),
    urlFor(county), urlFor(CHANNELS.find(channel => channel.id === 'cdtv2')), 'not a url',
  ]) assert.throws(() => officialPlayUrl(bad, main))
})

test('错误、空数据、坏 JSON、跳转、超大响应与超时均有明确失败结果', async () => {
  const cases = [
    [() => new Response('failure', { status: 503 }), /HTTP 503/],
    [() => new Response('', { status: 302, headers: { Location: 'https://evil.example/' } }), /HTTP 302/],
    [() => new Response('<html>error</html>'), /无效 JSON/],
    [() => new Response(JSON.stringify(payload({}, { state: false }))), /没有可用频道数据/],
    [() => new Response(JSON.stringify(payload({}, { result: 0 }))), /没有可用频道数据/],
    [() => new Response(JSON.stringify(payload({}, { code: 1 }))), /没有可用频道数据/],
    [() => response(null), /没有可用频道数据/],
    [() => response({}), /没有直播地址/],
    [() => new Response('x', { headers: { 'Content-Length': '524289' } }), /响应过大/],
    [() => new Response('x'.repeat(524289)), /响应过大/],
    [() => { throw new DOMException('timeout', 'TimeoutError') }, /请求超时/],
    [() => { throw new Error('network details should not leak') }, /网络请求失败/],
  ]
  for (const [fetchImpl, expected] of cases) {
    const result = await createResolver({ fetchImpl }).resolve(main.ref)
    assert.equal(result.url, '')
    assert.match(result.desc, expected)
  }
})

test('响应体读取期间的超时也可控，不吞掉异常导致请求挂起', async () => {
  const fetchImpl = async () => new Response(new ReadableStream({
    start(controller) { controller.error(new DOMException('timeout', 'TimeoutError')) },
  }))
  assert.match((await createResolver({ fetchImpl }).resolve(main.ref)).desc, /请求超时/)
})
