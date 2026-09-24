#!/usr/bin/env node
/**
 * 深圳广电官方节目单回归测试：上海零点 → 请求地址、按 daytime 挑那天、偏移 → 起止（下一条开始 /
 * 当天 24:00）、同刻两条去零长度、错误路径、频道 ref 与模块取流输出一一对应。全程离线，
 * 夹具按 2026-09-25 实测响应裁剪。
 *
 * 运行： node scripts/test-sztv-epg.mjs
 *       TZ=UTC node scripts/test-sztv-epg.mjs; TZ=America/Los_Angeles node scripts/test-sztv-epg.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import sztvEpg, { CHANNELS, EPG_API, dayStartMs, epgUrl, parseDay } from '../extractors/sztv/epg.js'
import { clearCache } from '../extractors/sztv/api.js'
import { getModule, validateModule } from '../extractors/registry.js'
import { providerProgrammes } from '../utils/epgXmltv.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }
const json = (body, init = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), {
  status: 200,
  ...init,
  headers: { 'content-type': 'application/json', ...init.headers },
})
const clone = value => JSON.parse(JSON.stringify(value))
const shanghaiClock = ms => new Date(ms + 8 * 3600 * 1000).toISOString().slice(11, 16)
const listed = programmes => programmes.map(item => `${shanghaiClock(item.start)}-${shanghaiClock(item.stop)} ${item.title}`)

// 2026-09-25 00:00 上海 = 2026-09-24T16:00:00Z
const DAY = '20260925'
const DAY_START = 1790265600000
const YESTERDAY_START = DAY_START - 24 * 3600 * 1000
// 上海 09-25 10:00
const NOW = DAY_START + 10 * 3600 * 1000

// ---- 夹具：2026-09-25 都市频道（ZwxzUXr）daytime=今天零点 实测响应裁剪 ----
// 字段、类型、取值原样，只删掉中间的节目和更早的五天。09-24 那天 05:40 排着「开台」与另一条同刻节目。
const DUSHI = {
  done: 'ok',
  id: 'ZwxzUXr',
  list: [
    {
      daytime: YESTERDAY_START,
      programme: [
        { s: 600000, t: '重播《第一现场》' },
        { s: 8400000, t: '闭台（测试卡）' },
        { s: 20400000, t: '开台' },
        { s: 20400000, t: '重播《女人帮》' },
        { s: 21900000, t: '重播《龙华十分》' },
      ],
    },
    {
      daytime: DAY_START,
      programme: [
        { s: 600000, t: '重播《第一现场》' },
        { s: 4200000, t: '重播《第1时评》' },
        { s: 8400000, t: '闭台（测试卡）' },
        { s: 20400000, t: '开台' },
        { s: 20700000, t: '重播《谈天说地》' },
        { s: 66000000, t: '定点直播《第一现场》' },
        { s: 69300000, t: '首播《第1时评》' },
        { s: 73800000, t: '第一剧场《新边城浪子》35-39' },
      ],
    },
  ],
}

// 深圳卫视（AxeFRth）今天傍晚一段
const WEISHI = {
  done: 'ok',
  id: 'AxeFRth',
  list: [{
    daytime: DAY_START,
    programme: [
      { s: 65400000, t: '重播《湾区财经》' },
      { s: 66600000, t: '《深视新闻》' },
      { s: 68400000, t: '转播中央台新闻联播' },
      { s: 70200000, t: '《美好深圳》' },
      { s: 85860000, t: '重播《湾区财经》' },
    ],
  }],
}

// 少儿频道：官方没有节目单；明天、不认识的频道、少参数都是 HTTP 200 + done 报错
const SHAOER = { done: 'ok', id: '1SIQj6s', list: [] }
const FUTURE = { done: '日期异常' }
const UNKNOWN = { done: '频道不存在' }
const MALFORMED = { done: '格式异常' }

// 官网栏目接口的全部行（含取流侧排除的购物频道），id、名称、liveId 取自 2026-09-25 实测
const CATALOG = {
  returnCode: '0000',
  returnDesc: '成功',
  returnData: [
    [24725, '深圳卫视4K超高清', 'R77mK1v'], [7867, '深圳卫视', 'AxeFRth'], [7868, '都市频道', 'ZwxzUXr'],
    [7880, '电视剧频道', '4azbkoY'], [7881, '少儿频道', '1SIQj6s'], [7869, '移动电视', 'wDF6KJ3'],
    [7878, '宜和购物频道', 'BJ5u5k2'], [7944, '国际频道', 'sztvgjpd'],
  ].map(([id, name, liveId]) => ({ id, name, logo: '', extend: { liveId, liveRate: [500], refername: name } })),
}

console.log('深圳节目单测试')

check('上海日期 → 当天零点毫秒与地址，不看运行机器的时区', () => {
  assert.equal(dayStartMs(DAY), DAY_START)
  assert.equal(dayStartMs('20260101'), Date.parse('2026-01-01T00:00:00+08:00'))
  assert.equal(EPG_API, 'https://hls-api.sztv.com.cn/api/getEpgs')
  assert.equal(epgUrl('ZwxzUXr', DAY), `${EPG_API}?channelId=ZwxzUXr&daytime=1790265600000`)
  for (const bad of ['20260231', '20261301', '2026925', '2026-09-25', '', 'abcdefgh']) {
    assert.ok(Number.isNaN(dayStartMs(bad)), bad)
  }
})

check('按 daytime 挑那天：偏移落到上海时钟，结束取下一条开始，最后一条到当天 24:00', () => {
  const programmes = parseDay(DUSHI, DAY_START)
  assert.deepEqual(listed(programmes), [
    '00:10-01:10 重播《第一现场》',
    '01:10-02:20 重播《第1时评》',
    '02:20-05:40 闭台（测试卡）',
    '05:40-05:45 开台',
    '05:45-18:20 重播《谈天说地》',
    '18:20-19:15 定点直播《第一现场》',
    '19:15-20:30 首播《第1时评》',
    '20:30-00:00 第一剧场《新边城浪子》35-39',
  ])
  assert.equal(programmes.at(-1).stop, DAY_START + 24 * 3600 * 1000)
  const relay = parseDay(WEISHI, DAY_START).find(item => item.title === '转播中央台新闻联播')
  assert.deepEqual(relay, { title: '转播中央台新闻联播', start: 1790334000000, stop: 1790335800000 })
  assert.equal(new Date(relay.start).toISOString(), '2026-09-25T11:00:00.000Z', '新闻联播 19:00 +08:00')
})

check('同一时刻的两条：前一条零长度丢掉，留官方排在后面的那条', () => {
  assert.deepEqual(listed(parseDay(DUSHI, YESTERDAY_START)), [
    '00:10-02:20 重播《第一现场》',
    '02:20-05:40 闭台（测试卡）',
    '05:40-06:05 重播《女人帮》',
    '06:05-00:00 重播《龙华十分》',
  ])
})

check('乱序照排；节目名去空白，缺名、负数、越过一天、非整数偏移的条目跳过', () => {
  const payload = {
    done: 'ok',
    list: [{
      daytime: DAY_START,
      programme: [
        { s: 70200000, t: '《美好深圳》' },
        { s: 68400000, t: '  转播中央台新闻联播 \n' },
        { s: 69000000, t: '   ' },
        { s: -1000, t: '负数' },
        { s: 86400000, t: '越过一天' },
        { s: '68400000', t: '字符串' },
        { s: 68400000.5, t: '小数' },
        null,
      ],
    }],
  }
  assert.deepEqual(listed(parseDay(payload, DAY_START)), ['19:00-19:30 转播中央台新闻联播', '19:30-00:00 《美好深圳》'])
})

check('那天没有分组、官方空节目单都回空；done 报错、结构不对、整批解不出都抛', () => {
  assert.deepEqual(parseDay(SHAOER, DAY_START), [])
  assert.deepEqual(parseDay(DUSHI, DAY_START + 24 * 3600 * 1000), [])
  assert.deepEqual(parseDay({ done: 'ok', list: [{ daytime: DAY_START, programme: [] }] }, DAY_START), [])
  assert.throws(() => parseDay(FUTURE, DAY_START), /接口拒绝：日期异常/)
  assert.throws(() => parseDay(UNKNOWN, DAY_START), /接口拒绝：频道不存在/)
  assert.throws(() => parseDay(MALFORMED, DAY_START), /接口拒绝：格式异常/)
  assert.throws(() => parseDay({}, DAY_START), /接口拒绝：没有 done/)
  assert.throws(() => parseDay(null, DAY_START), /返回结构异常/)
  assert.throws(() => parseDay([], DAY_START), /返回结构异常/)
  assert.throws(() => parseDay({ done: 'ok' }, DAY_START), /返回结构异常/)
  assert.throws(() => parseDay({ done: 'ok', list: [{ daytime: DAY_START, programme: 'x' }] }, DAY_START), /返回结构异常/)
  const seconds = clone(WEISHI)
  for (const item of seconds.list[0].programme) item.s = `${item.s / 1000}`
  assert.throws(() => parseDay(seconds, DAY_START), /时间格式异常/)
})

await checkAsync('请求：liveId + 今天零点毫秒、官网播放器来源头、不跟随跳转、可被打断', async () => {
  let seen
  const programmes = await sztvEpg.programmes('ZwxzUXr', DAY, {
    now: NOW,
    fetchImpl: async (url, options) => { seen = { url, options }; return json(DUSHI) },
  })
  assert.equal(programmes.length, 8)
  assert.equal(seen.url, `${EPG_API}?channelId=ZwxzUXr&daytime=${DAY_START}`)
  assert.equal(seen.options.redirect, 'manual')
  assert.ok(seen.options.signal instanceof AbortSignal)
  assert.equal(seen.options.headers.Referer, 'https://www.sztv.com.cn/pindao/index.html?liveId=ZwxzUXr')
})

await checkAsync('明天往后不联网直接回空（官方只发到今天）；过去的日子照取', async () => {
  const fetchImpl = async () => { throw new Error('不应请求') }
  assert.deepEqual(await sztvEpg.programmes('ZwxzUXr', '20260926', { now: NOW, fetchImpl }), [])
  const past = await sztvEpg.programmes('ZwxzUXr', '20260924', { now: NOW, fetchImpl: async () => json(DUSHI) })
  assert.equal(past.length, 4)
})

await checkAsync('官方没发（少儿）回空数组，不抛', async () => {
  assert.deepEqual(await sztvEpg.programmes('1SIQj6s', DAY, { now: NOW, fetchImpl: async () => json(SHAOER) }), [])
})

await checkAsync('HTTP 错误、跳转、done 报错、非 JSON、网络错误都抛出', async () => {
  const run = fetchImpl => sztvEpg.programmes('ZwxzUXr', DAY, { now: NOW, fetchImpl })
  await assert.rejects(run(async () => json('', { status: 503 })), /深圳节目单 HTTP 503/)
  await assert.rejects(run(async () => new Response(null, { status: 302, headers: { location: 'https://example.com/' } })), /HTTP 302/)
  await assert.rejects(run(async () => json(FUTURE)), /日期异常/)
  await assert.rejects(run(async () => json(UNKNOWN)), /频道不存在/)
  await assert.rejects(run(async () => json('<html>502 Bad Gateway</html>')), /不是 JSON/)
  await assert.rejects(run(async () => { throw new TypeError('fetch failed') }), /fetch failed/)
})

await checkAsync('响应过大：声明长度超限直接拒，流式读到超限就断开', async () => {
  const run = fetchImpl => sztvEpg.programmes('ZwxzUXr', DAY, { now: NOW, fetchImpl })
  await assert.rejects(run(async () => json('{}', { headers: { 'content-length': String(10 * 1024 * 1024) } })), /响应过大/)
  let cancelled = false
  const endless = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(64 * 1024).fill(0x20)) },
    cancel() { cancelled = true },
  })
  await assert.rejects(run(async () => new Response(endless)), /响应过大/)
  assert.ok(cancelled, '超限后断开上游')
})

await checkAsync('超时由 AbortController 打断', async () => {
  const hanging = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
  })
  const startedAt = Date.now()
  await assert.rejects(sztvEpg.programmes('ZwxzUXr', DAY, { now: NOW, fetchImpl: hanging, timeoutMs: 30 }), { name: 'AbortError' })
  assert.ok(Date.now() - startedAt < 2000)
})

await checkAsync('非法频道 key 或日期直接拒绝，不联网', async () => {
  const fetchImpl = async () => { throw new Error('不应请求') }
  for (const [key, day] of [['../x', DAY], ['ab', DAY], ['', DAY], ['Zwx&daytime=1', DAY], ['ZwxzUXr', '2026-09-25'], ['ZwxzUXr', '20260230']]) {
    await assert.rejects(sztvEpg.programmes(key, day, { now: NOW, fetchImpl }), /参数非法/, `${key} ${day}`)
  }
})

await checkAsync('只取今天：经公共件按上海日期取一天，跨时区也落在同一天', async () => {
  assert.equal(sztvEpg.days, 1)
  const requested = []
  // 上海 09-25 00:30；在 UTC / 洛杉矶跑时本机日期还是 09-24
  const programmes = await providerProgrammes(sztvEpg, 'ZwxzUXr', {
    now: Date.parse('2026-09-24T16:30:00Z'),
    fetchImpl: async url => { requested.push(url); return json(DUSHI) },
  })
  assert.deepEqual(requested, [`${EPG_API}?channelId=ZwxzUXr&daytime=${DAY_START}`])
  assert.equal(programmes.length, 8)
})

await checkAsync('节目单频道与模块取流输出的 deferredRef、名字一一对应，购物频道不出节目单', async () => {
  clearCache()
  try {
    const result = await getModule('sztv').fetch({}, { now: NOW, fetchImpl: async () => json(CATALOG) })
    const emitted = result.groups.flatMap(group => group.dataList)
    const channels = sztvEpg.channels()
    assert.equal(emitted.length, 7, '购物频道不输出')
    assert.deepEqual(channels.map(channel => channel.ref), emitted.map(channel => channel.deferredRef))
    assert.deepEqual(channels.map(channel => channel.name), emitted.map(channel => channel.name))
    // key 就是同一行栏目的 liveId
    const liveIds = new Map(CATALOG.returnData.map(row => [`sztv-${row.id}`, row.extend.liveId]))
    for (const channel of channels) assert.equal(channel.key, liveIds.get(channel.ref), channel.name)
    assert.ok(!CHANNELS.some(channel => channel.liveId === 'BJ5u5k2'))
  } finally {
    clearCache()
  }
})

check('模块已挂上节目单，提供者可单独拆走（不 import 任何项目模块）', () => {
  const module = getModule('sztv')
  assert.equal(module.epg, sztvEpg)
  assert.equal(module.capabilities.epg, true)
  assert.doesNotThrow(() => validateModule(module))
  const source = readFileSync(new URL('../extractors/sztv/epg.js', import.meta.url), 'utf8')
  const specifiers = [...source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map(match => match[1])
  for (const specifier of specifiers) assert.ok(specifier.startsWith('node:'), specifier)
})

console.log(`\n全部通过：${passed} ✅`)
