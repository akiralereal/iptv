#!/usr/bin/env node
/**
 * 广西网络台官方节目单回归测试：表单形状、上海时间解析、结束时间推算、错误路径、频道 ref 对齐。
 * 全部离线；样本按 2026-09-25 官方接口的真实响应裁剪，字段与信封原样保留。
 *
 * 运行： node scripts/test-gxtv-epg.mjs
 *       TZ=UTC node scripts/test-gxtv-epg.mjs
 *       TZ=America/Los_Angeles node scripts/test-gxtv-epg.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import gxtvEpg, { EPG_API, dateStrOf, parseProgrammes, parseShanghaiTime } from '../extractors/gxtv/epg.js'
import { CHANNELS } from '../extractors/gxtv/channels.js'
import { getModule, validateModule } from '../extractors/registry.js'
import { providerProgrammes, xmltvTime } from '../utils/epgXmltv.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

// 上海时间文本 → 毫秒，测试里用显式 +08:00 写期望值，与运行机器时区无关
const sh = text => Date.parse(`${text.replace(' ', 'T')}+08:00`)

const row = (channelName, id, programTime, programmeLength, programName) => ({
  programmeLength, copyright: true, programName, deptId: '0a509685ba1a11e884e55cf3fc49331c', channelName, id, programTime,
})
const envelope = data => ({ code: 0, message: '查询成功', data, successful: true })
const jsonResponse = (payload, init) => new Response(JSON.stringify(payload), {
  ...init, headers: { 'content-type': 'application/json', ...init?.headers },
})

// 广西卫视 2026-09-25 的真实片段：名字尾部带空格、20:15 时长为 0、最后一条跨零点 10 分钟
const GXWS_0925 = envelope([
  row('广西卫视', 704614, '2026-09-25 06:20:00', 600, '首播：一周新闻综述'),
  row('广西卫视', 704615, '2026-09-25 06:30:00', 1440, '重播：新闻·观见'),
  row('广西卫视', 704616, '2026-09-25 07:00:00', 60, '中华人民共和国国歌  '),
  row('广西卫视', 704617, '2026-09-25 07:03:00', 1440, '重播：广西新闻'),
  row('广西卫视', 704632, '2026-09-25 18:57:00', 180, '广西天气预报'),
  row('广西卫视', 704633, '2026-09-25 19:00:00', 1800, '转播：新闻联播'),
  row('广西卫视', 704634, '2026-09-25 19:35:00', 2400, '美丽剧场49集：大决战(13)'),
  row('广西卫视', 704635, '2026-09-25 20:15:00', 0, '广西海洋天气预报 '),
  row('广西卫视', 704636, '2026-09-25 20:50:00', 2280, '美丽剧场49集：大决战(14)'),
  row('广西卫视', 704639, '2026-09-25 23:30:00', 2400, '传奇剧场30集：中国骑兵(14)'),
])
// 广西卫视 2026-09-26 开头两条（次日零点半才开始，接得上前一天跨零点的那条）
const GXWS_0926 = envelope([
  row('广西卫视', 704640, '2026-09-26 00:30:00', 2400, '传奇剧场30集：中国骑兵(15)'),
  row('广西卫视', 704641, '2026-09-26 01:10:00', 2400, '传奇剧场30集：中国骑兵(16)'),
])
// 综艺旅游频道 2026-09-25 的真实片段：时长为 0 的剧场，含当天最后一条
const ZYLY_0925 = envelope([
  row('综艺旅游频道', 702186, '2026-09-25 10:40:00', 3300, '法治最前线(9月24日)'),
  row('综艺旅游频道', 702187, '2026-09-25 11:40:00', 0, '下午剧场:34集电视剧:特种兵之深入敌后（27-33）'),
  row('综艺旅游频道', 702188, '2026-09-25 18:00:00', 3000, '法治最前线(9月25日)'),
  row('综艺旅游频道', 702191, '2026-09-25 21:45:00', 0, '霞客广西(9月25日)'),
  row('综艺旅游频道', 702192, '2026-09-25 22:05:00', 0, '经典剧场:40集电视剧:神勇武工队传奇(9-11)'),
])
// 移动数字电视频道（官网 showProgramme=0）当天的真实响应
const EMPTY_DAY = { code: 0, message: '查询成功', data: [], successful: true }
const NO_DATA = { code: 0, message: '暂无数据', data: null, successful: true }
const BAD_DATE = { code: 1000, message: '日期格式不正确', data: null, successful: false }

// 频道接口 rows 的真实片段（字段裁剪到模块用得到的），含同名的第二条「国际频道」
const stream = path => `https://hlscdn.liangtv.cn/live/${path}.m3u8`
const CHANNEL_ROWS = [
  { name: '新闻在线网络直播专用', id: '43965b3b7fd64a5fb1e688c5dd2a6266', state: 1, showChannel: 1, showProgramme: 1, source: 0, encodeM3u8: '', decodeM3u8: 'https://mobilelive.gxtv.cn/live/gx_live1007/playlist.m3u8' },
  { name: '广西卫视', id: 'e7a7ab7df9fe11e88bcfe41f13b60c62', state: 1, showChannel: 1, showProgramme: 1, source: 2, encodeM3u8: stream('0c4ef3a44b934cacb8b47121dfada66c/d7e04258157b480dae53883cc6f8123b'), decodeM3u8: '' },
  { name: '综艺旅游频道', id: 'f3335975f9fe11e88bcfe41f13b60c62', state: 1, showChannel: 1, showProgramme: 1, source: 2, encodeM3u8: stream('de0f97348eb84f62aa6b7d8cf0430770/dd505d87880c478f901f38560ca4d4e6'), decodeM3u8: '' },
  { name: '都市频道', id: 'fdbaf085f9fe11e88bcfe41f13b60c62', state: 1, showChannel: 1, showProgramme: 1, source: 2, encodeM3u8: stream('b8f4e500a4024fd2bf189b46f490359f/b04d249044fb4d0887b88aa9c2cc8f6c'), decodeM3u8: '' },
  { name: '影视频道', id: '5e923d82058e11e9ba67e41f13b60c62', state: 1, showChannel: 1, showProgramme: 1, source: 2, encodeM3u8: stream('a84182dabc5147afbd3d90ddbb5a9404/d097f6c24c53463e897de496b32c7d2b'), decodeM3u8: '' },
  { name: '新闻频道', id: '9dfd8600075811e9ba67e41f13b60c62', state: 1, showChannel: 1, showProgramme: 1, source: 2, encodeM3u8: stream('a48635e37ac84afa82c0d0edc4bfabf9/dbc9a18971294257bad7c75b7f3f0c20'), decodeM3u8: '' },
  { name: '国际频道', id: 'bfa17b64157f11e999f0e41f13b60c62', state: 1, showChannel: 1, showProgramme: 1, source: 2, encodeM3u8: stream('0234c48e0bc24fe1b41b9999a253e581/1075ee38e04f490690f6a36a16e09c79'), decodeM3u8: '' },
  { name: '乐思购频道', id: 'ed58bc4a207811e999f0e41f13b60c62', state: 1, showChannel: 1, showProgramme: 1, source: 2, encodeM3u8: stream('2cb851292fd14014a6558343872899e6/0820054f3fcc4ee5b4d17198bd7eddd6'), decodeM3u8: '' },
  { name: '移动数字电视频道', id: '78dbfd44e6b74ab687204d2d8113cbf5', state: 1, showChannel: 1, showProgramme: 0, source: 2, encodeM3u8: stream('b6cea70bfad24970aaa2256a3c340ad4/0a79a8e5f94641e583d1872ef7bed2bf'), decodeM3u8: '' },
  { name: '国际频道', id: '1c20578d966b4afbaf85c012fb6cab70', state: 1, showChannel: 1, showProgramme: 0, source: 2, encodeM3u8: stream('0234c48e0bc24fe1b41b9999a253e581/1075ee38e04f490690f6a36a16e09c79'), decodeM3u8: '' },
]

const noRequest = async () => { throw new Error('不应发请求') }

console.log('广西节目单测试')

check('dateStr 与播放页一致：月、日不补零', () => {
  assert.equal(dateStrOf('20260925'), '2026-9-25')
  assert.equal(dateStrOf('20261001'), '2026-10-1')
  assert.equal(dateStrOf('20261231'), '2026-12-31')
  assert.throws(() => dateStrOf('2026-09-25'), /参数非法/)
  assert.throws(() => dateStrOf('2026092'), /参数非法/)
})

check('programTime 显式按 +08:00 解析，与运行机器时区无关', () => {
  assert.equal(parseShanghaiTime('2026-09-25 19:00:00'), Date.parse('2026-09-25T11:00:00Z'))
  assert.equal(parseShanghaiTime('2026-09-26 00:30:00'), Date.parse('2026-09-25T16:30:00Z'))
  assert.equal(parseShanghaiTime('2026-09-25 19:00'), Date.parse('2026-09-25T11:00:00Z'))
  assert.equal(xmltvTime(parseShanghaiTime('2026-09-25 19:00:00')), '20260925190000 +0800')
  for (const bad of ['', null, undefined, '19:00:00', '2026/09/25 19:00:00', '2026-09-25 24:00:00',
    '2026-02-31 00:00:00', '2026-09-25 19:60:00', 1790334000000]) {
    assert.equal(parseShanghaiTime(bad), null, String(bad))
  }
})

await checkAsync('按官网播放页的表单 POST：频道 uuid + 官网频道名 + 不补零日期', async () => {
  const requests = []
  const fetchImpl = async (url, options) => {
    requests.push({ url, options })
    return jsonResponse(GXWS_0925)
  }
  await gxtvEpg.programmes('广西卫视', '20260925', { fetchImpl })
  await gxtvEpg.programmes('广西卫视', '20261001', { fetchImpl })
  const [first, second] = requests
  assert.equal(first.url, EPG_API)
  assert.equal(first.options.method, 'POST')
  assert.equal(first.options.headers['Content-Type'], 'application/x-www-form-urlencoded')
  assert.equal(first.options.redirect, 'manual')
  assert.ok(first.options.signal instanceof AbortSignal)
  assert.deepEqual(Object.fromEntries(new URLSearchParams(first.options.body)), {
    channelId: 'e7a7ab7df9fe11e88bcfe41f13b60c62',
    channelName: '广西卫视',
    dateStr: '2026-9-25',
  })
  assert.equal(new URLSearchParams(second.options.body).get('dateStr'), '2026-10-1')
  // 表外的频道名：后端只认 channelName，不带 uuid 也能查
  await gxtvEpg.programmes('乐思购频道', '20260925', { fetchImpl })
  assert.deepEqual(Object.fromEntries(new URLSearchParams(requests[2].options.body)), {
    channelName: '乐思购频道', dateStr: '2026-9-25',
  })
})

await checkAsync('解析：标题去空白、结束 = 开始 + 时长、时长 0 补到下一条、跨零点照实保留', async () => {
  const programmes = await gxtvEpg.programmes('广西卫视', '20260925', { fetchImpl: async () => jsonResponse(GXWS_0925) })
  assert.equal(programmes.length, 10)
  assert.deepEqual(programmes[2], { title: '中华人民共和国国歌', start: sh('2026-09-25 07:00:00'), stop: sh('2026-09-25 07:01:00') })
  assert.deepEqual(programmes[5], { title: '转播：新闻联播', start: sh('2026-09-25 19:00:00'), stop: sh('2026-09-25 19:30:00') })
  // 节目间的广告时间不计入时长，空档照实保留：19:35 + 40 分钟 = 20:15
  assert.equal(programmes[6].stop, sh('2026-09-25 20:15:00'))
  assert.deepEqual(programmes[7], { title: '广西海洋天气预报', start: sh('2026-09-25 20:15:00'), stop: sh('2026-09-25 20:50:00') })
  assert.deepEqual(programmes[9], { title: '传奇剧场30集：中国骑兵(14)', start: sh('2026-09-25 23:30:00'), stop: sh('2026-09-26 00:10:00') })
  assert.ok(programmes.every(item => item.title === item.title.trim() && item.stop > item.start))
  assert.ok(programmes.every((item, i) => i === 0 || programmes[i - 1].start < item.start), '按开始时间升序')
})

check('时长为 0 的最后一条补到次日零点（上海）', () => {
  const programmes = parseProgrammes(ZYLY_0925)
  assert.deepEqual(programmes.map(item => [item.title.slice(0, 4), item.stop]), [
    ['法治最前', sh('2026-09-25 11:35:00')],
    ['下午剧场', sh('2026-09-25 18:00:00')],
    ['法治最前', sh('2026-09-25 18:50:00')],
    ['霞客广西', sh('2026-09-25 22:05:00')],
    ['经典剧场', sh('2026-09-26 00:00:00')],
  ])
})

check('脏时长：负数/非数字/缺失/超过一天按 0 处理，超出下一条开始的截断，坏时间与空标题跳过，同一开始只留一条', () => {
  const C = '都市频道'
  const programmes = parseProgrammes(envelope([
    row(C, 6, '2026-09-25 23:00:00', 90000, '超过一天'),
    row(C, 5, '2026-09-25 22:00:00', 'abc', '非数字'),
    row(C, 4, '2026-09-25 21:00:00', 7200, '比下一条还长'),
    row(C, 3, '2026-09-25 20:00:00', -60, '负数'),
    { ...row(C, 2, '2026-09-25 19:00:00', 600, '缺时长'), programmeLength: undefined },
    row(C, 1, '2026-09-25 18:00:00', 600, '   '),
    row(C, 7, '2026-09-25 25:00:00', 600, '坏时间'),
    row(C, 8, null, 600, '没时间'),
    row(C, 9, '2026-09-25 17:00:00', 600, '正常'),
  ]))
  assert.deepEqual(programmes.map(item => [item.title, item.start, item.stop]), [
    ['正常', sh('2026-09-25 17:00:00'), sh('2026-09-25 17:10:00')],
    ['缺时长', sh('2026-09-25 19:00:00'), sh('2026-09-25 20:00:00')],
    ['负数', sh('2026-09-25 20:00:00'), sh('2026-09-25 21:00:00')],
    ['比下一条还长', sh('2026-09-25 21:00:00'), sh('2026-09-25 22:00:00')],
    ['非数字', sh('2026-09-25 22:00:00'), sh('2026-09-25 23:00:00')],
    ['超过一天', sh('2026-09-25 23:00:00'), sh('2026-09-26 00:00:00')],
  ], '乱序输入也按开始时间排好')
  // 同一开始时间只留一条，优先有时长的
  assert.deepEqual(parseProgrammes(envelope([
    row(C, 1, '2026-09-25 20:00:00', 0, '零时长'),
    row(C, 2, '2026-09-25 20:00:00', 600, '有时长'),
    row(C, 3, '2026-09-25 21:00:00', 600, '下一条'),
  ])).map(item => [item.title, item.stop]), [
    ['有时长', sh('2026-09-25 20:10:00')],
    ['下一条', sh('2026-09-25 21:10:00')],
  ])
})

await checkAsync('当天没发：data 为空数组或 null 返回空数组', async () => {
  assert.deepEqual(await gxtvEpg.programmes('移动数字电视频道', '20260925', { fetchImpl: async () => jsonResponse(EMPTY_DAY) }), [])
  assert.deepEqual(await gxtvEpg.programmes('广西卫视', '20261231', { fetchImpl: async () => jsonResponse(NO_DATA) }), [])
})

await checkAsync('错误路径：HTTP 错误、跳转、业务错误码、非 JSON、格式不符、超大响应、断网、超时、参数非法都抛', async () => {
  const run = (fetchImpl, opts = {}) => gxtvEpg.programmes('广西卫视', '20260925', { fetchImpl, ...opts })
  await assert.rejects(run(async () => new Response('', { status: 503 })), /HTTP 503/)
  await assert.rejects(run(async () => new Response(null, { status: 302, headers: { location: 'https://waf.example/' } })), /HTTP 302/)
  await assert.rejects(run(async () => jsonResponse(BAD_DATE)), /1000：日期格式不正确/)
  await assert.rejects(run(async () => new Response('<html>访问受限</html>', { headers: { 'content-type': 'text/html' } })), /不是 JSON/)
  await assert.rejects(run(async () => jsonResponse({ code: 0, message: '查询成功', data: { rows: [] }, successful: true })), /格式异常/)
  await assert.rejects(run(async () => jsonResponse('ok')), /格式异常/)
  // 有数据但一条时间都读不出：接口改格式，不能当成「当天没发」
  await assert.rejects(run(async () => jsonResponse(envelope([{ ...GXWS_0925.data[0], programTime: 1790330400000 }]))), /格式异常/)
  await assert.rejects(run(async () => new Response('{}', { headers: { 'content-length': String(10 * 1024 * 1024) } })), /过大/)
  const endless = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(64 * 1024).fill(0x20)) } })
  await assert.rejects(run(async () => new Response(endless)), /过大/)
  await assert.rejects(run(async () => { throw new TypeError('fetch failed') }), /fetch failed/)
  const hang = async (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason))
  })
  await assert.rejects(run(hang, { timeoutMs: 20 }), { name: 'AbortError' })
  await assert.rejects(gxtvEpg.programmes('', '20260925', { fetchImpl: noRequest }), /参数非法/)
  await assert.rejects(gxtvEpg.programmes('广西卫视\n', '20260925', { fetchImpl: noRequest }), /参数非法/)
  await assert.rejects(gxtvEpg.programmes('广西卫视', '2026-09-25', { fetchImpl: noRequest }), /参数非法/)
})

await checkAsync('每个节目单 ref 都是模块实际产出的频道；没节目单的移动频道不登记', async () => {
  const module = getModule('gxtv')
  assert.equal(module.epg, gxtvEpg)
  assert.equal(module.capabilities.epg, true)
  assert.doesNotThrow(() => validateModule(module))
  const { groups } = await module.fetch({}, {
    fetchImpl: async () => jsonResponse({ code: 0, message: '查询成功', data: { total: CHANNEL_ROWS.length, rows: CHANNEL_ROWS }, successful: true }),
  })
  const emitted = new Map(groups.flatMap(group => group.dataList).map(channel => [channel.deferredRef, channel.name]))
  const provided = gxtvEpg.channels()
  assert.equal(emitted.size, 7)
  assert.ok(provided.every(channel => emitted.get(channel.ref) === channel.name), '节目单 ref 与显示名都要和模块产出一致')
  assert.deepEqual([...emitted.keys()].filter(ref => !provided.some(channel => channel.ref === ref)), ['gxtv-yd'])
  assert.equal(new Set(provided.map(channel => channel.key)).size, provided.length)
  // 表里的 uuid 与频道接口里同名、出节目单（showProgramme=1）的那一行一致
  for (const channel of CHANNELS) {
    const officialRow = CHANNEL_ROWS.find(r => r.name === channel.rawName && (channel.epg === false || r.showProgramme === 1))
    assert.equal(channel.id, officialRow?.id, channel.rawName)
    assert.equal(channel.epg === false, officialRow.showProgramme === 0, `${channel.rawName} 的 epg 标记应与官网 showProgramme 一致`)
  }
})

await checkAsync('两天合并：跨零点那条保留，与次日首条不重叠', async () => {
  const fetchImpl = async (url, options) => {
    const dateStr = new URLSearchParams(options.body).get('dateStr')
    return jsonResponse(dateStr === '2026-9-25' ? GXWS_0925 : GXWS_0926)
  }
  // 2026-09-25 10:00（上海）
  const merged = await providerProgrammes(gxtvEpg, '广西卫视', { now: sh('2026-09-25 10:00:00'), fetchImpl })
  assert.equal(merged.length, 12)
  assert.ok(merged.every((item, i) => i === 0 || merged[i - 1].stop <= item.start))
  assert.equal(xmltvTime(merged[9].stop), '20260926001000 +0800')
  assert.equal(xmltvTime(merged[10].start), '20260926003000 +0800')
})

check('epg.js 只 import 本目录的频道表，可整体拆出', () => {
  const source = readFileSync(new URL('../extractors/gxtv/epg.js', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map(match => match[1])
  assert.deepEqual(imports, ['./channels.js'])
})

console.log(`\n全部通过：${passed} ✅`)
