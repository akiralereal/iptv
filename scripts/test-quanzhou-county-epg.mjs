#!/usr/bin/env node
/**
 * 晋江、石狮官方节目单回归测试：按 unix 秒取当天、丢「精彩节目」占位与空白标题、重叠截断、
 * 同一时刻去重、平台拒绝与改版报错、请求地址与官网一致。样本按 2026-09-29 两台接口的真实响应裁剪。
 *
 * 运行： node scripts/test-quanzhou-county-epg.mjs
 *       TZ=UTC node scripts/test-quanzhou-county-epg.mjs
 *       TZ=America/Los_Angeles node scripts/test-quanzhou-county-epg.mjs
 */
import assert from 'node:assert/strict'

import countyEpg, { epgUrl, parseProgrammes, shanghaiDay } from '../extractors/quanzhou-county/epg.js'
import { getModule } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }
const sh = text => Date.parse(`${text.replace(' ', 'T')}+08:00`)
const sec = text => sh(text) / 1000

const row = (title, from, to, date = '2026-09-29') => ({
  title, date, start_time: `${from}:00`, end_time: `${to}:00`,
  star_time_timestamp: sec(`${date} ${from}`), end_time_timestamp: sec(`${date} ${to}`),
  time_status: 0, time_status_text: '预告', stream_id: '740505545773395968',
})
const ok = result => ({ error_code: 200, error_message: 'success', result })

// 石狮 09-29：故意乱序、含空白标题、同一时刻重复、一条越过下一条开始、一条前一天的、一条不到一分钟的
const SHISHI = ok([
  row('种太阳（重播）', '07:05', '07:20'),
  row('国歌', '07:00', '07:05'),
  row('          ', '16:00', '17:40'),
  row('转播中央新闻联播', '19:00', '19:40'),
  row('转播中央新闻联播', '19:00', '19:35'),
  row('转播福建新闻联播', '19:35', '20:00'),
  { ...row('片花', '20:00', '20:01'), end_time_timestamp: sec('2026-09-29 20:00') + 30 },
  row('电视剧', '23:10', '23:59'),
  row('电视剧', '23:10', '23:59', '2026-09-28'),
])
// 晋江：一天 24 条整点占位
const JINJIANG = ok(Array.from({ length: 24 }, (_, h) => {
  const from = `${String(h).padStart(2, '0')}:00`
  const to = h === 23 ? '23:59' : `${String(h + 1).padStart(2, '0')}:00`
  return row('精彩节目', from, to)
}))

console.log('晋江、石狮节目单测试')

check('模块挂上节目单，频道与模块实际输出一一对应', () => {
  const module = getModule('quanzhou-county')
  assert.equal(module.epg, countyEpg)
  assert.equal(countyEpg.days, 2)
  assert.deepEqual(countyEpg.channels(), [
    { ref: 'quanzhou-county-jinjiang', name: '晋江电视台', key: 'jinjiang' },
    { ref: 'quanzhou-county-shishi', name: '石狮新闻综合', key: 'shishi' },
  ])
})

await checkAsync('节目单频道名与模块输出的频道名一致', async () => {
  const { groups } = await getModule('quanzhou-county').fetch()
  assert.deepEqual(countyEpg.channels().map(c => c.name), groups[0].dataList.map(c => c.name))
})

check('上海日期换算与运行机器时区无关', () => {
  assert.deepEqual(shanghaiDay('20260929'), { start: sh('2026-09-29 00:00'), end: sh('2026-09-30 00:00'), iso: '2026-09-29' })
  assert.equal(shanghaiDay('20260931'), null)
  assert.equal(shanghaiDay('2026-09-29'), null)
})

check('石狮：排序去重、丢空白标题与碎片、只收当天、重叠截到下一档', () => {
  assert.deepEqual(parseProgrammes(SHISHI, '20260929'), [
    { title: '国歌', start: sh('2026-09-29 07:00'), stop: sh('2026-09-29 07:05') },
    { title: '种太阳（重播）', start: sh('2026-09-29 07:05'), stop: sh('2026-09-29 07:20') },
    { title: '转播中央新闻联播', start: sh('2026-09-29 19:00'), stop: sh('2026-09-29 19:35') },
    { title: '转播福建新闻联播', start: sh('2026-09-29 19:35'), stop: sh('2026-09-29 20:00') },
    { title: '电视剧', start: sh('2026-09-29 23:10'), stop: sh('2026-09-29 23:59') },
  ])
})

check('晋江整天占位、空结果都当官方没发', () => {
  assert.deepEqual(parseProgrammes(JINJIANG, '20260929'), [])
  assert.deepEqual(parseProgrammes(ok([]), '20260929'), [])
})

check('平台拒绝带错误码抛出；结构或时间字段改了报错', () => {
  assert.throws(() => parseProgrammes({ error_code: 10002, error_message: '客户信息不存在', result: [] }, '20260929'),
    error => error.code === 10002 && /客户信息不存在/.test(error.message))
  assert.throws(() => parseProgrammes({ error_code: 200, result: {} }, '20260929'), /结构/)
  assert.throws(() => parseProgrammes([], '20260929'), /结构/)
  const broken = ok([{ title: '石狮新闻', start_time: '20:00:00', end_time: '20:15:00' }])
  assert.throws(() => parseProgrammes(broken, '20260929'), /时间格式异常/)
  assert.throws(() => parseProgrammes(SHISHI, '20260931'), /参数非法/)
})

check('请求地址与官网节目单组件一致：石狮带 company_id，晋江不带', () => {
  const shishi = new URL(epgUrl('shishi', '20260929'))
  assert.equal(`${shishi.origin}${shishi.pathname}`, 'https://mapi-new.chinashishi.net/cloudlive-manage-mapi/api/topic/program/list')
  assert.deepEqual(Object.fromEntries(shishi.searchParams), {
    date: '2026-09-29', topic_id: '662611405685436416', app_secret: '5c03f9843fa239c14b52222e83098919', company_id: '492',
  })
  const jinjiang = new URL(epgUrl('jinjiang', '20260930'))
  assert.equal(`${jinjiang.origin}${jinjiang.pathname}`, 'https://mapi.ijjnews.com/cloudlive-manage-mapi/api/topic/program/list')
  assert.deepEqual(Object.fromEntries(jinjiang.searchParams), {
    date: '2026-09-30', topic_id: '657527900022525952', app_secret: '31ca2c44a23e6cd127ddee647fa9cf92',
  })
  assert.throws(() => epgUrl('nanan', '20260929'), /参数非法/)
})

const jsonResponse = (body, { status = 200 } = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
})

await checkAsync('programmes：注入的 fetch 拿到官网来源头，解析出当天节目', async () => {
  const calls = []
  const items = await countyEpg.programmes('shishi', '20260929', {
    fetchImpl: async (url, options) => { calls.push({ url, options }); return jsonResponse(SHISHI) },
  })
  assert.equal(items.length, 5)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, epgUrl('shishi', '20260929'))
  assert.equal(calls[0].options.headers.Referer, 'https://www.chinashishi.net/folder113/folder120/')
  assert.equal(calls[0].options.redirect, 'manual')
})

await checkAsync('programmes：HTTP 出错、不是 JSON、跳转都按失败抛出', async () => {
  await assert.rejects(countyEpg.programmes('jinjiang', '20260929', { fetchImpl: async () => jsonResponse('', { status: 502 }) }), /HTTP 502/)
  await assert.rejects(countyEpg.programmes('jinjiang', '20260929', { fetchImpl: async () => jsonResponse('<html>') }), /不是 JSON/)
  await assert.rejects(countyEpg.programmes('jinjiang', '20260929', {
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://example.com/' } }),
  }), /HTTP 302/)
  assert.deepEqual(await countyEpg.programmes('jinjiang', '20260929', { fetchImpl: async () => jsonResponse(JINJIANG) }), [])
})

console.log(`\n全部通过：${passed} ✅`)
