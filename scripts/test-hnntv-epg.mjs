#!/usr/bin/env node
/**
 * 海南网台官方节目单回归测试：七天返回里挑出指定日期、北京时间解析、错误路径、
 * 节目单频道与模块实际输出的频道一一对应。全部离线，夹具按 2026-09-25 实测返回裁剪。
 *
 * 运行： node scripts/test-hnntv-epg.mjs
 *       TZ=UTC node scripts/test-hnntv-epg.mjs
 *       TZ=America/Los_Angeles node scripts/test-hnntv-epg.mjs
 */
import assert from 'node:assert/strict'

import hnntvEpg, { EPG_API, parseShanghaiTime, pickDay } from '../extractors/hnntv/epg.js'
import { clearCache } from '../extractors/hnntv/api.js'
import { getModule, resolverFor, validateModule } from '../extractors/registry.js'
import { channelXml, providerProgrammes } from '../utils/epgXmltv.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

const shanghai = text => Date.parse(`${text.replace(' ', 'T')}+08:00`)
const json = (body, init) => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json' },
  ...init,
})

// 实测条目的全部字段；replayMode / liveMode 是官网回看、直播的版权屏蔽标记，节目单用不上
const entry = ([id, code, durationBySecond, showName, replayMode, liveMode, startDatetime, endDatetime, date, week, status]) => (
  { id, code, durationBySecond, showName, replayMode, liveMode, startDatetime, endDatetime, date, week, status }
)
const WEEK = { '2026-09-19': '周六', '2026-09-20': '周日', '2026-09-21': '周一', '2026-09-22': '周二', '2026-09-23': '周三', '2026-09-24': '周四', '2026-09-25': '周五' }
const day = (date, rows) => ({ date, week: WEEK[date], schedules: rows.map(entry) })

// GET /api/schedule/byDay?channelId=13（海南卫视）：今天 + 往前六天，每天首尾各留一两条
const SCHEDULE_13 = {
  businessCode: '00000',
  resultSet: [
    day('2026-09-19', [
      [6861266, 'schedule_af91d0a9-34c3-4196-ab1c-037f77ece740', 899, '卫视高尔夫', 0, 0, '2026-09-19 00:00:01', '2026-09-19 00:15:00', '2026-09-19', '周六', 1],
      [6861286, 'schedule_d86fd082-5294-4795-92f6-9112f67cd709', 1799, '乡村振兴电视夜校', 0, 0, '2026-09-19 23:30:00', '2026-09-19 23:59:59', '2026-09-19', '周六', 1],
    ]),
    day('2026-09-20', [
      [6861310, 'schedule_e40b7e92-95d4-4b8c-9fbc-c955db2c89f8', 2399, '纪录中国', 0, 0, '2026-09-20 23:20:00', '2026-09-20 23:59:59', '2026-09-20', '周日', 1],
    ]),
    day('2026-09-21', [
      [6861332, 'schedule_54841f64-6604-4675-be0c-48ffb775954b', 2399, '卫视高尔夫', 0, 0, '2026-09-21 23:20:00', '2026-09-21 23:59:59', '2026-09-21', '周一', 1],
    ]),
    day('2026-09-22', [
      [6865604, 'schedule_9a3aee57-6056-40db-a4ae-65cd71e57f62', 2399, '卫视高尔夫', 0, 0, '2026-09-22 23:20:00', '2026-09-22 23:59:59', '2026-09-22', '周二', 1],
    ]),
    day('2026-09-23', [
      [6865608, 'schedule_a1b7a2bb-0287-460c-bb45-9b8ca28ba9f2', 2399, '卫视高尔夫', 0, 0, '2026-09-23 23:20:00', '2026-09-23 23:59:59', '2026-09-23', '周三', 1],
    ]),
    day('2026-09-24', [
      [6865609, 'schedule_d4e79010-add5-449b-b21b-f14380b157f9', 899, '卫视高尔夫', 0, 0, '2026-09-24 00:00:01', '2026-09-24 00:15:00', '2026-09-24', '周四', 1],
      [6865632, 'schedule_5bc1af74-9880-419e-92e0-bb240c3259ec', 2399, '卫视高尔夫', 0, 0, '2026-09-24 23:20:00', '2026-09-24 23:59:59', '2026-09-24', '周四', 1],
    ]),
    day('2026-09-25', [
      [6866338, 'schedule_53a34f6a-3d31-40ca-b637-90c69ac32f5d', 8399, '卫视高尔夫', 0, 0, '2026-09-25 00:00:01', '2026-09-25 02:20:00', '2026-09-25', '周五', 1],
      [6866339, 'schedule_099ce33d-d125-49b7-b698-7fcb655dd4a2', 1380, '潮起海之南', 0, 0, '2026-09-25 02:20:00', '2026-09-25 02:43:00', '2026-09-25', '周五', 1],
      [6866353, 'schedule_0295f443-2ff0-46da-8c87-06753afe2bb8', 450, '天气预报', 0, 0, '2026-09-25 18:22:30', '2026-09-25 18:30:00', '2026-09-25', '周五', 1],
      [6866354, 'schedule_e3f0518a-a06d-48bf-b47a-b08097231f20', 1800, '海南新闻联播（直播）', 0, 0, '2026-09-25 18:30:00', '2026-09-25 19:00:00', '2026-09-25', '周五', 1],
      [6866355, 'schedule_ab435012-14f1-407c-a401-cb340861b96f', 1800, '新闻联播', 0, 0, '2026-09-25 19:00:00', '2026-09-25 19:30:00', '2026-09-25', '周五', 1],
      [6866356, 'schedule_86c123f7-980f-46f2-bbe8-19de99cdb29f', 1500, '步步为营', 0, 0, '2026-09-25 19:30:00', '2026-09-25 19:55:00', '2026-09-25', '周五', 1],
      [6866361, 'schedule_05a4974a-866a-495d-98d1-98b46ea06e88', 2399, '卫视高尔夫', 0, 0, '2026-09-25 23:20:00', '2026-09-25 23:59:59', '2026-09-25', '周五', 1],
    ]),
  ],
  description: '',
  count: 7,
  currentTime: '2026-09-25 00:52:45',
}

// GET /api/channel?type=1：官网频道表（模块 fetch() 的输入），外加一路广播看模块是否滤掉
const CHANNEL_LIST = {
  businessCode: '00000',
  resultSet: [
    { id: 13, name: '海南卫视', code: 'STHaiNan_channel_lywsgq', cspCode: 'fusion01000000050000000000000258', type: 1, channelNumber: 0, liveUrl: 'https://live2.hnntv.cn/srs/tv/lywsgq.m3u8', replayUrl: 'https://live2.hnntv.cn/play/lywsgq/playlist.m3u8' },
    { id: 5, name: '三沙卫视', code: 'STHaiNan_channel_ssws', cspCode: 'fusion01000000050000000000000114', type: 1, channelNumber: 0, liveUrl: 'https://livessws.hnntv.cn/live/ssws_260111hnntv.m3u8', replayUrl: 'https://live2.hnntv.cn/play/ssws/playlist.m3u8' },
    { id: 1, name: '海南自贸', code: 'jjpd', cspCode: 'fusion01000000050000000000000011', type: 1, channelNumber: 0, liveUrl: 'https://live2.hnntv.cn/srs/tv/jjpd.m3u8', replayUrl: 'https://live2.hnntv.cn/play/jjpd/playlist.m3u8' },
    { id: 3, name: '海南新闻', code: 'STHaiNan_channel_xwpd', cspCode: 'fusion01000000050000000000000015', type: 1, channelNumber: 0, liveUrl: 'https://live2.hnntv.cn/srs/tv/xwpd.m3u8', replayUrl: 'https://live2.hnntv.cn/play/xwpd/playlist.m3u8' },
    { id: 4, name: '海南社会与法', code: 'ggpd', cspCode: 'fusion01000000050000000000000012', type: 1, channelNumber: 0, liveUrl: 'https://live2.hnntv.cn/srs/tv/ggpd.m3u8', replayUrl: 'https://live2.hnntv.cn/play/ggpd/playlist.m3u8' },
    { id: 6, name: '海南文旅', code: 'wlpd', cspCode: 'fusion01000000050000000000000013', type: 1, channelNumber: 0, liveUrl: 'https://live2.hnntv.cn/srs/tv/wlpd.m3u8', replayUrl: 'https://live2.hnntv.cn/play/wlpd/playlist.m3u8' },
    { id: 7, name: '海南少儿', code: 'sepd', cspCode: 'fusion01000000050000000000000014', type: 1, channelNumber: 0, liveUrl: 'https://live2.hnntv.cn/srs/tv/sepd.m3u8', replayUrl: 'https://live2.hnntv.cn/play/sepd/playlist.m3u8' },
    { id: 8, name: '海南交通广播', code: 'jtgb', cspCode: 'fusion01000000050000000000000016', type: 2, channelNumber: 0, liveUrl: 'https://live2.hnntv.cn/srs/radio/jtgb.m3u8', replayUrl: '' },
  ],
  description: '',
  count: 8,
  currentTime: '2026-09-25 00:52:25',
}

// 实测：不存在的频道回空的七天、非数字 channelId 回 500、缺参回 10001
const UNKNOWN_CHANNEL = { businessCode: '00000', resultSet: [], description: '', count: 0, currentTime: '2026-09-25 00:55:10' }
const MISSING_CHANNEL = { businessCode: '10001', resultSet: null, description: '频道信息不可为空', count: 0, currentTime: '2026-09-25 00:55:11' }

const clone = value => structuredClone(value)
const serve = body => async () => json(body)

console.log('海南网台节目单测试')

check('「YYYY-MM-DD HH:mm:ss」一律按北京时间解析，非法值返回 NaN', () => {
  assert.equal(parseShanghaiTime('2026-09-25 19:00:00'), Date.parse('2026-09-25T11:00:00Z'))
  assert.equal(parseShanghaiTime('2026-09-25 00:00:01'), Date.parse('2026-09-24T16:00:01Z'))
  assert.equal(parseShanghaiTime(' 2026-09-25 23:59:59 '), Date.parse('2026-09-25T15:59:59Z'))
  for (const bad of ['', null, undefined, '2026-09-25', '2026/09/25 19:00:00', '2026-09-31 19:00:00',
    '2026-09-25 24:00:00', '2026-09-25 19:00', '1790334000', '2026-09-25 19:00:00+08:00']) {
    assert.ok(Number.isNaN(parseShanghaiTime(bad)), String(bad))
  }
})

await checkAsync('按 channelId 请求一次，从七天里只挑出指定那天，时间、顺序正确', async () => {
  const calls = []
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return json(SCHEDULE_13) }
  const today = await hnntvEpg.programmes('13', '20260925', { fetchImpl })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${EPG_API}?channelId=13`)
  assert.equal(calls[0].options.redirect, 'manual')
  assert.ok(calls[0].options.signal instanceof AbortSignal)
  assert.deepEqual(today.map(item => item.title),
    ['卫视高尔夫', '潮起海之南', '天气预报', '海南新闻联播（直播）', '新闻联播', '步步为营', '卫视高尔夫'])
  const news = today.find(item => item.title === '新闻联播')
  assert.deepEqual(news, { title: '新闻联播', start: shanghai('2026-09-25 19:00:00'), stop: shanghai('2026-09-25 19:30:00') })
  assert.equal(today[0].start, shanghai('2026-09-25 00:00:01'))
  assert.equal(today.at(-1).stop, shanghai('2026-09-25 23:59:59'))
  assert.ok(today.every((item, i) => item.start < item.stop && (i === 0 || today[i - 1].start <= item.start)))

  const past = await hnntvEpg.programmes('13', '20260924', { fetchImpl })
  assert.deepEqual(past.map(item => [item.title, item.start]), [
    ['卫视高尔夫', shanghai('2026-09-24 00:00:01')],
    ['卫视高尔夫', shanghai('2026-09-24 23:20:00')],
  ])
})

check('乱序排好、标题去首尾空白、官网隐藏（status 0）与残缺条目跳过', () => {
  const payload = clone(SCHEDULE_13)
  const rows = payload.resultSet[6].schedules
  rows.reverse()
  rows[0].showName = '  卫视高尔夫\n'
  rows.push({ ...rows[1], id: 1, showName: '已下线节目', status: 0 })
  rows.push({ ...rows[1], id: 2, showName: '   ' })
  rows.push({ ...rows[1], id: 3, showName: '倒挂', startDatetime: '2026-09-25 20:00:00', endDatetime: '2026-09-25 19:00:00' })
  rows.push({ ...rows[1], id: 4, showName: '零时长', endDatetime: rows[1].startDatetime })
  rows.push({ ...rows[1], id: 5, showName: '坏时间', startDatetime: '19:00' })
  const items = pickDay(payload, '20260925')
  assert.equal(items.length, 7)
  assert.equal(items.at(-1).title, '卫视高尔夫')
  assert.ok(items.every((item, i) => i === 0 || items[i - 1].start <= item.start))
  assert.ok(!items.some(item => ['已下线节目', '倒挂', '零时长', '坏时间', ''].includes(item.title)))
})

await checkAsync('返回里没有那一天（明天、七天以前、不存在的频道）返回空数组', async () => {
  assert.deepEqual(await hnntvEpg.programmes('13', '20260926', { fetchImpl: serve(SCHEDULE_13) }), [])
  assert.deepEqual(await hnntvEpg.programmes('13', '20260918', { fetchImpl: serve(SCHEDULE_13) }), [])
  assert.deepEqual(await hnntvEpg.programmes('999', '20260925', { fetchImpl: serve(UNKNOWN_CHANNEL) }), [])
  const allHidden = clone(SCHEDULE_13)
  for (const row of allHidden.resultSet[6].schedules) row.status = 0
  assert.deepEqual(pickDay(allHidden, '20260925'), [])
  const emptyDay = clone(SCHEDULE_13)
  emptyDay.resultSet[6].schedules = []
  assert.deepEqual(pickDay(emptyDay, '20260925'), [])
})

await checkAsync('HTTP、跳转、业务码、非 JSON、结构与时间格式异常一律抛出', async () => {
  const today = (fetchImpl, key = '13') => hnntvEpg.programmes(key, '20260925', { fetchImpl })
  await assert.rejects(today(async () => json({ businessCode: '10001', description: 'Field error in object ...' }, { status: 500 })), /HTTP 500/)
  await assert.rejects(today(async (_url, options) => {
    assert.equal(options.redirect, 'manual')
    return new Response(null, { status: 302, headers: { location: 'https://example.com/' } })
  }), /HTTP 302/)
  await assert.rejects(today(serve(MISSING_CHANNEL)), /频道信息不可为空/)
  await assert.rejects(today(async () => new Response('<html>维护中</html>', { headers: { 'content-type': 'text/html' } })), /不是 JSON/)
  await assert.rejects(today(async () => new Response('')), /不是 JSON/)
  await assert.rejects(today(serve({ ...SCHEDULE_13, resultSet: { date: '2026-09-25' } })), /结构不符合预期/)
  const noSchedules = clone(SCHEDULE_13)
  noSchedules.resultSet[6].schedules = null
  await assert.rejects(today(serve(noSchedules)), /格式异常/)
  // 时间换成时间戳之类的改版：有条目却一条都读不出来
  const epochTimes = clone(SCHEDULE_13)
  for (const row of epochTimes.resultSet[6].schedules) {
    row.startDatetime = String(Date.parse(`${row.startDatetime.replace(' ', 'T')}+08:00`))
    row.endDatetime = String(Date.parse(`${row.endDatetime.replace(' ', 'T')}+08:00`))
  }
  await assert.rejects(today(serve(epochTimes)), /时间格式异常/)
  await assert.rejects(today(async () => { throw new TypeError('fetch failed') }), /fetch failed/)
})

await checkAsync('超时中止请求，参数非法时不发请求', async () => {
  const hang = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  await assert.rejects(hnntvEpg.programmes('13', '20260925', { fetchImpl: hang, timeoutMs: 20 }), { name: 'AbortError' })
  const never = async () => { throw new Error('不应请求') }
  for (const [key, date] of [['13&x=1', '20260925'], ['', '20260925'], ['abc', '20260925'], ['13', '2026-09-25'], ['13', '']]) {
    await assert.rejects(hnntvEpg.programmes(key, date, { fetchImpl: never }), /参数非法/)
  }
})

await checkAsync('响应过大：声明长度超限直接拒，流式超限读到上限就取消下载', async () => {
  let cancelled = false
  await assert.rejects(hnntvEpg.programmes('13', '20260925', {
    fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true } }), {
      headers: { 'content-length': String(2 * 1024 * 1024) },
    }),
  }), /响应过大/)
  assert.ok(cancelled, '声明超限时丢弃响应体')

  let pulled = 0
  cancelled = false
  await assert.rejects(hnntvEpg.programmes('13', '20260925', {
    fetchImpl: async () => new Response(new ReadableStream({
      pull(controller) { pulled++; controller.enqueue(new Uint8Array(64 * 1024).fill(0x20)) },
      cancel() { cancelled = true },
    })),
  }), /响应过大/)
  assert.ok(cancelled, '流式超限时取消剩余下载')
  assert.ok(pulled <= 20, `只读到上限附近（读了 ${pulled} 块）`)
})

await checkAsync('节目单频道与模块 fetch() 实际输出一一对应，ref 都能路由回本模块', async () => {
  const module = getModule('hnntv')
  assert.equal(module.epg, hnntvEpg)
  assert.equal(module.capabilities.epg, true)
  assert.doesNotThrow(() => validateModule(module))
  clearCache()
  let output
  try {
    output = await module.fetch({}, { fetchImpl: async () => json(CHANNEL_LIST), now: Date.parse('2026-09-25T02:00:00Z') })
  } finally {
    clearCache()
  }
  const emitted = output.groups.flatMap(group => group.dataList)
  const providers = hnntvEpg.channels()
  // 七套电视官网都有节目单（2026-09-25 实测），所以两边应当完全一致
  assert.deepEqual(providers.map(channel => channel.ref), emitted.map(channel => channel.deferredRef))
  for (const channel of providers) {
    const match = emitted.find(item => item.deferredRef === channel.ref)
    assert.equal(channel.name, match.name)
    assert.equal(channel.ref, `hnntv-${channel.key}`, '节目单 channelId 就是频道表 id')
    assert.ok(module.claimsRef(channel.ref))
    assert.equal(resolverFor(channel.ref)?.epg, hnntvEpg, 'utils/moduleEpg.js 按 ref 找得到提供者')
  }
  assert.deepEqual(providers.map(channel => channel.key), ['13', '5', '1', '3', '4', '6', '7'])
})

await checkAsync('接入公共件：days=1 只取上海今天，写出的 XMLTV 时间是 +0800 本地钟点', async () => {
  const requested = []
  const fetchImpl = async url => { requested.push(url); return json(SCHEDULE_13) }
  // 2026-09-25 00:30（上海）——UTC 还是 24 号
  const items = await providerProgrammes(hnntvEpg, '13', { now: Date.parse('2026-09-24T16:30:00Z'), fetchImpl })
  assert.deepEqual(requested, [`${EPG_API}?channelId=13`])
  assert.equal(items.length, 7)
  const xml = channelXml('海南卫视', items)
  assert.match(xml, /<programme channel="海南卫视" start="20260925190000 \+0800" stop="20260925193000 \+0800">\n {8}<title lang="zh">新闻联播<\/title>/)
  assert.match(xml, /start="20260925000001 \+0800" stop="20260925022000 \+0800"/)
  assert.match(xml, /start="20260925232000 \+0800" stop="20260925235959 \+0800"/)
})

console.log(`\n全部通过：${passed} ✅（TZ=${process.env.TZ || '本机'}）`)
