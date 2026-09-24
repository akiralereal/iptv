#!/usr/bin/env node
/**
 * 大爱电视官方节目单回归测试：请求形状、台湾时间换算、结束时间推算、分段合并、错误路径、频道 ref 对齐。
 * 全部离线；样本按 2026-09-25 官方接口的真实响应裁剪（节目简介截短，其余字段原样保留）。
 *
 * 运行： node scripts/test-daai-epg.mjs
 *       TZ=UTC node scripts/test-daai-epg.mjs
 *       TZ=America/Los_Angeles node scripts/test-daai-epg.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import daaiEpg, { EPG_API, dayInfo, parseProgrammes, parseTaiwanTime } from '../extractors/daai/epg.js'
import { CHANNELS } from '../extractors/daai/channels.js'
import { getModule, validateModule } from '../extractors/registry.js'
import { providerProgrammes, xmltvTime } from '../utils/epgXmltv.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

// 上海（= 台湾）时间文本 → 毫秒，测试里用显式 +08:00 写期望值，与运行机器时区无关
const sh = text => Date.parse(`${text.replace(' ', 'T')}+08:00`)

// 官方接口的一条节目，字段集合与真实响应一致
const row = (time, title, daaiId, extra = {}) => ({
  time, premiere: null, title, title_en: '', daai_id: daaiId, thumbnail_url: '',
  share_url: `https://www.daai.tv/program/${daaiId.slice(0, 5)}/${daaiId}`, youtube_id: null, s3_url: '',
  summary: 'null', header_text: time.slice(11, 16), header_style: '', description_text: title, description_style: '', ...extra,
})
// 大爱一台 2026-09-25 的真实片段
const TV1_0925 = [
  row('2026-09-25 00:00:10', '經典劇坊_幸福在我家(32)', 'P13620032', { premiere: '2015-06-12 20:00:00', youtube_id: 'q_RcrSKTg9I', summary: '葉父把四兄弟聚集在一起，因為他決定趁現在人還在時' }),
  row('2026-09-25 00:50:00', '365日日素(314)', 'P19080314', { premiere: '2025-04-10 07:05:10', youtube_id: 'u_3xfPq-qFo', summary: '蔬菜牛奶鍋，奶水、鮮奶油熬煮至濃郁滑順' }),
  row('2026-09-25 00:55:10', '仁心慧語(728)', 'P18430728', { premiere: '2026-09-18 13:26:02', youtube_id: '1wVSpYLcH0o', summary: '「比起才華，更重要的是真的喜歡做這件事情。」' }),
  row('2026-09-25 06:29:30', '大愛真健康(980)', 'P18570980', { premiere: '2025-10-10 15:00:00', youtube_id: 'koxwgAICVeU', summary: '更多運動點這' }),
  row('2026-09-25 06:35:00', '大愛早安新聞 LIVE', 'N06303220'),
  row('2026-09-25 23:00:00', '大愛劇_聽見心的聲音(2)', 'P11080002', { premiere: '2022-11-12 20:00:00', youtube_id: 'q2tJvs6j3oA', summary: '池堃順應母親的期望，娶了溫柔嫻淑的寶桂為妻' }),
  row('2026-09-25 23:50:00', '大愛醫生館(6889)', 'P00166889', { premiere: '2026-09-25 20:50:00', summary: '一名五十多歲男性出現吞嚥困難' }),
]
// 大爱一台 2026-09-26 第一条：次日零点 20 秒才开始
const TV1_0926 = [
  row('2026-09-26 00:00:20', '人文講堂(84)', 'P12730084', { premiere: '2026-09-19 18:00:00', youtube_id: '8EknJOl3xrc', summary: '教育是「不放棄任何一個孩子」' }),
]
// 大爱二台 2026-09-25 开头：同一集被切成三段连着列
const TV2_0925 = [
  row('2026-09-25 00:00:00', '地球證詞-世界紀錄片(1370)', 'P11481370'),
  row('2026-09-25 00:20:10', '地球證詞-世界紀錄片(1370)', 'P11481370'),
  row('2026-09-25 00:39:48', '地球證詞-世界紀錄片(1370)', 'P11481370'),
  row('2026-09-25 01:00:00', '大愛地球村(5193)', 'P19075193'),
]

// 接口声明的是 text/html，内容其实是 JSON
const jsonResponse = (payload, init) => new Response(JSON.stringify(payload), {
  ...init, headers: { 'content-type': 'text/html; charset=UTF-8', ...init?.headers },
})
const noRequest = async () => { throw new Error('不应发请求') }

console.log('大爱电视节目单测试')

check('日期与台湾时间显式按 +08:00 换算，与运行机器时区无关', () => {
  assert.deepEqual(dayInfo('20260925'), {
    date: '2026-09-25', start: Date.parse('2026-09-24T16:00:00Z'), end: Date.parse('2026-09-25T16:00:00Z'),
  })
  assert.equal(parseTaiwanTime('2026-09-25 06:35:00'), Date.parse('2026-09-24T22:35:00Z'))
  assert.equal(parseTaiwanTime('2026-09-25 00:00:10'), Date.parse('2026-09-24T16:00:10Z'))
  for (const bad of ['', null, '06:35:00', '2026/09/25 06:35:00', '2026-09-25 24:00:00', '2026-02-31 00:00:00', 1790334000000]) {
    assert.equal(parseTaiwanTime(bad), null, String(bad))
  }
  for (const bad of ['2026-09-25', '20260231', '']) assert.throws(() => dayInfo(bad), /参数非法/)
})

await checkAsync('按官网频道配置里的 playlist 模板请求：频道段 + YYYY-MM-DD，带浏览器 UA，不跟跳转', async () => {
  const requests = []
  const fetchImpl = async (url, options) => { requests.push({ url, options }); return jsonResponse(TV1_0925) }
  await daaiEpg.programmes('ch1', '20260925', { fetchImpl })
  await daaiEpg.programmes('ch3', '20261001', { fetchImpl })
  assert.equal(requests[0].url, `${EPG_API}ch1/2026-09-25`)
  assert.equal(requests[1].url, `${EPG_API}ch3/2026-10-01`)
  assert.match(requests[0].options.headers['User-Agent'], /^Mozilla\/5\.0 .*Chrome\//)
  assert.equal(requests[0].options.redirect, 'manual')
  assert.ok(requests[0].options.signal instanceof AbortSignal)
})

await checkAsync('解析：结束取下一条开始，最后一条到次日零点', async () => {
  const programmes = await daaiEpg.programmes('ch1', '20260925', { fetchImpl: async () => jsonResponse(TV1_0925) })
  assert.deepEqual(programmes.map(item => [item.title, xmltvTime(item.start), xmltvTime(item.stop)]), [
    ['經典劇坊_幸福在我家(32)', '20260925000010 +0800', '20260925005000 +0800'],
    ['365日日素(314)', '20260925005000 +0800', '20260925005510 +0800'],
    ['仁心慧語(728)', '20260925005510 +0800', '20260925062930 +0800'],
    ['大愛真健康(980)', '20260925062930 +0800', '20260925063500 +0800'],
    ['大愛早安新聞 LIVE', '20260925063500 +0800', '20260925230000 +0800'],
    ['大愛劇_聽見心的聲音(2)', '20260925230000 +0800', '20260925235000 +0800'],
    ['大愛醫生館(6889)', '20260925235000 +0800', '20260926000000 +0800'],
  ])
})

check('广告切开的同一集并成一条；同名但节目编号不同的不并', () => {
  assert.deepEqual(parseProgrammes(TV2_0925, '20260925').map(item => [item.title, item.start, item.stop]), [
    ['地球證詞-世界紀錄片(1370)', sh('2026-09-25 00:00:00'), sh('2026-09-25 01:00:00')],
    ['大愛地球村(5193)', sh('2026-09-25 01:00:00'), sh('2026-09-26 00:00:00')],
  ])
  assert.equal(parseProgrammes([
    row('2026-09-25 10:00:00', '青春進行曲', 'P1'),
    row('2026-09-25 10:30:00', '青春進行曲', 'P2'),
  ], '20260925').length, 2)
})

check('脏数据：空标题、坏时间、他日条目跳过；乱序排好、同一开始只留一条', () => {
  const programmes = parseProgrammes([
    row('2026-09-25 20:00:00', '  大愛劇_聽見心的聲音(2)  ', 'P11080002'),
    row('2026-09-25 19:00:00', '大愛夜安新聞-1 LIVE', 'N1'),
    row('2026-09-25 19:00:00', '重复开始', 'N2'),
    row('2026-09-25 19:30:00', '   ', 'N3'),
    row('2026-09-25 25:00:00', '坏时间', 'N4'),
    row('2026-09-26 00:00:20', '次日', 'N5'),
    row('2026-09-24 23:50:00', '前一天', 'N6'),
  ], '20260925')
  assert.deepEqual(programmes.map(item => [item.title, item.start, item.stop]), [
    ['大愛夜安新聞-1 LIVE', sh('2026-09-25 19:00:00'), sh('2026-09-25 20:00:00')],
    ['大愛劇_聽見心的聲音(2)', sh('2026-09-25 20:00:00'), sh('2026-09-26 00:00:00')],
  ])
})

await checkAsync('当天没发：空数组返回空数组', async () => {
  assert.deepEqual(await daaiEpg.programmes('ch1', '20261005', { fetchImpl: async () => jsonResponse([]) }), [])
})

await checkAsync('错误路径：HTTP 错误、跳转、Cloudflare 拦截页、格式不符、超大响应、断网、超时、参数非法都抛', async () => {
  const run = (fetchImpl, opts = {}) => daaiEpg.programmes('ch1', '20260925', { fetchImpl, ...opts })
  await assert.rejects(run(async () => new Response('<!DOCTYPE html><html class="no-js">', { status: 403 })), /HTTP 403/)
  await assert.rejects(run(async () => new Response(null, { status: 301, headers: { location: 'https://www.daai.tv/' } })), /HTTP 301/)
  await assert.rejects(run(async () => new Response('<!DOCTYPE html><html class="no-js">')), /不是 JSON/)
  await assert.rejects(run(async () => jsonResponse({ data: TV1_0925 })), /格式异常/)
  // 有数据但一条时间都读不出：接口改格式，不能当成「当天没发」
  await assert.rejects(run(async () => jsonResponse(TV1_0925.map(item => ({ ...item, time: item.header_text })))), /格式异常/)
  await assert.rejects(run(async () => new Response('[]', { headers: { 'content-length': String(10 * 1024 * 1024) } })), /过大/)
  const endless = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(64 * 1024).fill(0x20)) } })
  await assert.rejects(run(async () => new Response(endless)), /过大/)
  await assert.rejects(run(async () => { throw new TypeError('fetch failed') }), /fetch failed/)
  const hang = async (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason))
  })
  await assert.rejects(run(hang, { timeoutMs: 20 }), { name: 'AbortError' })
  await assert.rejects(daaiEpg.programmes('ch2', '20260925', { fetchImpl: noRequest }), /参数非法/)
  await assert.rejects(daaiEpg.programmes('ch1/../x', '20260925', { fetchImpl: noRequest }), /参数非法/)
  await assert.rejects(daaiEpg.programmes('ch1', '2026-09-25', { fetchImpl: noRequest }), /参数非法/)
})

await checkAsync('每个节目单 ref 与显示名都是模块实际产出的频道，两台全登记', async () => {
  const module = getModule('daai')
  assert.equal(module.epg, daaiEpg)
  assert.equal(module.capabilities.epg, true)
  assert.doesNotThrow(() => validateModule(module))
  const { groups } = await module.fetch({})
  const emitted = groups.flatMap(group => group.dataList).map(channel => [channel.deferredRef, channel.name])
  assert.deepEqual(daaiEpg.channels().map(channel => [channel.ref, channel.name]), emitted)
  // 一台 = tv1 推流 = 官网 ch1，二台 = tv2 推流 = 官网 ch3（官网频道配置里 wowza_url 与 playlist 成对出现）
  assert.deepEqual(CHANNELS.map(channel => [channel.url.match(/\/(tv\d)\.m3u8$/)[1], channel.schedule]), [['tv1', 'ch1'], ['tv2', 'ch3']])
  assert.deepEqual(daaiEpg.channels().map(channel => channel.key), ['ch1', 'ch3'])
})

await checkAsync('两天合并：前一天最后一条接到次日零点，与次日首条不重叠', async () => {
  const fetchImpl = async url => jsonResponse(url.endsWith('/2026-09-25') ? TV1_0925 : TV1_0926)
  // 2026-09-25 10:00（上海）
  const merged = await providerProgrammes(daaiEpg, 'ch1', { now: sh('2026-09-25 10:00:00'), fetchImpl })
  assert.equal(merged.length, 8)
  assert.ok(merged.every((item, i) => i === 0 || merged[i - 1].stop <= item.start))
  assert.equal(xmltvTime(merged[6].stop), '20260926000000 +0800')
  assert.equal(xmltvTime(merged[7].start), '20260926000020 +0800')
})

check('epg.js 只 import 本目录的频道表，可整体拆出', () => {
  const source = readFileSync(new URL('../extractors/daai/epg.js', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map(match => match[1])
  assert.deepEqual(imports, ['./channels.js'])
})

console.log(`\n全部通过：${passed} ✅`)
