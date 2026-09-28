#!/usr/bin/env node
/**
 * 浙江新蓝网官方节目单回归测试：解析、占位日、串联单里的广告宣传过滤、按日取数与错误路径、
 * 频道 ref 与取流模块输出一致。全离线，夹具按 2026-09-25 官网实际返回裁剪。
 *
 * 运行： node scripts/test-cztv-epg.mjs   （可再用 TZ=UTC / TZ=America/Los_Angeles 各跑一遍）
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import cztvEpg, { EPG_API, STATIONS, fillerReason, parseProgrammes, shanghaiDayStart } from '../extractors/cztv/epg.js'
import { getModule, validateModule } from '../extractors/registry.js'
import { providerProgrammes, xmltvTime } from '../utils/epgXmltv.js'
import { appendModuleEpg } from '../utils/moduleEpg.js'
import { epgChannelId } from '../utils/epgAggregator.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }
const json = (body, init = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), {
  status: 200, ...init, headers: { 'content-type': 'application/json; charset=utf-8', ...(init.headers || {}) },
})
const noFetch = async () => { throw new Error('不应请求') }

// ---- 夹具：字段、字段顺序、值的类型都照 p.cztv.com 实际返回 ----

// GET /api/paas/channel/tv（原样，只有 10 行）
const CHANNEL_LIST = {
  alertMessage: '数据获取成功',
  state: 0,
  message: 'success',
  content: { list: [
    ['浙江卫视', 'http://oss.cztv.com/ucc/20200123/4aaea824fa3e4f8391a6243509de7011.png', '101', '天赐的声音(260814 第7季第10期)03下'],
    ['钱江都市', 'http://oss.cztv.com/image/uc/user_20200120/22682936202001201527561695077536.png', '102', '五四宪法与杭州 上'],
    ['经济生活', 'http://oss.cztv.com/ucc/20200123/fb0b3cff52e248e38b05be65c87869ad.png', '103', '《《今天的她们》》24（午夜1206）'],
    ['教科影视', 'http://oss.cztv.com/ucc/20200123/821f9a2695c24835aac3665ef4b2e9a1.png', '104', '《《良辰好景知几何》（二轮）》41（精编版）'],
    ['民生休闲', 'http://oss.cztv.com/ucc/20200123/dde8c15d034d45468c0fe1cd247805a3.png', '106', 'TC-2广告（9.25）'],
    ['新闻', 'http://oss.cztv.com/uploads/2023-06-20/1687261802752146585_newsliveicon.png', '107', '靓丽之窗2026-267'],
    ['少儿频道', 'http://oss.cztv.com/ucc/20200123/312d8aea2f2a4f678b084d2bd8dbcb05.png', '108', '《《彩虹护卫队》》12（少儿高清版）'],
    ['浙江国际', 'http://oss.cztv.com/ucc/20200123/ad3c07c7910e475a8631e4cff5a9431c.png', '110', '靓丽之窗2026-258'],
    ['好易购', 'http://oss.cztv.com/uploads/2023-06-20/1687261764728924223_haoyigouicon.png', '111', '精彩节目'],
    ['之江纪录', 'https://oss.cztv.com/ucc/20221019/c797cd82a3d44ca8a54f19a7e636b8f6.jpg', '112', '检修'],
  ].map(([name, logo, code, playing]) => ({ name, logo, tvLogo: '', station_code: code, station_playing: playing })) },
}

// GET /api/paas/program/<station_code>/<YYYYMMDD>：[program_id, play_time, duration, program_title]
const programPayload = (station, rows) => ({
  alertMessage: '数据获取成功',
  content: { list: [{
    ...station,
    list: rows.map(([id, playTime, duration, title]) => ({
      duration, program_status: 1, program_allow: '111', program_id: id, program_replay: 1, program_title: title, play_time: playTime,
    })),
  }] },
  message: 'success',
  state: 0,
})
const WEISHI = { station_id: 31, station_type: 1, station_name: '浙江卫视', station_icon: 'http://oss.cztv.com/ucc/20200123/4aaea824fa3e4f8391a6243509de7011.png' }
const SHAOER = { station_id: 8, station_type: 1, station_name: '少儿频道', station_icon: 'http://oss.cztv.com/ucc/20200123/312d8aea2f2a4f678b084d2bd8dbcb05.png' }
const MINSHENG = { station_id: 6, station_type: 1, station_name: '民生休闲', station_icon: 'http://oss.cztv.com/ucc/20200123/dde8c15d034d45468c0fe1cd247805a3.png' }

// 101/20260925 裁剪：零点接着昨天的那段、早间一段、晚间一段（到 24:00 切齐）
const WEISHI_0925 = programPayload({ ...WEISHI, station_date: '20260925' }, [
  [4628773, '1790265600000', '3844000', '天赐的声音(260814 第7季第10期)03下'],
  [4628786, '1790289300000', '1500000', '260924新闻深一度'],
  [4628787, '1790290800000', '49000', '《国歌》2021年2月版本(白天剧场版)01'],
  [4628788, '1790290849000', '1260000', '260924浙江新闻联播'],
  [4628789, '1790292109000', '300000', '260924今日聚焦'],
  [4628790, '1790292409000', '90000', '260925早间气象'],
  [4628791, '1790292499000', '150000', '包装1'],
  [4628792, '1790292649000', '15000', '度华年(黄金剧场版 片头)15秒'],
  [4628793, '1790292664000', '2447000', '经典剧场一度华年(黄金剧场版)37V1'],
  [4628794, '1790295111000', '15000', '度华年(黄金剧场版 片尾)15秒'],
  [4628795, '1790295126000', '150000', '包装2'],
  [4628796, '1790295276000', '15000', '度华年(黄金剧场版 片头)15秒'],
  [4628845, '1790330280000', '120000', '（直播）气象预报'],
  [4628846, '1790330400000', '1800000', '（直播）260925新闻深一度'],
  [4628847, '1790332200000', '1260000', '（直播）260925浙江新闻联播'],
  [4628848, '1790333460000', '120000', '（直播）气象'],
  [4628849, '1790333580000', '420000', '（直播）好戏看浙里'],
  [4628850, '1790334000000', '1800000', '（直播）转播中央电视台新闻联播'],
  [4628851, '1790335800000', '145000', '串联1'],
  [4628852, '1790335945000', '90000', '交锋(黄金剧场版 片头)90秒V1'],
  [4628853, '1790336035000', '2489000', '交锋(黄金剧场版)17'],
  [4628854, '1790338524000', '340000', '交锋1-20集(黄金剧场版 片尾)145秒'],
  [4628855, '1790338864000', '30000', '串联2'],
  [4628856, '1790338894000', '2520000', '奇妙练歌房3'],
  [4628857, '1790341414000', '180000', '串联3'],
  [4628858, '1790341594000', '1881000', '奔跑吧14(260508 第14季第3期)02正片上'],
  [4628859, '1790343475000', '2350000', '奔跑吧14(260508 第14季第3期)03正片中'],
  [4628860, '1790345825000', '811000', '奔跑吧14(260508 第14季第3期)04正片下'],
  [4628861, '1790346636000', '120000', '串联4'],
  [4628862, '1790346756000', '5244000', '《2026“文化中国·月是故乡明”华侨华人中秋晚会》'],
])
const WEISHI_0925_KEPT = [
  '天赐的声音(260814 第7季第10期)03下', '260924新闻深一度', '260924浙江新闻联播', '260924今日聚焦', '260925早间气象',
  '经典剧场一度华年(黄金剧场版)37V1', '（直播）气象预报', '（直播）260925新闻深一度', '（直播）260925浙江新闻联播',
  '（直播）气象', '（直播）好戏看浙里', '（直播）转播中央电视台新闻联播', '交锋(黄金剧场版)17', '奇妙练歌房3',
  '奔跑吧14(260508 第14季第3期)02正片上', '奔跑吧14(260508 第14季第3期)03正片中', '奔跑吧14(260508 第14季第3期)04正片下',
  '《2026“文化中国·月是故乡明”华侨华人中秋晚会》',
]

// 108/20260925 裁剪：「片尾版」是 30 分钟正片；台尾 23:59:34 被零点切下 26 秒的碎片
const SHAOER_0925 = programPayload({ ...SHAOER, station_date: '20260925' }, [
  [4629619, '1790292410000', '100000', '9.1S广告2'],
  [4629620, '1790292510000', '1800000', '《大海道》15（高清少儿片尾版）'],
  [4629621, '1790294310000', '145000', '集团公益广告10.23版4'],
  [4629680, '1790324661000', '719000', '《《梦幻镇之成长日记》》32（少儿高清版）'],
  [4629681, '1790325380000', '100000', '9.1S广告2'],
  [4629682, '1790325480000', '719000', '《《梦幻镇之成长日记》》33（少儿高清版）'],
  [4629683, '1790326199000', '45000', '奥运冠军禁毒反兴奋剂女子排球篇'],
  [4629684, '1790326244000', '100000', '9.1S广告3'],
  [4629685, '1790326344000', '419000', '《《梦宝奇游记》》24（少儿高清版）'],
  [4629747, '1790350849000', '865000', '《《少年师爷之稽山寻师》》1（少儿高清版）'],
  [4629748, '1790351714000', '260000', '公益广告5月21日版'],
  [4629749, '1790351974000', '26000', '《《少年师爷之稽山寻师》》2（少儿高清版）'],
])

// 106/20260925 裁剪：23 分钟的广告段、1 分钟的海洋预报
const MINSHENG_0925 = programPayload({ ...MINSHENG, station_date: '20260925' }, [
  [4629405, '1790312060000', '1360000', 'TC-5广告（9.25）'],
  [4629436, '1790330100000', '60000', '6频道海洋预报（9.25）'],
])

// 101/20260926：明天还没排，24 条整点「精彩节目」，program_id 是 926100..926123
const hourly = (firstId, firstMs) => Array.from({ length: 24 }, (_, i) => [firstId + i, String(firstMs + i * 3600000), '3600000', '精彩节目'])
const WEISHI_0926_PLACEHOLDER = programPayload({ ...WEISHI, station_date: '20260926' }, hourly(926100, 1790352000000))
// 日期离谱（如 20261231）或频道号不存在时的兜底：「精彩频道」，时间却是今天（20260925）的
const FALLBACK = programPayload({
  station_id: 0, station_type: 0, station_name: '精彩频道', station_date: '20260925',
  station_icon: 'http://o.cztvcloud.com/0/logos/2016/02/02/e23f35626503f775f6c001423715c919.png',
}, hourly(925100, 1790265600000))

// 2026-09-25 10:00（上海）
const NOW = Date.parse('2026-09-25T02:00:00Z')

console.log('浙江新蓝网节目单测试')

check('解析：毫秒字符串转时间戳，按开始排序，丢广告宣传与 1 分钟以内的条目', () => {
  const list = parseProgrammes(WEISHI_0925, '20260925')
  assert.deepEqual(list.map(item => item.title), WEISHI_0925_KEPT)
  assert.deepEqual(list[0], { title: '天赐的声音(260814 第7季第10期)03下', start: 1790265600000, stop: 1790269444000 })
  const news = list.find(item => item.title === '（直播）260925浙江新闻联播')
  assert.equal(xmltvTime(news.start), '20260925183000 +0800')
  assert.equal(xmltvTime(news.stop), '20260925185100 +0800')
  assert.equal(xmltvTime(list.at(-1).stop), '20260926000000 +0800', '最后一条切齐在零点')
  for (let i = 0; i < list.length; i++) {
    assert.ok(list[i].start < list[i].stop)
    if (i) assert.ok(list[i - 1].stop <= list[i].start, '不重叠')
  }
})

check('过滤：片尾版正片、带片头的长专题、1 分钟预报保留；长广告段、零点碎片丢掉', () => {
  assert.deepEqual(parseProgrammes(SHAOER_0925, '20260925').map(item => item.title), [
    '《大海道》15（高清少儿片尾版）',
    '《《梦幻镇之成长日记》》32（少儿高清版）',
    '《《梦幻镇之成长日记》》33（少儿高清版）',
    '《《梦宝奇游记》》24（少儿高清版）',
    '《《少年师爷之稽山寻师》》1（少儿高清版）',
  ])
  assert.deepEqual(parseProgrammes(MINSHENG_0925, '20260925').map(item => item.title), ['6频道海洋预报（9.25）'])
  // 以下标题取自 09-18～09-25 各台实际数据
  assert.equal(fillerReason('国坤堂（带微微生活家片头）A版', 1192000), '')
  assert.equal(fillerReason('大剧透《微暗之火》15分宣传片', 900000), '')
  assert.equal(fillerReason('9月25日串播QB12', 845000), 'filler')
  assert.equal(fillerReason('7.30永视力6分广告', 1860000), 'filler')
  assert.equal(fillerReason('垫片2025-001', 600000), 'filler')
  assert.equal(fillerReason('浙样的生活12026-019（特别节目宣传片C）', 180000), 'promo')
  assert.equal(fillerReason('青少年健康公益宣传之不止经典7.21起', 105000), 'promo')
  assert.equal(fillerReason('《清明上河图密码》正在MTV', 90000), 'promo')
  assert.equal(fillerReason('9.25节目预告WK1', 90000), 'promo')
  assert.equal(fillerReason('新闻深呼吸2026-268（大舒有话说）', 180000), '')
  assert.equal(fillerReason('检修', 28800000), '')
})

check('占位：明天的整点「精彩节目」与「精彩频道」兜底都返回空，兜底里今天的时间不会记到别的日子', () => {
  assert.deepEqual(parseProgrammes(WEISHI_0926_PLACEHOLDER, '20260926'), [])
  assert.deepEqual(parseProgrammes(FALLBACK, '20261231'), [])
  assert.deepEqual(parseProgrammes(FALLBACK, '20260925'), [])
  // 兜底哪天换成了别的名字，也只收落在所请求那天里的节目
  const renamed = structuredClone(FALLBACK)
  for (const item of renamed.content.list[0].list) item.program_title = '节目'
  assert.equal(parseProgrammes(renamed, '20260925').length, 24)
  assert.deepEqual(parseProgrammes(renamed, '20261231'), [])
})

check('空档与清洗：没有频道或没有节目返回空，标题去空白，跨零点截断、重叠按下一条截齐', () => {
  assert.deepEqual(parseProgrammes({ ...WEISHI_0925, content: { list: [] } }, '20260925'), [])
  assert.deepEqual(parseProgrammes(programPayload({ ...WEISHI, station_date: '20260925' }, []), '20260925'), [])
  const list = parseProgrammes(programPayload({ ...WEISHI, station_date: '20260925' }, [
    [1, '1790348400000', '7200000', '  跨零点晚会  '],           // 23:00 起两小时
    [2, '1790290800000', '1800000', '早间新闻'],                 // 07:00–07:30
    [3, '1790292000000', '1800000', '早间剧场'],                 // 07:20 起，与上一条重叠
    [4, '1790292000000', '600000', '同一时刻的另一条'],
    [5, '1790179200000', '3600000', '昨天的节目'],
    [6, 'abc', '600000', '坏时间'],
    [7, '1790300000000', '0', '零时长'],
    [8, '1790301000000', '600000', '   '],
  ]), '20260925')
  assert.deepEqual(list.map(item => [item.title, xmltvTime(item.start).slice(8, 12), xmltvTime(item.stop).slice(8, 12)]), [
    ['早间新闻', '0700', '0720'],
    ['早间剧场', '0720', '0750'],
    ['跨零点晚会', '2300', '0000'],
  ])
})

await checkAsync('按 station_code + 上海日期请求；带超时信号、不跟随跳转', async () => {
  const requests = []
  const list = await cztvEpg.programmes('101', '20260925', {
    fetchImpl: async (url, options) => { requests.push({ url, options }); return json(WEISHI_0925) },
  })
  assert.equal(list.length, WEISHI_0925_KEPT.length)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, `${EPG_API}101/20260925`)
  assert.equal(EPG_API, 'https://p.cztv.com/api/paas/program/')
  assert.equal(requests[0].options.redirect, 'manual')
  assert.ok(requests[0].options.signal instanceof AbortSignal)
  assert.deepEqual(await cztvEpg.programmes('101', '20260926', { fetchImpl: async () => json(WEISHI_0926_PLACEHOLDER) }), [])
})

await checkAsync('错误路径：HTTP 错误、跳转、非 JSON、state 非 0、结构不对、超大、超时、参数非法都抛出', async () => {
  const fails = (body, init) => cztvEpg.programmes('101', '20260925', { fetchImpl: async () => json(body, init) })
  await assert.rejects(fails('', { status: 503 }), /HTTP 503/)
  await assert.rejects(fails('404 page not found', { status: 404 }), /HTTP 404/)
  await assert.rejects(fails('', { status: 302, headers: { location: 'https://example.com/' } }), /HTTP 302/)
  await assert.rejects(fails('<html>维护中</html>'), /不是 JSON/)
  await assert.rejects(fails({ alertMessage: '系统繁忙', state: 1, message: 'error', content: {} }), /系统繁忙/)
  await assert.rejects(fails({ alertMessage: '数据获取成功', state: 0, message: 'success' }), /结构不符合预期/)
  await assert.rejects(fails({ ...WEISHI_0925, content: { list: [{ ...WEISHI, list: null }] } }), /结构不符合预期/)
  await assert.rejects(fails('{}', { headers: { 'content-length': String(600 * 1024) } }), /过大/)
  await assert.rejects(fails(JSON.stringify({ pad: 'x'.repeat(520 * 1024) })), /过大/)
  await assert.rejects(cztvEpg.programmes('101', '20260925', {
    timeoutMs: 20,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    }),
  }), { name: 'AbortError' })
  await assert.rejects(cztvEpg.programmes('101', '20260925', { fetchImpl: async () => { throw new Error('ECONNRESET') } }), /ECONNRESET/)
  await assert.rejects(cztvEpg.programmes('../x', '20260925', { fetchImpl: noFetch }), /参数非法/)
  await assert.rejects(cztvEpg.programmes('101', '2026-09-25', { fetchImpl: noFetch }), /参数非法/)
  await assert.rejects(cztvEpg.programmes('101', '20260231', { fetchImpl: noFetch }), /参数非法/)
})

check('上海日期零点与运行机器的时区无关', () => {
  assert.equal(shanghaiDayStart('20260925'), Date.parse('2026-09-24T16:00:00Z'))
  assert.equal(shanghaiDayStart('20260101'), Date.parse('2025-12-31T16:00:00Z'))
  assert.ok(Number.isNaN(shanghaiDayStart('20260230')))
  assert.ok(Number.isNaN(shanghaiDayStart('2026925')))
})

await checkAsync('每个节目单频道都是模块真实输出的频道（ref、显示名一致），好易购不列', async () => {
  const module = getModule('cztv')
  assert.equal(module.epg, cztvEpg)
  assert.equal(module.capabilities.epg, true)
  assert.doesNotThrow(() => validateModule(module))
  const result = await module.fetch({}, { fetchImpl: async () => json(CHANNEL_LIST) })
  const emitted = new Map(result.groups.flatMap(group => group.dataList).map(channel => [channel.deferredRef, channel.name]))
  const provided = cztvEpg.channels()
  assert.equal(provided.length, STATIONS.length)
  for (const { ref, name, key } of provided) {
    assert.equal(emitted.get(ref), name, `${ref} 应在模块输出中且同名`)
    assert.equal(ref, `cztv-${key}`)
  }
  assert.deepEqual([...emitted.keys()].sort(), provided.map(channel => channel.ref).sort(), '模块输出的频道都有节目单')
  assert.ok(!provided.some(channel => channel.key === '111'))
})

await checkAsync('接进取数管线：今天有节目、明天占位时只写今天；iptv 侧按 ref 追加进 XMLTV', async () => {
  const fetchImpl = async url => {
    if (String(url).endsWith('/20260925')) return json(String(url).includes('/108/') ? SHAOER_0925 : WEISHI_0925)
    if (String(url).endsWith('/20260926')) return json(WEISHI_0926_PLACEHOLDER)
    throw new Error(`意外请求 ${url}`)
  }
  const merged = await providerProgrammes(cztvEpg, '101', { now: NOW, fetchImpl })
  assert.deepEqual(merged.map(item => item.title), WEISHI_0925_KEPT)

  const dir = mkdtempSync(join(tmpdir(), 'iptv-cztv-epg-'))
  const bak = join(dir, 'playback.xml.bak')
  writeFileSync(bak, '')
  try {
    const result = await appendModuleEpg(bak, [
      { ref: 'cztv-101', name: '浙江卫视' },
      { ref: 'cztv-108', name: '浙江少儿' },
      { ref: 'cztv-111', name: '好易购' },
    ], new Set(), { now: NOW, fetchImpl })
    assert.deepEqual(result, { appended: 2, failed: 0 })
    const xml = readFileSync(bak, 'utf8')
    assert.match(xml, new RegExp(`<channel id="${epgChannelId('浙江卫视')}">`))
    assert.match(xml, /start="20260925183000 \+0800" stop="20260925185100 \+0800">\s*<title lang="zh">（直播）260925浙江新闻联播<\/title>/)
    assert.doesNotMatch(xml, /精彩节目|包装1|广告/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

console.log(`\n全部通过：${passed} ✅`)
