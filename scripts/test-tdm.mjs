#!/usr/bin/env node
/**
 * 澳广视（TDM）模块：路由改写与官网播放器一致、只放行澳广视域名、路由缓存与一时失败沿用、
 * 大陆取不到时给出可读原因。夹具按 2026-10-06 的真实响应裁剪（海外与澳门本地两种路由）。
 */
import assert from 'node:assert/strict'
import { getModule, listModules, resolverFor, validateModule } from '../extractors/registry.js'
import {
  applyDomainRoute, buildChannels, claimsRef, createResolver, officialStreamUrl, parseRoute, ROUTE_API, ROUTE_TTL_MS,
} from '../extractors/tdm/api.js'
import { CHANNELS } from '../extractors/tdm/channels.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

// 香港 / 台湾 / 日本 / 美国拿到的路由（Globalping 与洛杉矶出口一致）
const OVERSEAS = { message: 'OK', code: 0, type: 'Success', data: {
  domains: {
    'https://vod4.tdm.com.mo': 'https://vod5.tdm.com.mo',
    'https://live3.tdm.com.mo': 'https://live5.tdm.com.mo',
    'https://locallive.tdm.com.mo': 'https://globallive.tdm.com.mo',
    'https://localvod.tdm.com.mo': 'https://globalvod.tdm.com.mo',
  },
  videoDomain: 'https://vod4.tdm.com.mo', liveDomain: 'https://locallive.tdm.com.mo',
  sourceVideoDomain: 'https://vod3.tdm.com.mo', sourceLiveDomain: 'https://live3.tdm.com.mo',
} }
// 澳门本地探针拿到的：domains 映射到自己
const MACAU = { message: 'OK', data: {
  domains: { 'https://live3.tdm.com.mo': 'https://live3.tdm.com.mo', 'https://locallive.tdm.com.mo': 'https://locallive.tdm.com.mo' },
  liveDomain: 'https://locallive.tdm.com.mo', sourceLiveDomain: 'https://live3.tdm.com.mo',
} }

const jsonResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, body: null })

console.log('澳广视（TDM）模块测试')

check('模块定义：六套自办台、默认关闭、并进「澳门」组、播放时取流', () => {
  const module = getModule('tdm')
  assert.doesNotThrow(() => validateModule(module))
  assert.equal(module.defaultEnabled, false, '取流要服务端连官网，大陆连不上，交给用户打开')
  assert.equal(module.outputGroupName, '澳门')
  assert.equal(module.capabilities.resolve, true)
  assert.equal(module.channelHlsMode, undefined, '海外 CDN 不看来源头，302 直连即可')
  assert.deepEqual(CHANNELS.map(channel => channel.name), ['澳视澳门', '澳视葡文', '澳门体育', '澳门资讯', '澳门综艺', '澳门-Macau'])
  const ids = listModules().map(item => item.id)
  assert.equal(ids.indexOf('tdm'), ids.indexOf('lotustv') + 1, '和莲花卫视挨着，澳门组里莲花卫视在前')
})

check('频道：地址是官网源地址、台标是官网图，ref 归本模块路由', () => {
  const channels = buildChannels()
  assert.equal(channels.length, 6)
  for (const channel of channels) {
    assert.ok(claimsRef(channel.deferredRef))
    assert.equal(resolverFor(channel.deferredRef)?.id, 'tdm')
    assert.match(channel.logo, /^https:\/\/cdn2\.tdm\.com\.mo\/uploads\/attachment\/\d{4}-\d{2}\/[0-9a-f]{32}\.png$/)
    assert.equal(channel.catchup, 'none')
  }
  for (const channel of CHANNELS) assert.match(channel.streamUrl, /^https:\/\/live3\.tdm\.com\.mo\/[\w/.-]+\/playlist\.m3u8$/)
  assert.equal(claimsRef('tdm-cgtn'), false, '转播的 CGTN 不收')
})

check('路由改写与官网播放器一致：海外换到 globallive，澳门本地留在 locallive', () => {
  const raw = 'https://live3.tdm.com.mo/ch1/ch1.live/playlist.m3u8'
  assert.equal(applyDomainRoute(raw, parseRoute(OVERSEAS)), 'https://globallive.tdm.com.mo/ch1/ch1.live/playlist.m3u8')
  assert.equal(applyDomainRoute(raw, parseRoute(MACAU)), 'https://locallive.tdm.com.mo/ch1/ch1.live/playlist.m3u8')
  assert.equal(applyDomainRoute(raw, {}), raw, '没有路由就不改')
  assert.throws(() => parseRoute({ data: { domains: {} } }), /没有返回直播域名/)
})

check('只放行澳广视自己的 https 域名与 m3u8', () => {
  assert.equal(officialStreamUrl('https://globallive.tdm.com.mo/ch1/ch1.live/playlist.m3u8'),
    'https://globallive.tdm.com.mo/ch1/ch1.live/playlist.m3u8')
  for (const bad of [
    'http://globallive.tdm.com.mo/ch1/ch1.live/playlist.m3u8',
    'https://globallive.tdm.com.mo:8443/ch1/ch1.live/playlist.m3u8',
    'https://evil.example/ch1/ch1.live/playlist.m3u8',
    'https://tdm.com.mo.evil.example/ch1.m3u8',
    'https://globallive.tdm.com.mo/ch1/ch1.live/segment.ts',
    'not a url',
  ]) assert.throws(() => officialStreamUrl(bad), /澳广视/, bad)
})

await checkAsync('取流：路由缓存 5 分钟，到期重取；一时取不到沿用上一次的', async () => {
  const calls = []
  let fail = false
  const fetchImpl = async (url, init) => {
    calls.push(url)
    assert.equal(url, ROUTE_API)
    assert.match(init.headers.Referer, /tdm\.com\.mo/)
    if (fail) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ETIMEDOUT' } })
    return jsonResponse(OVERSEAS)
  }
  const { resolve } = createResolver({ fetchImpl })
  const t0 = 1_800_000_000_000
  const first = await resolve('tdm-ctvp', { now: t0 })
  assert.equal(first.url, 'https://globallive.tdm.com.mo/ch1/ch1.live/playlist.m3u8')
  const second = await resolve('tdm-sports', { now: t0 + 1000 })
  assert.equal(second.url, 'https://globallive.tdm.com.mo/ch4/sport_ch4.live/playlist.m3u8')
  assert.equal(calls.length, 1, '五分钟内共用一次路由')

  fail = true
  const stale = await resolve('tdm-info', { now: t0 + ROUTE_TTL_MS + 1 })
  assert.equal(stale.url, 'https://globallive.tdm.com.mo/ch5/info_ch5.live/playlist.m3u8', '取不到时沿用上一次的路由')
  assert.equal(calls.length, 2)
})

await checkAsync('从没取到过路由（大陆网络）：频道照留，播放时给出可读原因；不在白名单的域名不下发', async () => {
  const blocked = createResolver({ fetchImpl: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ETIMEDOUT' } }) } })
  const result = await blocked.resolve('tdm-ctvp', {})
  assert.equal(result.url, '')
  assert.match(result.desc, /澳视澳门 取流失败：ETIMEDOUT（澳广视官网与视频只对大陆以外开放）/)

  const evil = createResolver({ fetchImpl: async () => jsonResponse({ data: { ...OVERSEAS.data, liveDomain: 'https://evil.example' } }) })
  const refused = await evil.resolve('tdm-ctvp', {})
  assert.equal(refused.url, '')
  assert.match(refused.desc, /意外的直播域名/)

  const http = createResolver({ fetchImpl: async () => jsonResponse({}, 403) })
  assert.match((await http.resolve('tdm-ctvp', {})).desc, /路由接口 HTTP 403/)
  assert.match((await http.resolve('tdm-unknown', {})).desc, /引用格式错误/)
})

console.log(`\n全部通过：${passed} ✅`)
