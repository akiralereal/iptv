#!/usr/bin/env node
/**
 * 莆田官方节目单回归测试：按 unix 秒 + 时长取当天、丢「精彩节目」占位与前一天的条目、重叠截断、
 * zone 按上海日期换算且与运行机器时区无关、平台拒绝与改版报错、请求地址与官网一致。
 * 样本按 2026-09-30 一套（channel_id=4）与仙游电视台（channel_id=6）接口的真实响应裁剪。
 *
 * 运行： node scripts/test-putian-epg.mjs
 *       TZ=UTC node scripts/test-putian-epg.mjs
 *       TZ=America/Los_Angeles node scripts/test-putian-epg.mjs
 */
import assert from 'node:assert/strict'

import putianEpg, { EPG_API, epgUrl, parseProgrammes, shanghaiDay, zoneOf } from '../extractors/putian/epg.js'
import { CHANNELS } from '../extractors/putian/channels.js'
import { getModule } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }
const sh = text => Date.parse(`${text.replace(' ', 'T')}+08:00`)
const hhmm = seconds => new Date((seconds + 8 * 3600) * 1000).toISOString().slice(11, 16)

const row = (startTime, toff, theme, dates = '2026-09-30') => ({
  id: startTime, channel_id: '4', schedule_id: 0, record_id: 0, index_pic: '', start_time: startTime,
  date: dates, create_user_name: '林祖新', start: `${hhmm(startTime)}:00`, toff, theme,
  subtopic: '', type_id: 1, dates, end: hhmm(startTime + toff), end_time: startTime + toff,
  m3u8: `https://live1.ptbtv.com/pttv1/hd/${startTime}000,${toff}000.m3u8?_upt=1c92ef521790787603`,
  lave_time: 0, zhi_play: 0, now_play: 0, display: 1, channel_name: '莆田一套',
})
// 09-30：故意乱序；含前一天的一条、正好一分钟的国歌、标题带多余空格的一条；06:32 那档故意拉长、叠进下一档
const NEWS_0930 = [
  row(1790722380, 420, '莆阳文脉兴化府'),
  row(1790719200, 720, '系列片《天下妈祖》'),
  row(1790721120, 2340, '健康生活'),
  row(1790632800, 720, '系列片《天下妈祖》', '2026-09-29'),
  row(1790719920, 1200, '  秋生讲古 '),
  row(1790722800, 60, '国歌'),
  row(1790766000, 2100, '转播中央台新闻联播'),
  row(1790782200, 1799, '海洋气象预报'),
]
const placeholder = startTime => ({
  start_time: startTime, is_forbid: '0', url: '', live_forbid: '1', timeshift_forbid: '1', type: '',
  start: `${hhmm(startTime)}:00`, channel_id: '6', toff: 3600, theme: '精彩节目', subtopic: '', type_id: 1,
  dates: '2026-09-30', end_time: startTime + 3600, display: 1, stime: `${hhmm(startTime)}:00`,
  channel_name: '仙游电视台',
})
const XIANYOU_0930 = Array.from({ length: 24 }, (_, hour) => placeholder(1790697600 + hour * 3600))

console.log('莆田节目单测试')

check('节目单挂在模块上，三路频道按 ref 对上取流的 deferredRef', () => {
  const module = getModule('putian')
  assert.equal(module.epg, putianEpg)
  assert.equal(putianEpg.id, 'putian')
  assert.equal(putianEpg.days, 2)
  assert.deepEqual(putianEpg.channels(), CHANNELS.map(channel => ({ ref: channel.ref, name: channel.name, key: String(channel.id) })))
})

check('zone 按上海日期换算，与运行机器时区无关', () => {
  const now = sh('2026-09-30 00:30')
  assert.equal(zoneOf('20260930', now), 0)
  assert.equal(zoneOf('20261001', now), 1)
  assert.equal(zoneOf('20260929', now), -1)
  // 上海已过零点、UTC 还是前一天
  assert.equal(zoneOf('20260930', sh('2026-09-30 07:59')), 0)
  assert.equal(zoneOf('20261001', sh('2026-09-30 23:59')), 1)
  assert.ok(Number.isNaN(zoneOf('20260231', now)))
  assert.deepEqual(shanghaiDay('20260930'), { start: sh('2026-09-30 00:00'), end: sh('2026-10-01 00:00') })
})

check('请求地址与官网节目单一致；超出范围的日子不请求', () => {
  const now = sh('2026-09-30 12:00')
  const url = new URL(epgUrl('4', '20261001', now))
  assert.equal(`${url.origin}${url.pathname}`, EPG_API)
  assert.equal(url.searchParams.get('channel_id'), '4')
  assert.equal(url.searchParams.get('zone'), '1')
  assert.equal([...url.searchParams.keys()].length, 2)
  assert.equal(new URL(epgUrl('6', '20260923', now)).searchParams.get('zone'), '-7')
  assert.equal(epgUrl('4', '20261007', now), null)
  assert.equal(epgUrl('4', '20260922', now), null)
  assert.throws(() => epgUrl('99', '20260930', now), /参数非法/)
  assert.throws(() => epgUrl('4', 'bad', now), /参数非法/)
})

check('按起始秒 + 时长解析，丢前一天的条目，整理标题，重叠截断', () => {
  const programmes = parseProgrammes(NEWS_0930, '20260930')
  assert.deepEqual(programmes.map(item => item.title),
    ['系列片《天下妈祖》', '秋生讲古', '健康生活', '莆阳文脉兴化府', '国歌', '转播中央台新闻联播', '海洋气象预报'])
  assert.deepEqual(programmes[0], { title: '系列片《天下妈祖》', start: sh('2026-09-30 06:00'), stop: sh('2026-09-30 06:12') })
  const cctvNews = programmes.find(item => item.title === '转播中央台新闻联播')
  assert.deepEqual(cctvNews, { title: '转播中央台新闻联播', start: sh('2026-09-30 19:00'), stop: sh('2026-09-30 19:35') })
  // 06:32 那档叠进 06:53 的下一档：截到下一档开始
  assert.equal(programmes[2].stop, sh('2026-09-30 06:53'))
  assert.deepEqual(programmes[4], { title: '国歌', start: sh('2026-09-30 07:00'), stop: sh('2026-09-30 07:01') })
  assert.equal(programmes.at(-1).stop, sh('2026-09-30 23:59:59'))
  assert.deepEqual(parseProgrammes([], '20260930'), [])
})

check('一整天「精彩节目」占位当官方没发', () => {
  assert.deepEqual(parseProgrammes(XIANYOU_0930, '20260930'), [])
})

check('平台拒绝与改版都报错，不静默给空节目单', () => {
  assert.throws(
    () => parseProgrammes({ ErrorCode: '1', ErrorText: '缺少频道 id' }, '20260930'),
    error => error.code === 1 && /缺少频道 id/.test(error.message),
  )
  assert.throws(() => parseProgrammes({ data: [] }, '20260930'), /结构不符合预期/)
  assert.throws(() => parseProgrammes([{ theme: '莆田新闻联播', start: '20:03:00' }], '20260930'), /时间格式异常/)
  assert.throws(() => parseProgrammes([], '2026-09-30'), /参数非法/)
})

await checkAsync('programmes() 走注入的 fetch、今天用 zone=0、用非浏览器 UA；HTTP 错误与挑战页抛错', async () => {
  const todayIso = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
  const today = todayIso.replaceAll('-', '')
  const start = Date.parse(`${todayIso}T20:03:00+08:00`) / 1000
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push(new URL(url).searchParams.get('zone'))
    assert.equal(init.redirect, 'manual')
    assert.doesNotMatch(init.headers['User-Agent'], /Mozilla/)
    return new Response(JSON.stringify([row(start, 1500, '莆田新闻联播', todayIso)]))
  }
  const programmes = await putianEpg.programmes('4', today, { fetchImpl })
  assert.deepEqual(programmes, [{ title: '莆田新闻联播', start: start * 1000, stop: (start + 1500) * 1000 }])
  assert.deepEqual(seen, ['0'])
  await assert.rejects(
    putianEpg.programmes('4', today, { fetchImpl: async () => new Response('x', { status: 403 }) }),
    /HTTP 403/,
  )
  await assert.rejects(
    putianEpg.programmes('4', today, { fetchImpl: async () => new Response('<html><script src="/_fec_sbu/fec_wrapper.js"></script></html>') }),
    /不是 JSON/,
  )
})

console.log(`\n全部通过：${passed} ✅`)
