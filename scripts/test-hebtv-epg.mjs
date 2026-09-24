#!/usr/bin/env node
/**
 * 河北冀时官方节目单回归测试（全离线）：请求形状、按天取、上海时间解析与机器时区无关、
 * 宣传段与末档处理、错误路径，以及节目单频道与模块实际发出的电视频道一一对应。
 *
 * 夹具按 2026-09-25 实测响应裁剪，字段与形状保持原样。
 *
 * 运行： node scripts/test-hebtv-epg.mjs
 *       TZ=UTC node scripts/test-hebtv-epg.mjs
 *       TZ=America/Los_Angeles node scripts/test-hebtv-epg.mjs
 */
import assert from 'node:assert/strict'

import hebtvEpg, { CHANNELS, EPG_API, isoDate, parseProgrammes, shanghaiTime } from '../extractors/hebtv/epg.js'
import * as hebtvApi from '../extractors/hebtv/api.js'
import { getModule, validateModule } from '../extractors/registry.js'
import { channelXml, providerProgrammes, shanghaiDays, xmltvTime } from '../utils/epgXmltv.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

const TENANT = '0d91d6cfb98f5b206ac1e752757fc5a9'
const at = (date, time) => Date.parse(`${date}T${time}+08:00`)

// 与实测一致的整行字段（只改 id / 时间 / 名字）
let nextId = 2360630
function row(sourceId, sourceName, date, start, end, name) {
  return {
    sourceId, shield: 0, week: '星期五', addTime: '2026-09-24 11:31:29', addUser: 'yanru', segUrl: null, relaId: null,
    type: null, endDateTime: `${end.includes(' ') ? end : `${date} ${end}`}`, url: null, programlength: null,
    modifyUser: null, relaName: null, modifyTime: null, startDateTime: `${date} ${start}`, sourceType: 1, name,
    comment: null, id: nextId++, sourceName, state: 0, time: start, day: date,
  }
}
const ws = (date, start, end, name) => row(462, '河北卫视直播', date, start, end, name)
const sn = (date, start, end, name) => row(118, '三农频道直播', date, start, end, name)

// 河北卫视 2026-09-25 实测（节选）
const WEISHI_0925 = [
  ws('2026-09-25', '00:08:00', '01:14:00', '不期而遇的生活(5)'),
  ws('2026-09-25', '06:30:00', '07:00:00', '冀时全播报'),
  ws('2026-09-25', '07:00:00', '07:01:00', '中华人民共和国国歌'),
  ws('2026-09-25', '18:30:00', '18:55:00', '河北新闻联播'),
  ws('2026-09-25', '18:55:00', '19:00:00', '天气预报'),
  ws('2026-09-25', '19:00:00', '19:40:00', '中央台新闻'),
  ws('2026-09-25', '23:58:00', '23:59:59', '长城 长城'),
]
// 三农频道 2026-09-25 / 09-26 实测（节选）：宣传段与编辑并进节目名的宣传段
const SANNONG_0925 = [
  sn('2026-09-25', '17:30:00', '17:50:00', '烟火事10'),
  sn('2026-09-25', '17:50:00', '18:00:00', '宣传段'),
  sn('2026-09-25', '18:00:00', '18:50:00', '非常关注(直)'),
  sn('2026-09-25', '18:50:00', '19:00:00', '宣传段'),
  sn('2026-09-25', '19:00:00', '19:40:00', '和美剧场:不离不弃23'),
]
const SANNONG_0926 = [
  sn('2026-09-26', '07:40:00', '08:00:00', '宣传段'),
  sn('2026-09-26', '08:20:00', '08:45:00', '烟火事1 08:40 宣传段'),
  sn('2026-09-26', '08:45:00', '09:15:00', '热播剧场:嫂子嫂子'),
]
const body = (days, extra = {}) => ({ data: days, message: '操作成功', state: 200, success: true, ...extra })
// 实测：不认识的 sourceId、没排到的日子都回空对象；日期格式错、缺 tenantId 回 success false
const EMPTY = body({})
const BAD_DATE = { data: null, message: '时间格式不正确', state: 400, success: false }
const NO_TENANT = { data: null, message: 'API接口header或参数中头必须传递tenantId', state: 700006, success: false }

const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status, headers: { 'content-type': 'application/json;charset=UTF-8' },
})

console.log(`河北节目单测试（TZ=${process.env.TZ || '系统默认'}）`)

check('上海时间文本按 +08:00 解析，与机器时区无关；越界与格式不对得 NaN', () => {
  assert.equal(shanghaiTime('2026-09-25 19:00:00'), Date.parse('2026-09-25T11:00:00Z'))
  assert.equal(shanghaiTime('2026-09-25 00:08:00'), Date.parse('2026-09-24T16:08:00Z'))
  assert.equal(shanghaiTime(' 2026-09-25 23:59:59 '), Date.parse('2026-09-25T15:59:59Z'))
  for (const bad of ['2026-09-25T19:00:00', '2026/09/25 19:00:00', '2026-09-25 19:00', '2026-02-30 00:00:00', '2026-09-25 24:00:00', '', null, undefined]) {
    assert.ok(Number.isNaN(shanghaiTime(bad)), String(bad))
  }
  assert.equal(isoDate('20260925'), '2026-09-25')
  for (const bad of ['2026-09-25', '20260231', '2026092', 'abcdefgh']) assert.throws(() => isoDate(bad), /参数非法/)
})

check('只取所请求那天，按开始时间排序；末档 23:59:59 补到次日零点', () => {
  const programmes = parseProgrammes(body({ '2026-09-25': [...WEISHI_0925].reverse() }), '20260925')
  assert.deepEqual(programmes.map(item => item.title), [
    '不期而遇的生活(5)', '冀时全播报', '中华人民共和国国歌', '河北新闻联播', '天气预报', '中央台新闻', '长城 长城',
  ])
  assert.deepEqual(programmes[5], { title: '中央台新闻', start: at('2026-09-25', '19:00:00'), stop: at('2026-09-25', '19:40:00') })
  assert.equal(programmes.at(-1).stop, at('2026-09-26', '00:00:00'))
  assert.ok(programmes.every(item => item.start < item.stop))
  assert.equal(xmltvTime(programmes[5].start), '20260925190000 +0800')
  assert.match(channelXml('河北卫视', programmes), /start="20260925235800 \+0800" stop="20260926000000 \+0800"/)
  // 响应里别的日子不串进来
  assert.equal(parseProgrammes(body({ '2026-09-24': WEISHI_0925, '2026-09-25': [] }), '20260925').length, 0)
})

check('丢「宣传段」、剥掉并进节目名的宣传段，留下空档', () => {
  const today = parseProgrammes(body({ '2026-09-25': SANNONG_0925 }), '20260925')
  assert.deepEqual(today.map(item => item.title), ['烟火事10', '非常关注(直)', '和美剧场:不离不弃23'])
  assert.equal(today[1].stop, at('2026-09-25', '18:50:00'), '宣传段留作空档，不拉长前一条')
  const weekend = parseProgrammes(body({ '2026-09-26': SANNONG_0926 }), '20260926')
  assert.deepEqual(weekend.map(item => item.title), ['烟火事1', '热播剧场:嫂子嫂子'])
  assert.equal(weekend[0].stop, at('2026-09-26', '08:45:00'))
})

check('去首尾空白、丢残缺与倒挂、同一开始只留一条、重叠截到下一条开始', () => {
  const messy = [
    ws('2026-09-25', '18:00:00', '18:40:00', '  今日资讯 '),
    ws('2026-09-25', '18:00:00', '18:30:00', '重复开始'),
    ws('2026-09-25', '18:30:00', '19:10:00', '长了十分钟'),
    ws('2026-09-25', '19:00:00', '19:40:00', '中央台新闻'),
    ws('2026-09-25', '20:00:00', '19:00:00', '倒挂'),
    ws('2026-09-25', '21:00:00', '21:00:00', '零长'),
    ws('2026-09-25', '21:00:00', '21:30:00', '   '),
    { ...ws('2026-09-25', '22:00:00', '22:30:00', '坏时间'), startDateTime: '22:00' },
    ws('2026-09-26', '00:10:00', '01:00:00', '别的日子'),
  ]
  const programmes = parseProgrammes(body({ '2026-09-25': messy }), '20260925')
  assert.deepEqual(programmes.map(item => item.title), ['今日资讯', '长了十分钟', '中央台新闻'])
  assert.equal(programmes[1].stop, at('2026-09-25', '19:00:00'))
})

check('那天没排、空对象、data 为 null 返回空；状态或结构不对抛错', () => {
  assert.deepEqual(parseProgrammes(EMPTY, '20260925'), [])
  assert.deepEqual(parseProgrammes(body(null), '20260925'), [])
  assert.deepEqual(parseProgrammes(body({ '2026-09-26': SANNONG_0926 }), '20260925'), [])
  assert.throws(() => parseProgrammes(BAD_DATE, '20260925'), /时间格式不正确/)
  assert.throws(() => parseProgrammes(NO_TENANT, '20260925'), /tenantId/)
  assert.throws(() => parseProgrammes(null, '20260925'), /格式异常/)
  assert.throws(() => parseProgrammes(body([]), '20260925'), /格式异常/)
  assert.throws(() => parseProgrammes(body({ '2026-09-25': {} }), '20260925'), /格式异常/)
  const changed = WEISHI_0925.map(item => ({ ...item, startDateTime: item.startDateTime.replace(' ', 'T'), endDateTime: item.endDateTime.replace(' ', 'T') }))
  assert.throws(() => parseProgrammes(body({ '2026-09-25': changed }), '20260925'), /格式异常/)
})

await checkAsync('按官网页面的形状 POST：节目源号 + 租户号（体与头）+ 当天起止同一天', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    return json(body({ '2026-09-25': WEISHI_0925 }))
  }
  const programmes = await hebtvEpg.programmes('462', '20260925', { fetchImpl })
  assert.equal(programmes.length, 7)
  const [call] = calls
  assert.equal(call.url, EPG_API)
  assert.equal(call.init.method, 'POST')
  assert.deepEqual(JSON.parse(call.init.body), { sourceId: '462', tenantId: TENANT, day: '2026-09-25', dayEnd: '2026-09-25' })
  assert.equal(call.init.headers['Content-Type'], 'application/json')
  assert.equal(call.init.headers.tenantId, TENANT)
  assert.equal(call.init.redirect, 'manual')
  assert.ok(call.init.signal instanceof AbortSignal)
})

await checkAsync('没排到的日子返回空数组；HTTP、跳转、非 JSON、过大、网络错误都抛出', async () => {
  assert.deepEqual(await hebtvEpg.programmes('462', '20270101', { fetchImpl: async () => json(EMPTY) }), [])
  const cases = [
    [() => json({}, 503), /HTTP 503/],
    [() => new Response(null, { status: 302, headers: { location: 'https://example.com/' } }), /HTTP 302/],
    [() => new Response('<html>维护中</html>', { status: 200 }), /不是 JSON/],
    [() => json(NO_TENANT), /tenantId/],
    [() => new Response('x'.repeat(600 * 1024)), /过大/],
    [() => new Response('{}', { headers: { 'content-length': String(10 * 1024 * 1024) } }), /过大/],
    [() => { throw new TypeError('fetch failed') }, /fetch failed/],
  ]
  for (const [respond, pattern] of cases) {
    await assert.rejects(hebtvEpg.programmes('462', '20260925', { fetchImpl: async () => respond() }), pattern)
  }
  const never = async () => { throw new Error('不应请求') }
  await assert.rejects(hebtvEpg.programmes('../x', '20260925', { fetchImpl: never }), /参数非法/)
  await assert.rejects(hebtvEpg.programmes('462', '2026-09-25', { fetchImpl: never }), /参数非法/)
})

await checkAsync('超时由 AbortController 中止', async () => {
  const hang = async (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))
  await assert.rejects(hebtvEpg.programmes('462', '20260925', { fetchImpl: hang, timeoutMs: 30 }), { name: 'AbortError' })
})

await checkAsync('经公共件取今天 + 明天：每天一次请求、按天合并', async () => {
  const days = shanghaiDays(Date.now(), 2)
  const iso = days.map(day => `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}`)
  const requested = []
  const fetchImpl = async (_url, init) => {
    const { day } = JSON.parse(init.body)
    requested.push(day)
    return json(body({ [day]: [ws(day, '19:00:00', '19:40:00', '中央台新闻'), ws(day, '23:58:00', '23:59:59', '长城 长城')] }))
  }
  const programmes = await providerProgrammes(hebtvEpg, '462', { fetchImpl })
  assert.deepEqual(requested.sort(), iso)
  assert.equal(programmes.length, 4)
  assert.equal(xmltvTime(programmes[0].start), `${days[0]}190000 +0800`)
  assert.equal(programmes[1].stop - programmes[1].start, 2 * 60 * 1000, '末档补到零点')
  assert.ok(programmes.every((item, index) => index === 0 || programmes[index - 1].stop <= item.start))
})

await checkAsync('节目单频道与模块实际发出的电视频道一一对应，景观不出节目单', async () => {
  // 栏目 catalogId=32557 实测的 7 条稿件（字段裁剪），三佳购物由取流侧排除
  const article = (id, title, uri) => ({
    id, title, logo: 'https://pic.cmc.hebrts.cn/0/logo.png',
    appCustomParams: { movie: { liveUri: uri, liveKey: 'k5m9p2x8r4b3' } },
    liveVideo: [{ formats: [{ url: `https://tv.pull.hebtv.com${uri}` }] }],
  })
  const news = [
    article(10524916, '河北卫视', '/jishi/weishipindao.m3u8'),
    article(10516507, '经济生活', '/jishi/jingjishenghuo.m3u8'),
    article(10516509, '河北都市', '/jishi/dushipindao.m3u8'),
    article(10516510, '文旅体育', '/zhibo/yingshijupindao.m3u8'),
    article(10516511, '少儿科教', '/jishi/shaoerkejiao.m3u8'),
    article(10516508, '三农频道', '/jishi/nongminpindao.m3u8'),
    article(10516513, '三佳购物', '/zhibo/sanjiagouwu.m3u8'),
  ]
  const scenic = {
    id: 11605050, title: '慢直播丨石家庄', type: '15', logo: 'https://pic.cmc.hebrts.cn/0/sjz.png',
    appCustomParams: JSON.stringify({ customStyle: { imgPath: [] }, movie: { liveStatus: '1' } }),
  }
  const fetchImpl = async url => {
    const href = String(url)
    if (href === hebtvApi.CHANNEL_LIST_URL) return json({ returnCode: '0000', returnData: { news }, returnDesc: '成功', state: 0, success: true })
    if (href.startsWith(hebtvApi.SCENIC_LIST_URL)) return json({ data: { pageRecords: [scenic] } })
    if (href.startsWith(hebtvApi.SCENIC_DETAIL_URL)) {
      return json({ data: {
        articleId: '11605050', title: '慢直播丨石家庄', status: 1, cdnUri: '/live/sjz.m3u8', cdnKey: 'abc123',
        livePath: 'https://live.pull.hebtv.com/live/sjz.m3u8',
      } })
    }
    throw new Error(`意外请求 ${href}`)
  }
  hebtvApi.clearCache()
  const module = getModule('hebtv')
  const result = await module.fetch({}, { fetchImpl })
  hebtvApi.clearCache()
  const byGroup = Object.fromEntries(result.groups.map(group => [group.name, group.dataList]))
  const emittedTv = byGroup['河北电视台'].map(channel => [channel.deferredRef, channel.name])
  const provided = hebtvEpg.channels().map(channel => [channel.ref, channel.name])
  assert.equal(emittedTv.length, 6)
  assert.deepEqual(new Map(provided), new Map(emittedTv), '每个电视频道都有节目单，且没有多余的 ref')
  assert.equal(byGroup['河北景观'].length, 1)
  assert.ok(!provided.some(([ref]) => ref === byGroup['河北景观'][0].deferredRef), '景观慢直播不出节目单')
  assert.ok(provided.every(([ref]) => module.claimsRef(ref)))
  assert.deepEqual(hebtvEpg.channels().map(channel => channel.key), ['462', '114', '62', '334', '70', '118'])
  assert.equal(CHANNELS.length, 6)
})

check('模块挂上节目单且通过注册表校验', () => {
  const module = getModule('hebtv')
  assert.equal(module.epg, hebtvEpg)
  assert.equal(module.capabilities.epg, true)
  assert.equal(hebtvEpg.days, 2)
  assert.doesNotThrow(() => validateModule(module))
})

console.log(`\n全部通过：${passed} ✅`)
