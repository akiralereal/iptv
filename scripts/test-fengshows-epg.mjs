#!/usr/bin/env node
/**
 * 凤凰卫视官方节目单回归测试：请求形状、UTC 时间换算、结束时间推算、错误路径、频道 ref 对齐。
 * 全部离线；样本按 2026-09-25 官方接口的真实响应裁剪，字段原样保留。
 *
 * 运行： node scripts/test-fengshows-epg.mjs
 *       TZ=UTC node scripts/test-fengshows-epg.mjs
 *       TZ=America/Los_Angeles node scripts/test-fengshows-epg.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import fengshowsEpg, { EPG_API, parseProgrammes, scheduleUrl, shanghaiDayRange } from '../extractors/fengshows/epg.js'
import { CHANNELS } from '../extractors/fengshows/channels.js'
import { getModule, validateModule } from '../extractors/registry.js'
import { providerProgrammes, xmltvTime } from '../utils/epgXmltv.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

// 上海（= 香港）时间文本 → 毫秒，测试里用显式 +08:00 写期望值，与运行机器时区无关
const sh = text => Date.parse(`${text.replace(' ', 'T')}+08:00`)

const INFO = '7c96b084-60e1-40a9-89c5-682b994fb680'
const CHINESE = 'f7f48462-9b13-485b-8101-7b54716411ec'
// 官方接口的一条节目，字段集合与真实响应一致
const row = (liveId, _id, eventTime, date, title, extra = {}) => ({
  _id, title, brief: '', available: 1, created_time: '2026-09-18T06:50:54.667Z', modified_time: '2026-09-18T06:50:54.667Z',
  labels: [], __last_actived_time: '2026-09-18T06:50:54.667Z', marks: [], cover_list: [], authorized_countries: [],
  config_score: 0, flags: [], duanmu_enabled: 0, comment_enabled: 1, send_subscription: 0, translations: [],
  translation_languages: [], target_platforms: [], tags: [], live_id: liveId, type: 'schedule', content: '',
  event_time: eventTime, date, image_url: '', is_replayable: true, target_countries_and_regions: [],
  default_countries_and_regions: [], __v: 0, ...extra,
})

// 资讯台 2026-09-25 的真实片段：event_time 是 UTC，香港 00:00 = 前一天 16:00Z
const INFO_0925 = [
  row(INFO, '4b7e61b1-b32d-11f1-adcf-19dcd550ea86', '2026-09-24T16:00:00.000Z', 20260925, '鳳凰洲際快車'),
  row(INFO, '4b7e61b3-b32d-11f1-adcf-19dcd550ea86', '2026-09-24T16:57:00.000Z', 20260925, '鳳凰氣象站'),
  row(INFO, '4b7e61b5-b32d-11f1-adcf-19dcd550ea86', '2026-09-24T17:00:00.000Z', 20260925, '鳳凰正點播報 0100'),
  row(INFO, '4b7e6217-b32d-11f1-adcf-19dcd550ea86', '2026-09-25T11:00:00.000Z', 20260925, '賽輪輪胎 華聞大直播'),
  row(INFO, '4b7e6219-b32d-11f1-adcf-19dcd550ea86', '2026-09-25T11:57:00.000Z', 20260925, '鳳凰氣象站'),
  row(INFO, '4b7e622d-b32d-11f1-adcf-19dcd550ea86', '2026-09-25T15:30:00.000Z', 20260925, '總編輯時間'),
]
// 资讯台 2026-09-26 开头两条：次日同样从零点排起
const INFO_0926 = [
  row(INFO, '4c612091-b32d-11f1-90cc-21b7b06173e8', '2026-09-25T16:00:00.000Z', 20260926, '鳳凰洲際快車'),
  row(INFO, '4c612093-b32d-11f1-90cc-21b7b06173e8', '2026-09-25T16:57:00.000Z', 20260926, '鳳凰氣象站'),
]
// 中文台 2026-09-25 的真实片段，含冠名商前缀的官方标题
const CHINESE_0925 = [
  row(CHINESE, 'd23aeaa9-b32e-11f1-a577-9926b70dd08c', '2026-09-25T10:00:00.000Z', 20260925, '鳳凰焦點新聞 1800'),
  row(CHINESE, 'd23aeaab-b32e-11f1-a577-9926b70dd08c', '2026-09-25T10:27:00.000Z', 20260925, '鳳凰氣象站'),
  row(CHINESE, 'd23aeac1-b32e-11f1-a577-9926b70dd08c', '2026-09-25T15:30:00.000Z', 20260925, '以岭葯業 新聞今日談'),
]
// date 不是数字时接口回的是 mongoose 的 CastError 对象
const CAST_ERROR = { stringValue: '"NaN"', valueType: 'number', kind: 'Number', value: null, path: 'date', name: 'CastError', message: 'Cast to Number failed for value "NaN" (type number) at path "date" for model "Resource"' }

const jsonResponse = (payload, init) => new Response(JSON.stringify(payload), {
  ...init, headers: { 'content-type': 'application/json; charset=utf-8', ...init?.headers },
})
const noRequest = async () => { throw new Error('不应发请求') }

console.log('凤凰卫视节目单测试')

check('上海日期 → 当天零点区间，与运行机器时区无关', () => {
  assert.deepEqual(shanghaiDayRange('20260925'), { start: Date.parse('2026-09-24T16:00:00Z'), end: Date.parse('2026-09-25T16:00:00Z') })
  for (const bad of ['2026-09-25', '2026092', '20260231', '20261301', '', null, undefined]) {
    assert.throws(() => shanghaiDayRange(bad), /参数非法/, String(bad))
  }
})

await checkAsync('按官网直播页的参数请求：同一官方 API 主机、客户端标识、不跟跳转', async () => {
  const requests = []
  await fengshowsEpg.programmes(INFO, '20260925', {
    fetchImpl: async (url, options) => { requests.push({ url, options }); return jsonResponse(INFO_0925) },
  })
  const [{ url, options }] = requests
  assert.equal(url, scheduleUrl(INFO, '20260925'))
  const parsed = new URL(url)
  assert.equal(`${parsed.origin}${parsed.pathname}`, `${EPG_API}${INFO}/resources`)
  assert.deepEqual(Object.fromEntries(parsed.searchParams), { dir: 'asc', date: '20260925', page: '1', page_size: '200' })
  assert.equal(options.headers['fengshows-client'], 'app(fs-web,1000000);')
  assert.equal(options.headers.token, undefined, '节目单不带账号凭证')
  assert.equal(options.redirect, 'manual')
  assert.ok(options.signal instanceof AbortSignal)
})

await checkAsync('解析：UTC 开始时间换成绝对时刻，结束取下一条开始，最后一条到次日零点', async () => {
  const programmes = await fengshowsEpg.programmes(INFO, '20260925', { fetchImpl: async () => jsonResponse(INFO_0925) })
  assert.deepEqual(programmes.map(item => [item.title, xmltvTime(item.start), xmltvTime(item.stop)]), [
    ['鳳凰洲際快車', '20260925000000 +0800', '20260925005700 +0800'],
    ['鳳凰氣象站', '20260925005700 +0800', '20260925010000 +0800'],
    ['鳳凰正點播報 0100', '20260925010000 +0800', '20260925190000 +0800'],
    ['賽輪輪胎 華聞大直播', '20260925190000 +0800', '20260925195700 +0800'],
    ['鳳凰氣象站', '20260925195700 +0800', '20260925233000 +0800'],
    ['總編輯時間', '20260925233000 +0800', '20260926000000 +0800'],
  ])
  const chinese = parseProgrammes(CHINESE_0925, '20260925')
  assert.deepEqual(chinese[0], { title: '鳳凰焦點新聞 1800', start: sh('2026-09-25 18:00:00'), stop: sh('2026-09-25 18:27:00') })
  assert.equal(chinese[2].title, '以岭葯業 新聞今日談', '冠名商前缀是官方标题的一部分，原样保留')
})

check('脏数据：空标题、下架、非节目条目、坏时间、不带时区的时间、他日条目跳过；乱序排好、同一开始只留一条', () => {
  const programmes = parseProgrammes([
    row(INFO, 'a', '2026-09-25T15:30:00.000Z', 20260925, '  總編輯時間  '),
    row(INFO, 'b', '2026-09-25T11:00:00.000Z', 20260925, '賽輪輪胎 華聞大直播'),
    row(INFO, 'c', '2026-09-25T11:00:00.000Z', 20260925, '重复开始'),
    row(INFO, 'd', '2026-09-25T12:00:00.000Z', 20260925, '   '),
    row(INFO, 'e', '2026-09-25T12:30:00.000Z', 20260925, '已下架', { available: 0 }),
    row(INFO, 'f', '2026-09-25T13:00:00.000Z', 20260925, '文章', { type: 'article' }),
    row(INFO, 'g', '2026-09-25 13:30:00', 20260925, '没有时区'),
    row(INFO, 'h', 'yesterday', 20260925, '坏时间'),
    row(INFO, 'i', '2026-09-25T16:00:00.000Z', 20260926, '次日零点'),
    row(INFO, 'j', '2026-09-24T15:59:00.000Z', 20260924, '前一天'),
  ], '20260925')
  assert.deepEqual(programmes.map(item => [item.title, item.start, item.stop]), [
    ['賽輪輪胎 華聞大直播', sh('2026-09-25 19:00:00'), sh('2026-09-25 23:30:00')],
    ['總編輯時間', sh('2026-09-25 23:30:00'), sh('2026-09-26 00:00:00')],
  ])
})

await checkAsync('当天没发 / 不认识的直播 id：空数组返回空数组', async () => {
  assert.deepEqual(await fengshowsEpg.programmes(INFO, '20261002', { fetchImpl: async () => jsonResponse([]) }), [])
})

await checkAsync('错误路径：HTTP 错误、跳转、CastError、非 JSON、全部读不出、超大响应、断网、超时、参数非法都抛', async () => {
  const run = (fetchImpl, opts = {}) => fengshowsEpg.programmes(INFO, '20260925', { fetchImpl, ...opts })
  await assert.rejects(run(async () => new Response('', { status: 503 })), /HTTP 503/)
  await assert.rejects(run(async () => new Response(null, { status: 302, headers: { location: 'https://example.com/' } })), /HTTP 302/)
  await assert.rejects(run(async () => jsonResponse(CAST_ERROR, { status: 200 })), /格式异常/)
  await assert.rejects(run(async () => jsonResponse({ status: '0', data: INFO_0925 })), /格式异常/)
  await assert.rejects(run(async () => new Response('<html>blocked</html>', { headers: { 'content-type': 'text/html' } })), /不是 JSON/)
  // 有数据但一条时间都读不出：接口改格式，不能当成「当天没发」
  await assert.rejects(run(async () => jsonResponse(INFO_0925.map(item => ({ ...item, event_time: 1790352000000 })))), /格式异常/)
  await assert.rejects(run(async () => new Response('[]', { headers: { 'content-length': String(10 * 1024 * 1024) } })), /过大/)
  const endless = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(64 * 1024).fill(0x20)) } })
  await assert.rejects(run(async () => new Response(endless)), /过大/)
  await assert.rejects(run(async () => { throw new TypeError('fetch failed') }), /fetch failed/)
  const hang = async (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason))
  })
  await assert.rejects(run(hang, { timeoutMs: 20 }), { name: 'AbortError' })
  await assert.rejects(fengshowsEpg.programmes('', '20260925', { fetchImpl: noRequest }), /参数非法/)
  await assert.rejects(fengshowsEpg.programmes(`${INFO}/../x`, '20260925', { fetchImpl: noRequest }), /参数非法/)
  await assert.rejects(fengshowsEpg.programmes(INFO, '2026-09-25', { fetchImpl: noRequest }), /参数非法/)
})

await checkAsync('每个节目单 ref 与显示名都是模块实际产出的频道，三台全登记', async () => {
  const module = getModule('fengshows')
  assert.equal(module.epg, fengshowsEpg)
  assert.equal(module.capabilities.epg, true)
  assert.doesNotThrow(() => validateModule(module))
  const { groups } = await module.fetch({})
  const emitted = new Map(groups.flatMap(group => group.dataList).map(channel => [channel.deferredRef, channel.name]))
  const provided = fengshowsEpg.channels()
  assert.equal(provided.length, 3)
  assert.deepEqual(provided.map(channel => [channel.ref, channel.name]), [...emitted])
  assert.ok(provided.every(channel => module.claimsRef(channel.ref)))
  assert.deepEqual(provided.map(channel => channel.key), CHANNELS.map(channel => channel.id))
})

await checkAsync('两天合并：前一天最后一条接到次日首条，不重叠', async () => {
  const fetchImpl = async url => jsonResponse(new URL(url).searchParams.get('date') === '20260925' ? INFO_0925 : INFO_0926)
  // 2026-09-25 10:00（上海）
  const merged = await providerProgrammes(fengshowsEpg, INFO, { now: sh('2026-09-25 10:00:00'), fetchImpl })
  assert.equal(merged.length, 8)
  assert.ok(merged.every((item, i) => i === 0 || merged[i - 1].stop <= item.start))
  assert.equal(xmltvTime(merged[5].stop), '20260926000000 +0800')
  assert.equal(xmltvTime(merged[6].start), '20260926000000 +0800')
})

check('epg.js 只 import 本目录的频道表，可整体拆出', () => {
  const source = readFileSync(new URL('../extractors/fengshows/epg.js', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map(match => match[1])
  assert.deepEqual(imports, ['./channels.js'])
})

console.log(`\n全部通过：${passed} ✅`)
