#!/usr/bin/env node
/**
 * 南京广电官方节目单回归测试：请求地址、Unix 秒 / 上海时间解析、包装条目与重叠处理、错误路径、
 * 频道对齐（直链频道按显示名配对）。
 * 全部离线；样本按 2026-09-25 官方接口的真实响应裁剪，字段与信封原样保留。
 *
 * 运行： node scripts/test-njtv-epg.mjs
 *       TZ=UTC node scripts/test-njtv-epg.mjs
 *       TZ=America/Los_Angeles node scripts/test-njtv-epg.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import njtvEpg, { EPG_API, epgUrl, fillerReason, parseProgrammes, shanghaiDayStart, shanghaiTime } from '../extractors/njtv/epg.js'
import { TV_CHANNELS } from '../extractors/njtv/channels.js'
import { SCENIC_CHANNELS, TV_CHANNELS as API_TV_CHANNELS } from '../extractors/njtv/api.js'
import { getModule, validateModule } from '../extractors/registry.js'
import { providerProgrammes, xmltvTime } from '../utils/epgXmltv.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

// 上海时间文本 → 毫秒，测试里用显式 +08:00 写期望值，与运行机器时区无关
const sh = text => Date.parse(`${text.replace(' ', 'T')}+08:00`)

const REVIEW = 'http://nklive.nbs.cn/hls/d511bc9d-a694-4453-b3a2-4fc842cc97a1/index.m3u8?start_time='
const row = (epgId, taskId, name, startTime, endTime, start_time, end_time) => ({
  epgId, taskId, name, startTime, endTime, recordAuto: 0, shield: 0, taskUuid: null, date: null, size: 0,
  start_time, end_time, review_url: `${REVIEW}${start_time * 1000},${end_time * 1000}`,
})
const envelope = (data, request_list) => ({ error: 0, msg: '', data, request_list })
const jsonResponse = (payload, init) => new Response(JSON.stringify(payload), {
  ...init, headers: { 'content-type': 'text/html; charset=UTF-8', ...init?.headers },
})

// 南京新闻综合（taskId 39）2026-09-25 的真实片段：尾随空格与制表符、2 分钟台标片头、新闻联播、23:59:59 收尾
const NEWS_0925 = envelope([
  row(58919, 39, '直播南京（复）  ', '2026-09-25 00:00:00', '2026-09-25 00:25:00', 1790265600, 1790267100),
  row(58920, 39, '南京新闻（复）  ', '2026-09-25 00:30:00', '2026-09-25 01:00:00', 1790267400, 1790269200),
  row(58921, 39, '机房检修', '2026-09-25 01:00:00', '2026-09-25 01:50:00', 1790269200, 1790272200),
  row(58922, 39, '南京电视台总片头', '2026-09-25 05:52:00', '2026-09-25 05:54:00', 1790286720, 1790286840),
  row(58923, 39, '南京第一房产 + 南京第一家装\t', '2026-09-25 05:54:00', '2026-09-25 06:39:00', 1790286840, 1790289540),
  row(58939, 39, '南京新闻（直播）', '2026-09-25 18:30:00', '2026-09-25 19:00:00', 1790332200, 1790334000),
  row(58940, 39, '转播中央电视台新闻联播', '2026-09-25 19:00:00', '2026-09-25 19:38:00', 1790334000, 1790336280),
  row(58941, 39, '电视剧', '2026-09-25 19:38:00', '2026-09-25 20:25:00', 1790336280, 1790339100),
  row(58950, 39, '消费向导', '2026-09-25 23:40:00', '2026-09-25 23:59:59', 1790350800, 1790351999),
], { taskId: '39', contentid: '109152', gettime: '1790308800' })
// 同一频道 2026-09-26 开头两条
const NEWS_0926 = envelope([
  row(58951, 39, '直播南京（复）  ', '2026-09-26 00:00:00', '2026-09-26 00:25:00', 1790352000, 1790353500),
  row(58952, 39, '南京新闻（复）  ', '2026-09-26 00:30:00', '2026-09-26 01:00:00', 1790353800, 1790355600),
], { taskId: '39', contentid: '109152', gettime: '1790395200' })
// 南京教育科技（taskId 40）2026-09-25 的真实片段：30 秒的片头合集、3 分钟宣传片、20:05 那条结束晚于下一条开始
const EDU_0925 = envelope([
  row(58185, 40, '标点说房', '2026-09-25 00:45:00', '2026-09-25 01:00:00', 1790268300, 1790269200),
  row(58186, 40, '南京广播电视台总片头+频道形象片+收视指南', '2026-09-25 05:10:00', '2026-09-25 05:10:30', 1790284200, 1790284230),
  row(58187, 40, '南京第一家装', '2026-09-25 05:10:30', '2026-09-25 05:40:00', 1790284230, 1790286000),
  row(58206, 40, '动画片', '2026-09-25 17:00:00', '2026-09-25 17:36:00', 1790326800, 1790328960),
  row(58207, 40, '动画宣传片', '2026-09-25 17:36:00', '2026-09-25 17:39:00', 1790328960, 1790329140),
  row(58212, 40, '南京教育头条', '2026-09-25 19:50:00', '2026-09-25 20:05:00', 1790337000, 1790337900),
  row(58213, 40, '金色年代', '2026-09-25 20:05:00', '2026-09-25 20:20:00', 1790337900, 1790338800),
  row(58214, 40, '我的大学', '2026-09-25 20:15:00', '2026-09-25 20:50:00', 1790338500, 1790340600),
], { taskId: '40', contentid: '109153', gettime: '1790308800' })
// 后天以后与不存在的任务号的真实响应
const NO_DATA = { error: -1, msg: '没有数据', request_list: { taskId: '39', contentid: '109152', gettime: '1790568000' } }

const noRequest = async () => { throw new Error('不应发请求') }

console.log('南京广电节目单测试')

check('请求地址与牛咔节目单页一致：任务号 + 内容号 + 当天中午 12 点（上海）的 Unix 秒', () => {
  const url = new URL(epgUrl('39', '20260925'))
  assert.equal(`${url.origin}${url.pathname}`, EPG_API)
  assert.deepEqual(Object.fromEntries(url.searchParams), { taskId: '39', contentid: '109152', gettime: '1790308800' })
  assert.equal(new URL(epgUrl('43', '20261001')).searchParams.get('gettime'), String(sh('2026-10-01 12:00:00') / 1000))
  // 表外任务号：后端只按 taskId 查，不带内容号也行
  assert.deepEqual(Object.fromEntries(new URL(epgUrl('37', '20260925')).searchParams), { taskId: '37', gettime: '1790308800' })
  for (const [key, day] of [['', '20260925'], ['39&x=1', '20260925'], ['../1', '20260925'], ['1234567', '20260925'],
    ['39', '2026-09-25'], ['39', '20260231'], [null, '20260925']]) {
    assert.throws(() => epgUrl(key, day), /参数非法/, `${key} ${day}`)
  }
})

check('上海日期与时间显式按 +08:00 算，与运行机器时区无关', () => {
  assert.equal(shanghaiDayStart('20260925'), Date.parse('2026-09-24T16:00:00Z'))
  assert.ok(Number.isNaN(shanghaiDayStart('20260230')))
  assert.equal(shanghaiTime('2026-09-25 19:00:00'), Date.parse('2026-09-25T11:00:00Z'))
  assert.equal(xmltvTime(shanghaiTime('2026-09-25 23:59:59')), '20260925235959 +0800')
  for (const bad of ['', null, '19:00:00', '2026-09-25 24:00:00', '2026-02-31 00:00:00', '2026-09-25T19:00:00']) {
    assert.ok(Number.isNaN(shanghaiTime(bad)), String(bad))
  }
})

await checkAsync('解析：Unix 秒为准、标题去空白、台标片头去掉、停播时段照实保留', async () => {
  const requests = []
  const programmes = await njtvEpg.programmes('39', '20260925', {
    fetchImpl: async (url, options) => { requests.push({ url, options }); return jsonResponse(NEWS_0925) },
  })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, epgUrl('39', '20260925'))
  assert.equal(requests[0].options.redirect, 'manual')
  assert.ok(requests[0].options.signal instanceof AbortSignal)
  assert.deepEqual(programmes.map(item => item.title), [
    '直播南京（复）', '南京新闻（复）', '机房检修', '南京第一房产 + 南京第一家装',
    '南京新闻（直播）', '转播中央电视台新闻联播', '电视剧', '消费向导',
  ])
  assert.deepEqual(programmes[5], { title: '转播中央电视台新闻联播', start: sh('2026-09-25 19:00:00'), stop: sh('2026-09-25 19:38:00') })
  assert.equal(xmltvTime(programmes.at(-1).stop), '20260925235959 +0800')
  assert.ok(programmes.every(item => item.title === item.title.trim() && item.stop > item.start))
  assert.ok(programmes.every((item, i) => i === 0 || programmes[i - 1].stop <= item.start), '升序且不重叠')
})

check('包装条目：不到 1 分钟、十分钟内的片头/形象片/收视指南/宣传片去掉；重叠截到下一条开始', () => {
  const programmes = parseProgrammes(EDU_0925, '20260925')
  assert.deepEqual(programmes.map(item => [item.title, xmltvTime(item.start).slice(8, 12), xmltvTime(item.stop).slice(8, 12)]), [
    ['标点说房', '0045', '0100'],
    ['南京第一家装', '0510', '0540'],
    ['动画片', '1700', '1736'],
    ['南京教育头条', '1950', '2005'],
    ['金色年代', '2005', '2015'],
    ['我的大学', '2015', '2050'],
  ])
  assert.equal(fillerReason('南京电视台总片头', 2 * 60 * 1000), 'filler')
  assert.equal(fillerReason('收视指南', 60 * 1000), 'filler')
  assert.equal(fillerReason('南京广播电视台总片头+频道形象片+收视指南', 30 * 1000), 'short')
  assert.equal(fillerReason('转播中央电视台新闻联播', 38 * 60 * 1000), '')
  // 名字碰巧带「宣传片」但超过十分钟的照留
  assert.equal(fillerReason('城市宣传片展播', 30 * 60 * 1000), '')
})

check('只收开始时间在所请求那天的；缺 Unix 秒时读上海时间文本；零时长/倒挂/空标题跳过；同一开始只留一条', () => {
  const programmes = parseProgrammes(envelope([
    row(1, 39, '前一天的', '2026-09-24 23:30:00', '2026-09-25 00:10:00', 1790263800, 1790266200),
    { ...row(2, 39, '只有文本时间', '2026-09-25 08:00:00', '2026-09-25 08:30:00', 0, 0), start_time: undefined, end_time: null },
    row(3, 39, '零时长', '2026-09-25 09:00:00', '2026-09-25 09:00:00', 1790298000, 1790298000),
    row(4, 39, '倒挂', '2026-09-25 10:00:00', '2026-09-25 09:30:00', 1790301600, 1790299800),
    row(5, 39, '   ', '2026-09-25 11:00:00', '2026-09-25 11:30:00', 1790305200, 1790307000),
    row(6, 39, '短的', '2026-09-25 12:00:00', '2026-09-25 12:20:00', 1790308800, 1790310000),
    row(7, 39, '同一开始更长的', '2026-09-25 12:00:00', '2026-09-25 12:30:00', 1790308800, 1790310600),
    row(8, 39, '次日的', '2026-09-26 00:00:00', '2026-09-26 00:25:00', 1790352000, 1790353500),
  ]), '20260925')
  assert.deepEqual(programmes.map(item => [item.title, item.start, item.stop]), [
    ['只有文本时间', sh('2026-09-25 08:00:00'), sh('2026-09-25 08:30:00')],
    ['同一开始更长的', sh('2026-09-25 12:00:00'), sh('2026-09-25 12:30:00')],
  ])
})

await checkAsync('当天没发：「没有数据」与 data 为 null 返回空数组', async () => {
  assert.deepEqual(await njtvEpg.programmes('39', '20260928', { fetchImpl: async () => jsonResponse(NO_DATA) }), [])
  assert.deepEqual(parseProgrammes({ error: 0, msg: '', data: null }, '20260925'), [])
  assert.deepEqual(parseProgrammes(envelope([]), '20260925'), [])
})

await checkAsync('错误路径：HTTP 错误、跳转、其它错误码、非 JSON、格式不符、超大响应、断网、超时、参数非法都抛', async () => {
  const run = (fetchImpl, opts = {}) => njtvEpg.programmes('39', '20260925', { fetchImpl, ...opts })
  await assert.rejects(run(async () => new Response('', { status: 503 })), /HTTP 503/)
  await assert.rejects(run(async () => new Response(null, { status: 302, headers: { location: 'https://waf.example/' } })), /HTTP 302/)
  await assert.rejects(run(async () => jsonResponse({ error: -1, msg: '参数错误' })), /-1：参数错误/)
  await assert.rejects(run(async () => jsonResponse({ error: 500, msg: '' })), /500/)
  await assert.rejects(run(async () => new Response('<html>访问受限</html>')), /不是 JSON/)
  await assert.rejects(run(async () => jsonResponse({ error: 0, msg: '', data: { list: [] } })), /格式异常/)
  await assert.rejects(run(async () => jsonResponse('ok')), /格式异常/)
  // 有数据但一条时间都读不出：接口改格式，不能当成「当天没发」
  await assert.rejects(run(async () => jsonResponse(envelope([{ name: '南京新闻', begin: '19:00' }]))), /格式异常/)
  await assert.rejects(run(async () => new Response('{}', { headers: { 'content-length': String(10 * 1024 * 1024) } })), /过大/)
  const endless = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(64 * 1024).fill(0x20)) } })
  await assert.rejects(run(async () => new Response(endless)), /过大/)
  await assert.rejects(run(async () => { throw new TypeError('fetch failed') }), /fetch failed/)
  const hang = async (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason))
  })
  await assert.rejects(run(hang, { timeoutMs: 20 }), { name: 'AbortError' })
  await assert.rejects(njtvEpg.programmes('abc', '20260925', { fetchImpl: noRequest }), /参数非法/)
  await assert.rejects(njtvEpg.programmes('39', '2026-09-25', { fetchImpl: noRequest }), /参数非法/)
})

await checkAsync('两天合并：跨日不重叠、按开始时间排好', async () => {
  const fetchImpl = async url => jsonResponse(new URL(url).searchParams.get('gettime') === '1790308800' ? NEWS_0925 : NEWS_0926)
  const merged = await providerProgrammes(njtvEpg, '39', { now: sh('2026-09-25 10:00:00'), fetchImpl })
  assert.equal(merged.length, 10)
  assert.ok(merged.every((item, i) => i === 0 || merged[i - 1].stop <= item.start))
  assert.equal(xmltvTime(merged[8].start), '20260926000000 +0800')
})

// 官网电视脚本与 Live 南京页面的最小样本（结构同 scripts/test-city-live.mjs）
const tvScript = () => TV_CHANNELS.map(channel => `videosrc='${channel.fallbackUrl.replace(/^https:/, '')}';`).join('\n')
const scenicHtml = () => SCENIC_CHANNELS
  .map(channel => `<div class="swiper-slide" data-url="${channel.fallbackUrl}"><div></div><div style="text-align: center;">${channel.name}</div></div>`)
  .join('\n')

await checkAsync('频道对齐：四套电视频道的显示名与模块产出逐一相同，景观机位不登记', async () => {
  const module = getModule('njtv')
  assert.equal(module.epg, njtvEpg)
  assert.equal(module.capabilities.epg, true)
  assert.doesNotThrow(() => validateModule(module))
  const { groups } = await module.fetch({}, {
    fetchImpl: async url => ({ ok: true, status: 200, text: async () => (String(url).includes('tv.js') ? tvScript() : scenicHtml()) }),
  })
  const [tvGroup, scenicGroup] = groups
  const provided = njtvEpg.channels()
  // 直链频道没有 deferredRef：按来源模块 + 显示名配对，名字必须和 fetch() 产出的一字不差
  const emittedNames = new Set(groups.flatMap(group => group.dataList).map(channel => channel.name))
  assert.ok(provided.every(channel => emittedNames.has(channel.name)), '节目单登记的名字都要是模块实际产出的频道名')
  assert.deepEqual(provided.map(channel => channel.name), tvGroup.dataList.map(channel => channel.name))
  assert.ok(scenicGroup.dataList.every(channel => !provided.some(p => p.name === channel.name)), '景观机位不登记')
  assert.ok(tvGroup.dataList.every(channel => channel.deferredRef == null))
  assert.deepEqual(provided.map(channel => channel.key), ['39', '40', '42', '43'])
  assert.equal(new Set(provided.map(channel => channel.ref)).size, provided.length)
  assert.ok(provided.every(channel => /^njtv-\d+$/.test(channel.ref)))
  // 取流仍用同一份频道表（下标对应脚本里的地址）
  assert.equal(API_TV_CHANNELS, TV_CHANNELS)
})

check('epg.js 只 import 本目录的频道表，可整体拆出', () => {
  const source = readFileSync(new URL('../extractors/njtv/epg.js', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map(match => match[1])
  assert.deepEqual(imports, ['./channels.js'])
  const channels = readFileSync(new URL('../extractors/njtv/channels.js', import.meta.url), 'utf8')
  assert.equal([...channels.matchAll(/^import /gm)].length, 0)
})

console.log(`\n全部通过：${passed} ✅`)
