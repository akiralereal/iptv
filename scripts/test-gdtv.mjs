#!/usr/bin/env node
import assert from 'node:assert/strict'

import gdtv from '../extractors/gdtv/index.js'
import { buildChannels, channelIdFromRef, channelPageUrl } from '../extractors/gdtv/channels.js'
import {
  createResolver,
  STREAM_HARD_TTL_MS,
  STREAM_REFRESH_MS,
} from '../extractors/gdtv/resolver.js'
import { isOfficialStreamUrl } from '../extractors/gdtv/session.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }
const stream = token => `https://tcdn.itouchtv.cn/live/gdws.m3u8?t_token=${token}`

console.log('广东台荔枝网模块测试')

check('频道表固定排除购物频道，同时保留广东移动与 4K', () => {
  const channels = buildChannels()
  assert.equal(channels.length, 17)
  assert.equal(channels.some(channel => /购物/.test(channel.name)), false)
  assert.ok(channels.some(channel => channel.name === '广东移动'))
  assert.ok(channels.some(channel => channel.name === '广东4K超高清'))
  assert.ok(channels.every(channel => channel.relayHls === true))
  assert.ok(channels.every(channel => channel.deferredRef.startsWith('gdtv-')))
})

check('台标用官网频道卡的缩放版；只有总台标的经典剧、纪录片、健康用广东台台标，岭南戏曲留给内置台标', () => {
  const channels = buildChannels()
  const withLogo = channels.filter(channel => channel.logo)
  assert.equal(withLogo.length, 16)
  assert.ok(withLogo.every(channel =>
    /^https:\/\/img\.gdtv\.cn\/image\/\d{6}\/[^?]+\?x-oss-process=image\/resize,w_400$/.test(channel.logo)))
  // 广东台台标那三路是各自目录里的图（同一设计、文件不同），其余各台互不相同
  assert.equal(new Set(withLogo.map(channel => channel.logo)).size, withLogo.length)
  assert.match(channels.find(channel => channel.name === '广东健康').logo, /202202\/0\.1019544028130241553993b094d68a93bdOSS1645085168\.png/)
  assert.equal(channels.find(channel => channel.name === '广东卫视').logo,
    'https://img.gdtv.cn/image/202212/0.341152693165587748d6fc1c271c6514dOSS1670410407.jpg?x-oss-process=image/resize,w_400')
  assert.equal(channels.find(channel => channel.name === '岭南戏曲').logo, '', '岭南戏曲由内置台标补')
  assert.equal(gdtv.catalogVersion, 1, '改了台标，存量缓存要在启动时重建')
})

check('频道引用和官网页面范围严格受模块白名单约束', () => {
  assert.equal(channelIdFromRef('gdtv-43'), '43')
  assert.equal(channelIdFromRef('gdtv-42'), '', '南方购物不能通过手写引用绕过过滤')
  assert.equal(channelIdFromRef('gdtv-999'), '')
  assert.equal(channelPageUrl('16'), 'https://www.gdtv.cn/tvChannelDetail/16')
  assert.throws(() => channelPageUrl('42'), /ID 无效/)
  assert.equal(gdtv.claimsRef('gdtv-43'), true)
  assert.equal(gdtv.claimsRef('gdtv-42'), false)
})

check('只接受广东台官方取票域名、直播路径和 t_token', () => {
  assert.equal(isOfficialStreamUrl(stream('abc')), true)
  assert.equal(isOfficialStreamUrl('http://tcdn.itouchtv.cn/live/gdws.m3u8?t_token=abc'), false)
  assert.equal(isOfficialStreamUrl('https://evil.example/live/gdws.m3u8?t_token=abc'), false)
  assert.equal(isOfficialStreamUrl('https://tcdn.itouchtv.cn/live/gdws.m3u8'), false)
  assert.equal(isOfficialStreamUrl('https://tcdn.itouchtv.cn/video/gdws.m3u8?t_token=abc'), false)
})

await checkAsync('首次播放并发只取一次票，固定入口自动启用清单中继', async () => {
  let calls = 0
  let finish
  const captured = new Promise(resolve => { finish = resolve })
  const resolver = createResolver({ capture: async () => { calls++; return captured }, close: () => {} })
  const first = resolver.resolve('gdtv-43', { now: 0 })
  const second = resolver.resolve('gdtv-43', { now: 0 })
  await Promise.resolve()
  assert.equal(calls, 1)
  finish(stream('first'))
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.url, stream('first'))
  assert.equal(b.url, stream('first'))
  assert.equal(a.relayHls, true)
})

await checkAsync('45 秒后后台换票且不阻塞播放器，成功后切到新地址', async () => {
  let calls = 0
  let finishRefresh
  const resolver = createResolver({
    capture: async () => {
      calls++
      if (calls === 1) return stream('old')
      return new Promise(resolve => { finishRefresh = resolve })
    },
    close: () => {},
  })
  assert.equal((await resolver.resolve('gdtv-43', { now: 0 })).url, stream('old'))
  assert.equal((await resolver.resolve('gdtv-43', { now: STREAM_REFRESH_MS - 1 })).url, stream('old'))

  const refreshing = await resolver.resolve('gdtv-43', { now: STREAM_REFRESH_MS })
  assert.equal(refreshing.url, stream('old'), '安全窗口内应立即返回旧票')
  await Promise.resolve()
  assert.equal(calls, 2)
  finishRefresh(stream('new'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await resolver.resolve('gdtv-43', { now: STREAM_REFRESH_MS + 1000 })).url, stream('new'))
})

await checkAsync('后台续签失败可短暂沿用旧票，90 秒硬边界必须等到新票', async () => {
  let calls = 0
  const resolver = createResolver({
    capture: async () => {
      calls++
      if (calls === 1) return stream('old')
      if (calls === 2) throw new Error('temporary')
      return stream('renewed')
    },
    close: () => {},
  })
  await resolver.resolve('gdtv-43', { now: 0 })
  const fallback = await resolver.resolve('gdtv-43', { now: STREAM_REFRESH_MS })
  assert.equal(fallback.url, stream('old'))
  await new Promise(resolve => setImmediate(resolve))

  const renewed = await resolver.resolve('gdtv-43', { now: STREAM_HARD_TTL_MS })
  assert.equal(renewed.url, stream('renewed'))
  assert.equal(calls, 3)
})

await checkAsync('清缓存同时释放模块私有浏览器会话', async () => {
  let closed = 0
  const resolver = createResolver({ capture: async () => stream('x'), close: async () => { closed++ } })
  await resolver.resolve('gdtv-43', { now: 0 })
  assert.equal(resolver.cache.size, 1)
  resolver.clear()
  await Promise.resolve()
  assert.equal(resolver.cache.size, 0)
  assert.equal(closed, 1)
})

console.log(`\n全部通过：${passed} 项`)
