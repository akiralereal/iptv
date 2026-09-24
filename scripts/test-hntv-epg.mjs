#!/usr/bin/env node
/**
 * 河南（大象新闻）官方节目单回归测试：上海零点 → 请求地址、签名请求头、解析、编排模板识别、
 * 错误路径、频道 ref 与模块取流输出一一对应。全程离线，夹具按 2026-09-25 实测响应裁剪。
 *
 * 运行： node scripts/test-hntv-epg.mjs
 *       TZ=UTC node scripts/test-hntv-epg.mjs; TZ=America/Los_Angeles node scripts/test-hntv-epg.mjs
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import hntvEpg, { EPG_API, dayStartSeconds, epgUrl, parseProgrammes } from '../extractors/hntv/epg.js'
import { clearCache } from '../extractors/hntv/api.js'
import { getModule, validateModule } from '../extractors/registry.js'
import { providerProgrammes } from '../utils/epgXmltv.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }
const json = (body, init = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), {
  status: 200,
  ...init,
  headers: { 'content-type': 'application/json;charset=UTF-8', ...init.headers },
})
const clone = value => JSON.parse(JSON.stringify(value))

// 2026-09-25 00:00 上海 = 2026-09-24T16:00:00Z
const DAY = '20260925'
const DAY_START = 1790265600

// ---- 夹具：2026-09-25 实测响应裁剪（字段、类型、取值原样，只删掉中间的节目） ----

// 今天，录制系统：update_id 为正，每条带 signa；已播的条目还挂着回看 mp4
const TODAY_145 = {
  update_id: 495772,
  image: '/anonymous/2020/9/18/1306760236945772544.png',
  hotline: '',
  streams: ['http://tv4b.hndt.com/tv/bac95de7017f10003b15149a00000000_transios/playlist.m3u8'],
  name: '河南卫视',
  isprograms: 1,
  description: '',
  time: '00:04-00:40',
  programs: [
    {
      signa: 'MTQ1LDAwOjA0LDAwOjQwLDIwMjYtMDktMjU=',
      downloadUrl: ['https://new-file.hntv.tv/bdmz/data/new_record/jmd_20260925/HeNan1_20260925_0004_0040.mp4'],
      beginTime: '1790265840',
      endTime: '1790268000',
      title: '纪录',
      playUrl: ['https://new-file.hntv.tv/bdmz/data/new_record/jmd_20260925/HeNan1_20260925_0004_0040.mp4'],
    },
    { signa: 'MTQ1LDAwOjQwLDAxOjQ1LDIwMjYtMDktMjU=', beginTime: '1790268000', endTime: '1790271900', title: '武林风精编版' },
    { signa: 'MTQ1LDE4OjMwLDE4OjUyLDIwMjYtMDktMjU=', beginTime: '1790332200', endTime: '1790333520', title: '高清河南新闻联播' },
    { signa: 'MTQ1LDE5OjAwLDE5OjMyLDIwMjYtMDktMjU=', beginTime: '1790334000', endTime: '1790335920', title: '转播央视新闻联播' },
    { signa: 'MTQ1LDIzOjEzLDIzOjU3LDIwMjYtMDktMjU=', beginTime: '1790349180', endTime: '1790351820', title: '万象剧场巡回检察组' },
  ],
  video_streams: ['http://tvcdn.stream3.hndt.com/tv/65c4a6d5017e1000b2b6ea2500000000_transios/playlist.m3u8'],
  live: '纪录',
  cid: 145,
}

// 明天，法治频道：冻结的周编排模板（update_id 0、signa 空、多出 compere_str / logo）
const TEMPLATE_147 = {
  cid: 147,
  description: '',
  image: '/anonymous/2020/9/18/1306759939515092992.png',
  name: '法治频道',
  hotline: '',
  streams: ['http://tv4b.hndt.com/tv/bad89dde017f10009e72dbcb00000000_transios/playlist.m3u8'],
  video_streams: ['http://tvcdn.stream3.hndt.com/tv/65be54a9017e1000af59fb4800000000_transios/playlist.m3u8'],
  update_id: 0,
  isprograms: 1,
  live: '好剧连连看（7集连播）',
  time: '00:10-06:20',
  programs: [
    { beginTime: '1790352600', endTime: '1790374800', title: '好剧连连看（7集连播）', signa: '', playUrl: [''], downloadUrl: [''], compere_str: '', logo: '' },
    { beginTime: '1790374800', endTime: '1790376600', title: '法治现场精编版重播', signa: '', playUrl: [''], downloadUrl: [''], compere_str: '', logo: '' },
  ],
}

// 明天，河南卫视：没有任何数据
const EMPTY_145 = {
  cid: 145,
  description: '',
  image: '/anonymous/2020/9/18/1306760236945772544.png',
  name: '河南卫视',
  hotline: '',
  streams: ['http://tv4b.hndt.com/tv/bac95de7017f10003b15149a00000000_transios/playlist.m3u8'],
  video_streams: ['http://tvcdn.stream3.hndt.com/tv/65c4a6d5017e1000b2b6ea2500000000_transios/playlist.m3u8'],
  update_id: 0,
  isprograms: 0,
  live: '',
  time: '',
  programs: [],
}

// 签名 / 时间戳不对时照样 HTTP 200
const SIGN_REJECTED = { code: -2, msg: 'sign签名校验失败', success: false }
const TIMESTAMP_REJECTED = { code: -2, msg: 'timestamp无效', success: false }

// 频道列表接口里的全部行（含被白名单排除的购物频道），名称与 cid 取自实测
const LIST_ROWS = [
  [145, '河南卫视'], [149, '新闻频道'], [141, '都市频道'], [146, '民生频道'], [147, '法治频道'],
  [151, '公共频道'], [152, '河南乡村频道'], [148, '电视剧频道'], [154, '梨园频道'], [155, '文物宝库'],
  [156, '武术频道'], [157, '睛彩中原'], [194, '国学频道'], [150, '欢腾购物'],
].map(([cid, name]) => ({
  cid,
  name,
  image: `/anonymous/${cid}.png`,
  video_streams: [`http://tvcdn.stream3.hndt.com/tv/${cid}_transios/playlist.m3u8?wsSecret=x&wsTime=${DAY_START + 14400}`],
}))

const shanghaiClock = ms => new Date(ms + 8 * 3600 * 1000).toISOString().slice(11, 16)

console.log('河南节目单测试')

check('上海日期 → 当天零点 unix 秒与地址，不看运行机器的时区', () => {
  assert.equal(dayStartSeconds(DAY), DAY_START)
  assert.equal(dayStartSeconds('20260101'), Date.parse('2026-01-01T00:00:00+08:00') / 1000)
  assert.equal(dayStartSeconds('20261231'), Date.parse('2026-12-31T00:00:00+08:00') / 1000)
  assert.equal(epgUrl('145', DAY), `${EPG_API}145/${DAY_START}`)
  assert.equal(EPG_API, 'https://pubmod.hntv.tv/program/getAuth/vod/originStream/program/')
  for (const bad of ['20260231', '20261301', '2026925', '2026-09-25', '', 'abcdefgh']) {
    assert.ok(Number.isNaN(dayStartSeconds(bad)), bad)
  }
})

check('解析今天的节目单：秒 → 毫秒、按上海时钟落点正确、按开始时间排序', () => {
  const shuffled = clone(TODAY_145)
  shuffled.programs.reverse()
  const programmes = parseProgrammes(shuffled)
  assert.deepEqual(programmes.map(item => item.title), ['纪录', '武林风精编版', '高清河南新闻联播', '转播央视新闻联播', '万象剧场巡回检察组'])
  assert.deepEqual(programmes[3], { title: '转播央视新闻联播', start: 1790334000000, stop: 1790335920000 })
  assert.equal(new Date(programmes[2].start).toISOString(), '2026-09-25T10:30:00.000Z', '河南新闻联播 18:30 +08:00')
  // signa 是「频道,开始,结束,日期」的 base64，逐条对上上海时钟，证明单位与时区都没换错
  for (const [index, item] of TODAY_145.programs.entries()) {
    const [cid, from, to, date] = Buffer.from(item.signa, 'base64').toString().split(',')
    const parsed = programmes[index]
    assert.equal(cid, '145')
    assert.equal(date, '2026-09-25')
    assert.equal(shanghaiClock(parsed.start), from)
    assert.equal(shanghaiClock(parsed.stop), to)
  }
})

check('节目名去空白，缺名、倒挂、非数字时间的条目跳过', () => {
  const payload = clone(TODAY_145)
  payload.programs = [
    { signa: 'x', beginTime: '1790332200', endTime: '1790333520', title: '  高清河南新闻联播 \n' },
    { signa: 'x', beginTime: '1790334000', endTime: '1790335920', title: '   ' },
    { signa: 'x', beginTime: '1790335920', endTime: '1790335920', title: '零长度' },
    { signa: 'x', beginTime: '1790340000', endTime: '1790330000', title: '倒挂' },
    { signa: 'x', beginTime: '', endTime: '1790330000', title: '缺开始' },
    { signa: 'x', beginTime: '17903.5', endTime: '1790340000', title: '小数' },
    null,
  ]
  assert.deepEqual(parseProgrammes(payload), [{ title: '高清河南新闻联播', start: 1790332200000, stop: 1790333520000 }])
})

check('明天往后的编排模板与空日子都当官方没发', () => {
  assert.deepEqual(parseProgrammes(TEMPLATE_147), [])
  assert.deepEqual(parseProgrammes(EMPTY_145), [])
  const noUpdateId = clone(TODAY_145)
  delete noUpdateId.update_id
  assert.deepEqual(parseProgrammes(noUpdateId), [])
})

check('鉴权失败的 200 正文、不认识的 cid、结构不对都抛错', () => {
  assert.throws(() => parseProgrammes(SIGN_REJECTED), /河南节目单接口拒绝：sign签名校验失败/)
  assert.throws(() => parseProgrammes(TIMESTAMP_REJECTED), /timestamp无效/)
  assert.throws(() => parseProgrammes({}), /返回结构不符合预期/)
  assert.throws(() => parseProgrammes([]), /返回结构不符合预期/)
  assert.throws(() => parseProgrammes(null), /返回结构不符合预期/)
  assert.throws(() => parseProgrammes({ update_id: 1, programs: 'x' }), /返回结构不符合预期/)
})

await checkAsync('请求带 sign = SHA-256(盐 + 秒级 timestamp)、官网来源头、不跟随跳转', async () => {
  const now = 1790266012345
  let seen
  const programmes = await hntvEpg.programmes('149', DAY, {
    now,
    fetchImpl: async (url, options) => { seen = { url, options }; return json(TODAY_145) },
  })
  assert.equal(programmes.length, 5)
  assert.equal(seen.url, `${EPG_API}149/${DAY_START}`)
  assert.equal(seen.options.redirect, 'manual')
  assert.ok(seen.options.signal instanceof AbortSignal)
  assert.equal(seen.options.headers.timestamp, '1790266012')
  assert.equal(seen.options.headers.sign, createHash('sha256').update('6ca114a836ac7d731790266012').digest('hex'))
  assert.equal(seen.options.headers.Origin, 'https://static.hntv.tv')
  assert.equal(seen.options.headers.Referer, 'https://static.hntv.tv/kds/')
})

await checkAsync('签名时间取调用那一刻，不是节目单日期', async () => {
  let timestamp
  const before = Math.floor(Date.now() / 1000)
  await hntvEpg.programmes('145', '20260918', {
    fetchImpl: async (_url, options) => { timestamp = Number(options.headers.timestamp); return json(EMPTY_145) },
  })
  assert.ok(timestamp >= before && timestamp <= Math.floor(Date.now() / 1000) + 1)
})

await checkAsync('空日子与编排模板返回空数组，不抛', async () => {
  assert.deepEqual(await hntvEpg.programmes('145', '20260926', { fetchImpl: async () => json(EMPTY_145) }), [])
  assert.deepEqual(await hntvEpg.programmes('147', '20260926', { fetchImpl: async () => json(TEMPLATE_147) }), [])
})

await checkAsync('HTTP 错误、跳转、鉴权失败、非 JSON、网络错误都抛出', async () => {
  const run = fetchImpl => hntvEpg.programmes('145', DAY, { fetchImpl })
  await assert.rejects(run(async () => json('', { status: 503 })), /河南节目单 HTTP 503/)
  await assert.rejects(run(async () => new Response(null, { status: 302, headers: { location: 'https://example.com/' } })), /HTTP 302/)
  await assert.rejects(run(async () => json(SIGN_REJECTED)), /sign签名校验失败/)
  await assert.rejects(run(async () => json({})), /返回结构不符合预期/)
  await assert.rejects(run(async () => json('<html>502 Bad Gateway</html>')), /不是 JSON/)
  await assert.rejects(run(async () => { throw new TypeError('fetch failed') }), /fetch failed/)
})

await checkAsync('响应过大：声明长度超限直接拒，流式读到超限就断开', async () => {
  const run = fetchImpl => hntvEpg.programmes('145', DAY, { fetchImpl })
  await assert.rejects(run(async () => json('{}', { headers: { 'content-length': String(10 * 1024 * 1024) } })), /响应过大/)
  let cancelled = false
  const endless = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(64 * 1024).fill(0x20)) },
    cancel() { cancelled = true },
  })
  await assert.rejects(run(async () => new Response(endless)), /响应过大/)
  assert.ok(cancelled, '超限后断开上游')
})

await checkAsync('超时由 AbortController 打断', async () => {
  const hanging = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
  })
  const startedAt = Date.now()
  await assert.rejects(hntvEpg.programmes('145', DAY, { fetchImpl: hanging, timeoutMs: 30 }), { name: 'AbortError' })
  assert.ok(Date.now() - startedAt < 2000)
})

await checkAsync('非法频道 key 或日期直接拒绝，不联网', async () => {
  const fetchImpl = async () => { throw new Error('不应请求') }
  for (const [key, day] of [['../145', DAY], ['12345', DAY], ['', DAY], ['145', '2026-09-25'], ['145', '20260230']]) {
    await assert.rejects(hntvEpg.programmes(key, day, { fetchImpl }), /参数非法/, `${key} ${day}`)
  }
})

await checkAsync('只取今天：经公共件按上海日期取一天，跨时区也落在同一天', async () => {
  assert.equal(hntvEpg.days, 1)
  const requested = []
  // 上海 09-25 00:30；在 UTC / 洛杉矶跑时本机日期还是 09-24
  const programmes = await providerProgrammes(hntvEpg, '145', {
    now: Date.parse('2026-09-24T16:30:00Z'),
    fetchImpl: async url => { requested.push(url); return json(TODAY_145) },
  })
  assert.deepEqual(requested, [`${EPG_API}145/${DAY_START}`])
  assert.equal(programmes.length, 5)
})

await checkAsync('节目单频道与模块取流输出的 deferredRef 一一对应，cid 即频道 id', async () => {
  clearCache()
  try {
    const result = await getModule('hntv').fetch({}, {
      now: DAY_START * 1000,
      fetchImpl: async () => json(LIST_ROWS),
    })
    const emitted = result.groups.flatMap(group => group.dataList)
    const channels = hntvEpg.channels()
    assert.equal(emitted.length, 13, '购物频道不输出')
    assert.deepEqual(channels.map(channel => channel.ref), emitted.map(channel => channel.deferredRef))
    assert.deepEqual(channels.map(channel => channel.name), emitted.map(channel => channel.name))
    for (const channel of channels) assert.equal(channel.ref, `hntv-${channel.key}`)
    assert.ok(channels.every(channel => /^\d{1,4}$/.test(channel.key)))
  } finally {
    clearCache()
  }
})

check('模块已挂上节目单，提供者可单独拆走（只 import 本目录与 node: 内置）', () => {
  const module = getModule('hntv')
  assert.equal(module.epg, hntvEpg)
  assert.equal(module.capabilities.epg, true)
  assert.doesNotThrow(() => validateModule(module))
  for (const file of ['epg.js', 'sign.js', 'channels.js']) {
    const source = readFileSync(new URL(`../extractors/hntv/${file}`, import.meta.url), 'utf8')
    const specifiers = [...source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map(match => match[1])
    for (const specifier of specifiers) {
      assert.ok(specifier.startsWith('node:') || /^\.\/[\w-]+\.js$/.test(specifier), `${file} → ${specifier}`)
    }
  }
})

console.log(`\n全部通过：${passed} ✅`)
