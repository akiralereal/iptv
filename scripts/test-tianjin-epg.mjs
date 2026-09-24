#!/usr/bin/env node
/**
 * 天津广电（津云 WiseTV）官方节目单回归测试：请求形状、上海日期切天、零点切口与三小时切段的合并、
 * 时长批注、各类错误。全程离线，夹具照 2026-09-25 接口实际返回裁剪。
 *
 * 运行： node scripts/test-tianjin-epg.mjs
 *       TZ=UTC node scripts/test-tianjin-epg.mjs
 *       TZ=America/Los_Angeles node scripts/test-tianjin-epg.mjs
 */
import assert from 'node:assert/strict'

import tianjin from '../extractors/tianjin/index.js'
import tianjinEpg, { EPG_API, parseProgrammes, programmesUrl, shanghaiTime } from '../extractors/tianjin/epg.js'
import { buildChannels } from '../extractors/tianjin/api.js'
import { DEVICE_ID, wiseConfig } from '../extractors/tianjin/auth.js'
import { getModule, validateModule } from '../extractors/registry.js'
import { providerProgrammes, xmltvTime } from '../utils/epgXmltv.js'

// 离线：任何一条路径漏了注入的 fetchImpl 都直接失败
globalThis.fetch = async () => { throw new Error('离线测试不应访问网络') }

let passed = 0
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

const WS = '30001110000000000000000000000698'
const TY = '30001110000000000000000000000692'
let serial = 0
// 接口每行的字段与顺序：id, text, control, channelId, startTime, endTime, systemDate
const row = (channelId, start, end, text, control = 1285) => ({
  id: String(31002110000000000000000210356554n + BigInt(serial++)),
  text, control, channelId, startTime: start, endTime: end, systemDate: start.slice(0, 10),
})
const day = (channelId, date, programs) => ({ channelId, programs, systemDate: date })
const payload = (channelId, days) => ({ programslist: { channelId, data: days }, code: 200, message: 'OK', timestamp: 1790276138476 })
// 接口声明 text/html，正文是 JSON
const reply = (body, status = 200, headers = {}) => new Response(typeof body === 'string' || body instanceof ReadableStream ? body : JSON.stringify(body), {
  status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
})

const ws = (start, end, text, control) => row(WS, start, end, text, control)
// 天津卫视 09-24 末尾、09-25 全天摘录（播出日志粒度）、09-26（上午细、之后是编排计划）、09-27 开头
const D24 = day(WS, '2026-09-24', [
  ws('2026-09-24 22:43:00', '2026-09-24 23:24:00', '幸福满院(22)'),
  ws('2026-09-24 23:24:00', '2026-09-24 23:28:00', '天气预报', 3855),
  ws('2026-09-24 23:28:00', '2026-09-24 23:59:59', '八千里路云和月(14)'),
])
const D25 = day(WS, '2026-09-25', [
  ws('2026-09-25 00:00:00', '2026-09-25 00:13:00', '八千里路云和月(14)'),
  ws('2026-09-25 00:13:00', '2026-09-25 00:56:00', '八千里路云和月(15)'),
  ws('2026-09-25 01:53:00', '2026-09-25 02:37:00', '医探究竟', 3855),
  ws('2026-09-25 02:37:00', '2026-09-25 03:22:00', '医探究竟', 3855),
  ws('2026-09-25 18:30:00', '2026-09-25 18:57:00', '天津新闻', 3855),
  ws('2026-09-25 18:57:00', '2026-09-25 19:00:00', '天气预报', 3855),
  ws('2026-09-25 19:00:00', '2026-09-25 19:32:00', '新闻联播', 3855),
  ws('2026-09-25 23:51:00', '2026-09-25 23:55:00', '天气预报', 3855),
  ws('2026-09-25 23:55:00', '2026-09-25 23:59:59', '八千里路云和月(16)'),
])
const D26 = day(WS, '2026-09-26', [
  ws('2026-09-26 00:00:00', '2026-09-26 00:40:00', '八千里路云和月(16)'),
  ws('2026-09-26 00:40:00', '2026-09-26 01:23:00', '八千里路云和月(17)'),
  ws('2026-09-26 07:00:00', '2026-09-26 07:30:00', '津晨播报30’', 3855),
  ws('2026-09-26 07:30:00', '2026-09-26 10:30:00', '剧场:天狼星行动(4.5.6.7)'),
  ws('2026-09-26 10:30:00', '2026-09-26 12:00:00', '剧场:天狼星行动(4.5.6.7)'),
  ws('2026-09-26 12:25:00', '2026-09-26 12:30:00', '天气预报1’30”', 3855),
  ws('2026-09-26 18:30:00', '2026-09-26 18:57:00', '天津新闻 25’', 3855),
  ws('2026-09-26 23:25:00', '2026-09-26 23:30:00', '天气预报2’30”', 3855),
  ws('2026-09-26 23:30:00', '2026-09-26 23:59:59', '剧场:八千里路云和月(18)'),
])
const D27 = day(WS, '2026-09-27', [
  ws('2026-09-27 00:00:00', '2026-09-27 03:00:00', '剧场:八千里路云和月(18)'),
  ws('2026-09-27 03:00:00', '2026-09-27 04:20:00', '剧场:八千里路云和月(18)'),
  ws('2026-09-27 04:20:00', '2026-09-27 06:30:00', '剧场:虎刺红(13.14.15)'),
])
// 请求区间 → 接口返回的那几天
const SERVER = { '2026-09-24/2026-09-26': [D24, D25, D26], '2026-09-25/2026-09-27': [D25, D26, D27] }

function serve(log = []) {
  return async (url, init) => {
    log.push({ url: String(url), init })
    const match = /\/show\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})\/(\d{32})\/timestamp=0$/.exec(String(url))
    if (!match) return reply({ code: 404, message: 'not found' })
    const days = SERVER[`${match[1]}/${match[2]}`]
    if (!days) return reply({ code: 400, message: '开始时间不得早于今天往前第五天，结束时间不得晚于后天' })
    return reply(payload(match[3], match[3] === WS ? days : []))
  }
}

const at = text => shanghaiTime(text)
const titles = items => items.map(item => item.title)
const spans = items => items.map(item => [item.title, xmltvTime(item.start), xmltvTime(item.stop)])

console.log('天津广电（津云）节目单测试')

await checkAsync('模块挂上节目单提供者，频道表七路都有频道 ID 且都在模块输出里', async () => {
  assert.equal(getModule('tianjin'), tianjin)
  assert.equal(tianjin.epg, tianjinEpg)
  assert.equal(tianjin.capabilities.epg, true)
  assert.equal(tianjinEpg.days, 2)
  assert.doesNotThrow(() => validateModule(tianjin))
  const emitted = (await tianjin.fetch()).groups.flatMap(group => group.dataList)
  const provided = tianjinEpg.channels()
  assert.deepEqual(provided.map(channel => channel.ref), emitted.map(channel => channel.deferredRef))
  assert.deepEqual(provided.map(channel => channel.name), emitted.map(channel => channel.name))
  assert.deepEqual(provided.map(channel => channel.ref), buildChannels().map(channel => channel.deferredRef))
  assert.equal(provided[0].key, WS)
  assert.ok(provided.every(channel => /^\d{32}$/.test(channel.key)))
})

await checkAsync('请求形状：取当天连同前后各一天，带 App 的 ak/sk 与设备头，不跟跳转', async () => {
  const log = []
  await tianjinEpg.programmes(WS, '20260925', { fetchImpl: serve(log) })
  assert.equal(log.length, 1)
  assert.equal(log[0].url, `${EPG_API}/2026-09-24/2026-09-26/${WS}/timestamp=0`)
  assert.equal(log[0].url, `https://jyapi2.wisetv.com.cn:8684/v3/tv/programs/show/2026-09-24/2026-09-26/${WS}/timestamp=0`)
  assert.equal(programmesUrl(WS, '2026-09-25', '2026-09-27'), `${EPG_API}/2026-09-25/2026-09-27/${WS}/timestamp=0`)
  assert.equal(log[0].init.redirect, 'manual')
  assert.ok(log[0].init.signal instanceof AbortSignal)
  const headers = log[0].init.headers
  assert.equal(headers.ak, wiseConfig({}).ak)
  assert.equal(headers.sk, wiseConfig({}).sk)
  assert.equal(headers['x-deviceid'], DEVICE_ID)
  // 月末跨月也按上海日期推
  log.length = 0
  await tianjinEpg.programmes(WS, '20261001', { fetchImpl: serve(log) }).catch(() => {})
  assert.equal(log[0].url, `${EPG_API}/2026-09-30/2026-10-02/${WS}/timestamp=0`)
})

await checkAsync('按上海日期切天：末条 23:59:59 补到零点，跨零点的两段合回一条、两天都带着', async () => {
  const today = await tianjinEpg.programmes(WS, '20260925', { fetchImpl: serve() })
  assert.deepEqual(spans(today), [
    ['八千里路云和月(14)', '20260924232800 +0800', '20260925001300 +0800'],
    ['八千里路云和月(15)', '20260925001300 +0800', '20260925005600 +0800'],
    ['医探究竟', '20260925015300 +0800', '20260925023700 +0800'],
    ['医探究竟', '20260925023700 +0800', '20260925032200 +0800'],
    ['天津新闻', '20260925183000 +0800', '20260925185700 +0800'],
    ['天气预报', '20260925185700 +0800', '20260925190000 +0800'],
    ['新闻联播', '20260925190000 +0800', '20260925193200 +0800'],
    ['天气预报', '20260925235100 +0800', '20260925235500 +0800'],
    ['八千里路云和月(16)', '20260925235500 +0800', '20260926004000 +0800'],
  ])
  const news = today.find(item => item.title === '新闻联播')
  assert.equal(news.start, Date.parse('2026-09-25T11:00:00Z'))
  assert.ok(!today.some(item => item.title === '幸福满院(22)'), '前一天整条结束的不带')

  const tomorrow = await tianjinEpg.programmes(WS, '20260926', { fetchImpl: serve() })
  assert.equal(tomorrow[0].title, '八千里路云和月(16)')
  assert.equal(tomorrow[0].start, today.at(-1).start, '跨零点那条两次调用给出同一开始时间，调用方按开始时间去重')
  assert.equal(tomorrow[0].stop, at('2026-09-26 00:40:00'))
})

await checkAsync('编排计划：三小时切段合回一条，时长批注去掉；同名但不是人为切口的相邻两条照留', async () => {
  const tomorrow = await tianjinEpg.programmes(WS, '20260926', { fetchImpl: serve() })
  assert.deepEqual(spans(tomorrow), [
    ['八千里路云和月(16)', '20260925235500 +0800', '20260926004000 +0800'],
    ['八千里路云和月(17)', '20260926004000 +0800', '20260926012300 +0800'],
    ['津晨播报', '20260926070000 +0800', '20260926073000 +0800'],
    ['剧场:天狼星行动(4.5.6.7)', '20260926073000 +0800', '20260926120000 +0800'],
    ['天气预报', '20260926122500 +0800', '20260926123000 +0800'],
    ['天津新闻', '20260926183000 +0800', '20260926185700 +0800'],
    ['天气预报', '20260926232500 +0800', '20260926233000 +0800'],
    // 零点切口 + 次日 00:00–03:00 三小时切段 + 03:00–04:20，一共三段合成一条
    ['剧场:八千里路云和月(18)', '20260926233000 +0800', '20260927042000 +0800'],
  ])
  // 体育频道的「体育赛事」三段（90、120、175 分钟）是各自独立的播出条目，不合
  const sports = parseProgrammes(payload(TY, [day(TY, '2026-09-25', [
    row(TY, '2026-09-25 00:30:00', '2026-09-25 02:00:00', '体育赛事'),
    row(TY, '2026-09-25 02:00:00', '2026-09-25 04:00:00', '体育赛事'),
    row(TY, '2026-09-25 04:00:00', '2026-09-25 06:55:00', '体育赛事'),
    row(TY, '2026-09-25 06:55:00', '2026-09-25 07:00:00', '都市报道60分'),
  ])]), TY)
  assert.deepEqual(titles(sports), ['体育赛事', '体育赛事', '体育赛事', '都市报道60分'])
})

await checkAsync('走 providerProgrammes：今天 + 明天，跨零点那条只留一份，互不重叠', async () => {
  const log = []
  // 2026-09-25 10:00（上海）
  const items = await providerProgrammes(tianjinEpg, WS, { now: Date.parse('2026-09-25T02:00:00Z'), fetchImpl: serve(log) })
  assert.equal(log.length, 2)
  assert.equal(items.filter(item => item.title === '八千里路云和月(16)').length, 1)
  assert.ok(items.every((item, index) => item.start < item.stop && (index === 0 || items[index - 1].stop <= item.start)))
  assert.equal(items.at(-1).title, '剧场:八千里路云和月(18)')
})

await checkAsync('兜底：别的频道的行、坏时间、倒挂、空标题丢掉；同一开始只留第一条；重叠截到下一条开始', async () => {
  const items = parseProgrammes(payload(WS, [day(WS, '2026-09-25', [
    ws('2026-09-25 19:00:00', '2026-09-25 19:40:00', '新闻联播'),
    ws('2026-09-25 19:00:00', '2026-09-25 19:32:00', '重复'),
    ws('2026-09-25 19:32:00', '2026-09-25 20:25:00', '八千里路云和月(16)'),
    row(TY, '2026-09-25 19:40:00', '2026-09-25 20:00:00', '别的频道'),
    ws('2026-02-30 18:30:00', '2026-02-30 19:00:00', '坏日期'),
    ws('2026-09-25 21:00:00', '2026-09-25 20:00:00', '倒挂'),
    ws('2026-09-25 21:00:00', '2026-09-25 21:00:00', '零时长'),
    ws('2026-09-25 21:00:00', '2026-09-25 21:30:00', '   '),
    { text: '缺字段', channelId: WS },
    null,
  ])]), WS)
  assert.deepEqual(spans(items), [
    ['新闻联播', '20260925190000 +0800', '20260925193200 +0800'],
    ['八千里路云和月(16)', '20260925193200 +0800', '20260925202500 +0800'],
  ])
  for (const bad of ['2026-02-30 00:00:00', '2026-09-25 24:00:00', '2026-09-25T18:30:00', '', null]) {
    assert.ok(Number.isNaN(shanghaiTime(bad)), String(bad))
  }
  // 当天没排节目：空数组，不算失败
  assert.deepEqual(await tianjinEpg.programmes(TY, '20260925', { fetchImpl: serve() }), [])
})

await checkAsync('接口错误、HTTP 错误、非 JSON、结构不对、超时、过大都抛出', async () => {
  const cases = [
    [async () => reply({ code: 4001, message: '缺少授权认证信息' }), /缺少授权认证信息/],
    [async () => reply({ code: 400, message: '开始时间不得早于今天往前第五天，结束时间不得晚于后天' }), /不得晚于后天/],
    [async () => reply({ code: 200, message: 'OK' }), /格式异常/],
    [async () => reply('<html>502 Bad Gateway</html>'), /不是 JSON/],
    [async () => reply('', 503), /HTTP 503/],
    [async () => reply('', 302, { location: 'http://evil.test/' }), /HTTP 302/],
    [async () => { throw new TypeError('fetch failed') }, /fetch failed/],
    [async () => reply('{}', 200, { 'content-length': String(3 * 1024 * 1024) }), /响应过大/],
  ]
  for (const [fetchImpl, pattern] of cases) {
    await assert.rejects(tianjinEpg.programmes(WS, '20260925', { fetchImpl }), pattern, String(pattern))
  }
  const hang = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason))
  })
  await assert.rejects(tianjinEpg.programmes(WS, '20260925', { fetchImpl: hang, timeoutMs: 20 }), { name: 'AbortError' })
  // 没有 content-length 的分块响应，读到一半超了就停
  let pulled = 0
  const chunk = new Uint8Array(256 * 1024).fill(0x20)
  const endless = new ReadableStream({ pull(controller) { pulled++; controller.enqueue(chunk) } })
  await assert.rejects(tianjinEpg.programmes(WS, '20260925', { fetchImpl: async () => reply(endless) }), /响应过大/)
  assert.ok(pulled <= 4, `超限后不再继续读：${pulled}`)
  // 一天失败只丢这一天
  const items = await providerProgrammes(tianjinEpg, WS, {
    now: Date.parse('2026-09-25T02:00:00Z'),
    fetchImpl: async (url, init) => (String(url).includes('/2026-09-25/2026-09-27/') ? reply('', 502) : serve()(url, init)),
  })
  assert.equal(items.at(-1).title, '八千里路云和月(16)')
})

await checkAsync('参数非法不发请求', async () => {
  const fetchImpl = async () => { throw new Error('不应请求') }
  for (const [key, date] of [['../x', '20260925'], ['123', '20260925'], [`${WS}/x`, '20260925'],
    [WS, '2026-09-25'], [WS, '20260230'], [WS, '2026092'], [WS, undefined]]) {
    await assert.rejects(tianjinEpg.programmes(key, date, { fetchImpl }), /参数非法/, `${key} ${date}`)
  }
  // 数字形式的日期也认
  assert.equal((await tianjinEpg.programmes(WS, 20260925, { fetchImpl: serve() })).length, 9)
})

console.log(`\n全部通过：${passed} ✅（TZ=${process.env.TZ || '系统默认'}）`)
