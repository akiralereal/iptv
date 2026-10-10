#!/usr/bin/env node
/**
 * 青岛广播电视台官方节目单回归测试：请求形状（JSONP + 官网 Referer / Origin）、按上海日期切片、
 * 结束时间与重叠处理、错误路径、频道 ref 对齐。
 * 全部离线；样本按 2026-10-09 官方接口的真实响应裁剪，字段与 JSONP 外壳原样保留。
 *
 * 运行： node scripts/test-qingdao-epg.mjs
 *       TZ=UTC node scripts/test-qingdao-epg.mjs
 *       TZ=America/Los_Angeles node scripts/test-qingdao-epg.mjs
 */
import assert from 'node:assert/strict'

import qingdaoEpg, { EPG_API, PLAYER_PAGE, parseJsonp, parseProgrammes, shanghaiDayRange } from '../extractors/qingdao/epg.js'
import { CHANNELS } from '../extractors/qingdao/channels.js'
import { getModule, validateModule } from '../extractors/registry.js'
import { providerProgrammes, xmltvTime } from '../utils/epgXmltv.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

// 上海时间文本 → 毫秒，测试里用显式 +08:00 写期望值，与运行机器时区无关
const sh = text => Date.parse(`${text.replace(' ', 'T')}+08:00`)
const row = (start, end, name, visible = true) => ({ visible, start_time: start, end_time: end, name })
const jsonp = payload => `success_jsonp_callback(${JSON.stringify(payload)})`
const textResponse = (text, init = {}) => new Response(text, {
  status: init.status ?? 200, headers: { 'content-type': 'application/javascript', ...init.headers },
})

// QTV-1 2026-10-09 的真实片段：接口回「过去 7 天 + 今天」，这里留前一天最后两条与当天首尾几条；
// 每天从 00:00 切到 23:59:59，跨零点的「中国城市报道」被官方拆成两条
const QTV1_1009 = {
  status: 0,
  epg_data: [
    row(1791472080, 1791474840, '南来北往27'),            // 10-08 23:08
    row(1791474840, 1791475199, '中国城市报道'),          // 10-08 23:54 → 23:59:59
    row(1791475200, 1791490440, '中国城市报道'),          // 10-09 00:00
    row(1791490440, 1791491460, '文创之岛'),              // 04:14
    row(1791491460, 1791492420, '今日+健康 '),            // 04:31，名字尾部补一个空格
    row(1791492420, 1791493980, '海岸秘境'),              // 04:47
    row(1791555360, 1791558180, '南来北往28'),            // 22:16
    row(1791558180, 1791561000, '南来北往29'),            // 23:03
    row(1791561000, 1791561599, '中国城市报道'),          // 23:50 → 23:59:59
  ],
  server_time: 1791558156,
}
// QTV-5（channel=6）当天开头：凌晨到早上七点整段「天气预报」
const QTV5_1009 = {
  status: 0,
  epg_data: [
    row(1791475200, 1791500700, '天气预报'),
    row(1791500700, 1791502260, '校长说'),
    row(1791502260, 1791502860, '汉字解密'),
  ],
  server_time: 1791558156,
}

console.log('青岛节目单测试')

check('上海日期切片显式按 +08:00 算，与运行机器时区无关', () => {
  assert.deepEqual(shanghaiDayRange('20261009'), { start: Date.parse('2026-10-08T16:00:00Z'), stop: Date.parse('2026-10-09T16:00:00Z') })
  assert.equal(xmltvTime(shanghaiDayRange('20261009').start), '20261009000000 +0800')
  for (const bad of ['2026-10-09', '2026100', '20261332', '20260231', '', null]) {
    assert.throws(() => shanghaiDayRange(bad), /参数非法/, String(bad))
  }
})

check('JSONP 外壳剥掉后是 JSON；裸 JSON 也认；拦截页不是 JSON', () => {
  assert.deepEqual(parseJsonp('success_jsonp_callback({"status": 0, "epg_data": []})'), { status: 0, epg_data: [] })
  assert.deepEqual(parseJsonp('x({"a":1});'), { a: 1 })
  assert.deepEqual(parseJsonp(' {"a":1} '), { a: 1 })
  assert.throws(() => parseJsonp('<html><head><title>403 Forbidden</title></head></html>'), /不是 JSON/)
})

await checkAsync('按官网播放页的形状请求：channel 号 + days + callback，带官网 Referer / Origin', async () => {
  const requests = []
  const fetchImpl = async (url, options) => {
    requests.push({ url: new URL(url), options })
    return textResponse(jsonp(QTV1_1009))
  }
  await qingdaoEpg.programmes('1', '20261009', { fetchImpl })
  await qingdaoEpg.programmes('6', '20261009', { fetchImpl })
  const [first, second] = requests
  assert.equal(first.url.origin + first.url.pathname, EPG_API)
  assert.deepEqual(Object.fromEntries(first.url.searchParams), { channel: '1', days: '1', callback: 'success_jsonp_callback' })
  assert.equal(second.url.searchParams.get('channel'), '6')
  assert.equal(first.options.headers.Referer, PLAYER_PAGE)
  assert.equal(first.options.headers.Origin, 'https://www.qtv.com.cn')
  assert.match(first.options.headers['User-Agent'], /Mozilla/)
  assert.equal(first.options.redirect, 'manual')
  assert.ok(first.options.signal instanceof AbortSignal)
  // 不认识的 channel 号、坏日期不发请求
  await assert.rejects(qingdaoEpg.programmes('5', '20261009', { fetchImpl: async () => { throw new Error('不应发请求') } }), /参数非法/)
  await assert.rejects(qingdaoEpg.programmes('1', '2026-10-09', { fetchImpl: async () => { throw new Error('不应发请求') } }), /参数非法/)
  assert.equal(requests.length, 2)
})

await checkAsync('解析：只取这一天的条目、标题去空白、结束取官方 end_time、最后一条到次日零点', async () => {
  const programmes = await qingdaoEpg.programmes('1', '20261009', { fetchImpl: async () => textResponse(jsonp(QTV1_1009)) })
  assert.equal(programmes.length, 7, '前一天的两条不算今天的')
  assert.deepEqual(programmes[0], { title: '中国城市报道', start: sh('2026-10-09 00:00:00'), stop: sh('2026-10-09 04:14:00') })
  assert.deepEqual(programmes[2], { title: '今日+健康', start: sh('2026-10-09 04:31:00'), stop: sh('2026-10-09 04:47:00') })
  assert.deepEqual(programmes[6], { title: '中国城市报道', start: sh('2026-10-09 23:50:00'), stop: sh('2026-10-09 23:59:59') })
  assert.ok(programmes.every((item, i) => i === 0 || programmes[i - 1].start < item.start), '按开始时间升序')
  assert.ok(programmes.every((item, i) => i === programmes.length - 1 || item.stop <= programmes[i + 1].start), '互不重叠')

  // 前一天：同一份响应按日期切出 10-08 的两条
  const yesterday = await qingdaoEpg.programmes('1', '20261008', { fetchImpl: async () => textResponse(jsonp(QTV1_1009)) })
  assert.deepEqual(yesterday.map(item => item.title), ['南来北往27', '中国城市报道'])
  assert.equal(yesterday[1].stop, sh('2026-10-08 23:59:59'))
  // 接口没有明天：空数组，不是错误
  assert.deepEqual(await qingdaoEpg.programmes('1', '20261010', { fetchImpl: async () => textResponse(jsonp(QTV1_1009)) }), [])
  const qtv5 = await qingdaoEpg.programmes('6', '20261009', { fetchImpl: async () => textResponse(jsonp(QTV5_1009)) })
  assert.deepEqual(qtv5[0], { title: '天气预报', start: sh('2026-10-09 00:00:00'), stop: sh('2026-10-09 07:05:00') })
})

check('解析：隐藏条目与空名字剔除、重叠截到下一条、同一开始时间只留一条、缺结束时间补到下一条', () => {
  const day = '20261009'
  const parsed = parseProgrammes({
    status: 0,
    epg_data: [
      row(1791475200, 1791480000, '隐藏的', false),
      row(1791475200, 1791480000, '  '),
      row(1791475200, 1791480000, '凌晨剧场'),
      row(1791475200, 1791479000, '同一时刻的另一条'),
      row(1791479000, 1791483000, '重叠：上一条本该 01:20 结束'),
      row(1791483000, 0, '没有结束时间'),
      row(1791486600, 1791490000, '正常'),
    ],
  }, day)
  assert.deepEqual(parsed.map(item => item.title), ['凌晨剧场', '重叠：上一条本该 01:20 结束', '没有结束时间', '正常'])
  assert.equal(parsed[0].stop, 1791479000 * 1000, '结束晚于下一条开始的截到下一条开始')
  assert.equal(parsed[2].stop, 1791486600 * 1000, '缺结束时间补到下一条开始')
  assert.deepEqual(parseProgrammes({ status: 0, epg_data: [] }, day), [])
  assert.throws(() => parseProgrammes({ status: 1, epg_data: [] }, day), /status 1/)
  assert.throws(() => parseProgrammes({ status: 0 }, day), /格式异常/)
  assert.throws(() => parseProgrammes({ status: 0, epg_data: [{ name: '没有时间' }] }, day), /格式异常/)
  assert.throws(() => parseProgrammes('不是对象', day), /格式异常/)
})

await checkAsync('错误路径：403 拦截、响应过大、JSON 坏掉都抛错，让该频道本轮没有节目单', async () => {
  await assert.rejects(
    qingdaoEpg.programmes('1', '20261009', { fetchImpl: async () => textResponse('<html>403 Forbidden</html>', { status: 403 }) }),
    /HTTP 403/,
  )
  await assert.rejects(
    qingdaoEpg.programmes('1', '20261009', { fetchImpl: async () => textResponse('x({})', { headers: { 'content-length': String(10 * 1024 * 1024) } }) }),
    /响应过大/,
  )
  await assert.rejects(
    qingdaoEpg.programmes('1', '20261009', { fetchImpl: async () => textResponse('success_jsonp_callback({"status": 0, "epg_data": [') }),
    /不是 JSON/,
  )
  let aborted = false
  await assert.rejects(
    qingdaoEpg.programmes('1', '20261009', {
      timeoutMs: 10,
      fetchImpl: (url, { signal }) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) })
      }),
    }),
  )
  assert.equal(aborted, true, '超时要中止请求')
})

await checkAsync('提供者挂在模块上：频道 ref 与模块频道表一一对应，流水线按 ref 取得到节目', async () => {
  const module = getModule('qingdao')
  validateModule(module)
  assert.equal(module.epg, qingdaoEpg)
  assert.equal(module.capabilities.epg, true)
  assert.equal(qingdaoEpg.days, 1)
  const listed = qingdaoEpg.channels()
  assert.deepEqual(listed.map(channel => channel.ref), CHANNELS.map(channel => channel.ref))
  assert.deepEqual(listed.map(channel => channel.key), ['1', '2', '3', '4', '6'])
  assert.deepEqual(listed.map(channel => channel.name), CHANNELS.map(channel => channel.name))
  for (const channel of listed) assert.ok(module.claimsRef(channel.ref), channel.ref)

  // 流水线按「今天」取：固定 now 在 2026-10-09 上海时间，响应里有当天的编排
  const programmes = await providerProgrammes(qingdaoEpg, '1', {
    now: sh('2026-10-09 23:05:00'),
    fetchImpl: async () => textResponse(jsonp(QTV1_1009)),
  })
  assert.equal(programmes.length, 7)
  assert.equal(xmltvTime(programmes[0].start), '20261009000000 +0800')
})

console.log(`\n全部通过：${passed} ✅`)
