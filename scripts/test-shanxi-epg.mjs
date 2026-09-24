#!/usr/bin/env node
/**
 * 山西广电官方节目单回归测试：JSONP 解析、上海日期切天、同一轮只下一次、官方数据毛病的收拾、
 * 空文件与过期文件、各类错误。全程离线，夹具照 2026-09-25 官网实际返回裁剪。
 *
 * 运行： node scripts/test-shanxi-epg.mjs
 *       TZ=UTC node scripts/test-shanxi-epg.mjs
 *       TZ=America/Los_Angeles node scripts/test-shanxi-epg.mjs
 */
import assert from 'node:assert/strict'

import shanxi from '../extractors/shanxi/index.js'
import shanxiEpg, { EPG_ORIGIN, clearCache, parseEpgFile, shanghaiTime } from '../extractors/shanxi/epg.js'
import { buildChannels } from '../extractors/shanxi/api.js'
import { getModule, validateModule } from '../extractors/registry.js'
import { providerProgrammes, xmltvTime } from '../utils/epgXmltv.js'

// 离线：任何一条路径漏了注入的 fetchImpl 都直接失败
globalThis.fetch = async () => { throw new Error('离线测试不应访问网络') }

let passed = 0
const checkAsync = async (name, fn) => { clearCache(); await fn(); passed++; console.log(`  ✅ ${name}`) }

// 官网每行字段与顺序：column, name, liveid, start_time, end_time, zhubo；整份是紧凑 JSON 包在
// liveList.jsonpCallback(...) 里，末尾跟一个换行加两个空格
const row = (liveid, start, end, name, zhubo = '') => ({ column: '', name, liveid, start_time: start, end_time: end, zhubo })
const jsonp = rows => `liveList.jsonpCallback(${JSON.stringify(rows)})\n  `
const reply = (body, status = 200, headers = {}) => new Response(body, {
  status, headers: { 'content-type': status === 200 ? 'application/json' : 'text/html', ...headers },
})
const NOT_FOUND = '<html>\r\n<head><title>404 Not Found</title></head>\r\n<body>\r\n<center><h1>404 Not Found</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n'

const sx1 = (start, end, name) => row('q8RVWgs', start, end, name)
const SXTV1 = jsonp([
  sx1('2026-09-24 21:15:00', '2026-09-24 21:30:00', '晚间新闻'),
  sx1('2026-09-24 22:15:00', '2026-09-25 02:00:00', '电视剧：壮士出川'),
  sx1('2026-09-25 02:00:00', '2026-09-25 06:30:00', '经典电影'),
  sx1('2026-09-25 07:00:00', '2026-09-25 08:00:00', '山西新闻联播(重)'),
  sx1('2026-09-25 18:20:00', '2026-09-25 18:30:00', ' 英语新闻《Exploring Shanxi 发现山西》 '),
  sx1('2026-09-25 18:30:00', '2026-09-25 19:00:00', '山西新闻联播'),
  sx1('2026-09-25 19:00:00', '2026-09-25 19:35:00', '转播中央电视台新闻联播'),
  sx1('2026-09-25 22:00:00', '2026-09-26 02:00:00', '电视剧：壮士出川'),
  sx1('2026-09-26 02:00:00', '2026-09-26 06:20:00', '经典电影'),
])
// 太原：前一天最后一条拉到次日 07:00，和次日 01:45 的午夜剧场叠了五个多小时
const TAIYUAN = jsonp([
  row('taiyuan', '2026-09-23 21:15:00', '2026-09-24 07:00:00', '黄金剧场：新世界20-21'),
  row('taiyuan', '2026-09-24 01:45:00', '2026-09-24 07:00:00', '午夜剧场：光阴里的故事35-36，怒放1-3'),
  row('taiyuan', '2026-09-24 07:00:00', '2026-09-24 07:30:00', '新闻对话'),
])
// 临汾：零时长行，后面紧跟同一时刻开始的正经节目
const LINFEN = jsonp([
  row('linfen', '2026-09-21 22:30:00', '2026-09-21 22:50:00', '临汾新闻（当日复播）'),
  row('linfen', '2026-09-21 22:50:00', '2026-09-21 22:50:00', '平阳工匠（当日复播）'),
  row('linfen', '2026-09-21 22:50:00', '2026-09-22 07:00:00', '精品专题片和短视频展播'),
  row('linfen', '2026-09-22 07:00:00', '2026-09-22 07:30:00', '临汾新闻（前日复播）'),
])
// 朔州等七个地市：文件自 2024-12-19 起一直是这 29 个字节
const EMPTY = 'liveList.jsonpCallback([])\n  '
// 只剩一个月前节目的文件（地市更新不及时的样子）
const STALE = jsonp([
  row('taiyuan', '2026-08-22 07:00:00', '2026-08-22 07:30:00', '新闻对话'),
  row('taiyuan', '2026-08-22 07:30:00', '2026-08-22 10:10:00', '太原新闻'),
])

const at = text => shanghaiTime(text)
const titles = items => items.map(item => item.title)
const serve = (body, log = []) => async (url, init) => { log.push({ url: String(url), init }); return reply(body) }

console.log('山西广电节目单测试')

await checkAsync('模块挂上节目单提供者，频道表每一路都有节目单文件名且都在模块输出里', async () => {
  const module = getModule('shanxi')
  assert.equal(module, shanxi)
  assert.equal(shanxi.epg, shanxiEpg)
  assert.equal(shanxi.capabilities.epg, true)
  assert.equal(shanxi.catalogVersion, 1)
  assert.equal(shanxiEpg.days, 2)
  assert.doesNotThrow(() => validateModule(shanxi))

  const emitted = (await shanxi.fetch()).groups.flatMap(group => group.dataList)
  const provided = shanxiEpg.channels()
  assert.deepEqual(provided.map(channel => channel.ref), emitted.map(channel => channel.deferredRef))
  assert.deepEqual(provided.map(channel => channel.name), emitted.map(channel => channel.name))
  assert.deepEqual(provided.map(channel => channel.ref), buildChannels().map(channel => channel.deferredRef))
  // 官网直播页频道元素的 d 属性
  assert.deepEqual(provided.map(channel => channel.key), [
    'SXTV1', 'SXTV2', 'SXTV3', 'SXTV4', 'SXTV5', 'SXTV6',
    'taiyuan', 'shuozhou', 'xinzhou', 'yangquan', 'lvliang', 'jinzhong', 'changzhi', 'jincheng', 'linfen', 'yuncheng',
  ])
})

await checkAsync('JSONP 解析：去首尾空白、按 +08:00 算时间、按开始时间排序', async () => {
  const items = parseEpgFile(SXTV1)
  const news = items.find(item => item.title === '山西新闻联播')
  assert.equal(news.start, Date.parse('2026-09-25T10:30:00Z'))
  assert.equal(news.stop, Date.parse('2026-09-25T11:00:00Z'))
  assert.equal(xmltvTime(news.start), '20260925183000 +0800')
  assert.ok(items.some(item => item.title === '英语新闻《Exploring Shanxi 发现山西》'), '节目名去掉首尾空白')
  assert.ok(items.every((item, index) => item.start < item.stop && (index === 0 || items[index - 1].start < item.start)))
  // 文件里行序打乱也照样排好
  const shuffled = jsonp([sx1('2026-09-25 19:00:00', '2026-09-25 19:35:00', 'B'), sx1('2026-09-25 18:30:00', '2026-09-25 19:00:00', 'A')])
  assert.deepEqual(titles(parseEpgFile(shuffled)), ['A', 'B'])
  // 分号结尾、没有尾随空白的写法也认
  assert.equal(parseEpgFile('liveList.jsonpCallback([]);').length, 0)
})

await checkAsync('时间只认完整的上海时间格式，越界日期不会被顺延', async () => {
  assert.equal(shanghaiTime('2026-09-25 00:00:00'), Date.parse('2026-09-24T16:00:00Z'))
  for (const bad of ['2026-02-30 00:00:00', '2026-09-25 24:00:00', '2026-09-25 18:60:00', '2026-09-25T18:30:00', '2026/09/25 18:30:00', '', null]) {
    assert.ok(Number.isNaN(shanghaiTime(bad)), String(bad))
  }
  const items = parseEpgFile(jsonp([
    sx1('2026-02-30 18:30:00', '2026-02-30 19:00:00', '坏日期'),
    sx1('2026-09-25 19:00:00', '2026-09-25 18:30:00', '倒挂'),
    sx1('2026-09-25 18:30:00', '2026-09-25 19:00:00', '   '),
    { name: '缺字段' },
    null,
    sx1('2026-09-25 19:00:00', '2026-09-25 19:35:00', '正常'),
  ]))
  assert.deepEqual(titles(items), ['正常'])
})

await checkAsync('官方数据毛病：零时长行丢掉，前一天拉长到早上的末条截到下一条开始', async () => {
  const taiyuan = parseEpgFile(TAIYUAN)
  assert.deepEqual(taiyuan.map(item => [item.title, xmltvTime(item.start), xmltvTime(item.stop)]), [
    ['黄金剧场：新世界20-21', '20260923211500 +0800', '20260924014500 +0800'],
    ['午夜剧场：光阴里的故事35-36，怒放1-3', '20260924014500 +0800', '20260924070000 +0800'],
    ['新闻对话', '20260924070000 +0800', '20260924073000 +0800'],
  ])
  const linfen = parseEpgFile(LINFEN)
  assert.deepEqual(titles(linfen), ['临汾新闻（当日复播）', '精品专题片和短视频展播', '临汾新闻（前日复播）'])
  assert.equal(new Set(linfen.map(item => item.start)).size, linfen.length, '同一开始时间只留一条')
  // 两条都有时长、开始相同：留文件里靠前的那条，截重叠时不会截出零时长
  const twin = parseEpgFile(jsonp([
    sx1('2026-09-25 12:59:00', '2026-09-25 13:23:00', '奋晋者说（首播）'),
    sx1('2026-09-25 12:59:00', '2026-09-25 13:10:00', '奋晋者说'),
    sx1('2026-09-25 13:23:00', '2026-09-25 13:35:00', '发现山西（首播）'),
  ]))
  assert.deepEqual(titles(twin), ['奋晋者说（首播）', '发现山西（首播）'])
  assert.ok(twin.every(item => item.start < item.stop))
})

await checkAsync('按上海日期切天：与当天有交集的都算，跨零点那条两天都带', async () => {
  const log = []
  const fetchImpl = serve(SXTV1, log)
  const today = await shanxiEpg.programmes('SXTV1', '20260925', { fetchImpl })
  assert.equal(log[0].url, `${EPG_ORIGIN}/epg/SXTV1.json`)
  assert.equal(log[0].url, 'https://apphhplushttps.sxrtv.com/epg/SXTV1.json')
  assert.equal(log[0].init.redirect, 'manual')
  assert.ok(log[0].init.signal instanceof AbortSignal)
  assert.deepEqual(titles(today), [
    '电视剧：壮士出川', '经典电影', '山西新闻联播(重)', '英语新闻《Exploring Shanxi 发现山西》',
    '山西新闻联播', '转播中央电视台新闻联播', '电视剧：壮士出川',
  ])
  assert.ok(!today.some(item => item.title === '晚间新闻'), '前一天整条结束的不带')
  assert.equal(today[0].start, at('2026-09-24 22:15:00'), '零点前开播、零点后才结束的也在当天')
  const tomorrow = await shanxiEpg.programmes('SXTV1', '20260926', { fetchImpl })
  assert.deepEqual(titles(tomorrow), ['电视剧：壮士出川', '经典电影'])
  assert.equal(tomorrow[0].start, today.at(-1).start)
  assert.deepEqual(await shanxiEpg.programmes('SXTV1', '20261001', { fetchImpl }), [], '文件还没排到的日子')
  // 返回的是副本：改了不影响同一份缓存给另一天的结果
  today[0].title = '被改了'
  assert.equal((await shanxiEpg.programmes('SXTV1', '20260925', { fetchImpl }))[0].title, '电视剧：壮士出川')
})

await checkAsync('同一轮只下一次：两天并发共用一次下载，缓存过期或清空后才重下', async () => {
  const log = []
  const fetchImpl = serve(SXTV1, log)
  const [today, tomorrow] = await Promise.all(['20260925', '20260926'].map(day => shanxiEpg.programmes('SXTV1', day, { fetchImpl })))
  assert.equal(log.length, 1)
  assert.equal(today.length, 7)
  assert.equal(tomorrow.length, 2)
  await shanxiEpg.programmes('SXTV1', '20260925', { fetchImpl })
  assert.equal(log.length, 1, '有效期内不重下')
  await shanxiEpg.programmes('taiyuan', '20260924', { fetchImpl: serve(TAIYUAN, log) })
  assert.equal(log.length, 2, '不同频道各下各的')

  const realNow = Date.now
  Date.now = () => realNow() + 3 * 60 * 1000
  try {
    await shanxiEpg.programmes('SXTV1', '20260925', { fetchImpl })
    assert.equal(log.length, 3, '过了有效期重下')
  } finally {
    Date.now = realNow
  }
  clearCache()
  await shanxiEpg.programmes('SXTV1', '20260925', { fetchImpl })
  assert.equal(log.length, 4)
})

await checkAsync('走 providerProgrammes：今天 + 明天一次下载，跨零点那条只留一份', async () => {
  let calls = 0
  const fetchImpl = async () => { calls++; return reply(SXTV1) }
  // 2026-09-25 10:00（上海）
  const items = await providerProgrammes(shanxiEpg, 'SXTV1', { now: Date.parse('2026-09-25T02:00:00Z'), fetchImpl })
  assert.equal(calls, 1)
  assert.deepEqual(titles(items), [
    '电视剧：壮士出川', '经典电影', '山西新闻联播(重)', '英语新闻《Exploring Shanxi 发现山西》',
    '山西新闻联播', '转播中央电视台新闻联播', '电视剧：壮士出川', '经典电影',
  ])
})

await checkAsync('空文件与过期文件：当天没有节目返回空数组，不算失败', async () => {
  assert.deepEqual(await shanxiEpg.programmes('shuozhou', '20260925', { fetchImpl: serve(EMPTY) }), [])
  assert.deepEqual(await shanxiEpg.programmes('shuozhou', '20260926', { fetchImpl: serve(EMPTY) }), [])
  assert.deepEqual(await shanxiEpg.programmes('taiyuan', '20260925', { fetchImpl: serve(STALE) }), [])
  assert.equal((await shanxiEpg.programmes('taiyuan', '20260822', { fetchImpl: serve(STALE) })).length, 2)
  assert.deepEqual(await providerProgrammes(shanxiEpg, 'yuncheng', { now: Date.parse('2026-09-25T02:00:00Z'), fetchImpl: serve(EMPTY) }), [])
})

await checkAsync('格式错误抛出：不是 JSONP、JSON 坏了、不是数组、回调名不对', async () => {
  const cases = [
    ['<!DOCTYPE html><html><body>维护中</body></html>', /不是预期的 JSONP/],
    ['', /不是预期的 JSONP/],
    ['[{"name":"x"}]', /不是预期的 JSONP/],
    ['jsonpCallback([])', /不是预期的 JSONP/],
    ['liveList.jsonpCallback([{"name":)\n  ', /JSON 无效/],
    ['liveList.jsonpCallback({"code":500})\n  ', /格式异常/],
  ]
  for (const [body, pattern] of cases) {
    clearCache()
    await assert.rejects(shanxiEpg.programmes('SXTV1', '20260925', { fetchImpl: serve(body) }), pattern, body)
  }
})

await checkAsync('HTTP / 网络 / 超时 / 过大都抛出，失败不进缓存', async () => {
  await assert.rejects(shanxiEpg.programmes('SXTV9', '20260925', { fetchImpl: async () => reply(NOT_FOUND, 404) }), /HTTP 404/)
  await assert.rejects(shanxiEpg.programmes('SXTV1', '20260925', {
    fetchImpl: async () => reply('', 302, { location: 'http://evil.test/epg/SXTV1.json' }),
  }), /HTTP 302/, '跳转不跟')
  await assert.rejects(shanxiEpg.programmes('SXTV2', '20260925', { fetchImpl: async () => reply('', 503) }), /HTTP 503/)
  await assert.rejects(shanxiEpg.programmes('SXTV3', '20260925', {
    fetchImpl: async () => { throw new TypeError('fetch failed') },
  }), /fetch failed/)

  const hang = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason))
  })
  await assert.rejects(shanxiEpg.programmes('SXTV4', '20260925', { fetchImpl: hang, timeoutMs: 20 }), { name: 'AbortError' })

  await assert.rejects(shanxiEpg.programmes('SXTV5', '20260925', {
    fetchImpl: async () => reply(EMPTY, 200, { 'content-length': String(3 * 1024 * 1024) }),
  }), /响应过大/)
  // 没有 content-length 的分块响应，读到一半超了就停
  let pulled = 0
  const chunk = new Uint8Array(512 * 1024).fill(0x20)
  const endless = new ReadableStream({ pull(controller) { pulled++; controller.enqueue(chunk) } })
  await assert.rejects(shanxiEpg.programmes('SXTV6', '20260925', { fetchImpl: async () => reply(endless) }), /响应过大/)
  assert.ok(pulled <= 6, `超限后不再继续读：${pulled}`)

  // 同一轮并发的两天拿到同一个错误；下一次调用重新下载
  let calls = 0
  const flaky = async () => (++calls === 1 ? reply('', 502) : reply(SXTV1))
  const settled = await Promise.allSettled(['20260925', '20260926'].map(day => shanxiEpg.programmes('SXTV1', day, { fetchImpl: flaky })))
  assert.deepEqual(settled.map(result => result.status), ['rejected', 'rejected'])
  assert.equal(calls, 1)
  await assert.rejects(providerProgrammes(shanxiEpg, 'SXTV1', { now: Date.parse('2026-09-25T02:00:00Z'), fetchImpl: async () => reply('', 502) }), /HTTP 502/)
  assert.equal((await shanxiEpg.programmes('SXTV1', '20260925', { fetchImpl: flaky })).length, 7)
  assert.equal(calls, 2)
})

await checkAsync('参数非法不发请求', async () => {
  const fetchImpl = async () => { throw new Error('不应请求') }
  for (const [key, day] of [['../x', '20260925'], ['SXTV1.json?x=1', '20260925'], ['', '20260925'],
    ['SXTV1', '2026-09-25'], ['SXTV1', '20260230'], ['SXTV1', '2026092'], ['SXTV1', undefined]]) {
    await assert.rejects(shanxiEpg.programmes(key, day, { fetchImpl }), /参数非法/, `${key} ${day}`)
  }
  // 数字形式的日期也认
  assert.equal((await shanxiEpg.programmes('SXTV1', 20260925, { fetchImpl: serve(SXTV1) })).length, 7)
})

console.log(`\n全部通过：${passed} ✅（TZ=${process.env.TZ || '系统默认'}）`)
