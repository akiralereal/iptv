#!/usr/bin/env node
/**
 * YTN / NHK World 官方节目单回归测试：UTC+9 当地日与上海日的换算、跨两天拼接、宣传短片合并、
 * YTN 页面解析与日期核对、错误路径、频道 ref 对齐。
 * 全部离线；样本按 2026-09-25 官方接口 / 页面的真实响应裁剪（NHK 只留用得到的字段，YTN 保留原样标记）。
 *
 * 运行： node scripts/test-asian-live-epg.mjs
 *       TZ=UTC node scripts/test-asian-live-epg.mjs
 *       TZ=America/Los_Angeles node scripts/test-asian-live-epg.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import asianEpg, {
  NHK_EPG_BASE,
  YTN_SCHEDULE_PAGE,
  dayWindow,
  nhkProgrammes,
  parseNhkDay,
  parseYtnDay,
  ytnProgrammes,
} from '../extractors/asian-live/epg.js'
import { getModule, validateModule } from '../extractors/registry.js'
import { providerProgrammes, xmltvTime } from '../utils/epgXmltv.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

// 上海时间文本 → 毫秒，测试里用显式 +08:00 写期望值，与运行机器时区无关
const sh = text => Date.parse(`${text.replace(' ', 'T')}+08:00`)
const fmt = items => items.map(item => [item.title, xmltvTime(item.start), xmltvTime(item.stop)])

// ---- NHK World：masterpl.hls.nhkworld.jp/epg/w/<日本日期>.json 的真实条目 ----
const nhk = (seriesId, airingId, title, episodeTitle, start, end, extractProgram, episodeId) => ({
  seriesId, airingId, title, episodeTitle, description: '', link: '', thumbnail: '', firstShow: extractProgram ? 2 : 1,
  startTime: `${start}+09:00`, endTime: `${end}+09:00`, endTimeReal: `${end}+09:00`, jstrm: 1, wstrm: 1, extractProgram,
  episodeId, playURL: `https://masterpl.hls.nhkworld.jp/hls/w/${episodeId}/master.m3u8`, vodFlag: extractProgram ? 0 : 1,
  radioNotice: '', genres: '', subGenres: '',
})
const NHK_0925 = { data: [
  nhk('5036', '013', 'NHK NEWSLINE', '', '2026-09-25T00:00:00', '2026-09-25T00:28:00', 0, '503601320260925001'),
  nhk('5901', '017', 'INFO', 'RAMEN JAPAN #2 PR', '2026-09-25T00:28:00', '2026-09-25T00:29:00', 1, '590101720260925001'),
  nhk('5901', '023', 'INFO', 'Time-lapse Seto naikai Kagawa', '2026-09-25T00:29:00', '2026-09-25T00:30:00', 1, '590102320260925001'),
  nhk('5211', '017', 'The Business Keyhole', 'Hit Products Under the Inflation', '2026-09-25T00:30:00', '2026-09-25T00:53:00', 0, '521101720260925001'),
  nhk('5171', '001', 'JAPAN DELISH 5min.', 'Curry Rice', '2026-09-25T00:53:00', '2026-09-25T00:58:00', 0, '517100120260925001'),
  nhk('5901', '028', 'INFO', "Japan's National Parks 2min. PR #4", '2026-09-25T00:58:00', '2026-09-25T01:00:00', 1, '590102820260925001'),
  nhk('5036', '014', 'NHK NEWSLINE', '', '2026-09-25T01:00:00', '2026-09-25T01:28:00', 0, '503601420260925001'),
  nhk('5901', '032', 'INFO', 'Trails to Oishii Tokyo mini 2min. Kyabetsu', '2026-09-25T01:28:00', '2026-09-25T01:30:00', 1, '590103220260925001'),
  nhk('5113', '012', 'GRAND SUMO Highlights', 'Day 12', '2026-09-25T01:30:00', '2026-09-25T01:57:00', 0, '511301220260925001'),
  nhk('5109', '005', 'Japan Railway Journal', "Generations On Track:Toyohashi's Iconic Streetcar", '2026-09-25T18:30:00', '2026-09-25T18:58:00', 0, '510900520260925003'),
  nhk('5901', '031', 'INFO', 'Trails to Oishii Tokyo mini 2min. Sakura', '2026-09-25T18:58:00', '2026-09-25T19:00:00', 1, '590103120260925002'),
  nhk('5047', '003', 'NHK NEWS 7', '', '2026-09-25T19:00:00', '2026-09-25T19:30:00', 0, '504700320260925001'),
  nhk('5215', '002', 'Japan in Focus', 'Learning for Happiness', '2026-09-25T19:30:00', '2026-09-25T19:57:00', 0, '521500220260925003'),
  nhk('5036', '016', 'NHK NEWSLINE', '', '2026-09-25T23:00:00', '2026-09-25T23:28:00', 0, '503601620260925001'),
  nhk('5901', '030', 'INFO', 'Trails to Oishii Tokyo mini 2min. Saba', '2026-09-25T23:28:00', '2026-09-25T23:30:00', 1, '590103020260925002'),
  nhk('5131', '005', 'Design X Stories', 'Design Hunting in Aichi 2026', '2026-09-25T23:30:00', '2026-09-25T23:58:00', 0, '513100520260925001'),
  nhk('5998', '002', 'INFO', 'kiso', '2026-09-25T23:58:00', '2026-09-26T00:00:00', 1, '599800220260925002'),
] }
const NHK_0926 = { data: [
  nhk('5036', '022', 'NHK NEWSLINE', '', '2026-09-26T00:00:00', '2026-09-26T00:28:00', 0, '503602220260926001'),
  nhk('5901', '023', 'INFO', 'Time-lapse Seto naikai Kagawa', '2026-09-26T00:28:00', '2026-09-26T00:29:00', 1, '590102320260926001'),
  nhk('5901', '009', 'INFO', 'JAPAN FROM ABOVE #5 SEASONS', '2026-09-26T00:29:00', '2026-09-26T00:29:30', 1, '590100920260926001'),
  nhk('5901', '013', 'INFO', 'Channel Promo BOSAI', '2026-09-26T00:29:30', '2026-09-26T00:30:00', 1, '590101320260926001'),
  nhk('5215', '002', 'Japan in Focus', 'Learning for Happiness', '2026-09-26T00:30:00', '2026-09-26T00:57:00', 0, '521500220260926001'),
  nhk('5901', '022', 'INFO', 'Time-lapse Nikko Tochigi', '2026-09-26T00:57:00', '2026-09-26T00:58:00', 1, '590102220260926001'),
  nhk('5901', '028', 'INFO', "Japan's National Parks 2min. PR #4", '2026-09-26T00:58:00', '2026-09-26T01:00:00', 1, '590102820260926001'),
  nhk('5036', '023', 'NHK NEWSLINE', '', '2026-09-26T01:00:00', '2026-09-26T01:28:00', 0, '503602320260926001'),
  nhk('5901', '032', 'INFO', 'Trails to Oishii Tokyo mini 2min. Kyabetsu', '2026-09-26T01:28:00', '2026-09-26T01:30:00', 1, '590103220260926001'),
  nhk('5113', '013', 'GRAND SUMO Highlights', 'Day 13', '2026-09-26T01:30:00', '2026-09-26T01:57:00', 0, '511301320260926001'),
] }

// ---- YTN：m.ytn.co.kr/schedule.php?date=<韩国日期> 的真实标记（缩进、标签原样） ----
const ytnItem = (time, title, labels, onair = false) => `\t\t\t\t\t\t\t\t\t\t\t<li class="schedule_list${onair ? ' onair' : ''}">
\t\t\t\t\t\t\t\t<div class="time">${time}</div>
\t\t\t\t\t\t\t\t<div class="program_name">
\t\t\t\t\t\t\t\t${onair ? '<div class="ico_onair">ON AIR</div>' : ''}\t\t\t\t\t\t\t\t<span class="title">${title}</span><ul class="label_wrap">${labels.map(label => `<li class="program_label">${label}</li>`).join('')}</ul>\t\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t</li>
`
const ytnPage = (date, items) => `<!DOCTYPE html>
<html lang="ko">
<head><meta charset="utf-8" /><title>24시간 뉴스 생방송 | YTN </title>
<meta name="nate:url" content="https://m.ytn.co.kr/schedule.php"/></head>
<body>
\t\t\t<form name="replayListForm" method="get" action="?">
\t\t\t\t<input type="hidden" name="date" id="date" value="${date}" />
\t\t\t</form>
\t\t\t<div class="container">
\t\t\t\t<div class="live_top_wrapper"><div class="live_top"><h2 class="title">TV 편성표</h2></div></div>
\t\t\t\t<div class="btn_arti_by_date">
\t\t\t\t\t<a href="javascript:chgURL('date','2026-09-24');" class="btn_prev"><div class="on">이전</div></a>
\t\t\t\t</div>
\t\t\t\t<ul class="schedule_list_wrap">
${items.join('')}\t\t\t\t\t\t\t\t
\t\t\t\t</ul>
\t\t\t\t<div class="schedule_info">
\t\t\t\t\t<ul class="noti">
\t\t\t\t\t\t<li>최종 업데이트 : 2026-09-15 16:19</li> \t\t\t\t\t\t<li>이 편성표는 방송사 사정에 따라 변경될 수 있습니다.</li>
\t\t\t\t\t</ul>
\t\t\t\t\t<ul class="noti_icons"><li><span class="program_label">HD</span>HD 방송</li></ul>
\t\t\t\t</div>
\t\t\t</div>
</body></html>`
const LIVE = ['HD', '생', '본', '자']
const RERUN = ['HD', '재', '자']
const YTN_0925 = ytnPage('2026-09-25', [
  ytnItem('00:50', 'YTN24', LIVE),
  ytnItem('01:50', 'YTN24', LIVE),
  ytnItem('02:15', '특집-다큐24', RERUN),
  ytnItem('02:50', 'YTN24', LIVE, true),
  ytnItem('03:15', '특집-국가안보가 된 기술', RERUN),
  ytnItem('03:50', '뉴스퀘어 4AM', LIVE),
  ytnItem('04:50', '뉴스START 1부', LIVE),
  ytnItem('21:25', '황금나침반', ['HD', '본', '자']),
  ytnItem('21:50', '뉴스와이드', LIVE),
  ytnItem('23:50', 'YTN24', LIVE),
])
const YTN_0926 = ytnPage('2026-09-26', [
  ytnItem('00:50', 'YTN24', LIVE),
  ytnItem('01:50', 'YTN24', LIVE),
  ytnItem('02:15', '특집-다큐24', RERUN),
])
// 再往后的日期：页面照常出，列表为空
const YTN_EMPTY = date => ytnPage(date, [])
// 日期非法：404 加一段跳错误页的脚本
const YTN_BAD_DATE = "﻿\n\t<script>\n\tlocation.replace('/_comm/ytn_error.php');\n\t</script>\n\t"

const jsonResponse = (payload, init) => new Response(JSON.stringify(payload), {
  ...init, headers: { 'content-type': 'application/json', ...init?.headers },
})
const htmlResponse = (text, init) => new Response(text, {
  ...init, headers: { 'content-type': 'text/html; charset=UTF-8', ...init?.headers },
})
// 按地址回放的假 fetch：NHK 按日期文件、YTN 按 date 参数
function replay(routes, requests = []) {
  return async (url, options) => {
    requests.push({ url, options })
    const route = routes[url]
    if (!route) return new Response('404 page not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
    return route()
  }
}
const noRequest = async () => { throw new Error('不应发请求') }

console.log('YTN / NHK World 节目单测试')

check('上海日 D = 当地（UTC+9）D 日 01:00 到 D+1 日 01:00，取当地 D、D+1 两天；跨月也对', () => {
  const window = dayWindow('20260925')
  assert.equal(window.start, Date.parse('2026-09-25T00:00:00+08:00'))
  assert.equal(window.end, Date.parse('2026-09-26T00:00:00+08:00'))
  assert.equal(window.start, Date.parse('2026-09-25T01:00:00+09:00'))
  assert.deepEqual(window.localDays.map(day => [day.compact, day.dashed, day.midnight]), [
    ['20260925', '2026-09-25', Date.parse('2026-09-25T00:00:00+09:00')],
    ['20260926', '2026-09-26', Date.parse('2026-09-26T00:00:00+09:00')],
  ])
  assert.deepEqual(dayWindow('20261231').localDays.map(day => day.dashed), ['2026-12-31', '2027-01-01'])
  for (const bad of ['2026-09-25', '20260231', '', null]) assert.throws(() => dayWindow(bad), /参数非法/, String(bad))
})

await checkAsync('NHK：请求当地 D、D+1 两个日期文件', async () => {
  const requests = []
  const fetchImpl = replay({
    [`${NHK_EPG_BASE}20260925.json`]: () => jsonResponse(NHK_0925),
    [`${NHK_EPG_BASE}20260926.json`]: () => jsonResponse(NHK_0926),
  }, requests)
  await asianEpg.programmes('nhk-world', '20260925', { fetchImpl })
  assert.deepEqual(requests.map(r => r.url).sort(), [`${NHK_EPG_BASE}20260925.json`, `${NHK_EPG_BASE}20260926.json`])
  assert.ok(requests.every(r => r.options.redirect === 'manual' && r.options.signal instanceof AbortSignal))
})

await checkAsync('NHK：+09:00 换成上海时间，宣传短片并进前一条，只留上海日内的，跨到当地次日的也接上', async () => {
  const fetchImpl = replay({
    [`${NHK_EPG_BASE}20260925.json`]: () => jsonResponse(NHK_0925),
    [`${NHK_EPG_BASE}20260926.json`]: () => jsonResponse(NHK_0926),
  })
  const programmes = await asianEpg.programmes('nhk-world', '20260925', { fetchImpl })
  assert.deepEqual(fmt(programmes), [
    // 日本 01:00 = 上海 00:00；01:28 的宣传片并进来，到 01:30
    ['NHK NEWSLINE', '20260925000000 +0800', '20260925003000 +0800'],
    ['GRAND SUMO Highlights', '20260925003000 +0800', '20260925005700 +0800'],
    ['Japan Railway Journal', '20260925173000 +0800', '20260925180000 +0800'],
    // 日本 19:00 的 NHK NEWS 7 = 上海 18:00
    ['NHK NEWS 7', '20260925180000 +0800', '20260925183000 +0800'],
    ['Japan in Focus', '20260925183000 +0800', '20260925185700 +0800'],
    ['NHK NEWSLINE', '20260925220000 +0800', '20260925223000 +0800'],
    ['Design X Stories', '20260925223000 +0800', '20260925230000 +0800'],
    // 日本次日 00:00–01:00 的仍属上海这一天
    ['NHK NEWSLINE', '20260925230000 +0800', '20260925233000 +0800'],
    ['Japan in Focus', '20260925233000 +0800', '20260926000000 +0800'],
  ])
  // 日本 00:53 的 JAPAN DELISH 并上宣传片到日本 01:00 正好结束于上海零点：不属于这一天
  assert.ok(!programmes.some(item => item.title === 'JAPAN DELISH 5min.'))
})

check('NHK：宣传短片在最前面没有前一条时丢掉；坏时间、空标题跳过；数据全读不出报错', () => {
  const days = [parseNhkDay({ data: [
    nhk('5901', '001', 'INFO', 'PR', '2026-09-25T01:00:00', '2026-09-25T01:02:00', 1, 'a'),
    nhk('1', '001', '  Direct Talk  ', '', '2026-09-25T01:02:00', '2026-09-25T01:15:00', 0, 'b'),
    { ...nhk('2', '001', '坏时间', '', '2026-09-25T01:15:00', '2026-09-25T01:30:00', 0, 'c'), startTime: '2026-09-25 01:15:00' },
    nhk('3', '001', '   ', '', '2026-09-25T01:30:00', '2026-09-25T01:45:00', 0, 'd'),
    { ...nhk('4', '001', '缺结束', '', '2026-09-25T01:45:00', '2026-09-25T02:00:00', 0, 'e'), endTime: '' },
    nhk('5', '001', 'NHK NEWSLINE', '', '2026-09-25T02:00:00', '2026-09-25T02:28:00', 0, 'f'),
  ] })]
  assert.deepEqual(fmt(nhkProgrammes(days, '20260925')), [
    ['Direct Talk', '20260925000200 +0800', '20260925001500 +0800'],
    ['缺结束', '20260925004500 +0800', '20260925010000 +0800'],
    ['NHK NEWSLINE', '20260925010000 +0800', '20260925012800 +0800'],
  ])
  assert.throws(() => parseNhkDay({ data: [{ startTime: 1790265600000 }] }), /格式异常/)
  assert.throws(() => parseNhkDay({ items: [] }), /格式异常/)
  assert.throws(() => parseNhkDay([]), /格式异常/)
  assert.deepEqual(parseNhkDay({ data: [] }), [])
})

await checkAsync('NHK：没发的日期回 404 当空；两天都没发返回空数组', async () => {
  // 当地 D+1 还没发：只用 D 的，最后一条没有下一条，结束照官方给的
  const onlyToday = await asianEpg.programmes('nhk-world', '20260925', {
    fetchImpl: replay({ [`${NHK_EPG_BASE}20260925.json`]: () => jsonResponse(NHK_0925) }),
  })
  assert.deepEqual(fmt(onlyToday).at(-1), ['Design X Stories', '20260925223000 +0800', '20260925230000 +0800'])
  assert.deepEqual(await asianEpg.programmes('nhk-world', '20271001', { fetchImpl: replay({}) }), [])
})

await checkAsync('YTN：请求当地 D、D+1 两页，按回显日期核对', async () => {
  const requests = []
  const fetchImpl = replay({
    [`${YTN_SCHEDULE_PAGE}?date=2026-09-25`]: () => htmlResponse(YTN_0925),
    [`${YTN_SCHEDULE_PAGE}?date=2026-09-26`]: () => htmlResponse(YTN_0926),
  }, requests)
  await asianEpg.programmes('ytn', '20260925', { fetchImpl })
  assert.deepEqual(requests.map(r => r.url).sort(), [`${YTN_SCHEDULE_PAGE}?date=2026-09-25`, `${YTN_SCHEDULE_PAGE}?date=2026-09-26`])
  assert.ok(requests.every(r => r.options.redirect === 'manual'))
})

await checkAsync('YTN：韩国时间 −1 小时为上海时间，结束取下一条（可在当地次日），零点时正在播的那条带上', async () => {
  const fetchImpl = replay({
    [`${YTN_SCHEDULE_PAGE}?date=2026-09-25`]: () => htmlResponse(YTN_0925),
    [`${YTN_SCHEDULE_PAGE}?date=2026-09-26`]: () => htmlResponse(YTN_0926),
  })
  assert.deepEqual(fmt(await asianEpg.programmes('ytn', '20260925', { fetchImpl })), [
    // 韩国 00:50 开始、01:50 结束：上海零点时正在播
    ['YTN24', '20260924235000 +0800', '20260925005000 +0800'],
    ['YTN24', '20260925005000 +0800', '20260925011500 +0800'],
    ['특집-다큐24', '20260925011500 +0800', '20260925015000 +0800'],
    ['YTN24', '20260925015000 +0800', '20260925021500 +0800'],
    ['특집-국가안보가 된 기술', '20260925021500 +0800', '20260925025000 +0800'],
    ['뉴스퀘어 4AM', '20260925025000 +0800', '20260925035000 +0800'],
    ['뉴스START 1부', '20260925035000 +0800', '20260925202500 +0800'],
    ['황금나침반', '20260925202500 +0800', '20260925205000 +0800'],
    ['뉴스와이드', '20260925205000 +0800', '20260925225000 +0800'],
    ['YTN24', '20260925225000 +0800', '20260925235000 +0800'],
    // 韩国次日 00:50 = 上海 23:50，下一条在韩国次日 01:50
    ['YTN24', '20260925235000 +0800', '20260926005000 +0800'],
  ])
})

check('YTN 页面：标题解实体、去标签；空列表返回空；回显日期不符或页面改版报错', () => {
  const [day] = dayWindow('20260925').localDays
  const items = parseYtnDay(ytnPage('2026-09-25', [
    ytnItem('07:50', '뉴스 &amp; 이슈 <b>특집</b>', LIVE),
    ytnItem('08:50', '&#50672;&#xD569; 뉴스', LIVE),
    ytnItem('24:10', '坏时间', LIVE),
    ytnItem('09:50', '   ', LIVE),
  ]), day)
  assert.deepEqual(items, [
    { title: '뉴스 & 이슈 특집', start: sh('2026-09-25 06:50:00') },
    { title: '연합 뉴스', start: sh('2026-09-25 07:50:00') },
  ])
  assert.deepEqual(parseYtnDay(YTN_EMPTY('2026-09-25'), day), [])
  assert.throws(() => parseYtnDay(YTN_0926, day), /日期不符/)
  assert.throws(() => parseYtnDay('<html>no form</html>', day), /日期不符/)
  assert.throws(() => parseYtnDay(YTN_0925.replace('schedule_list_wrap', 'timetable'), day), /格式异常/)
  assert.throws(() => parseYtnDay(YTN_0925.replaceAll('<div class="time">', '<p class="time">'), day), /格式异常/)
  // 只有一天有数据时：最后一条到上海日末
  assert.deepEqual(fmt(ytnProgrammes([parseYtnDay(YTN_0925, day), []], '20260925')).at(-1),
    ['YTN24', '20260925225000 +0800', '20260926000000 +0800'])
})

await checkAsync('YTN：再往后没排的日期返回空数组', async () => {
  const fetchImpl = replay({
    [`${YTN_SCHEDULE_PAGE}?date=2026-10-05`]: () => htmlResponse(YTN_EMPTY('2026-10-05')),
    [`${YTN_SCHEDULE_PAGE}?date=2026-10-06`]: () => htmlResponse(YTN_EMPTY('2026-10-06')),
  })
  assert.deepEqual(await asianEpg.programmes('ytn', '20261005', { fetchImpl }), [])
})

await checkAsync('错误路径：HTTP 错误、跳转、非法日期 404、非 JSON、超大响应、断网、超时、参数非法都抛', async () => {
  const nhkRun = (fetchImpl, opts = {}) => asianEpg.programmes('nhk-world', '20260925', { fetchImpl, ...opts })
  const ytnRun = (fetchImpl, opts = {}) => asianEpg.programmes('ytn', '20260925', { fetchImpl, ...opts })
  await assert.rejects(nhkRun(async () => new Response('', { status: 503 })), /NHK World 节目单 HTTP 503/)
  await assert.rejects(nhkRun(async () => new Response(null, { status: 302, headers: { location: 'https://example.com/' } })), /HTTP 302/)
  await assert.rejects(nhkRun(async () => new Response('<html>oops</html>')), /不是 JSON/)
  await assert.rejects(nhkRun(async () => jsonResponse({ data: 'x' })), /格式异常/)
  await assert.rejects(nhkRun(async () => new Response('{}', { headers: { 'content-length': String(10 * 1024 * 1024) } })), /过大/)
  const endless = () => new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(64 * 1024).fill(0x20)) } })
  await assert.rejects(nhkRun(async () => new Response(endless())), /过大/)
  await assert.rejects(ytnRun(async () => htmlResponse(YTN_BAD_DATE, { status: 404 })), /YTN 节目单 HTTP 404/)
  await assert.rejects(ytnRun(async () => new Response(null, { status: 302, headers: { location: '/_comm/ytn_error.php' } })), /HTTP 302/)
  await assert.rejects(ytnRun(async () => new Response(endless())), /过大/)
  // 一天取到、另一天失败：整次失败（由流水线按天隔离）
  await assert.rejects(ytnRun(replay({ [`${YTN_SCHEDULE_PAGE}?date=2026-09-25`]: () => htmlResponse(YTN_0925) })), /HTTP 404/)
  await assert.rejects(ytnRun(async () => { throw new TypeError('fetch failed') }), /fetch failed/)
  const hang = async (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason))
  })
  await assert.rejects(nhkRun(hang, { timeoutMs: 20 }), { name: 'AbortError' })
  await assert.rejects(ytnRun(hang, { timeoutMs: 20 }), { name: 'AbortError' })
  await assert.rejects(asianEpg.programmes('arirang', '20260925', { fetchImpl: noRequest }), /参数非法/)
  await assert.rejects(asianEpg.programmes('constructor', '20260925', { fetchImpl: noRequest }), /参数非法/)
  await assert.rejects(asianEpg.programmes('ytn', '2026-09-25', { fetchImpl: noRequest }), /参数非法/)
})

await checkAsync('每个节目单 ref 与显示名都是模块实际产出的频道，两台全登记', async () => {
  const module = getModule('asian-live')
  assert.equal(module.epg, asianEpg)
  assert.equal(module.capabilities.epg, true)
  assert.doesNotThrow(() => validateModule(module))
  const { groups } = await module.fetch({})
  const emitted = groups.flatMap(group => group.dataList).map(channel => [channel.deferredRef, channel.name])
  assert.deepEqual(asianEpg.channels().map(channel => [channel.ref, channel.name]), emitted)
  assert.deepEqual(asianEpg.channels().map(channel => channel.key), ['ytn', 'nhk-world'])
  assert.ok(asianEpg.channels().every(channel => module.claimsRef(channel.ref)))
})

await checkAsync('两天合并：相邻两天都带上的同一条只留一份，前后不重叠', async () => {
  const fetchImpl = replay({
    [`${YTN_SCHEDULE_PAGE}?date=2026-09-25`]: () => htmlResponse(YTN_0925),
    [`${YTN_SCHEDULE_PAGE}?date=2026-09-26`]: () => htmlResponse(YTN_0926),
    [`${YTN_SCHEDULE_PAGE}?date=2026-09-27`]: () => htmlResponse(YTN_EMPTY('2026-09-27')),
  })
  // 2026-09-25 10:00（上海）
  const merged = await providerProgrammes(asianEpg, 'ytn', { now: sh('2026-09-25 10:00:00'), fetchImpl })
  assert.ok(merged.every((item, i) => i === 0 || merged[i - 1].stop <= item.start))
  assert.equal(new Set(merged.map(item => item.start)).size, merged.length)
  assert.equal(xmltvTime(merged.at(-1).start), '20260926011500 +0800')
})

check('epg.js 只 import 本目录的频道表，可整体拆出', () => {
  const source = readFileSync(new URL('../extractors/asian-live/epg.js', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map(match => match[1])
  assert.deepEqual(imports, ['./channels.js'])
})

console.log(`\n全部通过：${passed} ✅`)
