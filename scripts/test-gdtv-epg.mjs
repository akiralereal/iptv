#!/usr/bin/env node
/**
 * 广东台（荔枝网）官方节目单回归测试：上海日期 → 三天窗口地址、HMAC 签名请求头（对官网签名模块的
 * 实测输出）、解析与跨零点截断、错误路径、频道 ref 与模块取流输出一一对应。全程离线，
 * 夹具按 2026-09-25 实测响应裁剪。
 *
 * 运行： node scripts/test-gdtv-epg.mjs
 *       TZ=UTC node scripts/test-gdtv-epg.mjs; TZ=America/Los_Angeles node scripts/test-gdtv-epg.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import gdtvEpg, { CA_KEY, EPG_API, dayStartMs, epgUrl, parseMenus, signedHeaders } from '../extractors/gdtv/epg.js'
import { getModule, validateModule } from '../extractors/registry.js'
import { providerProgrammes } from '../utils/epgXmltv.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }
const json = (body, init = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), {
  status: 200,
  ...init,
  headers: { 'content-type': 'application/json;charset=UTF-8', ...init.headers },
})
const clone = value => JSON.parse(JSON.stringify(value))
const shanghaiClock = ms => new Date(ms + 8 * 3600 * 1000).toISOString().slice(11, 16)

// 2026-09-25 00:00 上海 = 2026-09-24T16:00:00Z
const DAY = '20260925'
const DAY_START = 1790265600000
const DAY_END = DAY_START + 24 * 3600 * 1000

// ---- 夹具：2026-09-25 广东卫视（tvChannelPk=43）beginAt=2026-09-24&endAt=2026-09-26 实测响应裁剪 ----
// 字段、类型、取值原样，只删掉中间的节目。24 日末条排到 25 日 00:40，25 日首条 00:24 就开始；
// 25 日末条排到 26 日 00:40，26 日首条 00:21 就开始——官网跨零点两天常叠十几二十分钟。
const menu = (pk, name, beginAt, endAt, tvColumnPk = 0) => ({ pk, name, beginAt, endAt, playBackUrl: null, sid: null, tvColumnPk, anchor: null })
const WEISHI = {
  resultList: [
    {
      dateAt: '2026-09-24',
      tvMenus: [
        menu(293357391, '孤舟(28)', 1790262420000, 1790265000000),
        menu(293357392, '南粤4K画卷', 1790265000000, 1790268000000, 66700873),
      ],
    },
    {
      dateAt: '2026-09-25',
      tvMenus: [
        menu(293548096, '英雄虎胆', 1790267040000, 1790272200000),
        menu(293548097, '重播节目、纪录片', 1790272200000, 1790283600000),
        menu(293548119, '广东新闻联播', 1790332200000, 1790333760000, 687),
        menu(293548120, '天气预报', 1790333760000, 1790334000000),
        menu(293548121, '转播中央台新闻联播', 1790334000000, 1790336100000),
        menu(293548122, '“山海升明月”2026粤港澳大湾区中秋晚会', 1790336100000, 1790343900000),
        menu(293548126, '南粤4K画卷', 1790351400000, 1790354400000, 66700873),
      ],
    },
    {
      dateAt: '2026-09-26',
      tvMenus: [
        menu(293548127, '跟踪追击', 1790353260000, 1790358780000),
        menu(293548128, '重播节目、纪录片', 1790358780000, 1790370000000),
      ],
    },
  ],
  systemTime: 1790271139792,
}

// 广东台经典剧（100）、纪录片（94）、健康（99）与不认识的频道：每天都是空 tvMenus
const EMPTY = {
  resultList: [
    { dateAt: '2026-09-24', tvMenus: [] },
    { dateAt: '2026-09-25', tvMenus: [] },
    { dateAt: '2026-09-26', tvMenus: [] },
  ],
  systemTime: 1790271198038,
}

// 不签名 / 旧密钥的实测 401 正文；少参数的 400 正文
const UNAUTHORIZED = { errorCode: 401, errorMessage: 'Unauthorized access!' }
const BAD_REQUEST = {
  timestamp: '2026-09-24T17:33:18.779+00:00',
  status: 400,
  error: 'Bad Request',
  message: "Required String parameter 'endAt' is not present",
  path: '/api/tv/v2/tvMenu',
}

console.log('广东台节目单测试')

check('上海日期 → 当天零点与前后各一天的地址，不看运行机器的时区', () => {
  assert.equal(dayStartMs(DAY), DAY_START)
  assert.equal(dayStartMs('20260101'), Date.parse('2026-01-01T00:00:00+08:00'))
  assert.equal(EPG_API, 'https://gdtv-api.gdtv.cn/api/tv/v2/tvMenu')
  assert.equal(epgUrl('43', DAY), `${EPG_API}?tvChannelPk=43&beginAt=2026-09-24&endAt=2026-09-26`)
  // 跨月、跨年
  assert.equal(epgUrl('16', '20261001'), `${EPG_API}?tvChannelPk=16&beginAt=2026-09-30&endAt=2026-10-02`)
  assert.equal(epgUrl('16', '20261231'), `${EPG_API}?tvChannelPk=16&beginAt=2026-12-30&endAt=2027-01-01`)
  for (const bad of ['20260231', '20261301', '2026925', '2026-09-25', '', 'abcdefgh']) {
    assert.ok(Number.isNaN(dayStartMs(bad)), bad)
  }
})

check('签名与官网 WebAssembly 签名模块的实测输出一致', () => {
  // 2026-09-25 在 Node 里跑官网兜底签名模块（chunk vendor_w_fallback）得到的一组值
  const url = `${EPG_API}?tvChannelPk=43&beginAt=2026-09-19&endAt=2026-09-28`
  assert.deepEqual(signedHeaders(url, 1790271100848), {
    'X-ITOUCHTV-Ca-Key': '89541943007407288657755311868534',
    'X-ITOUCHTV-Ca-Signature': 'B/fuVW8N1G7J18yGPb7p6JdxSzJXhLwZPzF1l5qDLxw=',
    'X-ITOUCHTV-Ca-Timestamp': '1790271100848',
    'X-ITOUCHTV-CLIENT': 'WEB_PC',
  })
  assert.equal(CA_KEY, '89541943007407288657755311868534')
  // 签的是完整 URL：换一个字符签名就变
  assert.notEqual(
    signedHeaders(url.replace('43', '44'), 1790271100848)['X-ITOUCHTV-Ca-Signature'],
    'B/fuVW8N1G7J18yGPb7p6JdxSzJXhLwZPzF1l5qDLxw=',
  )
  assert.throws(() => signedHeaders(url, Number.NaN), /请求时间无效/)
  assert.throws(() => signedHeaders(url, 1790271100), /请求时间无效/, '秒级时间戳不是官网的格式')
})

check('解析：毫秒原样、按上海时钟落点正确、跨零点重叠截到下一条开始', () => {
  const programmes = parseMenus(WEISHI)
  assert.deepEqual(programmes.map(item => item.title), [
    '孤舟(28)', '南粤4K画卷', '英雄虎胆', '重播节目、纪录片', '广东新闻联播', '天气预报',
    '转播中央台新闻联播', '“山海升明月”2026粤港澳大湾区中秋晚会', '南粤4K画卷', '跟踪追击', '重播节目、纪录片',
  ])
  const relay = programmes.find(item => item.title === '转播中央台新闻联播')
  assert.deepEqual(relay, { title: '转播中央台新闻联播', start: 1790334000000, stop: 1790336100000 })
  assert.equal(new Date(relay.start).toISOString(), '2026-09-25T11:00:00.000Z', '新闻联播 19:00 +08:00')
  // 24 日末条 23:50 → 00:40 截到 25 日首条 00:24；25 日末条截到 26 日首条 00:21
  assert.deepEqual([shanghaiClock(programmes[1].start), shanghaiClock(programmes[1].stop)], ['23:50', '00:24'])
  assert.deepEqual([shanghaiClock(programmes[8].start), shanghaiClock(programmes[8].stop)], ['23:50', '00:21'])
  for (let i = 1; i < programmes.length; i++) assert.ok(programmes[i - 1].stop <= programmes[i].start, `第 ${i} 条不重叠`)
})

check('节目名去空白，缺名、倒挂、零长度、秒级时间的条目跳过；同一时刻开始的只留一条', () => {
  const payload = {
    resultList: [{
      dateAt: '2026-09-25',
      tvMenus: [
        menu(1, '  转播中央台新闻联播 \n', 1790334000000, 1790336100000),
        menu(2, '同一时刻第二条', 1790334000000, 1790335000000),
        menu(3, '   ', 1790336100000, 1790343900000),
        menu(4, '零长度', 1790343900000, 1790343900000),
        menu(5, '倒挂', 1790350000000, 1790340000000),
        menu(6, '缺开始', null, 1790340000000),
        menu(7, '秒级', 1790334000, 1790336100),
        null,
      ],
    }],
  }
  assert.deepEqual(parseMenus(payload), [{ title: '转播中央台新闻联播', start: 1790334000000, stop: 1790336100000 }])
})

check('没排的日子回空；结构不对、拒绝正文、整批解不出（单位改了）都抛错', () => {
  assert.deepEqual(parseMenus(EMPTY), [])
  assert.deepEqual(parseMenus({ resultList: [] }), [])
  assert.throws(() => parseMenus(UNAUTHORIZED), /接口拒绝：Unauthorized access!/)
  assert.throws(() => parseMenus(BAD_REQUEST), /接口拒绝：Required String parameter/)
  assert.throws(() => parseMenus({}), /返回结构异常/)
  assert.throws(() => parseMenus(null), /返回结构异常/)
  assert.throws(() => parseMenus([]), /返回结构异常/)
  assert.throws(() => parseMenus({ resultList: [{ dateAt: '2026-09-25', tvMenus: 'x' }] }), /返回结构异常/)
  const seconds = clone(WEISHI)
  for (const group of seconds.resultList) {
    for (const item of group.tvMenus) { item.beginAt /= 1000; item.endAt /= 1000 }
  }
  assert.throws(() => parseMenus(seconds), /时间格式异常/)
})

await checkAsync('请求：前后各一天的窗口、带签名头与官网来源头、不跟随跳转、可被打断', async () => {
  const now = 1790271100848
  let seen
  await gdtvEpg.programmes('43', DAY, {
    now,
    fetchImpl: async (url, options) => { seen = { url, options }; return json(WEISHI) },
  })
  assert.equal(seen.url, `${EPG_API}?tvChannelPk=43&beginAt=2026-09-24&endAt=2026-09-26`)
  assert.equal(seen.options.redirect, 'manual')
  assert.ok(seen.options.signal instanceof AbortSignal)
  const { headers } = seen.options
  assert.deepEqual(
    Object.fromEntries(Object.entries(headers).filter(([name]) => name.startsWith('X-ITOUCHTV-'))),
    signedHeaders(seen.url, now),
  )
  assert.equal(headers['X-ITOUCHTV-Ca-Timestamp'], String(now))
  assert.equal(headers.Origin, 'https://www.gdtv.cn')
  assert.equal(headers.Referer, 'https://www.gdtv.cn/')
})

await checkAsync('签名时间取调用那一刻，不是节目单日期', async () => {
  let timestamp
  const before = Date.now()
  await gdtvEpg.programmes('43', '20260918', {
    fetchImpl: async (_url, options) => { timestamp = Number(options.headers['X-ITOUCHTV-Ca-Timestamp']); return json(EMPTY) },
  })
  assert.ok(timestamp >= before && timestamp <= Date.now())
})

await checkAsync('只回与当天有交集的节目：前一天跨进来的末条截短后保留，次日的不要', async () => {
  const programmes = await gdtvEpg.programmes('43', DAY, { fetchImpl: async () => json(WEISHI) })
  assert.deepEqual(programmes.map(item => `${shanghaiClock(item.start)}-${shanghaiClock(item.stop)} ${item.title}`), [
    '23:50-00:24 南粤4K画卷',
    '00:24-01:50 英雄虎胆',
    '01:50-05:00 重播节目、纪录片',
    '18:30-18:56 广东新闻联播',
    '18:56-19:00 天气预报',
    '19:00-19:35 转播中央台新闻联播',
    '19:35-21:45 “山海升明月”2026粤港澳大湾区中秋晚会',
    '23:50-00:21 南粤4K画卷',
  ])
  assert.ok(programmes.every(item => item.start < DAY_END && item.stop > DAY_START))
})

await checkAsync('官方没排（空频道、未来太远）返回空数组，不抛', async () => {
  assert.deepEqual(await gdtvEpg.programmes('100', DAY, { fetchImpl: async () => json(EMPTY) }), [])
  assert.deepEqual(await gdtvEpg.programmes('43', '20261010', { fetchImpl: async () => json(EMPTY) }), [])
})

await checkAsync('401（换了密钥）、其它 HTTP 错误、跳转、非 JSON、网络错误都抛出', async () => {
  const run = fetchImpl => gdtvEpg.programmes('43', DAY, { fetchImpl })
  await assert.rejects(run(async () => json(UNAUTHORIZED, { status: 401 })), /签名被拒（HTTP 401），官网可能换了密钥/)
  await assert.rejects(run(async () => json(BAD_REQUEST, { status: 400 })), /广东台节目单 HTTP 400/)
  await assert.rejects(run(async () => json('', { status: 503 })), /广东台节目单 HTTP 503/)
  await assert.rejects(run(async () => new Response(null, { status: 302, headers: { location: 'https://example.com/' } })), /HTTP 302/)
  await assert.rejects(run(async () => json('<html>502 Bad Gateway</html>')), /不是 JSON/)
  await assert.rejects(run(async () => json({ errorCode: 500, errorMessage: 'busy' })), /接口拒绝：busy/)
  await assert.rejects(run(async () => { throw new TypeError('fetch failed') }), /fetch failed/)
})

await checkAsync('响应过大：声明长度超限直接拒，流式读到超限就断开', async () => {
  const run = fetchImpl => gdtvEpg.programmes('43', DAY, { fetchImpl })
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
  await assert.rejects(gdtvEpg.programmes('43', DAY, { fetchImpl: hanging, timeoutMs: 30 }), { name: 'AbortError' })
  assert.ok(Date.now() - startedAt < 2000)
})

await checkAsync('非法频道 key 或日期直接拒绝，不联网', async () => {
  const fetchImpl = async () => { throw new Error('不应请求') }
  for (const [key, day] of [['../43', DAY], ['12345', DAY], ['', DAY], ['43&x=1', DAY], ['43', '2026-09-25'], ['43', '20260230']]) {
    await assert.rejects(gdtvEpg.programmes(key, day, { fetchImpl }), /参数非法/, `${key} ${day}`)
  }
})

await checkAsync('今天 + 明天：经公共件按上海日期取，跨零点那条只留一份，跨时区也落在同一天', async () => {
  assert.equal(gdtvEpg.days, 2)
  const requested = []
  // 上海 09-25 00:30；在 UTC / 洛杉矶跑时本机日期还是 09-24
  const programmes = await providerProgrammes(gdtvEpg, '43', {
    now: Date.parse('2026-09-24T16:30:00Z'),
    fetchImpl: async url => { requested.push(url); return json(WEISHI) },
  })
  assert.deepEqual(requested.sort(), [
    `${EPG_API}?tvChannelPk=43&beginAt=2026-09-24&endAt=2026-09-26`,
    `${EPG_API}?tvChannelPk=43&beginAt=2026-09-25&endAt=2026-09-27`,
  ])
  // 今天 8 条 + 明天 3 条（其中 25 日 23:50 那条两天都带着，只留一份）
  assert.equal(programmes.length, 10)
  assert.equal(programmes.filter(item => item.title === '南粤4K画卷').length, 2)
  for (let i = 1; i < programmes.length; i++) assert.ok(programmes[i - 1].stop <= programmes[i].start)
})

await checkAsync('节目单频道与模块取流输出的 deferredRef、名字一一对应，key 即官网频道 id', async () => {
  const result = await getModule('gdtv').fetch({}, {})
  const emitted = result.groups.flatMap(group => group.dataList)
  const channels = gdtvEpg.channels()
  assert.equal(emitted.length, 17, '购物频道不输出')
  assert.deepEqual(channels.map(channel => channel.ref), emitted.map(channel => channel.deferredRef))
  assert.deepEqual(channels.map(channel => channel.name), emitted.map(channel => channel.name))
  for (const channel of channels) {
    assert.equal(channel.ref, `gdtv-${channel.key}`)
    assert.ok(getModule('gdtv').claimsRef(channel.ref), channel.ref)
  }
  assert.ok(!channels.some(channel => channel.key === '42'), '南方购物不出节目单')
})

check('模块已挂上节目单，提供者可单独拆走（只 import 本目录与 node: 内置）', () => {
  const module = getModule('gdtv')
  assert.equal(module.epg, gdtvEpg)
  assert.equal(module.capabilities.epg, true)
  assert.doesNotThrow(() => validateModule(module))
  for (const file of ['epg.js', 'channels.js']) {
    const source = readFileSync(new URL(`../extractors/gdtv/${file}`, import.meta.url), 'utf8')
    const specifiers = [...source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map(match => match[1])
    for (const specifier of specifiers) {
      assert.ok(specifier.startsWith('node:') || /^\.\/[\w-]+\.js$/.test(specifier), `${file} → ${specifier}`)
    }
  }
})

console.log(`\n全部通过：${passed} ✅`)
