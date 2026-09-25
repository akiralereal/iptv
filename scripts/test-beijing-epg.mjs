#!/usr/bin/env node
/**
 * 北京广播电视台节目单（央视网接口）回归测试：请求参数、秒级时间戳、停播占位、零点衔接、
 * 错误路径、节目单频道与模块电视频道一一对应。全部离线，夹具按 2026-09-25 实测返回裁剪。
 *
 * 运行： node scripts/test-beijing-epg.mjs
 *       TZ=UTC node scripts/test-beijing-epg.mjs
 */
import assert from 'node:assert/strict'

import beijingEpg, { EPG_API, EPG_CHANNELS, dayStartMs, parseProgrammes } from '../extractors/beijing/epg.js'
import { BEIJING_CHANNELS, buildGroups } from '../extractors/beijing/api.js'
import { getModule, resolverFor, validateModule } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

const shanghai = text => Date.parse(`${text.replace(' ', 'T')}+08:00`)
const reply = (body, init) => new Response(typeof body === 'string' ? body : JSON.stringify(body), {
  headers: { 'content-type': 'application/json;charset=utf-8' },
  ...init,
})
const row = (title, startTime, endTime, showTime) => ({
  title, startTime, endTime, showTime, eventType: '', eventId: '', length: endTime - startTime,
  column_url: '', columnBackvideourl: '', top: '',
})
const day = (key, list, channelName = 'BRTV新闻') => ({
  data: { [key]: { isLive: '', liveSt: 1790317680, channelName, lvUrl: '', vip_flag: 0, list } },
})

// GET ?c=btv9&serviceId=tvcctv&d=20260925（BRTV新闻）：开头几条（含停播占位）与最后两条
const XW_0925 = day('btv9', [
  row('红绿灯', 1790266080, 1790268600, '00:08'),
  row('锐观察', 1790268600, 1790270400, '00:50'),
  row('晚间新闻报道', 1790270400, 1790273100, '01:20'),
  row('频道无节目', 1790273100, 1790286300, '02:05'),
  row('播前乐', 1790286300, 1790287320, '05:45'),
  row('空气质量播报', 1790348520, 1790348880, '23:02'),
  row('军情解码', 1790348880, 1790351940, '23:08'),
])
// 不认识的代号（体育以外、试不出来的卡酷少儿）
const UNKNOWN = { errcode: '1001', msg: 'params error' }
// BRTV体育（btv6）连续多天都是空列表
const EMPTY = day('btv6', [], 'BRTV体育')

const serve = body => async () => reply(body)

console.log('北京广播电视台节目单（央视网）测试')

check('YYYYMMDD 一律按上海日期换成当天零点，非法日期返回 NaN', () => {
  assert.equal(dayStartMs('20260925'), shanghai('2026-09-25 00:00:00'))
  for (const bad of ['2026-09-25', '20260931', '2026092', '']) assert.ok(Number.isNaN(dayStartMs(bad)), bad)
})

await checkAsync('按代号与日期请求一次，时间戳换毫秒、停播占位丢掉、23:59 接到 24:00', async () => {
  const calls = []
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return reply(XW_0925) }
  const items = await beijingEpg.programmes('btv9', '20260925', { fetchImpl })
  assert.equal(calls.length, 1)
  const url = new URL(calls[0].url)
  assert.equal(`${url.origin}${url.pathname}`, EPG_API)
  assert.deepEqual(Object.fromEntries(url.searchParams), { c: 'btv9', serviceId: 'tvcctv', d: '20260925' })
  assert.equal(calls[0].options.redirect, 'manual')
  assert.deepEqual(items.map(item => item.title), ['红绿灯', '锐观察', '晚间新闻报道', '播前乐', '空气质量播报', '军情解码'])
  assert.deepEqual(items[0], { title: '红绿灯', start: shanghai('2026-09-25 00:08:00'), stop: shanghai('2026-09-25 00:50:00') })
  assert.equal(items.at(-1).stop, shanghai('2026-09-26 00:00:00'), '最后一条接到次日零点')
})

await checkAsync('当天列表为空、没有这个代号的数据得空数组；不认识的代号照实报错', async () => {
  assert.deepEqual(await beijingEpg.programmes('btv6', '20260925', { fetchImpl: serve(EMPTY) }), [])
  assert.deepEqual(await beijingEpg.programmes('btv2', '20260925', { fetchImpl: serve({ data: {} }) }), [])
  await assert.rejects(beijingEpg.programmes('btv10', '20260925', { fetchImpl: serve(UNKNOWN) }), /params error/)
})

check('跨零点的只留当天那段；结束盖住下一条的截到下一条开始；同一时刻开始的只留第一条', () => {
  const items = parseProgrammes(day('btv2', [
    row('昨夜剧场', shanghai('2026-09-24 23:30:00') / 1000, shanghai('2026-09-25 00:20:00') / 1000, '23:30'),
    row('早间', shanghai('2026-09-25 06:00:00') / 1000, shanghai('2026-09-25 08:00:00') / 1000, '06:00'),
    row('重复', shanghai('2026-09-25 06:00:00') / 1000, shanghai('2026-09-25 07:00:00') / 1000, '06:00'),
    row('新闻', shanghai('2026-09-25 07:30:00') / 1000, shanghai('2026-09-25 08:00:00') / 1000, '07:30'),
    row('   ', shanghai('2026-09-25 09:00:00') / 1000, shanghai('2026-09-25 10:00:00') / 1000, '09:00'),
  ]), 'btv2', '20260925')
  assert.deepEqual(items.map(item => [item.title, new Date(item.start).toISOString(), new Date(item.stop).toISOString()]), [
    ['昨夜剧场', '2026-09-24T16:00:00.000Z', '2026-09-24T16:20:00.000Z'],
    ['早间', '2026-09-24T22:00:00.000Z', '2026-09-24T23:30:00.000Z'],
    ['新闻', '2026-09-24T23:30:00.000Z', '2026-09-25T00:00:00.000Z'],
  ])
})

await checkAsync('HTTP、非 JSON、结构与时间格式异常一律抛出', async () => {
  const today = fetchImpl => beijingEpg.programmes('btv9', '20260925', { fetchImpl })
  await assert.rejects(today(async () => reply('busy', { status: 503 })), /HTTP 503/)
  await assert.rejects(today(async () => reply('<html></html>')), /不是有效 JSON/)
  await assert.rejects(today(serve('null')), /返回异常/)
  await assert.rejects(today(serve({ data: { btv9: { list: 'x' } } })), /格式异常/)
  await assert.rejects(today(serve(day('btv9', [row('坏时间', 'x', 'y', '00:00')]))), /时间格式异常/)
  await assert.rejects(today(async () => { throw new TypeError('fetch failed') }), /fetch failed/)
})

await checkAsync('超时中止请求，参数非法时不发请求', async () => {
  const hang = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  await assert.rejects(beijingEpg.programmes('btv9', '20260925', { fetchImpl: hang, timeoutMs: 20 }), { name: 'AbortError' })
  const never = async () => { throw new Error('不应请求') }
  for (const [key, date] of [['btv9&c=x', '20260925'], ['', '20260925'], ['cctv1', '20260925'], ['btv123', '20260925'],
    ['btv9', '2026-09-25'], ['btv9', '20260931']]) {
    await assert.rejects(beijingEpg.programmes(key, date, { fetchImpl: never }), /参数非法/)
  }
})

check('节目单频道与模块电视频道对得上，ref 都能路由回本模块；卡酷少儿没有代号不出节目单', () => {
  const module = getModule('beijing')
  assert.equal(module.epg, beijingEpg)
  assert.equal(module.capabilities.epg, true)
  assert.doesNotThrow(() => validateModule(module))
  const emitted = buildGroups({ tvRows: BEIJING_CHANNELS }).flatMap(group => group.dataList)
  const providers = beijingEpg.channels()
  assert.equal(providers.length, EPG_CHANNELS.length)
  for (const channel of providers) {
    const match = emitted.find(item => item.deferredRef === channel.ref)
    assert.ok(match, `${channel.ref} 在模块输出里`)
    assert.equal(channel.name, match.name)
    assert.ok(module.claimsRef(channel.ref))
    assert.equal(resolverFor(channel.ref)?.epg, beijingEpg, 'utils/moduleEpg.js 按 ref 找得到提供者')
  }
  assert.deepEqual(emitted.filter(item => !providers.some(channel => channel.ref === item.deferredRef)).map(item => item.name), ['卡酷少儿'])
})

console.log(`\n全部通过：${passed} ✅`)
