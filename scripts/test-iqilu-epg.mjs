#!/usr/bin/env node
/**
 * 山东广电（齐鲁网）官方节目单回归测试：请求参数、秒级时间戳、零点衔接、编单录入毛病的收拾、
 * 错误路径、节目单频道与模块实际输出的频道一一对应。全部离线，夹具按 2026-09-25 实测返回裁剪。
 *
 * 运行： node scripts/test-iqilu-epg.mjs
 *       TZ=UTC node scripts/test-iqilu-epg.mjs
 *       TZ=America/Los_Angeles node scripts/test-iqilu-epg.mjs
 */
import assert from 'node:assert/strict'

import iqiluEpg, { EPG_API, parseProgrammes, shanghaiDayStart } from '../extractors/iqilu/epg.js'
import { clearCache } from '../extractors/iqilu/api.js'
import { getModule, resolverFor, validateModule } from '../extractors/registry.js'
import { channelXml, providerProgrammes } from '../utils/epgXmltv.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

const shanghai = text => Date.parse(`${text.replace(' ', 'T')}+08:00`)
// 接口声明 text/html，实际是 JSON
const reply = (body, init) => new Response(typeof body === 'string' ? body : JSON.stringify(body), {
  headers: { 'content-type': 'text/html;charset=utf-8' },
  ...init,
})

// 实测条目的全部字段；名字右侧补满空格，start_time / end_time 是编单录入的原文
const row = (name, start_time, end_time, initRowIndex, begintime, endtime) => (
  { name, start_time, end_time, cateid: '', catename: '', initRowIndex, begintime, endtime }
)
const day = (infos, t = 6.7) => ({ code: 1, data: { infos }, errmsg: '', score: {}, t, s: 'new' })

// GET ?channelID=24&date=2026-09-25（山东卫视）：首尾与晚间几条
const SDTV_0925 = day([
  row('红娘子-31                              ', '00:00:00', '04:47:00', 0, 1790265600, 1790282820),
  row('红娘子-32                              ', '04:47:00', '05:32:00', 1, 1790282820, 1790285520),
  row('红娘子-33                              ', '05:32:00', '06:22:00', 2, 1790285520, 1790288520),
  row('老农民-40                              ', '17:29:00', '18:10:00', 18, 1790328540, 1790331000),
  row('共产党员                               ', '18:10:00', '18:30:00', 19, 1790331000, 1790332200),
  row('山东新闻联播                           ', '18:30:00', '19:00:00', 20, 1790332200, 1790334000),
  row('中央台新闻联播                         ', '19:00:00', '19:34:00', 21, 1790334000, 1790336040),
  row('闯关东-45                              ', '19:34:00', '20:27:00', 22, 1790336040, 1790339220),
  row('2025中华家庭诗词擂台赛                 ', '23:53:00', '23:59:59', 28, 1790351580, 1790351999),
], 7.5)

// 明天还没发（2026-09-25 01:30 实测，多数频道如此）；不存在的 channelID 也是这样
const NOT_PUBLISHED = day(null, 55.6)

// 山东生活 2026-09-22：「20;09:00」录错，两条对应的时间戳是 false
const SHPD_0922 = day([
  row('生活帮                                              ', '17:55:00', '19:10:00', 38, 1790070900, 1790075400),
  row('健康生活帮                                          ', '19:10:00', '19:46:00', 39, 1790075400, 1790077560),
  row('乐享银龄                                            ', '19:46:00', '20;09:00', 40, 1790077560, false),
  row('行进中国                                            ', '20;09:00', '21:14:00', 41, false, 1790082840),
  row('健康生活帮                                          ', '21:14:00', '21:46:00', 42, 1790082840, 1790084760),
])

// 山东农科 2026-09-22：名字前后都有空格，最后跟一条起止都是零点的空行
const NKPD_0922 = day([
  row(' 田间示范秀                                                 ', '0:00:00', '00:05:00', 0, 1790006400, 1790006700),
  row('         乡村季风+种地宝典                                  ', '0:05:00', '00:52:00', 1, 1790006700, 1790009520),
  row('       田间示范秀                                           ', '23:39:00', '23:59:59', 53, 1790091540, 1790092799),
  row('                                                  ', '', '', 54, 1790006400, 1790006400),
])

// 山东少儿 2026-09-24：第一条的结束写成 23:35:50，盖住了后面整天
const SEPD_0924 = day([
  row('动画片：《喜羊羊与灰太狼羊村守护者1》                   ', '00:00:00', '23:35:50', 0, 1790179200, 1790264150),
  row('节目：《超级语文课第四季》                              ', '06:00:00', '07:31:00', 1, 1790200800, 1790206260),
  row('节目：《国宝在山东第二季》                              ', '07:31:00', '07:38:15', 2, 1790206260, 1790206695),
  row('节目：《成长没烦恼》                                    ', '07:38:15', '07:59:23', 3, 1790206695, 1790207963),
])

const clone = value => structuredClone(value)
const serve = body => async () => reply(body)

// 官网频道页（模块 fetch() 的输入）：页面 ID 与网页播放器公开携带的鉴权参数
const PAGES = {
  sdtv: ['24581', '山东卫视'], qlpd: ['24584', '齐鲁频道'], ggpd: ['24602', '新闻频道'],
  typd: ['24587', '体育休闲频道'], shpd: ['24596', '生活频道'], zypd: ['24593', '综艺频道'],
  nkpd: ['24599', '农科频道'], yspd: ['24590', '文旅频道'], sepd: ['24605', '少儿频道'],
}
const channelPage = ([id, name]) => `
  <script>var _pdCid = "${id}"; var _pdName = "${name}";</script>
  <script>
    var dF = 'https://feiying.litenews.cn/api/';
    var aF = 'v1/auth/exchange';
    var mxpx = 'QZMVKTRHPLXADJNE';
    var aly = 'BWRFYSNCOGIXUTPA';
  </script>`

console.log('山东齐鲁网节目单测试')

check('YYYYMMDD 一律按上海日期换成当天零点，非法日期返回 NaN', () => {
  assert.equal(shanghaiDayStart('20260925'), Date.parse('2026-09-24T16:00:00Z'))
  assert.equal(shanghaiDayStart('20260101'), Date.parse('2025-12-31T16:00:00Z'))
  for (const bad of ['', null, undefined, '2026-09-25', '20260931', '20261301', '2026092', '202609250', 'abcdefgh']) {
    assert.ok(Number.isNaN(shanghaiDayStart(bad)), String(bad))
  }
})

await checkAsync('按 epgId 与横线日期请求一次，时间戳换毫秒、标题去空白、23:59:59 接到次日零点', async () => {
  const calls = []
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return reply(SDTV_0925) }
  const items = await iqiluEpg.programmes('24', '20260925', { fetchImpl })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${EPG_API}?channelID=24&date=2026-09-25`)
  assert.equal(calls[0].options.redirect, 'manual')
  assert.ok(calls[0].options.signal instanceof AbortSignal)
  assert.deepEqual(items.map(item => item.title), [
    '红娘子-31', '红娘子-32', '红娘子-33', '老农民-40', '共产党员', '山东新闻联播', '中央台新闻联播', '闯关东-45',
    '2025中华家庭诗词擂台赛',
  ])
  assert.deepEqual(items.find(item => item.title === '山东新闻联播'),
    { title: '山东新闻联播', start: shanghai('2026-09-25 18:30:00'), stop: shanghai('2026-09-25 19:00:00') })
  assert.equal(items[0].start, shanghai('2026-09-25 00:00:00'))
  assert.equal(items.at(-1).stop, shanghai('2026-09-26 00:00:00'))
  assert.ok(items.every((item, i) => item.start < item.stop && (i === 0 || items[i - 1].stop <= item.start)))
})

await checkAsync('当天没发（infos 为 null 或空）、返回的不是请求那天，都得空数组', async () => {
  assert.deepEqual(await iqiluEpg.programmes('24', '20260926', { fetchImpl: serve(NOT_PUBLISHED) }), [])
  assert.deepEqual(await iqiluEpg.programmes('24', '20260926', { fetchImpl: serve(day([])) }), [])
  // 接口哪天不认 date、回了别的日子：不当成请求那天的节目
  assert.deepEqual(await iqiluEpg.programmes('24', '20260926', { fetchImpl: serve(SDTV_0925) }), [])
  assert.deepEqual(parseProgrammes(SDTV_0925, '20260924'), [])
})

check('录错的时间（false）与零点空行丢掉，名字中间的连续空白收成一个', () => {
  const shpd = parseProgrammes(SHPD_0922, '20260922')
  assert.deepEqual(shpd.map(item => item.title), ['生活帮', '健康生活帮', '健康生活帮'])
  assert.deepEqual(shpd.map(item => item.start), [
    shanghai('2026-09-22 17:55:00'), shanghai('2026-09-22 19:10:00'), shanghai('2026-09-22 21:14:00'),
  ])

  const nkpd = parseProgrammes(NKPD_0922, '20260922')
  assert.deepEqual(nkpd.map(item => item.title), ['田间示范秀', '乡村季风+种地宝典', '田间示范秀'])
  assert.equal(nkpd.at(-1).stop, shanghai('2026-09-23 00:00:00'))

  const spaced = clone(SDTV_0925)
  spaced.data.infos[3].name = '  老农民\t -40  \n'
  assert.equal(parseProgrammes(spaced, '20260925')[3].title, '老农民 -40')
})

check('结束写得太晚盖住后面的截到下一条开始；乱序排好，同一时刻开始的只留一条', () => {
  const sepd = parseProgrammes(SEPD_0924, '20260924')
  assert.deepEqual(sepd[0], {
    title: '动画片：《喜羊羊与灰太狼羊村守护者1》', start: shanghai('2026-09-24 00:00:00'), stop: shanghai('2026-09-24 06:00:00'),
  })
  assert.equal(sepd.length, 4)
  assert.ok(sepd.every((item, i) => item.start < item.stop && (i === 0 || sepd[i - 1].stop <= item.start)))

  const shuffled = clone(SDTV_0925)
  shuffled.data.infos.reverse()
  shuffled.data.infos.push({ ...shuffled.data.infos[0], name: '重复的末条' })
  const items = parseProgrammes(shuffled, '20260925')
  assert.equal(items.length, 9)
  assert.ok(items.every((item, i) => i === 0 || items[i - 1].start < item.start))
  // 秒级时间戳偶尔是字符串也认
  const stringly = clone(SDTV_0925)
  for (const entry of stringly.data.infos) {
    entry.begintime = String(entry.begintime)
    entry.endtime = String(entry.endtime)
  }
  assert.deepEqual(parseProgrammes(stringly, '20260925'), parseProgrammes(SDTV_0925, '20260925'))
})

await checkAsync('HTTP、跳转、业务码、非 JSON、结构与时间格式异常一律抛出', async () => {
  const today = fetchImpl => iqiluEpg.programmes('24', '20260925', { fetchImpl })
  await assert.rejects(today(async () => reply('<html>502 Bad Gateway</html>', { status: 502 })), /HTTP 502/)
  await assert.rejects(today(async (_url, options) => {
    assert.equal(options.redirect, 'manual')
    return new Response(null, { status: 302, headers: { location: 'https://example.com/' } })
  }), /HTTP 302/)
  await assert.rejects(today(serve({ code: 0, data: null, errmsg: '参数错误' })), /参数错误/)
  await assert.rejects(today(serve({ code: 1 })), /结构不符合预期/)
  await assert.rejects(today(serve([])), /结构不符合预期/)
  await assert.rejects(today(async () => reply('cb({"code":1,"data":{"infos":null}})')), /不是 JSON/)
  await assert.rejects(today(async () => reply('')), /不是 JSON/)
  await assert.rejects(today(serve(day({ name: '山东新闻联播' }))), /格式异常/)
  // 时间戳换成「HH:mm:ss」之类的改版：有条目却一条时间都读不出来
  const clockTimes = clone(SDTV_0925)
  for (const entry of clockTimes.data.infos) {
    entry.begintime = entry.start_time
    entry.endtime = entry.end_time
  }
  await assert.rejects(today(serve(clockTimes)), /时间格式异常/)
  const millis = clone(SDTV_0925)
  for (const entry of millis.data.infos) {
    entry.begintime *= 1000
    entry.endtime *= 1000
  }
  await assert.rejects(today(serve(millis)), /时间格式异常/)
  await assert.rejects(today(async () => { throw new TypeError('fetch failed') }), /fetch failed/)
})

await checkAsync('超时中止请求，参数非法时不发请求', async () => {
  const hang = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  await assert.rejects(iqiluEpg.programmes('24', '20260925', { fetchImpl: hang, timeoutMs: 20 }), { name: 'AbortError' })
  const never = async () => { throw new Error('不应请求') }
  for (const [key, date] of [['24&date=x', '20260925'], ['', '20260925'], ['abc', '20260925'], ['24581', '20260925'],
    ['24', '2026-09-25'], ['24', '20260931'], ['24', '']]) {
    await assert.rejects(iqiluEpg.programmes(key, date, { fetchImpl: never }), /参数非法/)
  }
})

await checkAsync('响应过大：声明长度超限直接拒，流式超限读到上限就取消下载', async () => {
  let cancelled = false
  await assert.rejects(iqiluEpg.programmes('24', '20260925', {
    fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true } }), {
      headers: { 'content-length': String(2 * 1024 * 1024) },
    }),
  }), /响应过大/)
  assert.ok(cancelled, '声明超限时丢弃响应体')

  let pulled = 0
  cancelled = false
  await assert.rejects(iqiluEpg.programmes('24', '20260925', {
    fetchImpl: async () => new Response(new ReadableStream({
      pull(controller) { pulled++; controller.enqueue(new Uint8Array(64 * 1024).fill(0x20)) },
      cancel() { cancelled = true },
    })),
  }), /响应过大/)
  assert.ok(cancelled, '流式超限时取消剩余下载')
  assert.ok(pulled <= 20, `只读到上限附近（读了 ${pulled} 块）`)
})

await checkAsync('节目单频道与模块 fetch() 实际输出一一对应，ref 都能路由回本模块', async () => {
  const module = getModule('iqilu')
  assert.equal(module.epg, iqiluEpg)
  assert.equal(module.capabilities.epg, true)
  assert.doesNotThrow(() => validateModule(module))
  clearCache()
  let output
  try {
    output = await module.fetch({}, {
      fetchImpl: async requestUrl => {
        const url = new URL(String(requestUrl))
        assert.equal(url.hostname, 'v.iqilu.com', 'fetch() 只读频道页')
        const page = PAGES[url.pathname.split('/').filter(Boolean).pop()]
        assert.ok(page, `未预期频道页 ${url.pathname}`)
        return { ok: true, status: 200, text: async () => channelPage(page) }
      },
    })
  } finally {
    clearCache()
  }
  const emitted = output.groups.flatMap(group => group.dataList)
  const providers = iqiluEpg.channels()
  // 九套电视官网都有节目单（2026-09-25 实测），所以两边应当完全一致
  assert.deepEqual(providers.map(channel => channel.ref), emitted.map(channel => channel.deferredRef))
  for (const channel of providers) {
    const match = emitted.find(item => item.deferredRef === channel.ref)
    assert.equal(channel.name, match.name)
    assert.ok(module.claimsRef(channel.ref))
    assert.equal(resolverFor(channel.ref)?.epg, iqiluEpg, 'utils/moduleEpg.js 按 ref 找得到提供者')
  }
  // 官网 time-shifting-local.js 里的编号，与频道页的 _pdCid 不是一套
  assert.deepEqual(providers.map(channel => channel.key), ['24', '25', '31', '26', '29', '28', '30', '27', '32'])
})

await checkAsync('接入公共件：days=2 按上海日期取今明两天，写出的 XMLTV 时间是 +0800 本地钟点', async () => {
  const requested = []
  const fetchImpl = async url => {
    requested.push(url)
    return reply(url.endsWith('2026-09-25') ? SDTV_0925 : NOT_PUBLISHED)
  }
  // 2026-09-25 01:30（上海）——UTC 还是 24 号
  const items = await providerProgrammes(iqiluEpg, '24', { now: Date.parse('2026-09-24T17:30:00Z'), fetchImpl })
  assert.deepEqual(requested.sort(), [`${EPG_API}?channelID=24&date=2026-09-25`, `${EPG_API}?channelID=24&date=2026-09-26`])
  assert.equal(items.length, 9)
  const xml = channelXml('山东卫视', items)
  assert.match(xml, /<programme channel="山东卫视" start="20260925183000 \+0800" stop="20260925190000 \+0800">\n {8}<title lang="zh">山东新闻联播<\/title>/)
  assert.match(xml, /start="20260925000000 \+0800" stop="20260925044700 \+0800"/)
  assert.match(xml, /start="20260925235300 \+0800" stop="20260926000000 \+0800"/)
})

console.log(`\n全部通过：${passed} ✅（TZ=${process.env.TZ || '本机'}）`)
