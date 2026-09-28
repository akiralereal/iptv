#!/usr/bin/env node
/**
 * 香港卫视官方节目单回归测试：请求形状、香港时间换算、结束时间推算、日期核对、错误路径、频道 ref 对齐。
 * 全部离线；样本按 2026-09-25 官方接口的真实响应裁剪，字段原样保留。
 *
 * 运行： node scripts/test-hkstv-epg.mjs
 *       TZ=UTC node scripts/test-hkstv-epg.mjs
 *       TZ=America/Los_Angeles node scripts/test-hkstv-epg.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import hkstvEpg, { EPG_API, dayInfo, parseProgrammes } from '../extractors/hkstv/epg.js'
import { CHANNEL } from '../extractors/hkstv/channels.js'
import { getModule, validateModule } from '../extractors/registry.js'
import { providerProgrammes, xmltvTime } from '../utils/epgXmltv.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

// 上海（= 香港）时间文本 → 毫秒，测试里用显式 +08:00 写期望值，与运行机器时区无关
const sh = text => Date.parse(`${text.replace(' ', 'T')}+08:00`)

// 官方接口的一条节目，字段集合与真实响应一致
const row = (id, playTime, duration, title, programDate, programId, replay = 1) => ({
  id, title, play_time: playTime, duration, description: '', details: '', replay, channel_id: 12,
  program_date: programDate, program_id: programId, play_state: 0, topic: null, play_total: 0, play_duration: 0,
})
const D0925 = '2026-09-24T16:00:00.000Z'
const D0926 = '2026-09-25T16:00:00.000Z'
// 2026-09-25 的真实片段：05:20 那条时长越过下一条开始，最后一条跨零点 5 分钟
const HKS_0925 = { data: [
  row(284041, '00:11:00', 1680, '映像', D0925, 22),
  row(284043, '00:41:00', 1500, '独爱东南', D0925, 112),
  row(284045, '05:20:00', 1200, '香江唱皖', D0925, 122),
  row(284026, '05:25:00', 1680, '健康加油站', D0925, 29),
  row(284037, '18:00:00', 600, '新闻纵览', D0925, 236, 0),
  row(284064, '20:00:00', 5820, '港视剧场', D0925, 177),
  row(284058, '23:22:00', 1680, '东边西边', D0925, 24),
  row(284039, '23:50:00', 900, '那点财经事', D0925, 28),
] }
// 2026-09-26 开头一条：00:11 才开始，接得上前一天跨零点的那条
const HKS_0926 = { data: [row(284106, '00:11:00', 1680, '映像', D0926, 22)] }
const EMPTY_DAY = { data: [] }
const BAD_DATE = { error: '缺少有效的日期' }

const jsonResponse = (payload, init) => new Response(JSON.stringify(payload), {
  ...init, headers: { 'content-type': 'application/json; charset=utf-8', ...init?.headers },
})
const noRequest = async () => { throw new Error('不应发请求') }

console.log('香港卫视节目单测试')

check('上海日期 → 接口日期与当天零点区间，与运行机器时区无关', () => {
  assert.deepEqual(dayInfo('20260925'), {
    date: '2026-09-25', start: Date.parse('2026-09-24T16:00:00Z'), end: Date.parse('2026-09-25T16:00:00Z'),
  })
  assert.equal(dayInfo('20261001').date, '2026-10-01')
  for (const bad of ['2026-09-25', '2026092', '20260231', '', null]) assert.throws(() => dayInfo(bad), /参数非法/, String(bad))
})

await checkAsync('按官网直播页的方式请求：YYYY-MM-DD 日期、不跟跳转', async () => {
  const requests = []
  await hkstvEpg.programmes('default', '20260925', {
    fetchImpl: async (url, options) => { requests.push({ url, options }); return jsonResponse(HKS_0925) },
  })
  const [{ url, options }] = requests
  assert.equal(url, `${EPG_API}?date=2026-09-25`)
  assert.equal(new URL(url).origin, 'https://hkstv.tv')
  assert.equal(options.redirect, 'manual')
  assert.ok(options.signal instanceof AbortSignal)
})

await checkAsync('解析：香港时间 + 时长，越过下一条的截断，最后一条跨零点照实保留', async () => {
  const programmes = await hkstvEpg.programmes('default', '20260925', { fetchImpl: async () => jsonResponse(HKS_0925) })
  assert.deepEqual(programmes.map(item => [item.title, xmltvTime(item.start), xmltvTime(item.stop)]), [
    ['映像', '20260925001100 +0800', '20260925003900 +0800'],
    ['独爱东南', '20260925004100 +0800', '20260925010600 +0800'],
    // 20 分钟的时长越过 05:25 的下一条，截到下一条开始
    ['香江唱皖', '20260925052000 +0800', '20260925052500 +0800'],
    ['健康加油站', '20260925052500 +0800', '20260925055300 +0800'],
    ['新闻纵览', '20260925180000 +0800', '20260925181000 +0800'],
    ['港视剧场', '20260925200000 +0800', '20260925213700 +0800'],
    ['东边西边', '20260925232200 +0800', '20260925235000 +0800'],
    ['那点财经事', '20260925235000 +0800', '20260926000500 +0800'],
  ])
  assert.deepEqual(programmes[4], { title: '新闻纵览', start: sh('2026-09-25 18:00:00'), stop: sh('2026-09-25 18:10:00') })
})

check('脏数据：时长缺失/为 0/超过一天补到下一条或次日零点，坏时间与空标题跳过，同一开始只留一条', () => {
  const programmes = parseProgrammes({ data: [
    row(9, '23:00:00', 0, '零时长最后一条', D0925, 1),
    row(8, '22:00:00', 90000, '超过一天', D0925, 1),
    row(7, '21:00:00', undefined, '缺时长', D0925, 1),
    row(6, '20:00:00', 600, '  带空白  ', D0925, 1),
    row(5, '20:00:00', 0, '同一开始零时长', D0925, 1),
    row(4, '19:00:00', 600, '   ', D0925, 1),
    row(3, '24:10:00', 600, '坏时间', D0925, 1),
    row(2, '7:00', 600, '坏格式', D0925, 1),
    row(1, '19:30', 600, '不带秒', D0925, 1),
  ] }, '20260925')
  assert.deepEqual(programmes.map(item => [item.title, item.start, item.stop]), [
    ['不带秒', sh('2026-09-25 19:30:00'), sh('2026-09-25 19:40:00')],
    ['带空白', sh('2026-09-25 20:00:00'), sh('2026-09-25 20:10:00')],
    ['缺时长', sh('2026-09-25 21:00:00'), sh('2026-09-25 22:00:00')],
    ['超过一天', sh('2026-09-25 22:00:00'), sh('2026-09-25 23:00:00')],
    ['零时长最后一条', sh('2026-09-25 23:00:00'), sh('2026-09-26 00:00:00')],
  ])
})

await checkAsync('当天没发：data 为空数组返回空数组', async () => {
  assert.deepEqual(await hkstvEpg.programmes('default', '20261201', { fetchImpl: async () => jsonResponse(EMPTY_DAY) }), [])
})

await checkAsync('错误路径：HTTP 错误、跳转、接口报错、日期被顺延、非 JSON、格式不符、超大响应、断网、超时、参数非法都抛', async () => {
  const run = (fetchImpl, opts = {}) => hkstvEpg.programmes('default', '20260925', { fetchImpl, ...opts })
  await assert.rejects(run(async () => jsonResponse(BAD_DATE, { status: 400 })), /HTTP 400/)
  await assert.rejects(run(async () => new Response(null, { status: 302, headers: { location: 'https://example.com/' } })), /HTTP 302/)
  await assert.rejects(run(async () => jsonResponse(BAD_DATE)), /接口报错：缺少有效的日期/)
  // 后端把日期顺延成了别的日子（实测 2026-02-31 → 03-03），不能按请求那天的零点去算
  await assert.rejects(run(async () => jsonResponse(HKS_0926)), /日期与请求不符/)
  await assert.rejects(run(async () => new Response('<html>502</html>', { headers: { 'content-type': 'text/html' } })), /不是 JSON/)
  await assert.rejects(run(async () => jsonResponse({ data: { list: [] } })), /格式异常/)
  await assert.rejects(run(async () => jsonResponse([])), /格式异常/)
  // 有数据但一条时间都读不出：接口改格式，不能当成「当天没发」
  await assert.rejects(run(async () => jsonResponse({ data: HKS_0925.data.map(item => ({ ...item, play_time: 1790266260 })) })), /格式异常/)
  await assert.rejects(run(async () => new Response('{}', { headers: { 'content-length': String(10 * 1024 * 1024) } })), /过大/)
  const endless = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(64 * 1024).fill(0x20)) } })
  await assert.rejects(run(async () => new Response(endless)), /过大/)
  await assert.rejects(run(async () => { throw new TypeError('fetch failed') }), /fetch failed/)
  const hang = async (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason))
  })
  await assert.rejects(run(hang, { timeoutMs: 20 }), { name: 'AbortError' })
  await assert.rejects(hkstvEpg.programmes('12', '20260925', { fetchImpl: noRequest }), /参数非法/)
  await assert.rejects(hkstvEpg.programmes('default', '2026-09-25', { fetchImpl: noRequest }), /参数非法/)
})

await checkAsync('节目单 ref 与显示名就是模块实际产出的那一路', async () => {
  const module = getModule('hkstv')
  assert.equal(module.epg, hkstvEpg)
  assert.equal(module.capabilities.epg, true)
  assert.doesNotThrow(() => validateModule(module))
  const { groups } = await module.fetch({})
  const emitted = groups.flatMap(group => group.dataList).map(channel => [channel.deferredRef, channel.name])
  assert.deepEqual(hkstvEpg.channels().map(channel => [channel.ref, channel.name]), emitted)
  assert.deepEqual(emitted, [[CHANNEL.ref, CHANNEL.name]])
  assert.ok(module.claimsRef(hkstvEpg.channels()[0].ref))
})

await checkAsync('两天合并：跨零点那条保留，与次日首条不重叠', async () => {
  const fetchImpl = async url => jsonResponse(new URL(url).searchParams.get('date') === '2026-09-25' ? HKS_0925 : HKS_0926)
  // 2026-09-25 10:00（上海）
  const merged = await providerProgrammes(hkstvEpg, 'default', { now: sh('2026-09-25 10:00:00'), fetchImpl })
  assert.equal(merged.length, 9)
  assert.ok(merged.every((item, i) => i === 0 || merged[i - 1].stop <= item.start))
  assert.equal(xmltvTime(merged[7].stop), '20260926000500 +0800')
  assert.equal(xmltvTime(merged[8].start), '20260926001100 +0800')
})

check('epg.js 只 import 本目录的频道表，可整体拆出', () => {
  const source = readFileSync(new URL('../extractors/hkstv/epg.js', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map(match => match[1])
  assert.deepEqual(imports, ['./channels.js'])
})

console.log(`\n全部通过：${passed} ✅`)
