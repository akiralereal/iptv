#!/usr/bin/env node
/**
 * 湖北广电官方节目单回归测试：请求地址与请求头、上海时间解析、跨零点与重叠处理、错误路径、频道 ref 对齐。
 * 全部离线；样本按 2026-09-25 长江云 TV 接口的真实响应裁剪，字段与信封原样保留。
 *
 * 运行： node scripts/test-hbtv-epg.mjs
 *       TZ=UTC node scripts/test-hbtv-epg.mjs
 *       TZ=America/Los_Angeles node scripts/test-hbtv-epg.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import hbtvEpg, { EPG_API, epgUrl, parseProgrammes, shanghaiDayStart, shanghaiTime } from '../extractors/hbtv/epg.js'
import { buildChannels, CHANNELS } from '../extractors/hbtv/channels.js'
import { getModule, validateModule } from '../extractors/registry.js'
import { providerProgrammes, xmltvTime } from '../utils/epgXmltv.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

// 上海时间文本 → 毫秒，测试里用显式 +08:00 写期望值，与运行机器时区无关
const sh = text => Date.parse(`${text.replace(' ', 'T')}+08:00`)

const HBWS = '99180001000000050000000000000204'
const row = (code, name, starttime, endtime) => ({
  channelcode: HBWS, channelname: '湖北卫视HD', code, endtime, name, startime: starttime, starttime,
})
const envelope = data => ({ total: data.length, code: 200, data, message: 'success' })
const jsonResponse = (payload, init) => new Response(JSON.stringify(payload), {
  ...init, headers: { 'content-type': 'text/plain;charset=UTF-8', ...init?.headers },
})

// 湖北卫视 2026-09-25 的真实片段：1 分钟国歌、带秒的新闻联播、跨零点的最后一条
const HBWS_0925 = envelope([
  row('000000006ab4de33f7e13002010cdccf', '深夜剧场:雪豹', '2026-09-25 00:42:00', '2026-09-25 01:27:00'),
  row('000000006ab4de33f7e13002010cdcd6', '大揭秘', '2026-09-25 06:25:00', '2026-09-25 07:00:00'),
  row('000000006ab4de33f7e13002010cdcd7', '中华人民共和国国歌', '2026-09-25 07:00:00', '2026-09-25 07:01:00'),
  row('000000006ab4de33f7e13002010cdcd8', '湖北新闻', '2026-09-25 07:01:00', '2026-09-25 08:00:00'),
  row('000000006ab4de33f7e13002010cdce4', '天气预报', '2026-09-25 18:25:00', '2026-09-25 18:30:00'),
  row('000000006ab4de33f7e13002010cdce5', '湖北新闻', '2026-09-25 18:30:00', '2026-09-25 19:00:04'),
  row('000000006ab4de33f7e13002010cdce6', '转播中央台新闻联播', '2026-09-25 19:00:04', '2026-09-25 19:32:00'),
  row('000000006ab4de33f7e13002010cdce7', '长江剧场:破晓东方', '2026-09-25 19:32:00', '2026-09-25 20:19:00'),
  row('000000006ab4de33f7e13002010cdcee', '深夜剧场:神枪', '2026-09-25 23:30:30', '2026-09-26 00:17:00'),
])
// 同一频道 2026-09-26 开头两条：零点半后才开始，与前一天跨零点那条之间空 25 分钟
const HBWS_0926 = envelope([
  row('000000006ab4593e7ccda82c3d06701d', '深夜剧场:神枪', '2026-09-26 00:42:00', '2026-09-26 01:27:00'),
  row('000000006ab4593e7ccda82c3d06701e', '深夜剧场:神枪', '2026-09-26 01:27:00', '2026-09-26 02:11:00'),
])
// 后天以后、日期格式不对、频道码不认识时的真实响应
const EMPTY_DAY = { total: 0, code: 200, data: [], message: 'success' }
// Authorization 不对时的真实响应
const BAD_AUTH = { code: 403, message: 'check is fail' }

const noRequest = async () => { throw new Error('不应发请求') }

console.log('湖北节目单测试')

check('请求地址与长江云 TV 频道详情页一致：未登录账号段 null + 频道码 + 补零日期', () => {
  const url = new URL(epgUrl(HBWS, '20260925'))
  assert.equal(`${url.origin}${url.pathname}`, EPG_API)
  assert.ok(url.pathname.endsWith('/play/null/show'))
  assert.deepEqual(Object.fromEntries(url.searchParams), { channelCode: HBWS, date: '2026-09-25' })
  assert.equal(new URL(epgUrl(HBWS, '20261001')).searchParams.get('date'), '2026-10-01')
  for (const [key, day] of [['', '20260925'], ['204', '20260925'], [`${HBWS}&x=1`, '20260925'], [null, '20260925'],
    [HBWS, '2026-09-25'], [HBWS, '20260931']]) {
    assert.throws(() => epgUrl(key, day), /参数非法/, `${key} ${day}`)
  }
})

check('上海时间显式按 +08:00 解析（秒可省），与运行机器时区无关', () => {
  assert.equal(shanghaiDayStart('20260925'), Date.parse('2026-09-24T16:00:00Z'))
  assert.equal(shanghaiTime('2026-09-25 19:00:04'), Date.parse('2026-09-25T11:00:04Z'))
  assert.equal(shanghaiTime('2026-09-25 19:00'), Date.parse('2026-09-25T11:00:00Z'))
  assert.equal(xmltvTime(shanghaiTime('2026-09-25 23:30:30')), '20260925233030 +0800')
  for (const bad of ['', null, undefined, '19:00:00', '2026-09-25 24:00:00', '2026-02-30 00:00:00', '2026-09-25T19:00:00']) {
    assert.ok(Number.isNaN(shanghaiTime(bad)), String(bad))
  }
})

await checkAsync('解析：带固定 Authorization 请求、标题去空白、跨零点那条照实保留', async () => {
  const requests = []
  const programmes = await hbtvEpg.programmes(HBWS, '20260925', {
    fetchImpl: async (url, options) => { requests.push({ url, options }); return jsonResponse(HBWS_0925) },
  })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, epgUrl(HBWS, '20260925'))
  assert.equal(requests[0].options.headers.Authorization, 'RCilBnX20oXYuA2wQ0')
  assert.equal(requests[0].options.redirect, 'manual')
  assert.ok(requests[0].options.signal instanceof AbortSignal)
  assert.equal(programmes.length, 9)
  assert.deepEqual(programmes[6], { title: '转播中央台新闻联播', start: sh('2026-09-25 19:00:04'), stop: sh('2026-09-25 19:32:00') })
  assert.deepEqual(programmes[2], { title: '中华人民共和国国歌', start: sh('2026-09-25 07:00:00'), stop: sh('2026-09-25 07:01:00') })
  assert.equal(xmltvTime(programmes.at(-1).stop), '20260926001700 +0800')
  assert.ok(programmes.every(item => item.title === item.title.trim() && item.stop > item.start))
  assert.ok(programmes.every((item, i) => i === 0 || programmes[i - 1].stop <= item.start), '升序且不重叠')
})

check('只收开始时间在所请求那天的；缺 starttime 读 startime；零时长/倒挂/空标题跳过；重叠截断；同一开始只留一条', () => {
  const programmes = parseProgrammes(envelope([
    row('a', '前一天的', '2026-09-24 23:30:00', '2026-09-25 00:15:00'),
    { ...row('b', '只有拼错的字段', '2026-09-25 08:00:00', '2026-09-25 08:30:00'), starttime: undefined },
    row('c', '零时长', '2026-09-25 09:00:00', '2026-09-25 09:00:00'),
    row('d', '倒挂', '2026-09-25 10:00:00', '2026-09-25 09:30:00'),
    row('e', '  ', '2026-09-25 11:00:00', '2026-09-25 11:30:00'),
    row('f', '  比下一条长 ', '2026-09-25 12:00:00', '2026-09-25 13:00:00'),
    row('g', '短的', '2026-09-25 12:30:00', '2026-09-25 12:40:00'),
    row('h', '同一开始更长的', '2026-09-25 12:30:00', '2026-09-25 12:50:00'),
    row('i', '次日的', '2026-09-26 00:42:00', '2026-09-26 01:27:00'),
  ]), '20260925')
  assert.deepEqual(programmes.map(item => [item.title, item.start, item.stop]), [
    ['只有拼错的字段', sh('2026-09-25 08:00:00'), sh('2026-09-25 08:30:00')],
    ['比下一条长', sh('2026-09-25 12:00:00'), sh('2026-09-25 12:30:00')],
    ['同一开始更长的', sh('2026-09-25 12:30:00'), sh('2026-09-25 12:50:00')],
  ])
})

await checkAsync('当天没发：空数组与 data 为 null 返回空数组', async () => {
  assert.deepEqual(await hbtvEpg.programmes(HBWS, '20260928', { fetchImpl: async () => jsonResponse(EMPTY_DAY) }), [])
  assert.deepEqual(parseProgrammes({ code: 200, data: null, message: 'success' }, '20260925'), [])
})

await checkAsync('错误路径：HTTP 错误、跳转、鉴权失败、非 JSON、格式不符、超大响应、断网、超时、参数非法都抛', async () => {
  const run = (fetchImpl, opts = {}) => hbtvEpg.programmes(HBWS, '20260925', { fetchImpl, ...opts })
  await assert.rejects(run(async () => new Response('<html>502 Bad Gateway</html>', { status: 502 })), /HTTP 502/)
  await assert.rejects(run(async () => new Response('{"status":400,"error":"Bad Request"}', { status: 400 })), /HTTP 400/)
  await assert.rejects(run(async () => new Response(null, { status: 302, headers: { location: 'https://waf.example/' } })), /HTTP 302/)
  await assert.rejects(run(async () => jsonResponse(BAD_AUTH)), /403：check is fail/)
  await assert.rejects(run(async () => new Response('<html>访问受限</html>')), /不是 JSON/)
  await assert.rejects(run(async () => jsonResponse({ code: 200, data: { list: [] }, message: 'success' })), /格式异常/)
  await assert.rejects(run(async () => jsonResponse('ok')), /格式异常/)
  // 有数据但一条时间都读不出：接口改格式，不能当成「当天没发」
  await assert.rejects(run(async () => jsonResponse(envelope([{ ...HBWS_0925.data[0], starttime: 1790334000, startime: 1790334000 }]))), /格式异常/)
  await assert.rejects(run(async () => new Response('{}', { headers: { 'content-length': String(10 * 1024 * 1024) } })), /过大/)
  const endless = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(64 * 1024).fill(0x20)) } })
  await assert.rejects(run(async () => new Response(endless)), /过大/)
  await assert.rejects(run(async () => { throw new TypeError('fetch failed') }), /fetch failed/)
  const hang = async (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason))
  })
  await assert.rejects(run(hang, { timeoutMs: 20 }), { name: 'AbortError' })
  await assert.rejects(hbtvEpg.programmes('204', '20260925', { fetchImpl: noRequest }), /参数非法/)
  await assert.rejects(hbtvEpg.programmes(HBWS, '2026-09-25', { fetchImpl: noRequest }), /参数非法/)
})

await checkAsync('两天合并：跨零点那条保留、与次日首条之间的空档照实保留', async () => {
  const fetchImpl = async url => jsonResponse(new URL(url).searchParams.get('date') === '2026-09-25' ? HBWS_0925 : HBWS_0926)
  const merged = await providerProgrammes(hbtvEpg, HBWS, { now: sh('2026-09-25 10:00:00'), fetchImpl })
  assert.equal(merged.length, 11)
  assert.ok(merged.every((item, i) => i === 0 || merged[i - 1].stop <= item.start))
  assert.equal(xmltvTime(merged[8].stop), '20260926001700 +0800')
  assert.equal(xmltvTime(merged[9].start), '20260926004200 +0800')
})

await checkAsync('每个节目单 ref 都是模块实际产出的频道，六套全登记、频道码互不相同', async () => {
  const module = getModule('hbtv')
  assert.equal(module.epg, hbtvEpg)
  assert.equal(module.capabilities.epg, true)
  assert.doesNotThrow(() => validateModule(module))
  const html = CHANNELS.map(channel => `{ id: ${channel.id}, name: "${channel.rawName}", stream: "https://live21-cjy.hbtv.com.cn/new-hbtv/${channel.streamPath}.m3u8?auth_key=${Math.floor(Date.now() / 1000) + 3600}-${'a'.repeat(32)}-0-${'b'.repeat(32)}" }`).join(',')
  const { groups } = await module.fetch({}, { fetchImpl: async () => ({ ok: true, status: 200, text: async () => html }) })
  const emitted = new Map(groups.flatMap(group => group.dataList).map(channel => [channel.deferredRef, channel.name]))
  const provided = hbtvEpg.channels()
  assert.equal(emitted.size, 6)
  assert.deepEqual(provided.map(channel => channel.ref), buildChannels().map(channel => channel.deferredRef))
  assert.ok(provided.every(channel => emitted.get(channel.ref) === channel.name), '节目单 ref 与显示名都要和模块产出一致')
  assert.equal(new Set(provided.map(channel => channel.key)).size, provided.length)
  assert.ok(provided.every(channel => /^\d{32}$/.test(channel.key)))
})

check('epg.js 只 import 本目录的频道表，可整体拆出', () => {
  const source = readFileSync(new URL('../extractors/hbtv/epg.js', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map(match => match[1])
  assert.deepEqual(imports, ['./channels.js'])
  const channels = readFileSync(new URL('../extractors/hbtv/channels.js', import.meta.url), 'utf8')
  assert.equal([...channels.matchAll(/^import /gm)].length, 0)
})

console.log(`\n全部通过：${passed} ✅`)
