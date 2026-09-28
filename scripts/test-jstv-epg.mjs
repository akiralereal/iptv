#!/usr/bin/env node
/**
 * 江苏网络台官方节目单回归测试（全离线）：匿名令牌、按 extraId 取节目、按天挑选、
 * 上海时间解析与机器时区无关、错误路径，以及节目单频道与模块实际发出的频道一一对应。
 *
 * 夹具按 2026-09-25 实测响应裁剪，字段与形状保持原样。
 *
 * 运行： node scripts/test-jstv-epg.mjs
 *       TZ=UTC node scripts/test-jstv-epg.mjs
 *       TZ=America/Los_Angeles node scripts/test-jstv-epg.mjs
 */
import assert from 'node:assert/strict'

import jstvEpg, {
  CHANNELS, EPG_API, clearCache, decodeProgrammes, parseShanghaiTime,
} from '../extractors/jstv/epg.js'
import { AUTH_URL, buildAuthRequest } from '../extractors/jstv/auth.js'
import * as jstvApi from '../extractors/jstv/api.js'
import { getModule, validateModule } from '../extractors/registry.js'
import { channelXml, providerProgrammes, shanghaiDays, xmltvTime } from '../utils/epgXmltv.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

// 2026-09-25 10:00（上海）
const NOW = Date.parse('2026-09-25T02:00:00Z')

// 与实测一致：HS256 JWT，webguest 角色，nbf→exp 15 分钟
function jwt(exp, uid = '75774cd34c7c2dddadb7008b2fd2e527') {
  const part = obj => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part({
    id: '38021007E1977299618B6FB1288F36A3',
    'http://schemas.microsoft.com/ws/2008/06/identity/claims/role': 'webguest',
    iss: 'ApiAuth', nbf: exp - 900, exp, appid: '3b93c452b851431c8b3a076789ab1e14', uid, platform: '41',
  })}.VX7tUDUuXa_fnSzdmY2uATrD5mFkGqIEyv-d1h-xowI`
}
const TOKEN = jwt(Math.floor(NOW / 1000) + 900)
const authBody = (token = TOKEN) => ({ data: { accessToken: token, userId: null }, code: 200, message: 'success' })

// 江苏卫视 days=1&isNeedTomorrow=0 的实测响应（昨天 + 今天），每天只留几条
const DAY_0924 = {
  date: '2026-09-24',
  data: [
    { id: '155237197428777779220260924000148', programName: '凭栏一片风云起', startTime: '2026-09-24 00:01:48', endTime: '2026-09-24 00:48:39' },
    { id: '155237197428777779220260924190004', programName: '新闻联播', startTime: '2026-09-24 19:00:04', endTime: '2026-09-24 19:33:19' },
    { id: '155237197428777779220260924231708', programName: '凭栏一片风云起', startTime: '2026-09-24 23:17:08', endTime: '2026-09-24 23:59:59' },
  ],
  blockTime: [],
}
const DAY_0925 = {
  date: '2026-09-25',
  data: [
    { id: '155268713047947673620260925000350', programName: '凭栏一片风云起', startTime: '2026-09-25 00:03:50', endTime: '2026-09-25 00:49:59' },
    { id: '155268713047947673620260925070120', programName: '江苏新时空', startTime: '2026-09-25 07:01:20', endTime: '2026-09-25 07:24:24' },
    { id: '155268713047947673620260925180000', programName: '新闻眼', startTime: '2026-09-25 18:00:00', endTime: '2026-09-25 18:30:00' },
    { id: '155268713047947673620260925190004', programName: '新闻联播', startTime: '2026-09-25 19:00:04', endTime: '2026-09-25 19:31:30' },
    { id: '155268713047947673620260925235524', programName: '凭栏一片风云起', startTime: '2026-09-25 23:55:24', endTime: '2026-09-25 23:59:59' },
  ],
  blockTime: [],
}
const epgBody = (days, channelId = 670, channelName = '江苏卫视') => ({
  data: { channelId, channelName, epg: days, allowReplay: 0 }, code: 200, message: '获取成功',
})
// 实测：页面写死的旧 id（534）与 days=0&isNeedTomorrow=1 都是这个空形状；不存在的 id 回 channelId 0
const EMPTY_BODY = epgBody([])
const UNKNOWN_BODY = epgBody([], 0, null)

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
})

/** 假 fetch：鉴权走 authFn，节目单走 epgFn；记下每次请求。 */
function fakeFetch({ authFn = () => json(authBody()), epgFn = () => json(epgBody([DAY_0925])) } = {}) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const call = { url: String(url), init }
    calls.push(call)
    if (call.url.startsWith(AUTH_URL)) return authFn(call)
    if (call.url.startsWith(EPG_API)) return epgFn(call, calls)
    throw new Error(`意外请求 ${call.url}`)
  }
  return { fetchImpl, calls, auth: () => calls.filter(c => c.url.startsWith(AUTH_URL)), epg: () => calls.filter(c => c.url.startsWith(EPG_API)) }
}

console.log(`江苏节目单测试（TZ=${process.env.TZ || '系统默认'}）`)

check('上海时间文本按 +08:00 解析，与机器时区无关；格式不对返回 NaN', () => {
  assert.equal(parseShanghaiTime('2026-09-25 19:00:04'), Date.parse('2026-09-25T11:00:04Z'))
  assert.equal(parseShanghaiTime('2026-09-25 00:03:50'), Date.parse('2026-09-24T16:03:50Z'))
  assert.equal(parseShanghaiTime(' 2026-09-25 23:59:59 '), Date.parse('2026-09-25T15:59:59Z'))
  for (const bad of ['2026-09-25T19:00:04', '2026/09/25 19:00:04', '2026-09-25 19:00', '2026-13-01 00:00:00', '', null, undefined]) {
    assert.ok(Number.isNaN(parseShanghaiTime(bad)), String(bad))
  }
})

check('从多天响应里只挑所需那天，按开始时间排序、去首尾空白、丢残缺节目', () => {
  const shuffled = { ...DAY_0925, data: [...DAY_0925.data].reverse() }
  const programmes = decodeProgrammes(epgBody([DAY_0924, shuffled]), '20260925')
  assert.deepEqual(programmes.map(item => item.title), ['凭栏一片风云起', '江苏新时空', '新闻眼', '新闻联播', '凭栏一片风云起'])
  assert.deepEqual(programmes[3], {
    title: '新闻联播', start: Date.parse('2026-09-25T11:00:04Z'), stop: Date.parse('2026-09-25T11:31:30Z'),
  })
  assert.ok(programmes.every(item => item.start < item.stop))
  assert.equal(xmltvTime(programmes[3].start), '20260925190004 +0800')
  assert.match(channelXml('江苏卫视', programmes), /start="20260925235524 \+0800" stop="20260925235959 \+0800"/)

  assert.deepEqual(decodeProgrammes(epgBody([DAY_0924, DAY_0925]), '20260924').map(item => item.title),
    ['凭栏一片风云起', '新闻联播', '凭栏一片风云起'])
  const messy = { date: '2026-09-25', data: [
    { programName: '  零距离 ', startTime: '2026-09-25 18:00:00', endTime: '2026-09-25 19:20:00' },
    { programName: '   ', startTime: '2026-09-25 19:20:00', endTime: '2026-09-25 19:49:00' },
    { programName: '倒挂', startTime: '2026-09-25 20:00:00', endTime: '2026-09-25 19:00:00' },
    { programName: '零长', startTime: '2026-09-25 21:00:00', endTime: '2026-09-25 21:00:00' },
    { programName: '坏时间', startTime: '18:00', endTime: '19:00' },
  ] }
  assert.deepEqual(decodeProgrammes(epgBody([messy]), '20260925').map(item => item.title), ['零距离'])
})

check('没有那天、空 epg 返回空；格式或状态码不对抛错', () => {
  assert.deepEqual(decodeProgrammes(epgBody([DAY_0924]), '20260925'), [])
  assert.deepEqual(decodeProgrammes(EMPTY_BODY, '20260925'), [])
  assert.deepEqual(decodeProgrammes(UNKNOWN_BODY, '20260925'), [])
  assert.deepEqual(decodeProgrammes(epgBody([{ date: '2026-09-25', data: [], blockTime: [] }]), '20260925'), [])
  assert.throws(() => decodeProgrammes({ data: null, code: 500, message: '服务器错误' }, '20260925'), /服务器错误/)
  assert.throws(() => decodeProgrammes({ data: {}, code: 200 }, '20260925'), /没有 epg/)
  assert.throws(() => decodeProgrammes(null, '20260925'), /没有 epg/)
  const changed = { date: '2026-09-25', data: [{ programName: '新闻联播', startTime: '2026-09-25T19:00:04+08:00', endTime: '2026-09-25T19:31:30+08:00' }] }
  assert.throws(() => decodeProgrammes(epgBody([changed]), '20260925'), /时间格式异常/)
})

await checkAsync('先取匿名签名令牌，再带 Bearer 按 extraId 只取今天；令牌缓存复用', async () => {
  clearCache()
  const fake = fakeFetch()
  const programmes = await jstvEpg.programmes('670', '20260925', { fetchImpl: fake.fetchImpl, now: NOW })
  assert.equal(programmes.length, 5)

  const [auth] = fake.auth()
  assert.equal(auth.init.method, 'POST')
  const signed = buildAuthRequest(NOW, JSON.parse(auth.init.body).uuid)
  assert.equal(auth.url, signed.url, '按请求时刻签名')
  assert.deepEqual(JSON.parse(auth.init.body), signed.body)
  assert.equal(auth.init.headers['Content-Type'], 'application/json')
  assert.equal(auth.init.redirect, 'manual')

  const [epg] = fake.epg()
  assert.equal(epg.url, `${EPG_API}?channelId=670&days=0&isNeedTomorrow=0`)
  assert.equal(epg.init.headers.Authorization, `Bearer ${TOKEN}`)
  assert.equal(epg.init.redirect, 'manual')
  assert.ok(epg.init.signal instanceof AbortSignal)

  await jstvEpg.programmes('669', '20260925', { fetchImpl: fake.fetchImpl, now: NOW + 5 * 60 * 1000 })
  assert.equal(fake.auth().length, 1, '令牌没过期不重签')
  // exp 前 2 分钟内视为过期，换新令牌
  await jstvEpg.programmes('669', '20260925', { fetchImpl: fake.fetchImpl, now: NOW + 14 * 60 * 1000 })
  assert.equal(fake.auth().length, 2)
})

await checkAsync('并发取多个频道只签发一次令牌', async () => {
  clearCache()
  const fake = fakeFetch()
  const results = await Promise.all(CHANNELS.slice(0, 4).map(channel =>
    jstvEpg.programmes(channel.id, '20260925', { fetchImpl: fake.fetchImpl, now: NOW })))
  assert.ok(results.every(list => list.length === 5))
  assert.equal(fake.auth().length, 1)
  assert.equal(fake.epg().length, 4)
})

await checkAsync('往回的日子只取到那天为止并挑出那天；明天不请求直接空', async () => {
  clearCache()
  const fake = fakeFetch({ epgFn: () => json(epgBody([DAY_0924, DAY_0925])) })
  const yesterday = await jstvEpg.programmes('670', '20260924', { fetchImpl: fake.fetchImpl, now: NOW })
  assert.match(fake.epg()[0].url, /[?&]days=1&isNeedTomorrow=0$/)
  assert.deepEqual(yesterday.map(item => item.title), ['凭栏一片风云起', '新闻联播', '凭栏一片风云起'])
  assert.ok(yesterday.every(item => item.start >= Date.parse('2026-09-23T16:00:00Z') && item.stop <= Date.parse('2026-09-24T16:00:00Z')))

  // 刚过零点（上海 09-26 00:00:05）还在取 09-25 的：往回 1 天
  const afterMidnight = await jstvEpg.programmes('670', '20260925', { fetchImpl: fake.fetchImpl, now: Date.parse('2026-09-25T16:00:05Z') })
  assert.match(fake.epg()[1].url, /[?&]days=1&isNeedTomorrow=0$/)
  assert.equal(afterMidnight.length, 5)

  const before = fake.calls.length
  assert.deepEqual(await jstvEpg.programmes('670', '20260926', { fetchImpl: fake.fetchImpl, now: NOW }), [])
  assert.deepEqual(await jstvEpg.programmes('670', '20260801', { fetchImpl: fake.fetchImpl, now: NOW }), [])
  assert.equal(fake.calls.length, before, '明天与 30 天前都不发请求')
})

await checkAsync('官方当天没发（空 epg、未知频道）返回空数组', async () => {
  clearCache()
  for (const body of [EMPTY_BODY, UNKNOWN_BODY, epgBody([DAY_0924])]) {
    const fake = fakeFetch({ epgFn: () => json(body) })
    assert.deepEqual(await jstvEpg.programmes('534', '20260925', { fetchImpl: fake.fetchImpl, now: NOW }), [])
  }
})

await checkAsync('401 换一张令牌重试一次；仍 401 或其它错误抛出', async () => {
  clearCache()
  const fresh = jwt(Math.floor(NOW / 1000) + 900, 'second')
  let issued = 0
  const retry = fakeFetch({
    authFn: () => json(authBody(issued++ ? fresh : TOKEN)),
    epgFn: call => (call.init.headers.Authorization === `Bearer ${fresh}` ? json(epgBody([DAY_0925])) : new Response('', { status: 401 })),
  })
  assert.equal((await jstvEpg.programmes('670', '20260925', { fetchImpl: retry.fetchImpl, now: NOW })).length, 5)
  assert.equal(retry.auth().length, 2)
  assert.equal(retry.epg().length, 2)

  clearCache()
  const denied = fakeFetch({ epgFn: () => new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer error="invalid_token"' } }) })
  await assert.rejects(jstvEpg.programmes('670', '20260925', { fetchImpl: denied.fetchImpl, now: NOW }), /HTTP 401/)
  assert.equal(denied.epg().length, 2, '只重试一次')

  const cases = [
    [{ authFn: () => json({}, 500) }, /鉴权 HTTP 500/],
    [{ authFn: () => json({ data: null, code: 400, message: '签名错误' }) }, /签名错误/],
    [{ epgFn: () => json({}, 503) }, /HTTP 503/],
    [{ epgFn: () => new Response(null, { status: 302, headers: { location: 'https://example.com/' } }) }, /HTTP 302/],
    [{ epgFn: () => new Response('<html>维护中</html>', { status: 200 }) }, /不是 JSON/],
    [{ epgFn: () => { throw new TypeError('fetch failed') } }, /fetch failed/],
    [{ epgFn: () => new Response('x'.repeat(300 * 1024)) }, /过大/],
    [{ epgFn: () => new Response('{}', { headers: { 'content-length': String(10 * 1024 * 1024) } }) }, /过大/],
  ]
  for (const [options, pattern] of cases) {
    clearCache()
    await assert.rejects(jstvEpg.programmes('670', '20260925', { fetchImpl: fakeFetch(options).fetchImpl, now: NOW }), pattern)
  }
  await assert.rejects(jstvEpg.programmes('../x', '20260925', { fetchImpl: async () => { throw new Error('不应请求') } }), /参数非法/)
  await assert.rejects(jstvEpg.programmes('670', '2026-09-25', { fetchImpl: async () => { throw new Error('不应请求') } }), /参数非法/)
})

await checkAsync('超时由 AbortController 中止', async () => {
  clearCache()
  const hang = fakeFetch({
    epgFn: call => new Promise((_, reject) => call.init.signal.addEventListener('abort', () => reject(call.init.signal.reason))),
  })
  await assert.rejects(jstvEpg.programmes('670', '20260925', { fetchImpl: hang.fetchImpl, now: NOW, timeoutMs: 30 }), { name: 'AbortError' })
})

await checkAsync('经公共件按今天取：只请求一次、只要今天', async () => {
  clearCache()
  const [today] = shanghaiDays(Date.now(), 1)
  const date = `${today.slice(0, 4)}-${today.slice(4, 6)}-${today.slice(6)}`
  const fake = fakeFetch({
    epgFn: () => json(epgBody([{
      date, data: [{ id: '1', programName: '新闻联播', startTime: `${date} 19:00:04`, endTime: `${date} 19:31:30` }], blockTime: [],
    }])),
  })
  const programmes = await providerProgrammes(jstvEpg, '670', { fetchImpl: fake.fetchImpl })
  assert.equal(programmes.length, 1)
  assert.equal(xmltvTime(programmes[0].start), `${today}190004 +0800`)
  assert.equal(fake.epg().length, 1)
  assert.match(fake.epg()[0].url, /[?&]days=0&isNeedTomorrow=0$/)
})

await checkAsync('节目单频道与模块实际发出的频道一一对应（ref、显示名）', async () => {
  // nav/8385 实测的 10 个频道（字段裁剪）；标题「体育休闲」由模块改名为「江苏体育休闲」
  const nav = [
    ['670', '江苏卫视', 'applive/jswspro'], ['676', '江苏卫视4K超高清', '4klive/jsws4kpro'],
    ['669', '江苏城市', 'applive/jscspro'], ['663', '江苏综艺', 'applive/jszypro'],
    ['664', '江苏影视', 'applive/jsyspro'], ['668', '江苏新闻', 'applive/jsxwpro'],
    ['666', '江苏教育', 'applive/jsjypro'], ['665', '体育休闲', 'applive/jsxxpro'],
    ['667', '优漫卡通', 'applive/ymktpro'], ['671', '江苏国际', 'applive/jsgjpro'],
  ].map(([extraId, title, path]) => ({
    title, extraId, showType: 50, articleType: 80,
    thumbnailsJson: [`https://images.jstv.com/images/${extraId}.png`],
    extraJson: { name: title, url: `https://litchi-play-encrypted.jstv.com/${path}.m3u8`, blockTime: [], ePG: [], encryptType: 3 },
  }))
  jstvApi.clearCache()
  const module = getModule('jstv')
  const fetchImpl = async url => (String(url).startsWith(AUTH_URL)
    ? json(authBody(jwt(Math.floor(Date.now() / 1000) + 900)))
    : json({ data: { articles: nav, totalCount: nav.length }, code: 200, message: '获取成功' }))
  const result = await module.fetch({}, { fetchImpl })
  jstvApi.clearCache()
  const emitted = result.groups.flatMap(group => group.dataList).map(channel => [channel.deferredRef, channel.name])
  const provided = jstvEpg.channels().map(channel => [channel.ref, channel.name])
  assert.equal(emitted.length, 10)
  assert.deepEqual(new Map(provided), new Map(emitted), '每个发出的频道都有节目单，且没有多余的 ref')
  assert.ok(jstvEpg.channels().every(channel => channel.ref === `jstv-${channel.key}`), 'key 就是 ref 里的 extraId')
  assert.ok(provided.every(([ref]) => module.claimsRef(ref)))
})

check('模块挂上节目单且通过注册表校验；签名件与取流共用同一份', () => {
  const module = getModule('jstv')
  assert.equal(module.epg, jstvEpg)
  assert.equal(module.capabilities.epg, true)
  assert.equal(jstvEpg.days, 1)
  assert.doesNotThrow(() => validateModule(module))
  assert.equal(jstvApi.buildAuthRequest, buildAuthRequest)
  assert.equal(jstvApi.AUTH_URL, AUTH_URL)
})

console.log(`\n全部通过：${passed} ✅`)
