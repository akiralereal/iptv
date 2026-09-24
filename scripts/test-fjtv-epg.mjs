#!/usr/bin/env node
/**
 * 福建官方节目单回归测试（全离线）：省级云直播平台的 app_secret 换取与缓存、按 topic_id 取节目、
 * 占位与串联包装过滤；厦门按 zone 取天、end_time 错位、零点校正；上海时间与机器时区无关；
 * 错误路径；以及节目单频道与模块实际发出的频道一一对应。
 *
 * 夹具按 2026-09-25 实测响应裁剪，字段与形状保持原样。
 *
 * 运行： node scripts/test-fjtv-epg.mjs
 *       TZ=UTC node scripts/test-fjtv-epg.mjs
 *       TZ=America/Los_Angeles node scripts/test-fjtv-epg.mjs
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import fjtvEpg, {
  BUSINESS_URL, PROVINCE_EPG_URL, XIAMEN_EPG_URL,
  clearCache, companySignature, fillerReason, parseProvinceProgrammes, parseXiamenProgrammes, shanghaiDay,
} from '../extractors/fjtv/epg.js'
import { PROVINCE_CHANNELS, XIAMEN_CHANNELS } from '../extractors/fjtv/channels.js'
import * as fjtvApi from '../extractors/fjtv/api.js'
import { getModule, validateModule } from '../extractors/registry.js'
import { channelXml, providerProgrammes, shanghaiDays, xmltvTime } from '../utils/epgXmltv.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

// 2026-09-25 10:00（上海）
const NOW = Date.parse('2026-09-25T02:00:00Z')
const ZONGHE = '665248990102917120'
const SECRET = 'ea574ead10512926477d6728c1ad1db0'

// api/topic/business 实测响应（client_info 只留几项）
const businessBody = (secret = SECRET) => ({
  error_code: 200, error_message: 'success',
  result: {
    title: '', app_secret: secret, tenant_id: '0', company_id: '468',
    client_info: { id: '651426062114234368', custom_appid: '468', tenant_id: '0', client_name: '海博TV' },
  },
})
// 不认识的 topic_id
const BUSINESS_EMPTY = { error_code: 200, error_message: 'success', result: [] }

const provinceRow = (id, title, date, startTime, endTime, start, stop, status = 0) => ({
  id, title, date, start_time: startTime, end_time: endTime,
  star_time_timestamp: start, end_time_timestamp: stop, toff: stop - start, time_status: status,
})
// 福建综合 2026-9-25 实测（20 条里留 5 条）
const ZONGHE_0925 = [
  provinceRow('961686217860730880', '重播：福建新闻联播', '2026-09-25', '00:25:00', '00:52:00', 1790267100, 1790268720, 2),
  provinceRow('961686217869119488', '重播：帮帮团', '2026-09-25', '00:52:00', '02:22:00', 1790268720, 1790274120, 1),
  provinceRow('961686217923645440', '福建新闻联播', '2026-09-25', '19:35:00', '20:05:00', 1790336100, 1790337900),
  provinceRow('961686217927839744', '新闻启示录', '2026-09-25', '20:05:00', '20:20:00', 1790337900, 1790338800),
  provinceRow('961686217944616960', '精选剧场：绝密使命', '2026-09-25', '22:45:00', '23:59:59', 1790347500, 1790351999),
]
// 福建少儿、文旅体育 2026-9-25 实测里的串联包装与尾随空格
const SHAONIAN_0925 = [
  provinceRow('961641786025742336', '中国熊猫之守护传说（100）', '2026-09-25', '07:00:00', '07:11:39', 1790290800, 1790291499),
  provinceRow('961641786084462592', '福建五色系列-4红色初心中的政绩观', '2026-09-25', '09:54:22', '09:55:27', 1790301262, 1790301327),
  provinceRow('961641786126405632', '福建五色系列-4红色初心中的政绩观', '2026-09-25', '12:13:12', '12:17:05', 1790309592, 1790309825),
  provinceRow('961641786176737280', '王文教总宣', '2026-09-25', '13:51:01', '13:54:23', 1790315461, 1790315663),
  provinceRow('961641786273206272', '偶们来了片头', '2026-09-25', '17:36:40', '17:36:55', 1790329000, 1790329015),
  provinceRow('961641786394841088', '超高清视界 让生活变得更美好宣传', '2026-09-25', '21:59:08', '22:04:14', 1790344748, 1790345054),
  provinceRow('961685729199149056', '福建文旅发布 ', '2026-09-25', '23:10:30', '23:22:30', 1790349030, 1790349750),
  provinceRow('961685729211731968', '2026《清新福建》 12', '2026-09-25', '23:54:30', '23:59:59', 1790351670, 1790351999),
]
// 次日还没录入、以及东南卫视天天都是这种：24 条整点「精彩节目」，date 不补零（留 3 条）
const PLACEHOLDER_0926 = [
  provinceRow('961803386787549184', '精彩节目', '2026-9-26', '00:00:00', '01:00:00', 1790352000, 1790355600),
  provinceRow('961803386787549185', '精彩节目', '2026-9-26', '01:00:00', '02:00:00', 1790355600, 1790359200),
  provinceRow('961803386787549207', '精彩节目', '2026-9-26', '23:00:00', '23:59:59', 1790434800, 1790438399),
]
const listBody = rows => ({ error_code: 200, error_message: 'success', result: rows })
const REJECTED_MISSING = { error_code: 10001, error_message: '签名错误1', result: [] }
const REJECTED_WRONG = { error_code: 10002, error_message: '客户信息不存在', result: [] }

const xiamenRow = (channelId, start, end, toff, startText, endText, theme, dates, name = '厦视一套') => ({
  id: start, channel_id: channelId, start_time: start, end_time: end, toff, start: startText, end: endText,
  theme, dates, channel_name: name,
})
// 厦视一套 zone 省略（今天）实测，23 条留 4 条
const XIAMEN_0925 = [
  xiamenRow('16', 1790265600, 1790268000, 2400, '00:00', '00:40', '父亲的身份17-19', '2026-09-25'),
  xiamenRow('16', 1790332200, 1790334000, 1800, '18:30', '19:00', '厦视新闻', '2026-09-25'),
  xiamenRow('16', 1790334000, 1790336100, 2100, '19:00', '19:35', '新闻联播', '2026-09-25'),
  xiamenRow('16', 1790345400, 1790351940, 6599, '22:10', '23:59', '父亲的身份20-22', '2026-09-25'),
]
// zone=1 实测：start_time 是明天的，end_time 却套着今天的日期
const XIAMEN_0926 = [
  xiamenRow('16', 1790352000, 1790268000, 2400, '00:00', '00:40', '父亲的身份20-22', '2026-09-26'),
  xiamenRow('16', 1790420400, 1790336100, 2100, '19:00', '19:35', '新闻联播', '2026-09-26'),
  xiamenRow('16', 1790431800, 1790351940, 6599, '22:10', '23:59', '父亲的身份23-25', '2026-09-26'),
]
// 厦视三套只有占位
const XIAMEN_18_0925 = [
  xiamenRow('18', 1790265600, 1790269200, 3600, '00:00', '01:00', '精彩节目', '2026-09-25', '直播通道3'),
  xiamenRow('18', 1790348400, 1790351940, 3599, '23:00', '23:59', '精彩节目', '2026-09-25', '直播通道3'),
]

// 讯飞 WAF 对浏览器 UA 的拦截页（裁剪）
const WAF_PAGE = '<!doctype html><html><head><meta charset=utf-8><title>403 Forbidden</title></head><body>抱歉，您的请求被阻断了</body></html>'

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
})

/** 假 fetch：business、省级节目单、厦门节目单各走各的；记下每次请求。 */
function fakeFetch({
  businessFn = () => json(businessBody()),
  provinceFn = () => json(listBody(ZONGHE_0925)),
  xiamenFn = () => json(XIAMEN_0925),
} = {}) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const call = { url: new URL(String(url)), init }
    calls.push(call)
    const base = call.url.origin + call.url.pathname
    if (base === BUSINESS_URL) return businessFn(call, calls)
    if (base === PROVINCE_EPG_URL) return provinceFn(call, calls)
    if (base === XIAMEN_EPG_URL) return xiamenFn(call, calls)
    throw new Error(`意外请求 ${url}`)
  }
  const only = target => () => calls.filter(c => c.url.origin + c.url.pathname === target)
  return { fetchImpl, calls, business: only(BUSINESS_URL), province: only(PROVINCE_EPG_URL), xiamen: only(XIAMEN_EPG_URL) }
}

console.log(`福建节目单测试（TZ=${process.env.TZ || '系统默认'}）`)

check('上海日期按 +08:00 切天，与机器时区无关；非法日期返回 null', () => {
  assert.deepEqual(shanghaiDay('20260925'), {
    start: Date.parse('2026-09-24T16:00:00Z'), end: Date.parse('2026-09-25T16:00:00Z'), iso: '2026-09-25', loose: '2026-9-25',
  })
  assert.equal(shanghaiDay('20261101').loose, '2026-11-1')
  for (const bad of ['20260230', '20261301', '2026-09-25', '', null]) assert.equal(shanghaiDay(bad), null, String(bad))
})

check('官网 getSigntrue：md5(468+秒) 的 0/7/14/21/30 位依次换成时间戳两位', () => {
  const now = 1790271000123
  const timestamp = '1790271000'
  const plain = createHash('md5').update(`468${timestamp}`).digest('hex')
  const signed = companySignature('468', now)
  assert.equal(signed.length, 32)
  for (const [index, at] of [0, 7, 14, 21, 30].entries()) {
    assert.equal(signed.slice(at, at + 2), timestamp.slice(index * 2, index * 2 + 2))
  }
  const untouched = [...signed].filter((_, i) => ![0, 1, 7, 8, 14, 15, 21, 22, 30, 31].includes(i)).join('')
  assert.equal(untouched, [...plain].filter((_, i) => ![0, 1, 7, 8, 14, 15, 21, 22, 30, 31].includes(i)).join(''))
})

check('省级：按时间戳取节目、去空白、按开始排序；新闻联播时间对得上', () => {
  const programmes = parseProvinceProgrammes(listBody([...ZONGHE_0925].reverse()), '20260925')
  assert.deepEqual(programmes.map(item => item.title), ['重播：福建新闻联播', '重播：帮帮团', '福建新闻联播', '新闻启示录', '精选剧场：绝密使命'])
  assert.deepEqual(programmes[2], { title: '福建新闻联播', start: Date.parse('2026-09-25T11:35:00Z'), stop: Date.parse('2026-09-25T12:05:00Z') })
  assert.equal(xmltvTime(programmes[2].start), '20260925193500 +0800')
  assert.match(channelXml('福建综合', programmes), /start="20260925224500 \+0800" stop="20260925235959 \+0800"/)
  assert.ok(programmes.every(item => item.start < item.stop))
})

check('串联包装：占位、不到 1 分钟、10 分钟内的宣传片头丢掉，正片与短节目留下', () => {
  const titles = parseProvinceProgrammes(listBody(SHAONIAN_0925), '20260925').map(item => item.title)
  assert.deepEqual(titles, [
    '中国熊猫之守护传说（100）', '福建五色系列-4红色初心中的政绩观', '福建五色系列-4红色初心中的政绩观',
    '福建文旅发布', '2026《清新福建》 12',
  ])
  assert.equal(fillerReason('精彩节目', 3600000), 'placeholder')
  assert.equal(fillerReason('偶们来了片头', 15000), 'short')
  assert.equal(fillerReason('王文教总宣', 202000), 'promo')
  assert.equal(fillerReason('超高清视界 让生活变得更美好宣传', 306000), 'promo')
  assert.equal(fillerReason('全省海洋环境预报', 240000), '')
  assert.equal(fillerReason('福建文旅发布', 720000), '')
  assert.equal(fillerReason('宣传片展播', 11 * 60 * 1000), '', '10 分钟以上的不当包装')
})

check('省级：整天占位、别的日子、空结果都返回空；平台拒绝与格式不对抛错', () => {
  assert.deepEqual(parseProvinceProgrammes(listBody(PLACEHOLDER_0926), '20260926'), [])
  assert.deepEqual(parseProvinceProgrammes(listBody(ZONGHE_0925), '20260926'), [])
  assert.deepEqual(parseProvinceProgrammes(listBody([]), '20260925'), [])
  assert.throws(() => parseProvinceProgrammes(REJECTED_MISSING, '20260925'), error => error.code === 10001 && /签名错误1/.test(error.message))
  assert.throws(() => parseProvinceProgrammes(REJECTED_WRONG, '20260925'), error => error.code === 10002)
  assert.throws(() => parseProvinceProgrammes({ error_code: 200, result: {} }, '20260925'), /结构不符合预期/)
  assert.throws(() => parseProvinceProgrammes(null, '20260925'), /结构不符合预期/)
  const changed = ZONGHE_0925.map(({ star_time_timestamp: _s, end_time_timestamp: _e, ...row }) => row)
  assert.throws(() => parseProvinceProgrammes(listBody(changed), '20260925'), /时间格式异常/)
})

check('厦门：只收那天的行，结束按 start_time + toff，不信别的日子错位的 end_time', () => {
  const today = parseXiamenProgrammes(XIAMEN_0925, '20260925')
  assert.deepEqual(today.dates, ['2026-09-25'])
  assert.deepEqual(today.programmes[2], { title: '新闻联播', start: Date.parse('2026-09-25T11:00:00Z'), stop: Date.parse('2026-09-25T11:35:00Z') })
  const tomorrow = parseXiamenProgrammes(XIAMEN_0926, '20260926')
  assert.deepEqual(tomorrow.programmes.map(item => [xmltvTime(item.start), xmltvTime(item.stop), item.title]), [
    ['20260926000000 +0800', '20260926004000 +0800', '父亲的身份20-22'],
    ['20260926190000 +0800', '20260926193500 +0800', '新闻联播'],
    ['20260926221000 +0800', '20260926235959 +0800', '父亲的身份23-25'],
  ])
  assert.deepEqual(parseXiamenProgrammes(XIAMEN_0926, '20260925'), { programmes: [], dates: ['2026-09-26'] })
  assert.deepEqual(parseXiamenProgrammes(XIAMEN_18_0925, '20260925').programmes, [])
  assert.deepEqual(parseXiamenProgrammes([], '20260925'), { programmes: [], dates: [] })
  assert.throws(() => parseXiamenProgrammes({ error_message: '404 Not Found', status_code: 404 }, '20260925'), /结构不符合预期/)
  const changed = XIAMEN_0925.map(({ toff: _t, ...row }) => row)
  assert.throws(() => parseXiamenProgrammes(changed, '20260925'), /时间格式异常/)
})

await checkAsync('省级：先换 app_secret 再按 topic_id 与「YYYY-M-D」取；用 Node UA、不跟随跳转', async () => {
  clearCache()
  const fake = fakeFetch()
  const programmes = await fjtvEpg.programmes(`province:${ZONGHE}`, '20260925', { fetchImpl: fake.fetchImpl, now: NOW })
  assert.equal(programmes.length, 5)

  const [business] = fake.business()
  assert.equal(business.url.searchParams.get('topic_id'), ZONGHE)
  assert.equal(business.url.searchParams.get('company_id'), '468')
  assert.equal(business.url.searchParams.get('signature'), companySignature('468', NOW))
  const [list] = fake.province()
  assert.deepEqual(Object.fromEntries(list.url.searchParams), {
    topic_id: ZONGHE, date: '2026-9-25', app_secret: SECRET, tenant_id: '0', company_id: '468',
  })
  for (const call of [business, list]) {
    assert.equal(call.init.headers['User-Agent'], 'node', '浏览器 UA 会被 WAF 拦下')
    assert.equal(call.init.redirect, 'manual')
    assert.ok(call.init.signal instanceof AbortSignal)
  }
})

await checkAsync('省级：并发多个频道只换一次 app_secret，一小时内复用', async () => {
  clearCache()
  const fake = fakeFetch()
  const provided = fjtvEpg.channels().filter(channel => channel.key.startsWith('province:'))
  const results = await Promise.all(provided.map(channel =>
    fjtvEpg.programmes(channel.key, '20260925', { fetchImpl: fake.fetchImpl, now: NOW })))
  assert.ok(results.every(list => list.length === 5))
  assert.equal(fake.business().length, 1)
  assert.equal(fake.province().length, provided.length)
  await fjtvEpg.programmes(`province:${ZONGHE}`, '20260925', { fetchImpl: fake.fetchImpl, now: NOW + 59 * 60 * 1000 })
  assert.equal(fake.business().length, 1)
  await fjtvEpg.programmes(`province:${ZONGHE}`, '20260925', { fetchImpl: fake.fetchImpl, now: NOW + 61 * 60 * 1000 })
  assert.equal(fake.business().length, 2)
})

await checkAsync('省级：平台说 app_secret 不对就重换一次；还不对、换不到都抛错', async () => {
  clearCache()
  const fresh = 'f'.repeat(32)
  let issued = 0
  const retry = fakeFetch({
    businessFn: () => json(businessBody(issued++ ? fresh : SECRET)),
    provinceFn: call => json(call.url.searchParams.get('app_secret') === fresh ? listBody(ZONGHE_0925) : REJECTED_WRONG),
  })
  assert.equal((await fjtvEpg.programmes(`province:${ZONGHE}`, '20260925', { fetchImpl: retry.fetchImpl, now: NOW })).length, 5)
  assert.equal(retry.business().length, 2)
  assert.equal(retry.province().length, 2)

  clearCache()
  const denied = fakeFetch({ provinceFn: () => json(REJECTED_MISSING) })
  await assert.rejects(fjtvEpg.programmes(`province:${ZONGHE}`, '20260925', { fetchImpl: denied.fetchImpl, now: NOW }), /签名错误1/)
  assert.equal(denied.province().length, 2, '只重试一次')

  const cases = [
    [{ businessFn: () => json(BUSINESS_EMPTY) }, /鉴权返回异常/],
    [{ businessFn: () => json({ error_code: 200, result: { app_secret: '' } }) }, /鉴权返回异常/],
    [{ businessFn: () => new Response(WAF_PAGE, { status: 403, headers: { 'content-type': 'text/html' } }) }, /鉴权 HTTP 403/],
    [{ provinceFn: () => new Response(WAF_PAGE, { status: 403, headers: { 'content-type': 'text/html' } }) }, /福建节目单 HTTP 403/],
    [{ provinceFn: () => new Response(null, { status: 302, headers: { location: 'https://share1.fjtv.net/appdown/download.html' } }) }, /HTTP 302/],
    [{ provinceFn: () => new Response('<html>维护中</html>', { status: 200 }) }, /不是 JSON/],
    [{ provinceFn: () => { throw new TypeError('fetch failed') } }, /fetch failed/],
    [{ provinceFn: () => new Response('x'.repeat(1100 * 1024)) }, /过大/],
    [{ provinceFn: () => new Response('{}', { headers: { 'content-length': String(10 * 1024 * 1024) } }) }, /过大/],
  ]
  for (const [options, pattern] of cases) {
    clearCache()
    await assert.rejects(fjtvEpg.programmes(`province:${ZONGHE}`, '20260925', { fetchImpl: fakeFetch(options).fetchImpl, now: NOW }), pattern)
  }
})

await checkAsync('厦门：zone 按上海日期相对今天算；带官网 Referer', async () => {
  clearCache()
  const byZone = { 0: XIAMEN_0925, 1: XIAMEN_0926 }
  const fake = fakeFetch({ xiamenFn: call => json(byZone[call.url.searchParams.get('zone')] || []) })
  const today = await fjtvEpg.programmes('xiamen:16', '20260925', { fetchImpl: fake.fetchImpl, now: NOW })
  const tomorrow = await fjtvEpg.programmes('xiamen:16', '20260926', { fetchImpl: fake.fetchImpl, now: NOW })
  assert.equal(today.length, 4)
  assert.equal(tomorrow.length, 3)
  assert.deepEqual(fake.xiamen().map(call => Object.fromEntries(call.url.searchParams)), [
    { channel_id: '16', zone: '0' }, { channel_id: '16', zone: '1' },
  ])
  const [call] = fake.xiamen()
  assert.equal(call.init.headers.Referer, 'https://www.xmtv.cn/')
  assert.equal(call.init.redirect, 'manual')
  assert.equal(fake.business().length, 0, '厦门不经过省级鉴权')

  // 上海已是 09-26 00:00:05 时取 09-26：zone 0；取 09-25：zone -1
  const midnight = Date.parse('2026-09-25T16:00:05Z')
  const late = fakeFetch({ xiamenFn: () => json(XIAMEN_0926) })
  await fjtvEpg.programmes('xiamen:16', '20260926', { fetchImpl: late.fetchImpl, now: midnight })
  await fjtvEpg.programmes('xiamen:16', '20260925', { fetchImpl: late.fetchImpl, now: midnight })
  assert.deepEqual(late.xiamen().map(c => c.url.searchParams.get('zone')).slice(0, 2), ['0', '-1'])
})

await checkAsync('厦门：零点前后服务器还是另一天时按响应里的 dates 校正一次', async () => {
  clearCache()
  // 本机已过零点（上海 09-26 00:00:05），服务器的「今天」还是 09-25
  const midnight = Date.parse('2026-09-25T16:00:05Z')
  const serverDays = { 0: XIAMEN_0925, 1: XIAMEN_0926 }
  const fake = fakeFetch({ xiamenFn: call => json(serverDays[call.url.searchParams.get('zone')] || []) })
  const programmes = await fjtvEpg.programmes('xiamen:16', '20260926', { fetchImpl: fake.fetchImpl, now: midnight })
  assert.equal(programmes.length, 3)
  assert.deepEqual(fake.xiamen().map(call => call.url.searchParams.get('zone')), ['0', '1'])

  // 只有占位或整天都是别的日期且差得离谱：不再追
  const odd = fakeFetch({ xiamenFn: () => json(XIAMEN_18_0925) })
  assert.deepEqual(await fjtvEpg.programmes('xiamen:18', '20260925', { fetchImpl: odd.fetchImpl, now: NOW }), [])
  assert.equal(odd.xiamen().length, 1)
  const far = fakeFetch({ xiamenFn: () => json(XIAMEN_0926) })
  assert.deepEqual(await fjtvEpg.programmes('xiamen:16', '20260923', { fetchImpl: far.fetchImpl, now: NOW }), [])
  assert.equal(far.xiamen().length, 1)
})

await checkAsync('厦门：错误路径与参数校验；太远的日子不请求', async () => {
  clearCache()
  const cases = [
    [() => json({ error_message: '404 Not Found', status_code: 404 }), /结构不符合预期/],
    [() => json({}, 502), /厦门节目单 HTTP 502/],
    [() => { throw new TypeError('fetch failed') }, /fetch failed/],
  ]
  for (const [xiamenFn, pattern] of cases) {
    await assert.rejects(fjtvEpg.programmes('xiamen:16', '20260925', { fetchImpl: fakeFetch({ xiamenFn }).fetchImpl, now: NOW }), pattern)
  }
  const never = async () => { throw new Error('不应请求') }
  for (const [key, day] of [['xiamen:../x', '20260925'], ['province:1', '20260925'], ['cztv:101', '20260925'], ['xiamen:16', '2026-09-25']]) {
    await assert.rejects(fjtvEpg.programmes(key, day, { fetchImpl: never, now: NOW }), /参数非法/)
  }
  assert.deepEqual(await fjtvEpg.programmes('xiamen:16', '20261010', { fetchImpl: never, now: NOW }), [])
  assert.deepEqual(await fjtvEpg.programmes(`province:${ZONGHE}`, '20260801', { fetchImpl: never, now: NOW }), [])
})

await checkAsync('超时由 AbortController 中止', async () => {
  clearCache()
  const hang = fakeFetch({
    xiamenFn: call => new Promise((_, reject) => call.init.signal.addEventListener('abort', () => reject(call.init.signal.reason))),
  })
  await assert.rejects(fjtvEpg.programmes('xiamen:16', '20260925', { fetchImpl: hang.fetchImpl, now: NOW, timeoutMs: 30 }), { name: 'AbortError' })
})

await checkAsync('经公共件按今天、明天取：明天还是占位时只有今天', async () => {
  clearCache()
  const [today, tomorrow] = shanghaiDays(Date.now(), 2)
  const range = shanghaiDay(today)
  const fake = fakeFetch({
    provinceFn: call => (call.url.searchParams.get('date') === range.loose
      ? json(listBody([provinceRow('1', '福建新闻联播', range.iso, '19:35:00', '20:05:00',
        (range.start + 70500000) / 1000, (range.start + 72300000) / 1000)]))
      : json(listBody(PLACEHOLDER_0926))),
  })
  const programmes = await providerProgrammes(fjtvEpg, `province:${ZONGHE}`, { fetchImpl: fake.fetchImpl })
  assert.equal(programmes.length, 1)
  assert.equal(xmltvTime(programmes[0].start), `${today}193500 +0800`)
  assert.deepEqual(fake.province().map(call => call.url.searchParams.get('date')), [range.loose, shanghaiDay(tomorrow).loose])
})

await checkAsync('节目单频道与模块实际发出的延迟解析频道一一对应（ref、显示名）', async () => {
  // 海博地市九路、看厦门三路、福州三路的实测形态（字段裁剪）
  const citySort = '665226484646215680'
  const cityRows = [
    ['727571808803282944', '厦门卫视', 'hb_xmtv/sd'], ['731087090473676800', '福州新闻综合频道', 'hb_fztv/sd'],
    ['727214415649083392', '漳州新闻综合频道', 'hb_zztv/sd'], ['727216678547394560', '三明综合频道', 'hb_smtv/sd'],
    ['727572738755977216', '泉州新闻综合频道', 'hb_qztv/sd'], ['727216450918322176', '南平综合频道', 'hb_nptv/sd'],
    ['727212352215093248', '龙岩综合频道', 'hb_lytv/sd'], ['727213694589505536', '莆田新闻综合频道', 'hb_puttv/sd'],
    ['727574414028103680', '平潭综合频道', 'hb_pttv/sd'], ['727213159174017024', '宁德新闻综合频道', 'hb_ndtv/sd'],
  ].map(([id, title, path]) => ({
    id, title, sort_id: citySort, indexpic: `https://fyfile.fjtv.net/file/${id}.png`,
    topic_camera: [{ streams: [{ hls: `https://live4-fuyun.fjtv.net/${path}/live.m3u8` }] }],
  }))
  const xiamenApiRow = definition => ({
    id: Number(definition.id), name: definition.rawNames[0],
    m3u8: `https://live1.kxm.xmtv.cn/${definition.path}/playlist.m3u8?_upt=4a4bb5f81790278304`,
    channel_stream: [{ is_main: 1, m3u8: `https://live1.kxm.xmtv.cn/${definition.path}/ytkTnG/live.m3u8?_upt=aeda21a51790278304` }],
  })
  const fetchImpl = async requestUrl => {
    const url = new URL(String(requestUrl))
    if (url.href.startsWith(fjtvApi.CHANNEL_LIST_URL)) return json(cityRows)
    if (url.href.startsWith(fjtvApi.XIAMEN_CHANNEL_URL)) {
      return json([xiamenApiRow(XIAMEN_CHANNELS.find(channel => channel.id === url.searchParams.get('channel_id')))])
    }
    if (url.pathname.endsWith('.m3u8')) return new Response('#EXTM3U\n#EXT-X-TARGETDURATION:6\nsegment.ts\n')
    throw new Error(`意外请求 ${url}`)
  }
  fjtvApi.clearXiamenCache()
  const module = getModule('fjtv')
  const result = await module.fetch({}, { fetchImpl })
  fjtvApi.clearXiamenCache()
  const channels = result.groups.flatMap(group => group.dataList)
  const deferred = new Map(channels.filter(channel => channel.deferredRef).map(channel => [channel.deferredRef, channel.name]))
  assert.equal(deferred.size, 9, '省级六路 + 厦门三路')
  const provided = new Map(fjtvEpg.channels().map(channel => [channel.ref, channel.name]))
  assert.equal(provided.size, 7)
  for (const [ref, name] of provided) assert.equal(deferred.get(ref), name, `${ref} 的显示名要与模块发出的一致`)
  assert.ok([...provided.keys()].every(ref => module.claimsRef(ref)))
  // 没有节目单的只有官方只发占位的两路
  const missing = [...deferred.keys()].filter(ref => !provided.has(ref))
  assert.deepEqual(missing, ['fjtv-province-665248966136664064', 'fjtv-xiamen-18'])
  assert.deepEqual(
    [...PROVINCE_CHANNELS, ...XIAMEN_CHANNELS].filter(channel => channel.epg === false).map(channel => channel.name),
    ['东南卫视', '厦视三套'],
  )
  // 直链的地市频道不出节目单，名字也不与节目单频道撞
  const direct = channels.filter(channel => !channel.deferredRef).map(channel => channel.name)
  assert.equal(direct.length, 9 + 3 - 1, '海博九路里的福州台换成福州三路')
  assert.ok(direct.every(name => ![...provided.values()].includes(name)))
})

check('模块挂上节目单且通过注册表校验；频道表与取流共用同一份', () => {
  const module = getModule('fjtv')
  assert.equal(module.epg, fjtvEpg)
  assert.equal(module.capabilities.epg, true)
  assert.equal(fjtvEpg.days, 2)
  assert.doesNotThrow(() => validateModule(module))
  assert.equal(fjtvApi.PROVINCE_CHANNELS, PROVINCE_CHANNELS)
  assert.equal(fjtvApi.XIAMEN_CHANNELS, XIAMEN_CHANNELS)
})

console.log(`\n全部通过：${passed} ✅`)
