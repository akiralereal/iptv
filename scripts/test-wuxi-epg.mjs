#!/usr/bin/env node
/**
 * 无锡官方节目单回归测试：按 unix 秒 + 时长取当天、丢收尾标记与同一时刻的重复条目、重叠截断、
 * zone 按上海日期换算且与运行机器时区无关、平台拒绝与改版报错、请求地址与网页一致。
 * 样本按 2026-09-29 新闻综合频道（channel_id=4）接口的真实响应裁剪。
 *
 * 运行： node scripts/test-wuxi-epg.mjs
 *       TZ=UTC node scripts/test-wuxi-epg.mjs
 *       TZ=America/Los_Angeles node scripts/test-wuxi-epg.mjs
 */
import assert from 'node:assert/strict'

import wuxiEpg, { EPG_API, epgUrl, parseProgrammes, shanghaiDay, zoneOf } from '../extractors/wuxi/epg.js'
import { CHANNELS } from '../extractors/wuxi/channels.js'
import { getModule } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }
const sh = text => Date.parse(`${text.replace(' ', 'T')}+08:00`)

const row = (startTime, toff, theme, date = '2026-09-29') => ({
  id: startTime, channel_id: '4', schedule_id: 0, record_id: 0, index_pic: '',
  start_time: startTime, date, start: new Date((startTime + 8 * 3600) * 1000).toISOString().slice(11, 19),
  toff, theme, create_user_name: 'maowei', created_at: '2026-09-29 19:50:07',
})
// 09-29：故意乱序；含前一天的一条、不到一分钟的「健康好生活」片段、末尾 1 秒 / 0 秒 / 正常三条同名
const NEWS_0929 = [
  row(1790613977, 21433, '繁华似锦'),
  row(1790611200, 2777, '请您欣赏'),
  row(1790524800, 2777, '请您欣赏', '2026-09-28'),
  row(1790635410, 146, '健康好生活'),
  row(1790635556, 844, '  请您欣赏 '),
  row(1790636400, 48, '国歌'),
  row(1790690808, 3960, '阿福聊斋'),
  row(1790694768, 1, '锦囊妙录'),
  row(1790694769, 0, '锦囊妙录'),
  row(1790694769, 2830, '锦囊妙录'),
]

console.log('无锡节目单测试')

check('节目单挂在模块上，五路频道按 ref 对上取流的 deferredRef', () => {
  const module = getModule('wuxi')
  assert.equal(module.epg, wuxiEpg)
  assert.equal(wuxiEpg.id, 'wuxi')
  assert.equal(wuxiEpg.days, 2)
  assert.deepEqual(wuxiEpg.channels(), CHANNELS.map(channel => ({ ref: channel.ref, name: channel.name, key: String(channel.id) })))
})

check('zone 按上海日期换算，与运行机器时区无关', () => {
  const now = sh('2026-09-29 00:30')
  assert.equal(zoneOf('20260929', now), 0)
  assert.equal(zoneOf('20260930', now), 1)
  assert.equal(zoneOf('20260928', now), -1)
  // 上海已过零点、UTC 还是前一天
  assert.equal(zoneOf('20260929', sh('2026-09-29 07:59')), 0)
  assert.equal(zoneOf('20260930', sh('2026-09-29 23:59')), 1)
  assert.ok(Number.isNaN(zoneOf('20260231', now)))
  assert.deepEqual(shanghaiDay('20260929'), { start: sh('2026-09-29 00:00'), end: sh('2026-09-30 00:00') })
})

check('请求地址与网页节目表一致；超出网页日期范围的日子不请求', () => {
  const now = sh('2026-09-29 12:00')
  const url = new URL(epgUrl('4', '20260930', now))
  assert.equal(`${url.origin}${url.pathname}`, EPG_API)
  assert.equal(url.searchParams.get('channel_id'), '4')
  assert.equal(url.searchParams.get('zone'), '1')
  assert.equal(url.searchParams.get('appid'), 'm2oszr2ukmxzvqr4ai')
  assert.equal(url.searchParams.get('appkey'), '7fbab2da9b4c7cd2405ffa7e8097cc22')
  assert.equal(new URL(epgUrl('11', '20260924', now)).searchParams.get('zone'), '-5')
  assert.equal(epgUrl('4', '20261001', now), null)
  assert.equal(epgUrl('4', '20260923', now), null)
  assert.throws(() => epgUrl('99', '20260929', now), /参数非法/)
  assert.throws(() => epgUrl('4', 'bad', now), /参数非法/)
})

check('按起始秒 + 时长解析，丢收尾标记、重复与前一天的条目，重叠截断', () => {
  const programmes = parseProgrammes(NEWS_0929, '20260929')
  assert.deepEqual(programmes.map(item => item.title), ['请您欣赏', '繁华似锦', '健康好生活', '请您欣赏', '阿福聊斋', '锦囊妙录'])
  assert.deepEqual(programmes[0], { title: '请您欣赏', start: sh('2026-09-29 00:00'), stop: sh('2026-09-29 00:46:17') })
  assert.equal(programmes[2].stop - programmes[2].start, 146 * 1000)
  assert.deepEqual(programmes.at(-1), { title: '锦囊妙录', start: sh('2026-09-29 23:12:49'), stop: sh('2026-09-29 23:59:59') })
  // 与下一条重叠的截到下一条开始
  const overlapped = parseProgrammes([row(1790611200, 3600, '甲'), row(1790613000, 600, '乙')], '20260929')
  assert.equal(overlapped[0].stop, overlapped[1].start)
  assert.deepEqual(parseProgrammes([], '20260929'), [])
})

check('平台拒绝与改版都报错，不静默给空节目单', () => {
  assert.throws(
    () => parseProgrammes({ error_code: 1000, error_message: '授权验证未通过哦', data: [] }, '20260929'),
    error => error.code === 1000 && /授权验证未通过/.test(error.message),
  )
  assert.throws(() => parseProgrammes({ data: [] }, '20260929'), /结构不符合预期/)
  assert.throws(() => parseProgrammes([{ theme: '甲', start: '07:00:00' }], '20260929'), /时间格式异常/)
  assert.throws(() => parseProgrammes([], '2026-09-29'), /参数非法/)
})

await checkAsync('programmes() 走注入的 fetch、今天用 zone=0；HTTP 错误与非 JSON 抛错', async () => {
  const todayIso = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
  const today = todayIso.replaceAll('-', '')
  const start = Date.parse(`${todayIso}T08:00:00+08:00`) / 1000
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push(new URL(url).searchParams.get('zone'))
    assert.equal(init.redirect, 'manual')
    assert.match(init.headers['User-Agent'], /Chrome/)
    return new Response(JSON.stringify([row(start, 1800, '无锡新闻', todayIso)]))
  }
  const programmes = await wuxiEpg.programmes('4', today, { fetchImpl })
  assert.deepEqual(programmes, [{ title: '无锡新闻', start: start * 1000, stop: (start + 1800) * 1000 }])
  assert.deepEqual(seen, ['0'])
  await assert.rejects(
    wuxiEpg.programmes('4', today, { fetchImpl: async () => new Response('x', { status: 502 }) }),
    /HTTP 502/,
  )
  await assert.rejects(
    wuxiEpg.programmes('4', today, { fetchImpl: async () => new Response('<html>云防护</html>') }),
    /不是 JSON/,
  )
})

console.log(`\n全部通过：${passed} ✅`)
