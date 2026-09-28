#!/usr/bin/env node
/**
 * 云视网官方节目单回归测试：请求形状、占位行剔除、时间前缀、结束时间推算、错误路径、频道 ref 对齐。
 * 全部离线；样本按 2026-09-25 官方 getJmd 接口的真实响应裁剪，字段与信封原样保留。
 *
 * 运行： node scripts/test-yunnan-epg.mjs
 *       TZ=UTC node scripts/test-yunnan-epg.mjs
 *       TZ=America/Los_Angeles node scripts/test-yunnan-epg.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import yunnanEpg, { EPG_API, dayOf, parseSchedule } from '../extractors/yunnan/epg.js'
import { CHANNELS } from '../extractors/yunnan/channels.js'
import { CHANNELS as API_CHANNELS } from '../extractors/yunnan/api.js'
import { getModule, validateModule } from '../extractors/registry.js'
import { providerProgrammes, xmltvTime } from '../utils/epgXmltv.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

// 上海时间文本 → 毫秒，测试里用显式 +08:00 写期望值，与运行机器时区无关
const sh = text => Date.parse(`${text.replace(' ', 'T')}+08:00`)
const jsonResponse = (payload, init) => new Response(JSON.stringify(payload), {
  ...init, headers: { 'content-type': 'application/json', ...init?.headers },
})

const row = (id, name, start, duration, channelId = 236, endtime = null) => ({
  id, name, channel_id: channelId, start, look: '1', duration, endtime,
})
const envelope = (webName, lists, time = 1790271281) => ({
  lists, list: [], streamer: `https://tvlive.yntv.cn/live/${webName}/playlist_dvr_range-`, name: '', time,
})

// 云南卫视 2026-09-25 的真实片段：开头是服务器补的「精彩节目」（id 1、从零点后 1 秒到第一档），
// 名字带「HH:MM 」前缀，最后一档被截在 23:59:59
const WS_0925 = envelope('yunnanweishi', [
  row(1, '00:00 精彩节目', 1790265601, 3179, 236, 1790268780),
  row(742656, '00:53 炫梦剧场', 1790268780, 3900),
  row(742657, '01:58 炫梦剧场', 1790272680, 2820),
  row(742662, '07:00 中华人民共和国国歌', 1790290800, 60),
  row(742663, '07:01 云南新闻联播', 1790290860, 3720),
  row(742673, '18:30 云南新闻联播', 1790332200, 1560),
  row(742674, '18:56 天气预报', 1790333760, 240),
  row(742675, '19:00 转播中央台新闻联播', 1790334000, 2040),
  row(742676, '19:34 炫美剧场', 1790336040, 3000),
  row(742682, '22:50 南亚东南亚天气预报', 1790347800, 3540),
  row(742683, '23:49 炫梦剧场', 1790351340, 659),
])
// 云南卫视 2026-09-26 开头与结尾
const WS_0926 = envelope('yunnanweishi', [
  row(1, '00:00 精彩节目', 1790352001, 3299, 236, 1790355300),
  row(742771, '00:55 炫梦剧场', 1790355300, 3960),
  row(742772, '02:01 炫梦剧场', 1790359260, 2820),
  row(742790, '19:00 转播中央台新闻联播', 1790420400, 2040),
  row(742799, '23:51 炫梦剧场', 1790437860, 539),
])
// 2026-09-18（七天前）的真实响应：只剩最后一条，前面一整段是占位
const WS_0918 = envelope('yunnanweishi', [
  row(1, '00:00 精彩节目', 1789660801, 85739, 236, 1789746540),
  row(741839, '23:49 炫梦剧场', 1789746540, 659),
])
// 还没排的日子（实测 2026-10-02 起）：24 条整点「精彩节目」，channel_id 1、look 空
const placeholderDay = dayStartSeconds => envelope('yunnanweishi', Array.from({ length: 24 }, (_, hour) => ({
  id: 1, name: `${String(hour).padStart(2, '0')}:00 精彩节目`, channel_id: 1,
  start: dayStartSeconds + 1 + hour * 3600, look: '', duration: 3600, endtime: null,
})))
// 不认识的频道名（七彩云端地方台、拼错的标识）的真实响应
const UNKNOWN = { lists: [], list: [], streamer: null, name: null, time: null }
// 加速乐 WAF 拦截页的开头（缺浏览器 UA 或 Referer 时回 403）
const WAF_PAGE = '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8" />\n<style>\nbody{ background:#fff; font-family: microsoft yahei; color:#969696; font-size:14px;}'

const noRequest = async () => { throw new Error('不应发请求') }

console.log('云南节目单测试')

check('日期参数：YYYYMMDD → 官网 da=YYYY-MM-DD，零点显式按 +08:00 算', () => {
  assert.deepEqual(dayOf('20260925'), { da: '2026-09-25', dayStart: sh('2026-09-25 00:00:00') })
  assert.deepEqual(dayOf('20261001'), { da: '2026-10-01', dayStart: Date.parse('2026-09-30T16:00:00Z') })
  for (const bad of ['2026-09-25', '2026092', '20260231', '20261301', '', null, undefined]) {
    assert.throws(() => dayOf(bad), /参数非法/, String(bad))
  }
})

await checkAsync('请求与官网直播页一致：getJmd?name=&da=，带浏览器 UA 与云视网 Referer，不跟跳转', async () => {
  const requests = []
  const fetchImpl = async (url, options) => {
    requests.push({ url, options })
    return jsonResponse(new URL(url).searchParams.get('da') === '2026-09-25' ? WS_0925 : UNKNOWN)
  }
  await yunnanEpg.programmes('yunnanweishi', '20260925', { fetchImpl })
  await yunnanEpg.programmes('yunnanguoji', '20261001', { fetchImpl })
  const [first, second] = requests
  assert.equal(first.url, `${EPG_API}?name=yunnanweishi&da=2026-09-25`)
  assert.equal(second.url, `${EPG_API}?name=yunnanguoji&da=2026-10-01`)
  assert.equal(first.options.method, undefined)
  assert.equal(first.options.redirect, 'manual')
  assert.ok(first.options.signal instanceof AbortSignal)
  // WAF 只放行浏览器 UA + 云视网 Referer，缺一样都是 403
  assert.equal(first.options.headers.Referer, 'https://www.yntv.cn/live.html')
  assert.equal(first.options.headers.Origin, 'https://www.yntv.cn')
  assert.match(first.options.headers['User-Agent'], /^Mozilla\/5\.0 \(.+Chrome\/\d+/)
})

await checkAsync('解析：丢服务器占位、去「HH:MM」前缀、结束 = 开始 + 时长、最后一档补到次日零点', async () => {
  const programmes = await yunnanEpg.programmes('yunnanweishi', '20260925', { fetchImpl: async () => jsonResponse(WS_0925) })
  assert.equal(programmes.length, 10)
  assert.deepEqual(programmes[0], { title: '炫梦剧场', start: sh('2026-09-25 00:53:00'), stop: sh('2026-09-25 01:58:00') })
  assert.deepEqual(programmes[2], { title: '中华人民共和国国歌', start: sh('2026-09-25 07:00:00'), stop: sh('2026-09-25 07:01:00') })
  assert.deepEqual(programmes[6], { title: '转播中央台新闻联播', start: sh('2026-09-25 19:00:00'), stop: sh('2026-09-25 19:34:00') })
  assert.equal(xmltvTime(programmes[6].start), '20260925190000 +0800')
  assert.deepEqual(programmes[9], { title: '炫梦剧场', start: sh('2026-09-25 23:49:00'), stop: sh('2026-09-26 00:00:00') })
  assert.ok(programmes.every(item => !/精彩节目|^\d{2}:\d{2}/.test(item.title)))
  assert.ok(programmes.every(item => item.title === item.title.trim() && item.stop > item.start))
  assert.ok(programmes.every((item, i) => i === 0 || programmes[i - 1].stop <= item.start), '升序且不重叠')
})

check('官网 getRq 里多个空格的前缀也去干净', () => {
  const dayStart = sh('2026-09-25 00:00:00')
  assert.deepEqual(parseSchedule(envelope('yunnanweishi', [row(742656, '00:53    炫梦剧场', 1790268780, 3900)]), dayStart),
    [{ title: '炫梦剧场', start: sh('2026-09-25 00:53:00'), stop: sh('2026-09-25 01:58:00') }])
})

await checkAsync('当天没发：整天占位、不认识的频道、只剩占位的边缘日子都不当节目', async () => {
  const run = (payload, day = '20261005') => yunnanEpg.programmes('yunnanweishi', day, { fetchImpl: async () => jsonResponse(payload) })
  assert.deepEqual(await run(placeholderDay(sh('2026-10-05 00:00:00') / 1000)), [])
  assert.deepEqual(await run(UNKNOWN), [])
  // 日期格式不对时官网回的是 start 从 -1 起的整点占位，也按没发处理
  assert.deepEqual(await run(placeholderDay(-1 - 1)), [])
  assert.deepEqual(await run(WS_0918, '20260918'),
    [{ title: '炫梦剧场', start: sh('2026-09-18 23:49:00'), stop: sh('2026-09-19 00:00:00') }])
})

check('脏数据：时长缺失/为 0/为负/超过一天补到下一条或零点，超出下一条的截断，同一开始只留一条，跨日与坏行跳过', () => {
  const dayStart = sh('2026-09-25 00:00:00')
  const at = text => sh(`2026-09-25 ${text}`) / 1000
  const programmes = parseSchedule(envelope('yunnandushi', [
    row(9, '23:00 超过一天', at('23:00:00'), 90000),
    row(8, '22:00 非数字', at('22:00:00'), 'abc'),
    row(7, '21:00 比下一条还长', at('21:00:00'), 7200),
    row(6, '20:00 负数', at('20:00:00'), -60),
    { ...row(5, '19:00 缺时长', at('19:00:00'), 0), duration: undefined },
    row(4, '18:00 ', at('18:00:00'), 600),
    row(3, '17:30 字符串开始', String(at('17:30:00')), 600),
    row(2, '17:00 小数开始', at('17:00:00') + 0.5, 600),
    row(10, '昨天的', at('00:00:00') - 600, 1200),
    row(11, '明天的', at('00:00:00') + 86400, 600),
    row(12, '无前缀的标题', at('16:00:00'), 600),
  ]), dayStart)
  assert.deepEqual(programmes.map(item => [item.title, item.start, item.stop]), [
    ['无前缀的标题', sh('2026-09-25 16:00:00'), sh('2026-09-25 16:10:00')],
    ['字符串开始', sh('2026-09-25 17:30:00'), sh('2026-09-25 17:40:00')],
    ['缺时长', sh('2026-09-25 19:00:00'), sh('2026-09-25 20:00:00')],
    ['负数', sh('2026-09-25 20:00:00'), sh('2026-09-25 21:00:00')],
    ['比下一条还长', sh('2026-09-25 21:00:00'), sh('2026-09-25 22:00:00')],
    ['非数字', sh('2026-09-25 22:00:00'), sh('2026-09-25 23:00:00')],
    ['超过一天', sh('2026-09-25 23:00:00'), sh('2026-09-26 00:00:00')],
  ], '乱序输入也按开始时间排好')
  // 同一开始时间只留一条，优先有时长的
  assert.deepEqual(parseSchedule(envelope('yunnandushi', [
    row(1001, '20:00 零时长', at('20:00:00'), 0),
    row(1002, '20:00 有时长', at('20:00:00'), 600),
    row(1003, '21:00 下一条', at('21:00:00'), 600),
  ]), dayStart).map(item => [item.title, item.stop]), [
    ['有时长', sh('2026-09-25 20:10:00')],
    ['下一条', sh('2026-09-25 21:10:00')],
  ])
})

await checkAsync('错误路径：WAF 403、跳转、非 JSON、格式不符、有节目却一条用不上、超大响应、断网、超时、参数非法都抛', async () => {
  const run = (fetchImpl, opts = {}) => yunnanEpg.programmes('yunnanweishi', '20260925', { fetchImpl, ...opts })
  await assert.rejects(run(async () => new Response(WAF_PAGE, { status: 403, headers: { 'content-type': 'text/html' } })), /HTTP 403/)
  await assert.rejects(run(async () => new Response(null, { status: 302, headers: { location: 'https://www.yntv.cn/' } })), /HTTP 302/)
  await assert.rejects(run(async () => new Response(WAF_PAGE, { headers: { 'content-type': 'text/html' } })), /不是 JSON/)
  await assert.rejects(run(async () => jsonResponse({ code: 0, data: [] })), /格式异常/)
  await assert.rejects(run(async () => jsonResponse({ lists: {} })), /格式异常/)
  await assert.rejects(run(async () => jsonResponse(null)), /格式异常/)
  // 有真节目却全落在别的日子：接口没按 da 返回，不能当成「当天没发」
  await assert.rejects(run(async () => jsonResponse(WS_0926)), /格式异常/)
  await assert.rejects(run(async () => new Response('{}', { headers: { 'content-length': String(10 * 1024 * 1024) } })), /过大/)
  const endless = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(64 * 1024).fill(0x20)) } })
  await assert.rejects(run(async () => new Response(endless)), /过大/)
  await assert.rejects(run(async () => { throw new TypeError('fetch failed') }), /fetch failed/)
  const hang = async (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason))
  })
  await assert.rejects(run(hang, { timeoutMs: 20 }), { name: 'AbortError' })
  for (const key of ['', 'YunnanWeishi', 'yunnan weishi', 'yunnanweishi&da=2026-09-26', '临沧综合', null]) {
    await assert.rejects(yunnanEpg.programmes(key, '20260925', { fetchImpl: noRequest }), /参数非法/, String(key))
  }
  await assert.rejects(yunnanEpg.programmes('yunnanweishi', '2026-09-25', { fetchImpl: noRequest }), /参数非法/)
})

await checkAsync('每个节目单 ref 都是模块实际产出的频道；七彩云端三台没有节目单不登记', async () => {
  const module = getModule('yunnan')
  assert.equal(module.epg, yunnanEpg)
  assert.equal(module.capabilities.epg, true)
  assert.doesNotThrow(() => validateModule(module))
  const { groups } = await module.fetch({}, { fetchImpl: noRequest })
  const emitted = new Map(groups.flatMap(group => group.dataList).map(channel => [channel.deferredRef, channel.name]))
  const provided = yunnanEpg.channels()
  assert.equal(emitted.size, 7)
  assert.deepEqual(provided, [
    { ref: 'yunnan-satellite', name: '云南卫视', key: 'yunnanweishi' },
    { ref: 'yunnan-urban', name: '云南都市', key: 'yunnandushi' },
    { ref: 'yunnan-travel', name: '云南康旅', key: 'yunnangonggong' },
    { ref: 'yunnan-lancang', name: '澜湄国际', key: 'yunnanguoji' },
  ])
  assert.ok(provided.every(channel => emitted.get(channel.ref) === channel.name), '节目单 ref 与显示名都要和模块产出一致')
  assert.deepEqual([...emitted.keys()].filter(ref => !provided.some(channel => channel.ref === ref)),
    ['yunnan-lincang', 'yunnan-nujiang', 'yunnan-zhaotong'])
  // 取流与节目单用的是同一张表
  assert.equal(API_CHANNELS, CHANNELS)
})

await checkAsync('两天合并：前一天最后一档到零点，次日从第一档真节目接上，不重叠', async () => {
  const fetchImpl = async url => jsonResponse(new URL(url).searchParams.get('da') === '2026-09-25' ? WS_0925 : WS_0926)
  const merged = await providerProgrammes(yunnanEpg, 'yunnanweishi', { now: sh('2026-09-25 10:00:00'), fetchImpl })
  assert.equal(merged.length, 14)
  assert.ok(merged.every((item, i) => i === 0 || merged[i - 1].stop <= item.start))
  assert.equal(xmltvTime(merged[9].stop), '20260926000000 +0800')
  assert.equal(xmltvTime(merged[10].start), '20260926005500 +0800')
  assert.equal(xmltvTime(merged.at(-1).stop), '20260927000000 +0800')
})

check('epg.js 只 import 本目录的频道表，可整体拆出', () => {
  const source = readFileSync(new URL('../extractors/yunnan/epg.js', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map(match => match[1])
  assert.deepEqual(imports, ['./channels.js'])
  const table = readFileSync(new URL('../extractors/yunnan/channels.js', import.meta.url), 'utf8')
  assert.doesNotMatch(table, /^import /m)
})

console.log(`\n全部通过：${passed} ✅`)
