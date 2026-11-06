#!/usr/bin/env node
import assert from 'node:assert/strict'

import gdtv from '../extractors/gdtv/index.js'
import { buildChannels, channelIdFromRef, channelPageUrl } from '../extractors/gdtv/channels.js'
import {
  createResolver,
  STREAM_HARD_TTL_MS,
  STREAM_REFRESH_MS,
  streamSchedule,
} from '../extractors/gdtv/resolver.js'
import { createApiSession, isOfficialStreamUrl, streamExpiresAt } from '../extractors/gdtv/session.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }
const stream = token => `https://tcdn.itouchtv.cn/live/gdws.m3u8?t_token=${token}`
// 纪录片的地址形态（2026-09-25 实测）：auth_key 第一段是过期时刻（秒），签发起 30 分钟
const MINUTE = 60 * 1000
const ISSUED = 1790331591000
const documentary = (expiresAt = ISSUED + 30 * MINUTE) =>
  `https://lbplay.grtn.cn/live/jilupian.m3u8?auth_key=${expiresAt / 1000}-0-0-0123456789abcdef0123456789abcdef`

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

check('纪录片走 lbplay.grtn.cn + auth_key，同样只认官方域名、直播路径和完整签名', () => {
  assert.equal(isOfficialStreamUrl(documentary()), true)
  assert.equal(isOfficialStreamUrl(documentary().replace('https:', 'http:')), false)
  assert.equal(isOfficialStreamUrl(documentary().replace('lbplay.grtn.cn', 'evil.example')), false)
  assert.equal(isOfficialStreamUrl(documentary().replace('/live/', '/vod/')), false)
  assert.equal(isOfficialStreamUrl('https://lbplay.grtn.cn/live/jilupian.m3u8'), false)
  assert.equal(isOfficialStreamUrl('https://lbplay.grtn.cn/live/jilupian.m3u8?auth_key=abc'), false)
  // 两套签名不能串用
  assert.equal(isOfficialStreamUrl('https://lbplay.grtn.cn/live/jilupian.m3u8?t_token=abc'), false)
  assert.equal(isOfficialStreamUrl(`https://tcdn.itouchtv.cn/live/gdws.m3u8?${new URL(documentary()).search.slice(1)}`), false)
  assert.equal(streamExpiresAt(documentary()), ISSUED + 30 * MINUTE)
  assert.equal(streamExpiresAt(stream('abc')), 0)
})

check('带过期时刻的地址按有效期换票：离过期 5 分钟换、2 分钟硬边界，最多信 30 分钟', () => {
  assert.deepEqual(streamSchedule(documentary(), ISSUED),
    { refreshAt: ISSUED + 25 * MINUTE, hardExpiresAt: ISSUED + 28 * MINUTE })
  // 本机时钟慢 10 分钟：算出来 40 分钟，只信 30 分钟
  assert.deepEqual(streamSchedule(documentary(), ISSUED - 10 * MINUTE),
    { refreshAt: ISSUED + 15 * MINUTE, hardExpiresAt: ISSUED + 18 * MINUTE })
  // 本机时钟快 10 分钟：只剩 20 分钟，照样提前换
  assert.deepEqual(streamSchedule(documentary(), ISSUED + 10 * MINUTE),
    { refreshAt: ISSUED + 25 * MINUTE, hardExpiresAt: ISSUED + 28 * MINUTE })
  // 剩不到 10 分钟、t_token 读不出过期时刻：都按 45 秒 / 90 秒
  for (const [url, at] of [[documentary(), ISSUED + 25 * MINUTE], [stream('abc'), ISSUED]]) {
    assert.deepEqual(streamSchedule(url, at), { refreshAt: at + STREAM_REFRESH_MS, hardExpiresAt: at + STREAM_HARD_TTL_MS })
  }
})

await checkAsync('纪录片取到一次地址后 25 分钟内不再请求频道接口', async () => {
  let calls = 0
  const resolver = createResolver({ capture: async () => { calls++; return documentary() }, close: () => {} })
  assert.equal((await resolver.resolve('gdtv-94', { now: ISSUED })).url, documentary())
  for (const at of [STREAM_REFRESH_MS, STREAM_HARD_TTL_MS, 10 * MINUTE, 25 * MINUTE - 1]) {
    await resolver.resolve('gdtv-94', { now: ISSUED + at })
  }
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1)
  await resolver.resolve('gdtv-94', { now: ISSUED + 25 * MINUTE })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 2, '离过期 5 分钟后台换票')
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

await checkAsync('清缓存同时取消模块取流任务', async () => {
  let closed = 0
  const resolver = createResolver({ capture: async () => stream('x'), close: async () => { closed++ } })
  await resolver.resolve('gdtv-43', { now: 0 })
  assert.equal(resolver.cache.size, 1)
  resolver.clear()
  await Promise.resolve()
  assert.equal(resolver.cache.size, 0)
  assert.equal(closed, 1)
})

await checkAsync('清缓存发生在取流任务启动前时，不再创建过期会话', async () => {
  let calls = 0
  const resolver = createResolver({ capture: async () => { calls++; return stream('old') }, close: () => {} })
  const resolving = resolver.resolve('gdtv-43')
  resolver.clear()
  const result = await resolving
  assert.equal(result.url, '')
  assert.match(result.desc, /已取消/)
  assert.equal(calls, 0)
  assert.equal(resolver.cache.size, 0)
})

await checkAsync('已取消的旧任务失败时不影响新一轮缓存', async () => {
  let rejectOld
  let calls = 0
  const resolver = createResolver({
    capture: () => ++calls === 1
      ? new Promise((resolve, reject) => { rejectOld = reject })
      : Promise.resolve(stream('new')),
    close: () => {},
  })
  const old = resolver.resolve('gdtv-43')
  await Promise.resolve()
  resolver.clear()
  await resolver.resolve('gdtv-43')
  rejectOld(new Error('cancelled'))
  await old
  assert.equal(resolver.cache.get('43').lastError, '')
  assert.equal(resolver.cache.get('43').retryAt, 0)
})

function apiFixture({ initialNode = 'initial-1', preflightStatus = 204, streamUrl, waitForNode = false } = {}) {
  const requests = []
  const sockets = []
  const socketFactory = () => {
    const socket = {
      closed: false,
      send(message) {
        assert.deepEqual(JSON.parse(message), { route: 'getwsparam', message: initialNode })
        if (!waitForNode) queueMicrotask(() => socket.onmessage?.({
          data: JSON.stringify({ status: 201, wsnode: 'official%2Bnode' }),
        }))
      },
      close() { socket.closed = true },
    }
    sockets.push(socket)
    queueMicrotask(() => socket.onopen?.())
    return socket
  }
  const fetchImpl = async (url, options) => {
    options.signal.throwIfAborted()
    requests.push({ url, ...options })
    if (url.endsWith('/getParam')) return Response.json({ node: initialNode })
    if (options.method === 'OPTIONS') return new Response(null, { status: preflightStatus })
    const id = new URL(url).searchParams.get('tvChannelPk')
    const preflight = requests.findLast(request => request.url === url && request.method === 'OPTIONS')
    assert.ok(preflight, '取地址前必须完成同一 URL 的预检')
    assert.equal(preflight.headers['Access-Control-Request-Method'], 'GET')
    assert.match(options.headers['X-ITOUCHTV-Ca-Signature'], /^[A-Za-z0-9+/]+=*$/)
    if (sockets.length) assert.ok(sockets.some(socket => !socket.closed), '请求频道时会话仍应打开')
    return Response.json({ pk: Number(id), playUrl: JSON.stringify({ hd: streamUrl || stream(id) }) })
  }
  return { session: createApiSession({ fetchImpl, socketFactory }), requests, sockets }
}

await checkAsync('纯接口完成节点交换、频道预检及取流，完成后释放 WebSocket', async () => {
  const { session, requests, sockets } = apiFixture()
  assert.equal(await session.capture('43'), stream('43'))
  assert.equal(requests.length, 3)
  assert.equal(new URL(requests.at(-1).url).searchParams.get('node'),
    Buffer.from('official%2Bnode', 'latin1').toString('base64'))
  assert.equal(sockets.length, 1)
  assert.equal(sockets[0].closed, true)
})

await checkAsync('初始化节点无需 WebSocket 时仍完成频道预检', async () => {
  const { session, sockets, requests } = apiFixture({ initialNode: 'ready-node-0' })
  assert.equal(await session.capture('47'), stream('47'))
  assert.equal(sockets.length, 0)
  assert.equal(requests[1].method, 'OPTIONS')
})

await checkAsync('频道预检失败后停止取流并关闭连接', async () => {
  const { session, requests, sockets } = apiFixture({ preflightStatus: 503 })
  await assert.rejects(session.capture('43'), /预检返回 HTTP 503/)
  assert.equal(requests.length, 2)
  assert.equal(sockets[0].closed, true)
})

await checkAsync('初始化节点与播放域名校验失败时不留下连接', async () => {
  const invalidNode = apiFixture({ initialNode: '' })
  await assert.rejects(invalidNode.session.capture('43'), /初始化节点无效/)
  assert.equal(invalidNode.sockets.length, 0)
  const invalidStream = apiFixture({ streamUrl: 'https://evil.example/live/test.m3u8?t_token=x' })
  await assert.rejects(invalidStream.session.capture('43'), /没有返回有效/)
  assert.equal(invalidStream.sockets[0].closed, true)
  await assert.rejects(invalidStream.session.capture('42'), /频道 ID 无效/)
})

await checkAsync('清理正在等待节点的取流立即取消请求并释放连接', async () => {
  const { session, sockets } = apiFixture({ waitForNode: true })
  const capture = session.capture('43')
  const rejected = assert.rejects(capture, /取流已取消/)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(sockets.length, 1)
  session.close()
  await rejected
  assert.equal(sockets[0].closed, true)
  assert.equal(sockets[0].onmessage, null)
})

await checkAsync('不同频道可并行取票，各自关闭短连接', async () => {
  const { session, sockets } = apiFixture()
  assert.deepEqual(await Promise.all([session.capture('43'), session.capture('47')]), [stream('43'), stream('47')])
  assert.equal(sockets.length, 2)
  assert.ok(sockets.every(socket => socket.closed))
})

console.log(`\n全部通过：${passed} 项`)
