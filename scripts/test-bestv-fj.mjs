#!/usr/bin/env node
/** 2026-10-29 真实目录/响应裁剪夹具；签名目录使用合成值，不保存 clientID 或播放凭据。 */
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import module from '../extractors/bestv-fj/index.js'
import { CHANNELS, DEFAULT_CHANNEL_IDS, refOf } from '../extractors/bestv-fj/channels.js'
import { buildChannels, createResolver, mediaUrl, selectedIds, validateManifest } from '../extractors/bestv-fj/api.js'
import { API_BASE, createApiClient } from '../extractors/bestv-fj/auth.js'
import { getModule, resolverFor, listModules } from '../extractors/registry.js'
import { resolveConfig, validateConfig, ExtractorManager } from '../utils/extractorManager.js'

const catalog = JSON.parse(readFileSync(new URL('./fixtures/bestv-fj/catalog.json', import.meta.url)))
const stream = token => `http://fjnetv51.live.bestvcdn.com.cn/${token.repeat(64)}/live/program/live/hxjchd/4000000/mnf.m3u8?userid=test`
const manifest = sequence => `#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n#EXTINF:10,\n2026102922/${sequence}.ts\n`
const response = json => new Response(JSON.stringify(json))
const play = url => ({ tvid: 219, state: 'live', paid: false, contentIsFree: false, validSeconds: 300, tv_name: '多彩文体4K', playUrl: url })
let passed = 0
async function check(name, fn) { await fn(); passed++; console.log(`  ✅ ${name}`) }

await check('模块默认关，64 路可选、预选七路、旧 ID 205 不认领', () => {
  assert.equal(getModule('bestv-fj'), module)
  assert.equal(module.name, '百视通')
  assert.equal(module.region, '百视通')
  assert.equal(module.defaultEnabled, false)
  assert.equal(module.channelHlsMode, 'relay')
  assert.equal(module.channelHlsModeForConfig({}), 'relay')
  assert.equal(module.channelHlsModeForConfig({ networkMode: 'ipv6' }), 'proxy')
  assert.equal(resolveConfig(module).networkMode, 'auto')
  assert.equal(validateConfig(module, { networkMode: 'ipv6' }).ok, true)
  assert.equal(validateConfig(module, { networkMode: 'invalid' }).ok, false)
  assert.equal(module.relayProxyCompatible, true)
  assert.equal(module.capabilities.catchup, false)
  assert.equal(CHANNELS.length, 64)
  assert.equal(new Set(CHANNELS.map(c => c.id)).size, 64)
  assert.deepEqual(selectedIds(resolveConfig(module)), DEFAULT_CHANNEL_IDS)
  assert.equal(resolverFor(refOf('219')), module)
  for (const ref of ['bestv-fj-205', 'bestv-fj-999', 'bestv-fj-219/extra']) assert.equal(module.claimsRef(ref), false)
  assert.equal(validateConfig(module, { channels: [] }).ok, false)
  assert.equal(validateConfig(module, { channels: ['205'] }).ok, false)
  assert.equal(validateConfig(module, { channels: CHANNELS.map(c => c.id) }).ok, true)
});
await check('官方目录七路与完整 64 路可构建，台标来自平台、频道对象不含签名地址', async () => {
  const defaults = buildChannels(catalog, DEFAULT_CHANNEL_IDS)
  assert.equal(defaults.length, 7)
  assert.equal(buildChannels(catalog, CHANNELS.map(c => c.id)).length, 64)
  assert.ok(defaults.every(c => c.logo.startsWith('https://tvappstatic.bestv.com.cn/images/') && c.relayHls && !c.url && c.catchup === 'none'))
  let calls = 0
  const result = await module.fetch({}, { fetchImpl: async url => { calls++; return response(url.includes('client-id-by-region') ? { clientID: 'test' } : catalog) } })
  assert.equal(calls, 2)
  assert.deepEqual(result.groups[0].dataList, defaults)
});
await check('目录结构变化、频道消失、第三方台标不当作抓取成功', () => {
  assert.throws(() => buildChannels({}, DEFAULT_CHANNEL_IDS))
  assert.equal(buildChannels([], DEFAULT_CHANNEL_IDS).length, 0) // 空目录由 fetch 判失败，见地区版目录一项
  const bad = structuredClone(catalog)
  bad.flatMap(g => g.items).find(c => c.id === 219).icon = 'http://127.0.0.1/logo.png'
  assert.throws(() => buildChannels(bad, DEFAULT_CHANNEL_IDS))
  const stopped = structuredClone(catalog)
  stopped.flatMap(g => g.items).find(c => c.id === 219).enabled = 0
  assert.equal(buildChannels(stopped, DEFAULT_CHANNEL_IDS).length, 6)
  const conflict = structuredClone(catalog)
  conflict[0].items.push({ ...conflict.flatMap(g => g.items).find(c => c.id === 219), icon: 'https://tvappstatic.bestv.com.cn/images/x/other.png' })
  assert.throws(() => buildChannels(conflict, DEFAULT_CHANNEL_IDS), /未唯一列出频道 219/)
});
await check('地区版目录缺台只跳过：上海版目录出三路并写明跳过哪些，一路都没有才失败', async () => {
  // 2026-10-29 镇江上海移动出口（AS24400）拿到的真实目录，字段裁剪同 catalog.json
  const shanghai = JSON.parse(readFileSync(new URL('./fixtures/bestv-fj/catalog-shanghai.json', import.meta.url)))
  const absent = []
  assert.deepEqual(buildChannels(shanghai, DEFAULT_CHANNEL_IDS, absent).map(c => c.name), ['都市剧场', '东方财经', '生活时尚'])
  assert.deepEqual(absent, ['219', '222', '225', '226'])
  const fetchWith = payload => async url => response(url.includes('client-id-by-region') ? { clientID: 'test' } : payload)
  const result = await module.fetch({}, { fetchImpl: fetchWith(shanghai) })
  assert.equal(result.groups[0].dataList.length, 3)
  assert.deepEqual(result.meta.skipped, ['219', '222', '225', '226'])
  assert.deepEqual(result.meta.warnings, ['这台服务器拿到的官方目录里没有多彩文体4K、动漫秀场、乐游、法治天地（百视通按地区下发频道），已跳过'])
  const stopped = structuredClone(shanghai)
  stopped.flatMap(g => g.items).filter(c => c.id === 230).forEach(c => { c.enabled = 0 })
  assert.deepEqual((await module.fetch({}, { fetchImpl: fetchWith(stopped) })).meta.warnings.at(-1), '官方目录已停用 1 个选中频道')
  await assert.rejects(module.fetch({ channels: '219\n222' }, { fetchImpl: fetchWith(shanghai) }), /没有已选择的频道/)
  await assert.rejects(module.fetch({}, { fetchImpl: fetchWith([]) }), /没有已选择的频道/)
  assert.equal((await module.fetch({}, { fetchImpl: fetchWith(catalog) })).meta.warnings.length, 0)
});
await check('媒体与分片锁定同一 CDN、频道、签名目录，拒绝变成加密/点播/子清单', () => {
  const url = stream('A')
  assert.equal(validateManifest(manifest(10), url), manifest(10))
  for (const raw of ['http://127.0.0.1/a.ts', stream('B'), url.replace('hxjchd', 'cctv1hd'), url.replace('fjnetv51', 'evil'), url.replace('http:', 'file:')]) assert.throws(() => mediaUrl(raw, url))
  // 上海版目录的播放节点
  const dongfang = url.replace('fjnetv51.live', 'dongfang5g-pc-v52-live').replace('hxjchd', 'dsjchd')
  assert.equal(mediaUrl(dongfang), dongfang)
  assert.equal(validateManifest(manifest(10), dongfang), manifest(10))
  for (const raw of [dongfang.replace('dongfang5g-pc-v52-live', 'dongfang5g-pc-v52-live.evil'), dongfang.replace('.bestvcdn.com.cn', '.bestvcdn.com.cn.evil.test')]) assert.throws(() => mediaUrl(raw))
  for (const text of [manifest(1) + '#EXT-X-ENDLIST', manifest(1) + '#EXT-X-KEY:METHOD=AES-128,URI="key"', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\na.m3u8', manifest(1).replace('2026102922/1.ts', 'http://evil.test/a.ts')]) assert.throws(() => validateManifest(text, url))
});
await check('并发只取一次票、每次读实时清单；两分钟换播放票、七分钟换 clientID', async () => {
  let time = 0, clients = 0, plays = 0, manifests = 0
  const resolver = createResolver({ now: () => time, fetchImpl: async (url, opts) => {
    assert.equal(opts.redirect, 'manual')
    if (url.includes('client-id-by-region')) { clients++; return response({ clientID: `test-${clients}` }) }
    if (url.startsWith(API_BASE)) {
      assert.match(opts.headers.timestamp, /^\d+$/)
      assert.match(opts.headers.sign, /^[a-f0-9]{32}$/)
      plays++; return response(play(stream(String.fromCharCode(64 + plays))))
    }
    manifests++; return new Response(manifest(100 + manifests))
  } })
  const first = await Promise.all([resolver.resolve(refOf('219')), resolver.resolve(refOf('219'))])
  assert.ok(first.every(r => r.url && r.relayHls && r.manifestText))
  assert.equal(clients, 1); assert.equal(plays, 1); assert.equal(manifests, 2)
  time = 121000
  assert.notEqual((await resolver.resolve(refOf('219'))).url, first[0].url)
  assert.equal(clients, 1); assert.equal(plays, 2)
  time = 421000
  assert.ok((await resolver.resolve(refOf('219'))).url)
  assert.equal(clients, 2); assert.equal(plays, 3)
});
await check('CDN 提前拒绝旧签名就重新取票；失败不返回旧流', async () => {
  let plays = 0, rejectOld = false, offline = false
  const resolver = createResolver({ fetchImpl: async url => {
    if (url.includes('client-id-by-region')) return response({ clientID: 'test' })
    if (url.startsWith(API_BASE)) { if (offline) throw new Error('secret-url'); plays++; return response(play(stream(plays === 1 ? 'A' : 'B'))) }
    if (rejectOld && url === stream('A')) return new Response('', { status: 403 })
    return new Response(manifest(100))
  } })
  assert.equal((await resolver.resolve(refOf('219'))).url, stream('A'))
  rejectOld = true
  assert.equal((await resolver.resolve(refOf('219'))).url, stream('B'))
  assert.equal(plays, 2)
  resolver.clear(); offline = true
  const result = await resolver.resolve(refOf('219'))
  assert.equal(result.url, '')
  assert.ok(!result.desc.includes('secret-url'))
});
await check('付费、错误频道、缺有效期、非直播均不放行，未知 ref 不访问上游', async () => {
  for (const override of [{ paid: true }, { paid: undefined }, { state: 'vod' }, { tvid: 220 }, { validSeconds: 0 }]) {
    let media = 0
    const resolver = createResolver({ fetchImpl: async url => {
      if (url.includes('client-id-by-region')) return response({ clientID: 'test' })
      if (url.startsWith(API_BASE)) return response({ ...play(stream('A')), ...override })
      media++; return new Response(manifest(1))
    } })
    assert.equal((await resolver.resolve(refOf('219'))).url, '')
    assert.equal(media, 0)
  }
  const resolver = createResolver({ fetchImpl: () => { throw new Error('should not run') } })
  assert.equal((await resolver.resolve('bestv-fj-205')).url, '')
});
await check('上海版明确免费频道允许 paid=true + contentIsFree=true，未标免费仍拒绝', async () => {
  // 2026-10-30 真实匿名上海身份的福建新闻 / 陕西卫视等响应；播放目录使用合成签名。
  for (const contentIsFree of [true, false, undefined, 'true']) {
    const url = stream('A').replace('fjnetv51.live', 'dongfang5g-pc-v52-live').replace('hxjchd', 'fjxwpd')
    const resolver = createResolver({ fetchImpl: async target => {
      if (target.includes('client-id-by-region')) return response({ clientID: 'test' })
      if (target.startsWith(API_BASE)) return response({ tvid: '157', tv_name: '福建新闻', state: 'live', paid: true, contentIsFree, validSeconds: 17900, playUrl: url })
      return new Response(manifest(100))
    } })
    const result = await resolver.resolve(refOf('157'))
    assert.equal(Boolean(result.url), contentIsFree === true)
  }
});
await check('IPv6 模式要求媒体全代理并将同一地址族交给分片链路', async () => {
  const resolver = createResolver({ family: 6, fetchImpl: async url => {
    if (url.includes('client-id-by-region')) return response({ clientID: 'test' })
    if (url.startsWith(API_BASE)) return response(play(stream('A')))
    return new Response(manifest(100))
  } })
  const result = await resolver.resolve(refOf('219'))
  assert.equal(result.proxyHls, true)
  assert.equal(result.upstreamFamily, 6)
  assert.ok(result.manifestText.startsWith('#EXTM3U'))
});
await check('切换网络模式立即覆盖旧磁盘频道的路由，无需等旧缓存过期', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bestv-mode-test-'))
  try {
    const modules = Object.fromEntries(listModules().map(m => [m.id, { enabled: false }]))
    modules['bestv-fj'] = { enabled: true, config: { networkMode: 'ipv6' } }
    writeFileSync(join(dir, 'extractors.json'), JSON.stringify({ masterSwitchRetired: true, modules }))
    writeFileSync(join(dir, 'extractor-cache.json'), JSON.stringify({ modules: { 'bestv-fj': {
      catalogVersion: module.catalogVersion,
      groups: [{ name: '百视通', dataList: [{ name: '多彩文体4K', deferredRef: refOf('219'), relayHls: true }] }],
      health: { lastSuccessAt: Date.now(), channelCount: 1 },
    } } }))
    const manager = new ExtractorManager()
    manager.configPath = join(dir, 'extractors.json')
    manager.cachePath = join(dir, 'extractor-cache.json')
    manager.legacyConfigPath = join(dir, 'system-config.json')
    manager.load()
    let channel = manager.getValidChannels().flatMap(g => g.dataList).find(c => c.deferredRef === refOf('219'))
    assert.equal(channel.proxyHls, true)
    assert.equal(channel.relayHls, false)
    manager.updateModuleConfig('bestv-fj', { networkMode: 'auto' })
    channel = manager.getValidChannels().flatMap(g => g.dataList).find(c => c.deferredRef === refOf('219'))
    assert.equal(channel.proxyHls, false)
    assert.equal(channel.relayHls, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
});
await check('API 拒绝 clientID 时仅更新一次；超大响应与跳转失败', async () => {
  let clients = 0, attempts = 0
  const api = createApiClient({ fetchImpl: async url => {
    if (url.includes('client-id-by-region')) { clients++; return response({ clientID: `client-${clients}` }) }
    attempts++; return attempts === 1 ? new Response('', { status: 401 }) : response(catalog)
  } })
  assert.deepEqual(await api.request('/tvs'), catalog)
  assert.equal(clients, 2); assert.equal(attempts, 2)
  for (const res of [new Response('', { status: 302, headers: { Location: 'http://127.0.0.1/' } }), new Response('x', { headers: { 'Content-Length': '2000000' } })]) {
    const bad = createApiClient({ fetchImpl: async () => res })
    await assert.rejects(bad.request('/tvs'))
  }
});
console.log(`\n百视通福建：${passed} 项通过`)
