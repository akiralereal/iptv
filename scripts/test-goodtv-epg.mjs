#!/usr/bin/env node
/**
 * GOOD TV 官方节目单回归测试：请求形状、整表按上海日切分、台湾时间换算、跨零点、共用下载、
 * 错误路径、频道 ref 对齐。全部离线；样本按 2026-09-25 官方接口的真实响应裁剪，字段原样保留。
 *
 * 运行： node scripts/test-goodtv-epg.mjs
 *       TZ=UTC node scripts/test-goodtv-epg.mjs
 *       TZ=America/Los_Angeles node scripts/test-goodtv-epg.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import goodtvEpg, { EPG_API, SCHEDULE_TTL_MS, fetchSchedule, parseProgrammes, parseTaiwanTime, shanghaiDayRange } from '../extractors/goodtv/epg.js'
import { CHANNELS } from '../extractors/goodtv/channels.js'
import { getModule, validateModule } from '../extractors/registry.js'
import { providerProgrammes, xmltvTime } from '../utils/epgXmltv.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

// 上海（= 台湾）时间文本 → 毫秒，测试里用显式 +08:00 写期望值，与运行机器时区无关
const sh = text => Date.parse(`${text.replace(' ', 'T')}+08:00`)

const row = (programId, programName, episodeId, episodeName, start, end, nodeId) => ({
  programId, programName, episodeId, episodeName, start, end, nodeId,
})
// 综合台（GOODTV1）整表的真实片段：09-24 尾、09-25 头尾、09-26 头，以及 09-26 跨零点的电影
const TV1 = [
  row('T300002', '精選系列生命更新專題', 'T300002_0039', '與人分享盼望', '2026-09-24T22:00:00', '2026-09-24T23:00:00', 3171),
  row('D101009', '與天使有約', 'D101009_0028', '好漢當年勇', '2026-09-24T23:00:00', '2026-09-25T00:00:00', 1553),
  row('F713001', '穿越古今', 'F713001_0022', '使徒行傳至啟示錄－掃羅的翻轉', '2026-09-25T00:00:00', '2026-09-25T00:30:00', 6566),
  row('G209001', '遇見祝福', 'G209001_0017', '人生不NG', '2026-09-25T00:30:00', '2026-09-25T00:35:00', 807),
  row('G004003', '真情部落格', 'G004003_0622', '勇敢站立', '2026-09-25T00:35:00', '2026-09-25T01:30:00', 801),
  row('F005102', '展翅上騰', 'F005102_0383', '堅持直到主成就(下)', '2026-09-25T23:00:00', '2026-09-25T23:30:00', 1685),
  row('L010001', '妳今天好嗎', 'L010001_0021', '為工作瘋狂的日子', '2026-09-25T23:30:00', '2026-09-26T00:00:00', 2419),
  row('G002007', '恩雨之聲', 'G002007_0648', '日本牙醫唔易做', '2026-09-26T00:00:00', '2026-09-26T00:30:00', 2122),
  row('G209002', '遇見祝福', 'G209002_0017', '神是朋友', '2026-09-26T00:30:00', '2026-09-26T00:35:00', 808),
  row('F009102', '生命的贏家(雙語)', 'F009102_0234', '神必再次成就', '2026-09-26T22:00:00', '2026-09-26T22:30:00', 1704),
  row('D301001', '家庭電影院', 'D301001_0404', '天使之心', '2026-09-26T22:30:00', '2026-09-27T00:30:00', 753),
  row('N215001', '國度視野-好消息會客室', 'N215001_0013', '超過半世紀事奉 認真傳道X聖靈工作', '2026-09-27T00:30:00', '2026-09-27T01:00:00', 8039),
]

const jsonResponse = (payload, init) => new Response(JSON.stringify(payload), {
  ...init, headers: { 'content-type': 'application/json; charset=utf-8', ...init?.headers },
})
const noRequest = async () => { throw new Error('不应发请求') }

console.log('GOOD TV 节目单测试')

check('日期与台湾时间显式按 +08:00 换算，与运行机器时区无关', () => {
  assert.deepEqual(shanghaiDayRange('20260925'), { start: Date.parse('2026-09-24T16:00:00Z'), end: Date.parse('2026-09-25T16:00:00Z') })
  assert.equal(parseTaiwanTime('2026-09-25T00:30:00'), Date.parse('2026-09-24T16:30:00Z'))
  for (const bad of ['', null, '2026-09-25T24:00:00', '2026-02-31T00:00:00', '2026-09-25T00:30:00Z', 1790267400000]) {
    assert.equal(parseTaiwanTime(bad), null, String(bad))
  }
  for (const bad of ['2026-09-25', '20260231', '']) assert.throws(() => shanghaiDayRange(bad), /参数非法/)
})

await checkAsync('按官网直播页的方式请求整表：GOODTV<ch>、不带账号凭证、不跟跳转', async () => {
  const requests = []
  const fetchImpl = async (url, options) => { requests.push({ url, options }); return jsonResponse(TV1) }
  await goodtvEpg.programmes('GOODTV1', '20260925', { fetchImpl })
  await goodtvEpg.programmes('GOODTV2', '20260925', { fetchImpl })
  assert.deepEqual(requests.map(r => r.url), [`${EPG_API}GOODTV1`, `${EPG_API}GOODTV2`])
  assert.equal(requests[0].options.headers.authorization, undefined)
  assert.equal(requests[0].options.redirect, 'manual')
  assert.ok(requests[0].options.signal instanceof AbortSignal)
})

await checkAsync('整表按上海日切：只留当天开始的，标题取节目名，结束用官方给的', async () => {
  const programmes = await goodtvEpg.programmes('GOODTV1', '20260925', { fetchImpl: async () => jsonResponse(TV1) })
  assert.deepEqual(programmes.map(item => [item.title, xmltvTime(item.start), xmltvTime(item.stop)]), [
    ['穿越古今', '20260925000000 +0800', '20260925003000 +0800'],
    ['遇見祝福', '20260925003000 +0800', '20260925003500 +0800'],
    ['真情部落格', '20260925003500 +0800', '20260925013000 +0800'],
    ['展翅上騰', '20260925230000 +0800', '20260925233000 +0800'],
    ['妳今天好嗎', '20260925233000 +0800', '20260926000000 +0800'],
  ])
})

check('跨零点的节目归开始那天，结束照官方到次日；次日从它结束处接上', () => {
  const day26 = parseProgrammes(TV1, '20260926')
  assert.deepEqual(day26.at(-1), { title: '家庭電影院', start: sh('2026-09-26 22:30:00'), stop: sh('2026-09-27 00:30:00') })
  assert.deepEqual(parseProgrammes(TV1, '20260927'), [
    { title: '國度視野-好消息會客室', start: sh('2026-09-27 00:30:00'), stop: sh('2026-09-27 01:00:00') },
  ])
})

check('脏数据：结束缺失/不晚于开始补到下一条（整表里的，可在次日），越过下一条的截断，空节目名与坏时间跳过', () => {
  const programmes = parseProgrammes([
    row('A', '結束缺失', 'A_1', '', '2026-09-25T20:00:00', '', 1),
    row('B', '結束早於開始', 'B_1', '', '2026-09-25T21:00:00', '2026-09-25T20:00:00', 1),
    row('C', '越過下一條', 'C_1', '', '2026-09-25T22:00:00', '2026-09-25T23:30:00', 1),
    row('D', '  帶空白  ', 'D_1', '', '2026-09-25T23:00:00', '', 1),
    row('E', '   ', 'E_1', '', '2026-09-25T19:00:00', '2026-09-25T20:00:00', 1),
    row('F', '壞時間', 'F_1', '', '2026-09-25 25:00', '2026-09-25T20:00:00', 1),
    row('G', '次日', 'G_1', '', '2026-09-26T00:10:00', '2026-09-26T01:00:00', 1),
  ], '20260925')
  assert.deepEqual(programmes.map(item => [item.title, item.start, item.stop]), [
    ['結束缺失', sh('2026-09-25 20:00:00'), sh('2026-09-25 21:00:00')],
    ['結束早於開始', sh('2026-09-25 21:00:00'), sh('2026-09-25 22:00:00')],
    ['越過下一條', sh('2026-09-25 22:00:00'), sh('2026-09-25 23:00:00')],
    ['帶空白', sh('2026-09-25 23:00:00'), sh('2026-09-26 00:10:00')],
  ])
  // 当天没有排到的：空数组
  assert.deepEqual(parseProgrammes(TV1, '20261201'), [])
  assert.deepEqual(parseProgrammes([], '20260925'), [])
})

await checkAsync('同一轮各天共用一次下载；换了 fetch、过期或失败后才重新取', async () => {
  let calls = 0
  const fetchImpl = async () => { calls++; return jsonResponse(TV1) }
  const merged = await providerProgrammes(goodtvEpg, 'GOODTV1', { now: sh('2026-09-25 10:00:00'), fetchImpl })
  assert.equal(calls, 1, '今天、明天两次调用只下载一次')
  assert.equal(merged.length, 9)
  assert.ok(merged.every((item, i) => i === 0 || merged[i - 1].stop <= item.start))
  // 过期后重新取
  await fetchSchedule('GOODTV1', { fetchImpl, now: Date.now() + SCHEDULE_TTL_MS + 1 })
  assert.equal(calls, 2)
  // 失败不留在缓存里
  let failing = 0
  const flaky = async () => { failing++; if (failing === 1) throw new TypeError('fetch failed'); return jsonResponse(TV1) }
  await assert.rejects(goodtvEpg.programmes('GOODTV2', '20260925', { fetchImpl: flaky }), /fetch failed/)
  assert.equal((await goodtvEpg.programmes('GOODTV2', '20260925', { fetchImpl: flaky })).length, 5)
  assert.equal(failing, 2)
})

await checkAsync('错误路径：HTTP 错误、跳转、WAF 页、格式不符、全部读不出、超大响应、超时、参数非法都抛', async () => {
  // 每个用例一个新 fetch，避开共用下载的缓存
  const run = (fetchImpl, opts = {}) => goodtvEpg.programmes('GOODTV1', '20260925', { fetchImpl, ...opts })
  await assert.rejects(run(async () => new Response('', { status: 500 })), /HTTP 500/)
  await assert.rejects(run(async () => new Response(null, { status: 302, headers: { location: 'https://www.goodtv.tv/' } })), /HTTP 302/)
  await assert.rejects(run(async () => new Response('<!DOCTYPE html><title></title>', { status: 200 })), /不是 JSON/)
  await assert.rejects(run(async () => jsonResponse({ data: TV1 })), /格式异常/)
  // 有数据但一条时间都读不出：接口改格式，不能当成「当天没排」
  await assert.rejects(run(async () => jsonResponse(TV1.map(item => ({ ...item, start: Date.parse(`${item.start}+08:00`) })))), /格式异常/)
  await assert.rejects(run(async () => new Response('[]', { headers: { 'content-length': String(64 * 1024 * 1024) } })), /过大/)
  const endless = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(256 * 1024).fill(0x20)) } })
  await assert.rejects(run(async () => new Response(endless)), /过大/)
  const hang = async (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason))
  })
  await assert.rejects(run(hang, { timeoutMs: 20 }), { name: 'AbortError' })
  await assert.rejects(goodtvEpg.programmes('GOODTV3', '20260925', { fetchImpl: noRequest }), /参数非法/)
  await assert.rejects(goodtvEpg.programmes('GOODTV1', '2026-09-25', { fetchImpl: noRequest }), /参数非法/)
})

await checkAsync('每个节目单 ref 与显示名都是模块实际产出的频道，两台全登记', async () => {
  const module = getModule('goodtv')
  assert.equal(module.epg, goodtvEpg)
  assert.equal(module.capabilities.epg, true)
  assert.doesNotThrow(() => validateModule(module))
  const { groups } = await module.fetch({})
  const emitted = groups.flatMap(group => group.dataList).map(channel => [channel.deferredRef, channel.name])
  assert.deepEqual(goodtvEpg.channels().map(channel => [channel.ref, channel.name]), emitted)
  // 官网页面 ch 参数、取流路径的频道段、节目单频道名三者一致
  for (const channel of CHANNELS) {
    const ch = new URL(channel.page).searchParams.get('ch')
    assert.equal(channel.stream, `live-ch${ch}`)
    assert.equal(channel.schedule, `GOODTV${ch}`)
  }
})

check('epg.js 只 import 本目录的频道表，可整体拆出', () => {
  const source = readFileSync(new URL('../extractors/goodtv/epg.js', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map(match => match[1])
  assert.deepEqual(imports, ['./channels.js'])
})

console.log(`\n全部通过：${passed} ✅`)
