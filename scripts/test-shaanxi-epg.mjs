#!/usr/bin/env node
/**
 * 陕西广电官方节目单回归测试：脚本解析、按响应 Date 头认定是哪一天、官方数据毛病的收拾、
 * 空正文、各类错误。全程离线，夹具照 2026-09-25 官网实际返回裁剪。
 *
 * 运行： node scripts/test-shaanxi-epg.mjs
 *       TZ=UTC node scripts/test-shaanxi-epg.mjs
 *       TZ=America/Los_Angeles node scripts/test-shaanxi-epg.mjs
 */
import assert from 'node:assert/strict'

import shaanxi from '../extractors/shaanxi/index.js'
import shaanxiEpg, { EPG_API, clockOffset, dayStartMs, parsePlaylist, shanghaiDay } from '../extractors/shaanxi/epg.js'
import { CHANNELS, buildChannels } from '../extractors/shaanxi/api.js'
import { getModule, validateModule } from '../extractors/registry.js'
import { channelXml, providerProgrammes, xmltvTime } from '../utils/epgXmltv.js'

// 离线：任何一条路径漏了注入的 fetchImpl 都直接失败
globalThis.fetch = async () => { throw new Error('离线测试不应访问网络') }

let passed = 0
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

// 官网原样：紧凑 JSON、中文转成 \uXXXX、末尾一个分号，前后没有空白
const row = (start, end, name, allowLive = 1) => ({ start, end, name, allowLive })
const script = rows => `var snr_Playlist = ${JSON.stringify(rows).replace(/[\u0080-￿]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)};`
// 官网 Date 头：2026-09-25 02:54:47（上海）
const SERVED = 'Thu, 24 Sep 2026 18:54:47 GMT'
const reply = (body, { status = 200, date = SERVED, type = 'application/javascript; charset=utf-8' } = {}) => new Response(body, {
  status, headers: { 'content-type': type, ...(date ? { date } : {}) },
})
const serve = (body, log = [], options) => async (url, init) => { log.push({ url: String(url), init }); return reply(body, options) }
const at = (day, clock) => dayStartMs(day) + clockOffset(clock)
const titles = items => items.map(item => item.title)

// 陕西卫视：07:00 国歌与重播的新闻联播起止一样，播出的是后一条
const STAR = script([
  row('00:00', '00:05', '未央影院：战上海'),
  row('00:05', '01:05', '纪录时间'),
  row('06:29', '07:00', '纪录时间'),
  row('07:00', '07:29', '中华人民共和国国歌'),
  row('07:00', '07:29', '陕西新闻联播（重）'),
  row('07:29', '08:15', '早间剧场'),
  row('23:30', '23:59', '未央影院：地道战'),
])
// 移动电视：夜里「晚曲台标」「彩图」两条同时段，最后一条是 23:59 起止的零时长宣传
const MOBILE = script([
  row('00:00', '00:01', '宣传'),
  row('00:01', '05:30', '晚曲台标'),
  row('00:01', '05:30', '彩图'),
  row('05:30', '06:00', '彩图'),
  row('06:00', '06:01', '台标晨曲'),
  row('06:01', '06:21', '乐学西安 乐活西安 1'),
  row('23:30', '23:59', '网闻播报'),
  row('23:59', '23:59', '宣传'),
])

console.log('陕西广电节目单测试')

await checkAsync('模块挂上节目单提供者，频道表每一路都有节目单键且都在模块输出里', async () => {
  assert.equal(getModule('shaanxi'), shaanxi)
  assert.equal(shaanxi.epg, shaanxiEpg)
  assert.equal(shaanxi.capabilities.epg, true)
  assert.equal(shaanxiEpg.days, 1, '接口只给当天')
  assert.doesNotThrow(() => validateModule(shaanxi))
  const listed = shaanxiEpg.channels()
  assert.deepEqual(listed, CHANNELS.map(channel => ({ ref: channel.ref, name: channel.name, key: channel.key })))
  assert.deepEqual(listed.map(channel => channel.key), ['star', '1', '2', '3', '5', '7', 'nl', '11'])
  const refs = new Set(buildChannels().map(channel => channel.deferredRef))
  assert.ok(listed.every(channel => refs.has(channel.ref)))
})

await checkAsync('时间换算只认上海时区，与运行机器的时区无关', async () => {
  assert.equal(dayStartMs('20260925'), Date.parse('2026-09-24T16:00:00Z'))
  assert.ok(Number.isNaN(dayStartMs('20260931')))
  assert.ok(Number.isNaN(dayStartMs('2026-09-25')))
  assert.equal(shanghaiDay(Date.parse(SERVED)), '20260925')
  assert.equal(shanghaiDay(Date.parse('2026-09-24T15:59:59Z')), '20260924')
  assert.equal(clockOffset('07:29'), (7 * 60 + 29) * 60_000)
  assert.equal(clockOffset('24:00'), 24 * 60 * 60_000)
  for (const bad of ['24:01', '7:60', '0729', '', null, '07:29:00']) assert.ok(Number.isNaN(clockOffset(bad)), String(bad))
})

await checkAsync('同一时刻两条留后一条，最后一条接到 24:00', async () => {
  const items = parsePlaylist(STAR, '20260925')
  assert.deepEqual(titles(items), ['未央影院：战上海', '纪录时间', '纪录时间', '陕西新闻联播（重）', '早间剧场', '未央影院：地道战'])
  assert.deepEqual(items[3], { title: '陕西新闻联播（重）', start: at('20260925', '07:00'), stop: at('20260925', '07:29') })
  assert.equal(items.at(-1).stop, dayStartMs('20260926'))
  assert.equal(xmltvTime(items[0].start), '20260925000000 +0800')
  assert.equal(xmltvTime(items.at(-1).stop), '20260926000000 +0800')
  // 前后衔接：没有重叠
  for (let i = 1; i < items.length; i++) assert.ok(items[i - 1].stop <= items[i].start)
})

await checkAsync('移动电视：夜间台标与彩图留彩图，零时长的尾巴丢掉', async () => {
  const items = parsePlaylist(MOBILE, '20260925')
  assert.deepEqual(titles(items), ['宣传', '彩图', '彩图', '台标晨曲', '乐学西安 乐活西安 1', '网闻播报'])
  assert.equal(items[1].start, at('20260925', '00:01'))
  assert.equal(items.at(-1).stop, dayStartMs('20260926'))
})

await checkAsync('跨零点写法、重叠、乱序、坏行各自收拾', async () => {
  const items = parsePlaylist(script([
    row('22:00', '23:10', '晚间剧场'),
    row('08:00', '09:00', '早间新闻'),
    row('23:00', '00:30', '午夜剧场'),
    row('09:00', '09:00', '零时长'),
    row('10:00', '11:00', ''),
    row('10:00', 'x', '坏时间'),
    row('24:00', '24:00', '越界'),
  ]), '20260925')
  assert.deepEqual(titles(items), ['早间新闻', '晚间剧场', '午夜剧场'])
  assert.equal(items[1].stop, at('20260925', '23:00'), '晚间剧场截到午夜剧场开始')
  assert.equal(items[2].stop, at('20260926', '00:30'), '跨零点的结束算到次日')
})

await checkAsync('空正文当官方没发；格式不对照实报错', async () => {
  assert.deepEqual(parsePlaylist('', '20260925'), [])
  assert.deepEqual(parsePlaylist(script([]), '20260925'), [])
  assert.deepEqual(parsePlaylist('var snr_Playlist = []', '20260925'), [], '分号可有可无')
  assert.throws(() => parsePlaylist('<html>502</html>', '20260925'), /不是预期的脚本/)
  assert.throws(() => parsePlaylist('var snr_Playlist = [{', '20260925'), /JSON 无效/)
  assert.throws(() => parsePlaylist('var snr_Playlist = {"a":1};', '20260925'), /格式异常/)
  assert.throws(() => parsePlaylist(script([{ begin: '00:00', finish: '01:00', title: 'x' }]), '20260925'), /时间格式异常/)
})

await checkAsync('按频道键请求官方接口，响应 Date 头的上海日期就是这份节目单的日期', async () => {
  const log = []
  const items = await shaanxiEpg.programmes('star', '20260925', { fetchImpl: serve(STAR, log) })
  assert.equal(items.length, 6)
  assert.equal(log.length, 1)
  assert.equal(log[0].url, `${EPG_API}?channel=star`)
  assert.equal(log[0].init.redirect, 'manual')
  assert.ok(log[0].init.signal)

  // 本机已过零点、官网还没过（Date 头仍是前一天 23:59:58）：宁可当天没有，也不张冠李戴
  const early = await shaanxiEpg.programmes('star', '20260925', {
    fetchImpl: serve(STAR, [], { date: 'Thu, 24 Sep 2026 15:59:58 GMT' }),
  })
  assert.deepEqual(early, [])
  // 没有 Date 头时按本机时间认定
  const today = shanghaiDay(Date.now())
  const undated = await shaanxiEpg.programmes('1', today, { fetchImpl: serve(STAR, [], { date: '' }) })
  assert.equal(undated.length, 6)
  assert.equal(undated[0].start, dayStartMs(today))
})

await checkAsync('不认识的频道回空正文：当天没发，交给外部源', async () => {
  const items = await shaanxiEpg.programmes('4', '20260925', { fetchImpl: serve('', [], { type: 'text/html; charset=UTF-8' }) })
  assert.deepEqual(items, [])
})

await checkAsync('HTTP 错误、响应过大、参数非法都抛出，由调用方计数', async () => {
  await assert.rejects(
    shaanxiEpg.programmes('star', '20260925', { fetchImpl: serve('busy', [], { status: 502 }) }),
    /节目单 HTTP 502/,
  )
  const huge = async () => new Response('x', { headers: { 'content-length': String(2 * 1024 * 1024), date: SERVED } })
  await assert.rejects(shaanxiEpg.programmes('star', '20260925', { fetchImpl: huge }), /响应过大/)
  const streamed = async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(256 * 1024)) },
  }), { headers: { date: SERVED } })
  await assert.rejects(shaanxiEpg.programmes('star', '20260925', { fetchImpl: streamed }), /响应过大/)
  const never = async () => { throw new Error('不应请求') }
  await assert.rejects(shaanxiEpg.programmes('../x', '20260925', { fetchImpl: never }), /参数非法/)
  await assert.rejects(shaanxiEpg.programmes('star', '2026-09-25', { fetchImpl: never }), /参数非法/)
  const hang = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
  })
  await assert.rejects(shaanxiEpg.programmes('star', '20260925', { fetchImpl: hang, timeoutMs: 20 }), { name: 'AbortError' })
})

await checkAsync('经公共件按模块声明的天数取、写成 XMLTV', async () => {
  const now = Date.parse(SERVED)
  const items = await providerProgrammes(shaanxiEpg, 'star', { now, fetchImpl: serve(STAR) })
  assert.equal(items.length, 6)
  const xml = channelXml('陕西卫视', items)
  assert.match(xml, /<channel id="陕西卫视">/)
  assert.match(xml, /start="20260925070000 \+0800" stop="20260925072900 \+0800">\n {8}<title lang="zh">陕西新闻联播（重）<\/title>/)
  assert.doesNotMatch(xml, /国歌/)
})

console.log(`\n全部通过：${passed} ✅`)
