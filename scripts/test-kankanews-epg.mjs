#!/usr/bin/env node
/**
 * 看看新闻官方节目单回归测试：验签请求、节目解析、空日与各类错误、频道 ref 与模块实际输出一致。
 * 全程离线；fixture 按 2026-09-25 官网真实返回裁剪，字段与形状照原样。
 *
 * 运行： node scripts/test-kankanews-epg.mjs
 *       TZ=UTC node scripts/test-kankanews-epg.mjs、TZ=America/Los_Angeles node scripts/test-kankanews-epg.mjs
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import kankanewsEpg, { EPG_API, parseProgrammes } from '../extractors/kankanews/epg.js'
import { buildSignedHeaders } from '../extractors/kankanews/sign.js'
import { PROGRAM_LIST_URL, buildSignedHeaders as apiSignedHeaders } from '../extractors/kankanews/api.js'
import { getModule, resolverFor } from '../extractors/registry.js'
import { providerProgrammes, xmltvTime } from '../utils/epgXmltv.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }
const json = (body, init = {}) => new Response(JSON.stringify(body), {
  status: 200, ...init, headers: { 'content-type': 'application/json', ...init.headers },
})
const md5 = value => createHash('md5').update(value).digest('hex')

// ---- fixture：2026-09-25 实际返回裁剪 ----

// 上海 2026-09-25 00:30，UTC 还是 24 号
const NOW = Date.parse('2026-09-24T16:30:00Z')
const FIXED = { now: NOW, nonce: 'abcd1234', uuid: '0123456789ABCDEFGHIJK' }

const DFWS_HEAD = {
  id: 1, name: '东方卫视',
  cover: 'https://p.statickksmg.com/cont/2022/11/23/image_1669190729_FkAz4zRf.png',
  jump_app_head: 'kkl://knews', jump_app: 'action=channel&id=1',
}
const DFWS_ROWS = [
  { id: 2224120, name: '电视连续剧：《济公》（1）', date: '00:00', start_time: 1790265600, end_time: 1790267340, start_time_string: '2026-09-25 00:00:00', end_time_string: '2026-09-25 00:29:00', is_shield: 0, is_review: 0, can_review: 0 },
  { id: 2224121, name: '电视连续剧：《济公》（2）', date: '00:29', start_time: 1790267340, end_time: 1790269740, start_time_string: '2026-09-25 00:29:00', end_time_string: '2026-09-25 01:09:00', is_shield: 0, is_review: 0, can_review: 0 },
  { id: 2224156, name: '电视连续剧：《济公》（4）', date: '23:37', start_time: 1790350620, end_time: 1790352000, start_time_string: '2026-09-25 23:37:00', end_time_string: '2026-09-26 00:00:00', is_shield: 0, is_review: 0, can_review: 0 },
]
const XWZH_HEAD = {
  id: 2, name: '新闻综合',
  cover: 'https://p.statickksmg.com/cont/2022/11/23/image_1669191050_hE4B6b0a.png',
  jump_app_head: 'kkl://knews', jump_app: 'action=channel&id=2',
}
const XWZH_ROWS = [
  // 版权屏蔽：官网网络直播停播，电视照播
  { id: 2224002, name: '79集连续剧：大秧歌（69）', date: '00:00', start_time: 1790265600, end_time: 1790265900, start_time_string: '2026-09-25 00:00:00', end_time_string: '2026-09-25 00:05:00', is_shield: 1, is_review: 0, can_review: 0 },
  { id: 2224159, name: '纪录片真实影院（539）　田野之上5', date: '01:26', start_time: 1790270760, end_time: 1790273580, start_time_string: '2026-09-25 01:26:00', end_time_string: '2026-09-25 02:13:00', is_shield: 0, is_review: 1, can_review: 1 },
]
const programsBody = (channelId, date, head, programs) => ({
  params: { channel_id: channelId, date }, code: '1000', response_time: '1790268823.1089',
  result: { ...head, programs },
})
// 明天：同形状，programs 为空
const DFWS_TOMORROW = programsBody('1', '2026-09-26', DFWS_HEAD, [])
// 没有节目单的频道（魔都眼 11 / 新纪实 12）回另一种形状
const NO_SCHEDULE = {
  params: { channel_id: '11', date: '2026-09-25' }, code: '1000', response_time: '1790268823.4937',
  result: { system_time: 1790268823, date: '2026-09-25', list: [] },
}
const apiError = (channelId, code, message) => ({
  params: { channel_id: channelId, date: '2026-09-25' }, response_time: '1790268855.9234', code, message,
})
// 频道表（/content/pc/tv/channels）与景观线路（/content/pc/news/detail）裁剪
const CHANNEL_ROWS = [
  { id: 1, name: '东方卫视', is_exist_program: 1 },
  { id: 2, name: '新闻综合', is_exist_program: 1 },
  { id: 11, name: '魔都眼', is_exist_program: 0 },
  { id: 5, name: '第一财经', is_exist_program: 1 },
  { id: 12, name: '新纪实', is_exist_program: 0 },
  { id: 10, name: '五星体育', is_exist_program: 1 },
  { id: 4, name: '都市频道', is_exist_program: 1 },
  { id: 9, name: '哈哈炫动', is_exist_program: 1 },
]
const SCENIC_ROWS = [
  { id: 15989, title: '陆家嘴', play_url: 'encrypted' },
  { id: 13755, title: '外滩观光平台', play_url: 'encrypted' },
  { id: 12835, title: '魔都眼', play_url: 'encrypted' },
  { id: 13973, title: '北外滩', play_url: 'encrypted' },
  { id: 13974, title: '外白渡桥', play_url: 'encrypted' },
]

const neverFetch = async () => { throw new Error('不应发出请求') }
const programmesWith = (body, key = '1', extra = {}) => kankanewsEpg.programmes(key, '20260925', {
  fetchImpl: async () => (body instanceof Response ? body : json(body)), ...extra,
})

console.log('看看新闻节目单测试')

check('验签：取流详情的既有固定样本不变，节目单请求按排序串双 MD5', () => {
  assert.equal(apiSignedHeaders, buildSignedHeaders, 'api.js 照旧导出同一个验签函数')
  assert.equal(buildSignedHeaders({ channel_id: '2' }, { now: 1720000000000, nonce: 'abcd1234', uuid: FIXED.uuid }).sign,
    '91365fae251585050ea90559bea0f3ea')
  const headers = buildSignedHeaders({ channel_id: '1', date: '2026-09-25' }, FIXED)
  const canonical = 'Api-Version=v1&channel_id=1&date=2026-09-25&nonce=abcd1234&platform=pc'
    + '&timestamp=1790267400&version=2.42.15&28c8edde3d61a0411511d3b1866f0636'
  assert.equal(headers.sign, md5(md5(canonical)))
  assert.equal(headers.sign, 'f4bd78b838080ca97c1d1bc7b6546047')
  assert.equal(headers.timestamp, 1790267400)
  assert.equal(headers['m-uuid'], FIXED.uuid)
})

await checkAsync('请求：上海日期换成 YYYY-MM-DD，带固定签名、超时信号、不跟随跳转', async () => {
  assert.equal(EPG_API, PROGRAM_LIST_URL)
  let seen
  const list = await kankanewsEpg.programmes('1', '20260925', {
    ...FIXED,
    fetchImpl: async (url, options) => { seen = { url, options }; return json(programsBody('1', '2026-09-25', DFWS_HEAD, DFWS_ROWS)) },
  })
  assert.equal(seen.url, `${EPG_API}?channel_id=1&date=2026-09-25`)
  assert.equal(seen.options.headers.sign, 'f4bd78b838080ca97c1d1bc7b6546047')
  assert.equal(seen.options.headers.platform, 'pc')
  assert.equal(seen.options.redirect, 'manual')
  assert.ok(seen.options.signal instanceof AbortSignal)
  assert.equal(list.length, 3)
})

check('解析：秒转毫秒、按开始排序、标题去首尾空白、屏蔽节目照写、残缺条目跳过', () => {
  const rows = [
    XWZH_ROWS[1],
    { ...XWZH_ROWS[0], name: ' 　 79集连续剧：大秧歌（69）　 ' },
    { ...XWZH_ROWS[1], id: 1, name: '　 ' },                                  // 空标题
    { ...XWZH_ROWS[1], id: 2, end_time: XWZH_ROWS[1].start_time },           // 零时长
    { ...XWZH_ROWS[1], id: 3, start_time: null },                             // 缺开始
    { ...XWZH_ROWS[1], id: 4, end_time: '1790273580.5' },                     // 非整数秒
  ]
  const list = parseProgrammes(programsBody('2', '2026-09-25', XWZH_HEAD, rows), '2')
  assert.deepEqual(list, [
    { title: '79集连续剧：大秧歌（69）', start: 1790265600000, stop: 1790265900000 },
    { title: '纪录片真实影院（539）　田野之上5', start: 1790270760000, stop: 1790273580000 },
  ])
  const dfws = parseProgrammes(programsBody('1', '2026-09-25', DFWS_HEAD, [...DFWS_ROWS].reverse()), '1')
  assert.deepEqual(dfws.map(item => item.title), DFWS_ROWS.map(row => row.name))
  // 官网 start_time_string 是上海时间；换算结果与之逐条一致
  assert.equal(xmltvTime(dfws[0].start), '20260925000000 +0800')
  assert.equal(xmltvTime(dfws[1].stop), '20260925010900 +0800')
  assert.equal(xmltvTime(dfws[2].stop), '20260926000000 +0800', '最后一条收在次日零点')
})

await checkAsync('空日：明天空列表、无节目单频道的 {list: []} 形状都返回空数组', async () => {
  assert.deepEqual(await programmesWith(DFWS_TOMORROW), [])
  assert.deepEqual(await programmesWith(NO_SCHEDULE, '11'), [])
})

await checkAsync('错误：验签 4001 / 4003、频道不存在、HTTP 与跳转、非 JSON、结构变化、频道错位都抛出', async () => {
  await assert.rejects(programmesWith(apiError('1', '4001', '验签参数格式错误')), /4001：验签参数格式错误/)
  await assert.rejects(programmesWith(apiError('1', '4003', '验签失败')), /4003：验签失败/)
  await assert.rejects(programmesWith(apiError('99', '7201', '电视频道不存在'), '99'), /7201：电视频道不存在/)
  await assert.rejects(programmesWith(new Response('busy', { status: 503 })), /HTTP 503/)
  await assert.rejects(programmesWith(new Response(null, { status: 302, headers: { location: 'https://www.kankanews.com/' } })), /HTTP 302/)
  await assert.rejects(programmesWith(new Response('<html>维护中</html>', { status: 200 })), /不是 JSON/)
  await assert.rejects(programmesWith({ code: '1000', result: { ...DFWS_HEAD } }), /结构不符合预期/)
  await assert.rejects(programmesWith({ ...NO_SCHEDULE, result: { ...NO_SCHEDULE.result, list: [{ id: 1 }] } }), /结构不符合预期/)
  await assert.rejects(programmesWith({ code: 1000 }), /结构不符合预期/)
  await assert.rejects(programmesWith(programsBody('2', '2026-09-25', XWZH_HEAD, XWZH_ROWS), '1'), /频道与请求不一致/)
  await assert.rejects(kankanewsEpg.programmes('1', '20260925', {
    fetchImpl: async () => { throw new TypeError('fetch failed') },
  }), /fetch failed/)
})

await checkAsync('防御：参数非法不发请求，超时中止，响应过大按声明长度或边读边截断', async () => {
  await assert.rejects(kankanewsEpg.programmes('../1', '20260925', { fetchImpl: neverFetch }), /参数非法/)
  await assert.rejects(kankanewsEpg.programmes('1', '2026-09-25', { fetchImpl: neverFetch }), /参数非法/)
  await assert.rejects(kankanewsEpg.programmes('1', '20260925', {
    timeoutMs: 20,
    fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason))
    }),
  }), { name: 'AbortError' })
  await assert.rejects(programmesWith(new Response('{}', { headers: { 'content-length': String(600 * 1024) } })), /响应过大/)
  let pulls = 0
  const endless = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(64 * 1024)) } })
  await assert.rejects(programmesWith(new Response(endless)), /响应过大/)
  assert.ok(pulls < 12, `超限即停，不把整条流读完（读了 ${pulls} 块）`)
})

await checkAsync('按天取：上海日期与机器时区无关，明天空着只用今天，全失败才抛', async () => {
  const dates = []
  const today = await providerProgrammes(kankanewsEpg, '1', {
    now: NOW,
    fetchImpl: async url => {
      const date = new URL(url).searchParams.get('date')
      dates.push(date)
      return json(date === '2026-09-25' ? programsBody('1', date, DFWS_HEAD, DFWS_ROWS) : DFWS_TOMORROW)
    },
  })
  assert.deepEqual(dates.sort(), ['2026-09-25', '2026-09-26'])
  assert.deepEqual(today.map(item => item.start), DFWS_ROWS.map(row => row.start_time * 1000))
  await assert.rejects(providerProgrammes(kankanewsEpg, '1', {
    now: NOW, fetchImpl: async () => json(apiError('1', '4003', '验签失败')),
  }), /验签失败/)
})

await checkAsync('频道：每个登记的 ref 都是模块实际输出的频道，名字一致；只漏掉没有节目单的', async () => {
  const module = getModule('kankanews')
  assert.equal(module.epg, kankanewsEpg)
  assert.equal(module.capabilities.epg, true)
  assert.equal(kankanewsEpg.days, 2)
  const list = await module.fetch({}, {
    fetchImpl: async url => {
      const { pathname } = new URL(url)
      if (pathname === '/content/pc/tv/channels') return json({ code: '1000', result: { limit_time: 180, list: CHANNEL_ROWS } })
      assert.equal(pathname, '/content/pc/news/detail')
      return json({ code: '1000', result: { limit_time: 180, play_info: SCENIC_ROWS } })
    },
  })
  const emitted = new Map(list.groups.flatMap(group => group.dataList).map(channel => [channel.deferredRef, channel.name]))
  assert.equal(emitted.size, 13)
  const mapped = kankanewsEpg.channels()
  for (const { ref, name, key } of mapped) {
    assert.equal(emitted.get(ref), name, `${ref} 应以「${name}」输出`)
    assert.equal(ref, `kankanews-${key}`)
    assert.equal(resolverFor(ref), module)
  }
  // 没登记的恰好是频道表里 is_exist_program=0 的两个台和五路景观
  const withSchedule = CHANNEL_ROWS.filter(row => row.is_exist_program === 1).map(row => `kankanews-${row.id}`)
  assert.deepEqual(mapped.map(channel => channel.ref), withSchedule)
  assert.deepEqual([...emitted.keys()].filter(ref => !withSchedule.includes(ref)), [
    'kankanews-11', 'kankanews-12',
    'kankanews-scenic-15989', 'kankanews-scenic-13755', 'kankanews-scenic-12835',
    'kankanews-scenic-13973', 'kankanews-scenic-13974',
  ])
})

console.log(`\n全部通过：${passed} ✅`)
