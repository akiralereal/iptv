#!/usr/bin/env node
/**
 * 新疆广播电视台官方节目单回归测试：请求形状、北京时间解析、含当分钟的结束时间、零点截断、
 * 官方数据毛病的收拾、错误路径、频道 ref 对齐。全程离线，夹具照 2026-09-25 官方接口实际返回裁剪，
 * 字段与信封原样保留。
 *
 * 运行： node scripts/test-xinjiang-epg.mjs
 *       TZ=UTC node scripts/test-xinjiang-epg.mjs
 *       TZ=America/Los_Angeles node scripts/test-xinjiang-epg.mjs
 */
import assert from 'node:assert/strict'

import xinjiang from '../extractors/xinjiang/index.js'
import xinjiangEpg, { EPG_API, guideDay, minuteOfDay, parseGuide } from '../extractors/xinjiang/epg.js'
import { CHANNELS } from '../extractors/xinjiang/channels.js'
import { CHANNELS as API_CHANNELS, buildChannels } from '../extractors/xinjiang/api.js'
import { getModule, validateModule } from '../extractors/registry.js'
import { providerProgrammes, xmltvTime } from '../utils/epgXmltv.js'

// 离线：任何一条路径漏了注入的 fetchImpl 都直接失败
globalThis.fetch = async () => { throw new Error('离线测试不应访问网络') }

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

// 上海时间文本 → 毫秒，期望值一律写显式 +08:00，与运行机器时区无关
const sh = text => Date.parse(`${text.replace(' ', 'T')}+08:00`)
const titles = items => items.map(item => item.title)
const spans = items => items.map(item => [item.title, xmltvTime(item.start), xmltvTime(item.stop)])

const row = (Id, Name, TVDate, StartTime, EndTime, State = 3, RecordFileUrl = null, RecordFileDuration = 0) => ({
  Id, Name, TVDate, StartTime, EndTime, IsForbidden: false, RecordFileUrl, RecordFileDuration, State,
})
const envelope = data => ({ recordsetCount: data.length, pageSize: 0, page: 0, allPage: 0, message: '', success: true, code: 0, data })
const reply = (body, status = 200, headers = {}) => new Response(
  typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } },
)

// 新疆卫视 2026-09-25（凌晨一点半取的）：零点那条是前一天 23:56 那条的延续、07:59 国歌起止同一分钟、
// 19:00 转播央视《新闻联播》、最后一条跨过零点写到 00:28
const REVIEW = 'https://slststore.xjtvs.com.cn/livereview/202609/'
const XJTV1_0925 = envelope([
  row(516571, '《健康公开课》', '2026-09-25', '00:00', '00:28', 1, `${REVIEW}%e3%80%8a%e5%81%a5%e5%ba%b7%e5%85%ac%e5%bc%80%e8%af%be%e3%80%8b_2026-09-24_23:56_xjtv1.mp4`, 1085),
  row(516572, '《真实纪录》', '2026-09-25', '00:29', '00:57', 1, `${REVIEW}%e3%80%8a%e7%9c%9f%e5%ae%9e%e7%ba%aa%e5%bd%95%e3%80%8b_2026-09-25_00:29_xjtv1.mp4`, 1865),
  row(516573, '丝路剧场：48集《功勋》（42—43）', '2026-09-25', '00:58', '02:31', 2),
  row(516578, '中华人民共和国国歌', '2026-09-25', '07:59', '07:59'),
  row(516579, '《新疆新闻联播》', '2026-09-25', '08:00', '08:31'),
  row(516585, '《真实纪录》', '2026-09-25', '18:31', '18:59'),
  row(516586, '央视《新闻联播》', '2026-09-25', '19:00', '19:29'),
  row(516587, '《新疆新闻联播》', '2026-09-25', '19:30', '19:59'),
  row(516594, '新闻夜班车', '2026-09-25', '23:33', '23:55'),
  row(516595, '《健康公开课》', '2026-09-25', '23:56', '00:28'),
])
// 新疆卫视 2026-09-26：开头把前一天跨零点那条再列一遍，最后一条写到 00:00
const XJTV1_0926 = envelope([
  row(516596, '《健康公开课》', '2026-09-26', '00:00', '00:28'),
  row(516597, '《真实纪录》', '2026-09-26', '00:29', '00:57'),
  row(516621, '《健康公开课》', '2026-09-26', '23:56', '00:00'),
])
// 维吾尔语新闻综合 2026-09-25：零点那条起止都写 00:00（下一条 00:01 开始），译制版《新闻联播》排在 22:00
const XJTV2_0925 = envelope([
  row(516740, '黄金剧场: 39集《西北岁月》（14—15）', '2026-09-25', '00:00', '00:00', 1),
  row(516741, '《真实纪录》', '2026-09-25', '00:01', '00:29', 1),
  row(516761, '《新疆新闻联播》', '2026-09-25', '21:30', '21:59'),
  row(516762, '央视《新闻联播》', '2026-09-25', '22:00', '22:31'),
  row(516763, '黄金剧场: 39集《西北岁月》（16—17）', '2026-09-25', '22:32', '00:00'),
])
// 体育健康 2026-09-25：凌晨一点才开始排，节目名带尾随空格
const XJTV7_0925 = envelope([
  row(517487, '重播： 跟我耍大牌 第20260924期', '2026-09-25', '01:00', '07:59', 2),
  row(517488, '2026“同心杯”新疆足球超级联赛', '2026-09-25', '08:00', '09:29'),
  row(517489, '重播：健康365 ', '2026-09-25', '09:30', '09:32'),
  row(517503, '重播：自治区全运会', '2026-09-25', '22:36', '00:00'),
])
// 少儿频道、不认识的 tvChannelId、后天以后：都是这 101 个字节
const EMPTY = '{"recordsetCount":0,"pageSize":0,"page":0,"allPage":0,"message":"","success":true,"code":0,"data":[]}'

// 按请求里的 tvChannelId + date 回对应夹具，记下每次请求
function officialApi(log = []) {
  const days = {
    '1|2026-9-25 00:00:00': XJTV1_0925,
    '1|2026-9-26 00:00:00': XJTV1_0926,
    '3|2026-9-25 00:00:00': XJTV2_0925,
    '21|2026-9-25 00:00:00': XJTV7_0925,
  }
  return async (url, init) => {
    log.push({ url: String(url), init })
    const params = new URL(url).searchParams
    const body = days[`${params.get('tvChannelId')}|${params.get('date')}`]
    return reply(body ?? EMPTY)
  }
}
const noRequest = async () => { throw new Error('不应发请求') }

console.log('新疆广播电视台节目单测试')

await checkAsync('模块挂上节目单提供者，频道表每一路都在模块输出里、ref 一一对应', async () => {
  assert.equal(getModule('xinjiang'), xinjiang)
  assert.equal(xinjiang.epg, xinjiangEpg)
  assert.equal(xinjiang.capabilities.epg, true)
  assert.equal(xinjiang.catalogVersion, 2)
  assert.equal(xinjiangEpg.days, 2)
  assert.doesNotThrow(() => validateModule(xinjiang))
  // 取流与节目单用的是同一张表
  assert.equal(API_CHANNELS, CHANNELS)

  const emitted = (await xinjiang.fetch()).groups.flatMap(group => group.dataList)
  const provided = xinjiangEpg.channels()
  assert.deepEqual(provided.map(channel => channel.ref), emitted.map(channel => channel.deferredRef))
  assert.deepEqual(provided.map(channel => channel.name), emitted.map(channel => channel.name))
  assert.deepEqual(provided.map(channel => channel.ref), buildChannels().map(channel => channel.deferredRef))
  // 官网频道接口 TVChannelList 的 Id，2026-09-25 核实
  assert.deepEqual(provided.map(channel => [channel.name, channel.key]), [
    ['新疆卫视', '1'], ['维吾尔语新闻综合', '3'], ['哈萨克语新闻综合', '4'], ['新疆汉语综艺', '16'], ['维吾尔语影视', '17'],
    ['新疆体育健康', '21'], ['新疆少儿', '23'],
  ])
})

check('上海日期 → 当天零点、TVDate 与页面同款不补零的查询日期', () => {
  assert.deepEqual(guideDay('20260925'), {
    dayStart: Date.parse('2026-09-24T16:00:00Z'), tvDate: '2026-09-25', query: '2026-9-25 00:00:00',
  })
  assert.equal(guideDay(20261001).query, '2026-10-1 00:00:00')
  assert.equal(guideDay('20261231').dayStart, sh('2026-12-31 00:00:00'))
  for (const bad of ['20260230', '20261301', '20260900', '2026-09-25', '2026092', '', null, undefined]) {
    assert.equal(guideDay(bad), null, String(bad))
  }
})

check('HH:mm → 当天第几分钟；越界与其它写法得 NaN', () => {
  assert.equal(minuteOfDay('00:00'), 0)
  assert.equal(minuteOfDay('19:00'), 1140)
  assert.equal(minuteOfDay(' 23:59 '), 1439)
  assert.equal(minuteOfDay('7:05'), 425)
  for (const bad of ['24:00', '12:60', '12:5', '1200', '12:00:00', '', null, undefined]) {
    assert.ok(Number.isNaN(minuteOfDay(bad)), String(bad))
  }
})

check('解析：北京时间、结束取 EndTime 后一分钟、跨零点那条截在次日零点', () => {
  const items = parseGuide(XJTV1_0925, '20260925')
  assert.deepEqual(spans(items), [
    ['《健康公开课》', '20260925000000 +0800', '20260925002900 +0800'],
    ['《真实纪录》', '20260925002900 +0800', '20260925005800 +0800'],
    ['丝路剧场：48集《功勋》（42—43）', '20260925005800 +0800', '20260925023200 +0800'],
    ['中华人民共和国国歌', '20260925075900 +0800', '20260925080000 +0800'],
    ['《新疆新闻联播》', '20260925080000 +0800', '20260925083200 +0800'],
    ['《真实纪录》', '20260925183100 +0800', '20260925190000 +0800'],
    ['央视《新闻联播》', '20260925190000 +0800', '20260925193000 +0800'],
    ['《新疆新闻联播》', '20260925193000 +0800', '20260925200000 +0800'],
    ['新闻夜班车', '20260925233300 +0800', '20260925235600 +0800'],
    ['《健康公开课》', '20260925235600 +0800', '20260926000000 +0800'],
  ])
  const relay = items.find(item => item.title === '央视《新闻联播》')
  assert.equal(relay.start, Date.parse('2026-09-25T11:00:00Z'))
  assert.equal(relay.stop, Date.parse('2026-09-25T11:30:00Z'))
  assert.ok(items.every((item, index) => item.start < item.stop && (index === 0 || items[index - 1].stop <= item.start)))
})

check('零点那条起止都写 00:00 的按一分钟算；最后一条写 00:00 的到次日零点；节目名去首尾空白', () => {
  assert.deepEqual(spans(parseGuide(XJTV2_0925, '20260925')), [
    ['黄金剧场: 39集《西北岁月》（14—15）', '20260925000000 +0800', '20260925000100 +0800'],
    ['《真实纪录》', '20260925000100 +0800', '20260925003000 +0800'],
    ['《新疆新闻联播》', '20260925213000 +0800', '20260925220000 +0800'],
    ['央视《新闻联播》', '20260925220000 +0800', '20260925223200 +0800'],
    ['黄金剧场: 39集《西北岁月》（16—17）', '20260925223200 +0800', '20260926000000 +0800'],
  ])
  const sports = parseGuide(XJTV7_0925, '20260925')
  assert.deepEqual(titles(sports), ['重播： 跟我耍大牌 第20260924期', '2026“同心杯”新疆足球超级联赛', '重播：健康365', '重播：自治区全运会'])
  assert.equal(sports[0].start, sh('2026-09-25 01:00:00'), '凌晨一点前没排的不补')
  assert.equal(sports.at(-1).stop, sh('2026-09-26 00:00:00'))
})

check('官方数据毛病：行序打乱照样排好、同一开始时间只留一条、真空档照实保留', () => {
  const day = '2026-09-25'
  const items = parseGuide(envelope([
    row(3, 'C', day, '10:00', '10:29'),
    row(1, 'A', day, '08:00', '08:29'),
    row(2, 'A2', day, '08:00', '08:59'),
    // 结束后隔了半小时才有下一条：空档照实保留，不拉长
    row(4, 'B', day, '09:00', '09:29'),
  ]), '20260925')
  assert.deepEqual(spans(items), [
    ['A', '20260925080000 +0800', '20260925083000 +0800'],
    ['B', '20260925090000 +0800', '20260925093000 +0800'],
    ['C', '20260925100000 +0800', '20260925103000 +0800'],
  ])
})

check('结束时间写坏或倒挂：取下一条开始，最后一条到次日零点；读不出开始时间与没名字的行不要', () => {
  const day = '2026-09-25'
  const items = parseGuide(envelope([
    row(1, '缺结束', day, '06:00', null),
    // 中间一条 EndTime 比开始还早：当成跨零点，再截到下一条开始
    row(2, '倒挂', day, '07:00', '06:30'),
    row(3, '结束越界', day, '08:00', '25:00'),
    row(4, '   ', day, '09:00', '09:29'),
    row(5, '开始写坏', day, '9点', '09:59'),
    { Name: '缺字段' },
    null,
    row(6, '末条结束写坏', day, '23:00', '??'),
  ]), '20260925')
  assert.deepEqual(spans(items), [
    ['缺结束', '20260925060000 +0800', '20260925070000 +0800'],
    ['倒挂', '20260925070000 +0800', '20260925080000 +0800'],
    ['结束越界', '20260925080000 +0800', '20260925230000 +0800'],
    ['末条结束写坏', '20260925230000 +0800', '20260926000000 +0800'],
  ])
})

check('TVDate 不是请求那天的行不要；缺 TVDate 的照收', () => {
  const items = parseGuide(envelope([
    row(1, '前一天的', '2026-09-24', '23:00', '23:59'),
    { ...row(2, '没写日期', null, '08:00', '08:29') },
    row(3, '当天的', '2026-09-25', '09:00', '09:29'),
  ]), '20260925')
  assert.deepEqual(titles(items), ['没写日期', '当天的'])
  // 整份都是别的日子：接口多半没按日期查，报错而不是当成当天节目
  assert.throws(() => parseGuide(envelope([row(1, 'X', '2026-09-24', '08:00', '08:29')]), '20260925'), /格式异常/)
})

check('信封：空数组与 null 是当天没发；success / code 不对、data 不是数组、整份不是对象都抛', () => {
  assert.deepEqual(parseGuide(JSON.parse(EMPTY), '20260925'), [])
  assert.deepEqual(parseGuide({ ...JSON.parse(EMPTY), data: null }, '20260925'), [])
  assert.throws(() => parseGuide({ ...JSON.parse(EMPTY), success: false, message: '参数错误' }, '20260925'), /参数错误/)
  assert.throws(() => parseGuide({ ...JSON.parse(EMPTY), code: 500 }, '20260925'), /接口返回异常/)
  assert.throws(() => parseGuide({ ...JSON.parse(EMPTY), data: {} }, '20260925'), /格式异常/)
  for (const bad of [null, [], '', 'x']) assert.throws(() => parseGuide(bad, '20260925'), /格式异常/, String(bad))
  // 有行却一条都读不出
  assert.throws(() => parseGuide(envelope([{ Id: 1, Title: 'x', Begin: '08:00' }]), '20260925'), /格式异常/)
})

await checkAsync('请求形状：GET 官方接口、参数与官网页面一致、不跟跳转、带超时信号', async () => {
  const log = []
  const items = await xinjiangEpg.programmes('1', '20260925', { fetchImpl: officialApi(log) })
  assert.equal(items.length, 10)
  assert.equal(log.length, 1)
  const url = new URL(log[0].url)
  assert.equal(`${url.origin}${url.pathname}`, EPG_API)
  assert.equal(EPG_API, 'https://slstapi.xjtvs.com.cn/api/TVLiveV100/TVGuideList')
  assert.deepEqual([...url.searchParams], [['tvChannelId', '1'], ['date', '2026-9-25 00:00:00'], ['json', 'true']])
  const init = log[0].init
  assert.equal(init.method, undefined)
  assert.equal(init.body, undefined)
  assert.equal(init.redirect, 'manual')
  assert.ok(init.signal instanceof AbortSignal)
  assert.equal(init.headers.Referer, 'https://www.xjtvs.com.cn/column/tv/434')
  assert.equal(init.headers.Origin, 'https://www.xjtvs.com.cn')
})

await checkAsync('走 providerProgrammes：今天 + 明天，跨零点那条首尾相接不重叠', async () => {
  const log = []
  // 2026-09-25 01:30（上海）
  const items = await providerProgrammes(xinjiangEpg, '1', { now: Date.parse('2026-09-24T17:30:00Z'), fetchImpl: officialApi(log) })
  assert.deepEqual(log.map(entry => new URL(entry.url).searchParams.get('date')).sort(), ['2026-9-25 00:00:00', '2026-9-26 00:00:00'])
  assert.equal(items.length, 13)
  const boundary = items.findIndex(item => item.start === sh('2026-09-26 00:00:00'))
  assert.equal(items[boundary - 1].stop, items[boundary].start, '前一天最后一条停在零点，次日从零点接上')
  assert.equal(items[boundary - 1].title, items[boundary].title)
  assert.ok(items.every((item, index) => item.start < item.stop && (index === 0 || items[index - 1].stop <= item.start)))
  assert.equal(items.at(-1).stop, sh('2026-09-27 00:00:00'))
})

await checkAsync('少儿频道与后天以后：空数组，不算失败', async () => {
  assert.deepEqual(await xinjiangEpg.programmes('23', '20260925', { fetchImpl: officialApi() }), [])
  assert.deepEqual(await xinjiangEpg.programmes('1', '20260928', { fetchImpl: officialApi() }), [])
  assert.deepEqual(await providerProgrammes(xinjiangEpg, '23', { now: Date.parse('2026-09-24T17:30:00Z'), fetchImpl: officialApi() }), [])
})

await checkAsync('HTTP / 跳转 / 网络 / 超时 / 过大 / 非 JSON 都抛出', async () => {
  // 日期写坏时官方回 500 空响应
  await assert.rejects(xinjiangEpg.programmes('1', '20260925', { fetchImpl: async () => reply('', 500) }), /HTTP 500/)
  await assert.rejects(xinjiangEpg.programmes('1', '20260925', {
    fetchImpl: async () => reply('', 302, { location: 'http://evil.test/' }),
  }), /HTTP 302/, '跳转不跟')
  await assert.rejects(xinjiangEpg.programmes('1', '20260925', {
    fetchImpl: async () => { throw new TypeError('fetch failed') },
  }), /fetch failed/)

  const hang = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason))
  })
  await assert.rejects(xinjiangEpg.programmes('1', '20260925', { fetchImpl: hang, timeoutMs: 20 }), { name: 'AbortError' })

  await assert.rejects(xinjiangEpg.programmes('1', '20260925', {
    fetchImpl: async () => reply(EMPTY, 200, { 'content-length': String(1024 * 1024) }),
  }), /响应过大/)
  // 没有 content-length 的分块响应，读到一半超了就停
  let pulled = 0
  const chunk = new Uint8Array(64 * 1024).fill(0x20)
  const endless = new ReadableStream({ pull(controller) { pulled++; controller.enqueue(chunk) } })
  await assert.rejects(xinjiangEpg.programmes('1', '20260925', { fetchImpl: async () => new Response(endless) }), /响应过大/)
  assert.ok(pulled <= 6, `超限后不再继续读：${pulled}`)

  await assert.rejects(xinjiangEpg.programmes('1', '20260925', {
    fetchImpl: async () => reply('<html><body>Server Error</body></html>'),
  }), /不是 JSON/)
  // 带 BOM 的 JSON 照样认
  assert.equal((await xinjiangEpg.programmes('1', '20260925', { fetchImpl: async () => reply(`﻿${JSON.stringify(XJTV1_0925)}`) })).length, 10)

  await assert.rejects(providerProgrammes(xinjiangEpg, '1', {
    now: Date.parse('2026-09-24T17:30:00Z'), fetchImpl: async () => reply('', 500),
  }), /HTTP 500/)
})

await checkAsync('参数非法不发请求', async () => {
  for (const [key, day] of [['', '20260925'], ['1&date=x', '20260925'], ['../1', '20260925'], ['1234567', '20260925'],
    [undefined, '20260925'], ['1', '2026-09-25'], ['1', '20260230'], ['1', '2026092'], ['1', undefined]]) {
    await assert.rejects(xinjiangEpg.programmes(key, day, { fetchImpl: noRequest }), /参数非法/, `${key} ${day}`)
  }
  // 数字形式的 key 与日期也认
  assert.equal((await xinjiangEpg.programmes(1, 20260925, { fetchImpl: officialApi() })).length, 10)
})

console.log(`\n全部通过：${passed} ✅（TZ=${process.env.TZ || '系统默认'}）`)
