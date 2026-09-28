#!/usr/bin/env node
/**
 * 大连云官方节目单回归测试（全离线）：匿名 SM2 令牌与 ticket 头、按天取、时刻还原与机器时区无关、
 * 预告与重叠处理、错误路径，以及节目单频道与模块实际发出的频道一一对应。
 *
 * 服务端用自造的 SM2 密钥对扮演（真密钥只在服务端），夹具按 2026-09-25 实测响应裁剪，
 * 字段与形状保持原样。
 *
 * 运行： node scripts/test-dalian-epg.mjs
 *       TZ=UTC node scripts/test-dalian-epg.mjs
 *       TZ=America/Los_Angeles node scripts/test-dalian-epg.mjs
 */
import assert from 'node:assert/strict'

import dalianEpg, { CHANNELS, EPG_API, clearCache, parseProgrammes, shanghaiDayStart } from '../extractors/dalian/epg.js'
import { SERVER_PUBLIC_KEY, buildTicket, ticketPlaintext } from '../extractors/dalian/auth.js'
import * as dalianApi from '../extractors/dalian/api.js'
import { generateSm2KeyPair, sm2Decrypt, sm2Encrypt } from '../extractors/dalian/sm2.js'
import { getModule, validateModule } from '../extractors/registry.js'
import { channelXml, providerProgrammes, shanghaiDays, xmltvTime } from '../utils/epgXmltv.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

const fixedScalar = value => () => Buffer.from(value.toString(16).padStart(64, '0'), 'hex')
const SERVER = generateSm2KeyPair({ randomBytesImpl: fixedScalar(3n) })

// 2026-09-25 10:00（上海）
const NOW = Date.parse('2026-09-25T02:00:00Z')
const DAY = Date.parse('2026-09-25T00:00:00+08:00')
const at = time => Date.parse(`2026-09-25T${time}+08:00`)

// 实测行的完整字段；startTime / endTime 是「当天几点」按 +08:00 存成 1970-01-01 的毫秒数
const row = (channel, id, name, startTime, endTime, copyright = 3, date = DAY) => ({
  id, name, siteID: 1, type: 1, channel, date, startTime, endTime, fileType: 0, fileUrl: null, copyright,
})
// 新闻综合 2026-09-25 实测（节选）
const NEWS_0925 = [
  row(7, 107212, '遇见大连', -7230000, -7210000),
  row(7, 107133, '早安大连', -3550000, 900000),
  row(7, 107221, '精选剧场 ', 22560000, 25062000, 1),
  row(7, 107215, '转播辽宁新闻', 37800000, 39299000),
  row(7, 107218, '转播中央台新闻联播', 39600000, 41400000),
  row(7, 107244, '深夜剧场', 55800000, 57599000, 1),
]
// 生活频道 2026-09-25 实测（节选）：前一条多出一分钟、串联预告
const LIFE_0925 = [
  row(8, 108340, '【动漫星球】', 32230000, 36000000, 1),
  row(8, 108231, '首播小螺号', 35940000, 37271000),
  row(8, 108214, '节目预告（一）', 37680000, 37800000),
  row(8, 108456, '首播民生大连', 37800000, 40500000),
  row(8, 108247, '生活气象站', 40500000, 40710000),
]
const body = programs => ({ status: 0, data: { sysTime: NOW, channels: null, programs }, message: '操作成功' })
// 实测：不带 / 带坏 ticket 回 HTTP 200 + 401；缺 date 回 400
const UNAUTHORIZED = { status: 401, data: null, message: '请求未授权' }
const MISSING_DATE = { status: 400, data: null, message: '缺少必要的请求参数: date' }

const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status, headers: { 'content-type': 'application/json;charset=UTF-8' },
})

// 客户端发出的密文不带 04 前缀（与官方客户端一致）；sm2Decrypt 会先剥一个开头的 04，
// C1.x 恰好以 04 开头时（1/256）就剥错，所以服务端这边补上前缀再解
const serverDecrypt = cipher => sm2Decrypt(SERVER.privateKey, `04${cipher}`).toString('utf8')

/** 扮演大连云服务端：解开四个加密参数下发令牌，节目单请求解开 ticket 交给 programsFn。 */
function fakeServer({ tokens = ['app.test.1', 'app.test.2', 'app.test.3'], timeout = NOW + 300_000, programsFn } = {}) {
  const calls = []
  let issued = 0
  const fetchImpl = async (rawUrl, init = {}) => {
    const url = new URL(String(rawUrl))
    const call = { url, init }
    calls.push(call)
    if (url.origin === 'https://wan-dlrm.dlrm.cn' && url.pathname === '/app/security/token') {
      const plain = Object.fromEntries(['type', 'key', 'secret', 'publicKey'].map(key => [
        key, serverDecrypt(url.searchParams.get(key)),
      ]))
      assert.deepEqual({ ...plain, publicKey: undefined }, {
        type: 'app', key: 'mediax-dev-app', secret: '367bde41-4eae-4c59-b151-47fc1ce83153', publicKey: undefined,
      })
      const token = tokens[Math.min(issued++, tokens.length - 1)]
      const data = sm2Encrypt(plain.publicKey, JSON.stringify({ type: 'app', token, timeout, deltime: timeout + 300_000 }))
      return json({ status: 0, data: `04${data}`, message: '操作成功' })
    }
    if (`${url.origin}${url.pathname}` === EPG_API) {
      call.ticket = JSON.parse(serverDecrypt(init.headers.ticket))
      return (programsFn || (() => json(body(NEWS_0925))))(call)
    }
    throw new Error(`意外请求 ${url.href}`)
  }
  return {
    fetchImpl,
    calls,
    tokenCalls: () => calls.filter(call => call.url.pathname === '/app/security/token'),
    programCalls: () => calls.filter(call => call.url.pathname === '/app/tv/programs'),
  }
}
const opts = (fake, extra = {}) => ({ fetchImpl: fake.fetchImpl, now: NOW, serverPublicKey: SERVER.publicKey, ...extra })

console.log(`大连云节目单测试（TZ=${process.env.TZ || '系统默认'}）`)

check('上海日期零点与机器时区无关；非法日期得 NaN', () => {
  assert.equal(shanghaiDayStart('20260925'), Date.parse('2026-09-24T16:00:00Z'))
  assert.equal(shanghaiDayStart('20260925'), 1790265600000, '与 H5 页面在上海时区发出的 date 一致')
  for (const bad of ['2026-09-25', '20260231', '2026092', '', null]) assert.ok(Number.isNaN(shanghaiDayStart(bad)), String(bad))
})

check('时刻 = 上海零点 + startTime + 8 小时；去首尾空白、末档 23:59:59 补到零点', () => {
  const programmes = parseProgrammes(body([...NEWS_0925].reverse()), DAY)
  assert.deepEqual(programmes.map(item => item.title), ['遇见大连', '早安大连', '精选剧场', '转播辽宁新闻', '转播中央台新闻联播', '深夜剧场'])
  assert.deepEqual(programmes[0], { title: '遇见大连', start: at('05:59:30'), stop: at('05:59:50') })
  assert.deepEqual(programmes[4], { title: '转播中央台新闻联播', start: at('19:00:00'), stop: at('19:30:00') })
  assert.equal(programmes[3].stop, at('18:54:59'))
  assert.equal(programmes.at(-1).stop, Date.parse('2026-09-26T00:00:00+08:00'))
  assert.equal(xmltvTime(programmes[4].start), '20260925190000 +0800')
  assert.match(channelXml('大连新闻综合', programmes), /start="20260925233000 \+0800" stop="20260926000000 \+0800"/)
})

check('丢短的「节目预告」、重叠截到下一条开始、同一开始只留一条', () => {
  const programmes = parseProgrammes(body(LIFE_0925), DAY)
  assert.deepEqual(programmes.map(item => item.title), ['【动漫星球】', '首播小螺号', '首播民生大连', '生活气象站'])
  assert.equal(programmes[0].stop, at('17:59:00'), '多出的一分钟截掉')
  assert.equal(programmes[1].stop, at('18:21:11'), '预告留作空档')
  const messy = parseProgrammes(body([
    row(8, 1, '重复开始甲', 37800000, 38000000),
    row(8, 2, '重复开始乙', 37800000, 38100000),
    row(8, 3, '节目预告（长）', 38100000, 38100000 + 20 * 60 * 1000),
    row(8, 4, '倒挂', 45000000, 44000000),
    row(8, 5, '   ', 46000000, 47000000),
    row(8, 6, '坏时间', '18:00', '19:00'),
    row(8, 7, '越过零点', 55800000, 57600000 + 30 * 60 * 1000),
  ]), DAY)
  assert.deepEqual(messy.map(item => item.title), ['重复开始甲', '节目预告（长）', '越过零点'])
  assert.equal(messy.at(-1).stop, Date.parse('2026-09-26T00:00:00+08:00'), '越过零点的截在零点')
})

check('回显的 date 不是这一天的行不收；全对不上、结构或状态不对抛错；没排返回空', () => {
  const mixed = [...NEWS_0925, row(7, 9, '别的日子', 0, 1800000, 3, DAY + 86_400_000)]
  assert.equal(parseProgrammes(body(mixed), DAY).length, NEWS_0925.length)
  assert.deepEqual(parseProgrammes(body([]), DAY), [])
  assert.deepEqual(parseProgrammes(body(null), DAY), [])
  assert.throws(() => parseProgrammes(body(NEWS_0925.map(item => ({ ...item, date: DAY + 4 * 3600_000 }))), DAY), /格式异常/)
  assert.throws(() => parseProgrammes(body(NEWS_0925.map(item => ({ ...item, startTime: '06:00' }))), DAY), /格式异常/)
  assert.throws(() => parseProgrammes(body({}), DAY), /格式异常/)
  assert.throws(() => parseProgrammes(UNAUTHORIZED, DAY), /请求未授权/)
  assert.throws(() => parseProgrammes(MISSING_DATE, DAY), /缺少必要的请求参数/)
  assert.throws(() => parseProgrammes(null, DAY), /格式异常/)
})

await checkAsync('先匿名换令牌，再带 ticket（令牌 + 校正时间）按频道号与上海零点取；令牌缓存复用', async () => {
  clearCache()
  const fake = fakeServer()
  const programmes = await dalianEpg.programmes('7', '20260925', opts(fake))
  assert.equal(programmes.length, 6)
  const [token] = fake.tokenCalls()
  assert.equal(token.init.redirect, 'manual')
  const [call] = fake.programCalls()
  assert.equal(call.url.searchParams.get('channel'), '7')
  assert.equal(call.url.searchParams.get('date'), '1790265600000')
  assert.equal(call.init.headers.source, 'APP')
  assert.match(call.init.headers['User-Agent'], /^DalianCloud\//)
  assert.deepEqual(call.ticket, JSON.parse(ticketPlaintext('app.test.1', NOW)))
  assert.equal(call.init.redirect, 'manual')
  assert.ok(call.init.signal instanceof AbortSignal)

  await dalianEpg.programmes('8', '20260925', opts(fake, { now: NOW + 4 * 60 * 1000 }))
  assert.equal(fake.tokenCalls().length, 1, '令牌没到期不重换')
  // 到期前 30 秒内视为过期
  await dalianEpg.programmes('8', '20260925', opts(fake, { now: NOW + 4.6 * 60 * 1000 }))
  assert.equal(fake.tokenCalls().length, 2)
  assert.equal(fake.programCalls().at(-1).ticket.token, 'app.test.2')
})

await checkAsync('并发取三个频道只换一次令牌', async () => {
  clearCache()
  const fake = fakeServer()
  const results = await Promise.all(CHANNELS.map(channel => dalianEpg.programmes(channel.id, '20260925', opts(fake))))
  assert.ok(results.every(list => list.length === 6))
  assert.equal(fake.tokenCalls().length, 1)
  assert.equal(fake.programCalls().length, 3)
})

await checkAsync('令牌被提前作废（401）换一张重试一次；仍 401 抛出', async () => {
  clearCache()
  const retry = fakeServer({ programsFn: call => json(call.ticket.token === 'app.test.2' ? body(LIFE_0925) : UNAUTHORIZED) })
  assert.equal((await dalianEpg.programmes('8', '20260925', opts(retry))).length, 4)
  assert.equal(retry.tokenCalls().length, 2)
  assert.equal(retry.programCalls().length, 2)

  clearCache()
  const denied = fakeServer({ programsFn: () => json(UNAUTHORIZED) })
  await assert.rejects(dalianEpg.programmes('8', '20260925', opts(denied)), /请求未授权/)
  assert.equal(denied.programCalls().length, 2, '只重试一次')
})

await checkAsync('没排的日子返回空；换令牌失败、HTTP、跳转、非 JSON、过大、网络错误都抛出', async () => {
  clearCache()
  assert.deepEqual(await dalianEpg.programmes('999', '20270101', opts(fakeServer({ programsFn: () => json(body([])) }))), [])
  const cases = [
    [() => json({}, 503), /HTTP 503/],
    [() => new Response(null, { status: 302, headers: { location: 'https://example.com/' } }), /HTTP 302/],
    [() => new Response('<html>维护中</html>', { status: 200 }), /不是 JSON/],
    [() => new Response('x'.repeat(300 * 1024)), /过大/],
    [() => new Response('{}', { headers: { 'content-length': String(10 * 1024 * 1024) } }), /过大/],
    [() => { throw new TypeError('fetch failed') }, /fetch failed/],
  ]
  for (const [respond, pattern] of cases) {
    clearCache()
    await assert.rejects(dalianEpg.programmes('7', '20260925', opts(fakeServer({ programsFn: respond }))), pattern)
  }
  clearCache()
  const badToken = { fetchImpl: async () => json({ status: 500, data: null, message: '服务繁忙' }), now: NOW, serverPublicKey: SERVER.publicKey }
  await assert.rejects(dalianEpg.programmes('7', '20260925', badToken), /服务繁忙/)
  clearCache()
  await assert.rejects(dalianEpg.programmes('7', '20260925', opts(fakeServer({ timeout: NOW - 1 }))), /无效或已过期/)
  const never = { fetchImpl: async () => { throw new Error('不应请求') } }
  await assert.rejects(dalianEpg.programmes('../x', '20260925', never), /参数非法/)
  await assert.rejects(dalianEpg.programmes('7', '2026-09-25', never), /参数非法/)
})

await checkAsync('超时由 AbortController 中止', async () => {
  clearCache()
  const hang = fakeServer({
    programsFn: call => new Promise((_, reject) => call.init.signal.addEventListener('abort', () => reject(call.init.signal.reason))),
  })
  await assert.rejects(dalianEpg.programmes('7', '20260925', opts(hang, { timeoutMs: 50 })), { name: 'AbortError' })
})

await checkAsync('经公共件取今天 + 明天：一次令牌、每天一次请求', async () => {
  clearCache()
  const days = shanghaiDays(Date.now(), 2)
  const fake = fakeServer({
    timeout: Date.now() + 300_000,
    programsFn: call => {
      const date = Number(call.url.searchParams.get('date'))
      return json(body([row(7, 1, '转播中央台新闻联播', 39600000, 41400000, 3, date), row(7, 2, '深夜剧场', 55800000, 57599000, 1, date)]))
    },
  })
  // 公共件只传 fetchImpl / timeoutMs；换上自造的服务端公钥另包一层
  const provider = { ...dalianEpg, programmes: (key, day, options) => dalianEpg.programmes(key, day, { ...options, serverPublicKey: SERVER.publicKey }) }
  const programmes = await providerProgrammes(provider, '7', { fetchImpl: fake.fetchImpl })
  assert.equal(fake.tokenCalls().length, 1)
  assert.deepEqual(fake.programCalls().map(call => Number(call.url.searchParams.get('date'))).sort(), days.map(shanghaiDayStart))
  assert.equal(programmes.length, 4)
  assert.equal(xmltvTime(programmes[0].start), `${days[0]}190000 +0800`)
  assert.ok(programmes.every((item, index) => index === 0 || programmes[index - 1].stop <= item.start))
})

check('节目单频道与模块实际发出的频道一一对应（ref、显示名）', () => {
  // tv/channels 实测的正式频道与测试频道（字段裁剪），测试频道由取流侧排除
  const live = id => `https://livepull.dlrm.cn/dlrm/00000000-0000-0000-0000-${String(id).padStart(12, '0')}.m3u8?txSecret=${'a'.repeat(64)}&txTime=8FA8000E`
  const catalog = { status: 0, data: { sysTime: 0, channels: [
    { id: 7, siteID: 1, type: 1, name: '新闻综合频道', liveUrl: live(7) },
    { id: 8, siteID: 1, type: 1, name: '生活频道', liveUrl: live(8) },
    { id: 9, siteID: 1, type: 1, name: '文体频道', liveUrl: live(9) },
    { id: 10, siteID: 1, type: 1, name: '测试电视频道', liveUrl: live(10) },
  ] } }
  const groups = dalianApi.buildChannelGroups(dalianApi.normalizeChannels(catalog, 1_700_000_000_000))
  const emitted = groups.flatMap(group => group.dataList).map(channel => [channel.deferredRef, channel.name])
  const provided = dalianEpg.channels().map(channel => [channel.ref, channel.name])
  assert.equal(emitted.length, 3)
  assert.deepEqual(new Map(provided), new Map(emitted), '每个发出的频道都有节目单，且没有多余的 ref')
  const module = getModule('dalian')
  assert.ok(provided.every(([ref]) => module.claimsRef(ref)))
  assert.ok(dalianEpg.channels().every(channel => channel.ref === `dalian-${channel.key}`), 'key 就是 ref 里的频道号')
})

check('模块挂上节目单且通过注册表校验；令牌与 ticket 与取流共用同一份', () => {
  const module = getModule('dalian')
  assert.equal(module.epg, dalianEpg)
  assert.equal(module.capabilities.epg, true)
  assert.equal(dalianEpg.days, 2)
  assert.doesNotThrow(() => validateModule(module))
  assert.equal(dalianApi.ticketPlaintext, ticketPlaintext)
  // 生产 ticket 用内置的服务端公钥
  assert.match(buildTicket('app.test', NOW), /^[0-9a-f]+$/)
  assert.match(SERVER_PUBLIC_KEY, /^04[0-9A-F]{128}$/)
})

console.log(`\n全部通过：${passed} ✅`)
