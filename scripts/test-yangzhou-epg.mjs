#!/usr/bin/env node
/**
 * 扬州官方节目单回归测试：北京时间 yyyyMMddHHmmss 与运行机器时区无关、按开始时间落在当天筛
 * （丢前一天跨零点的那档）、丢不到一分钟的国歌、同一时刻去重、重叠截断、平台拒绝与改版报错、
 * 请求地址与 H5 频道页一致。样本按 2026-09-29 新闻频道（channelId=235）接口的真实响应裁剪。
 *
 * 运行： node scripts/test-yangzhou-epg.mjs
 *       TZ=UTC node scripts/test-yangzhou-epg.mjs
 *       TZ=America/Los_Angeles node scripts/test-yangzhou-epg.mjs
 */
import assert from 'node:assert/strict'

import yangzhouEpg, { EPG_API, epgUrl, parseProgrammes, parseTime, shanghaiDay } from '../extractors/yangzhou/epg.js'
import { CHANNELS } from '../extractors/yangzhou/channels.js'
import { getModule } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }
const sh = text => Date.parse(`${text.replace(' ', 'T')}+08:00`)

const row = (programName, startTime, endTime) => ({
  banFlag: 0, categoryId: 'programme_4', channelId: '235', channelName: '新闻频道', contentType: 2,
  id: `8ad1ad44${startTime}`, liveType: 1, programName, startTime, endTime, status: 1,
})
const ok = rows => ({ costTime: 6, currTime: '20260929220326', data: { rows, totalCount: 0 }, message: '成功', state: 1000, totalCount: 0 })

// 09-29：带前一天 22:14 开始、跨零点的那档；48 秒的国歌；故意乱序；一对同一时刻；一条越过下一条开始
const NEWS_0929 = ok([
  row('星光剧场', '20260928221432', '20260929003017'),
  row('国歌', '20260929070013', '20260929070101'),
  row('新闻女生三把叨（重播）', '20260929113613', '20260929120013'),
  row('扬州新闻', '20260929080013', '20260929083013'),
  row('新闻联播', '20260929190013', '20260929193713'),
  row('新闻联播', '20260929190013', '20260929190513'),
  row('天气预报', '20260929220013', '20260929223015'),
  row('星光剧场', '20260929222715', '20260930002439'),
])

console.log('扬州节目单测试')

check('节目单挂在模块上，四路直链频道按名字对上', () => {
  assert.equal(getModule('yangzhou').epg, yangzhouEpg)
  assert.equal(yangzhouEpg.id, 'yangzhou')
  assert.equal(yangzhouEpg.days, 2)
  assert.deepEqual(yangzhouEpg.channels(), CHANNELS.map(channel => ({ ref: `yangzhou-${channel.id}`, name: channel.name, key: channel.id })))
})

check('北京时间 yyyyMMddHHmmss 换算与运行机器时区无关', () => {
  assert.equal(parseTime('20260929080013'), sh('2026-09-29 08:00:13'))
  assert.equal(parseTime('20260930002439'), sh('2026-09-30 00:24:39'))
  assert.ok(Number.isNaN(parseTime('2026-09-29 08:00')))
  assert.ok(Number.isNaN(parseTime('20260929256000')))
  assert.deepEqual(shanghaiDay('20260929'), { start: sh('2026-09-29 00:00'), end: sh('2026-09-30 00:00') })
  assert.equal(shanghaiDay('20260231'), null)
})

check('请求地址与 H5 频道页一致', () => {
  const url = new URL(epgUrl('235', '20260930'))
  assert.equal(`${url.origin}${url.pathname}`, EPG_API)
  assert.equal(url.searchParams.get('service'), 'getProgramList')
  assert.equal(url.searchParams.get('apiVersion'), '2.9')
  assert.deepEqual(JSON.parse(url.searchParams.get('params')), {
    channelId: '235', idx: 0, size: 200, startTime: '20260930000000', endTime: '20260930235959',
  })
  assert.throws(() => epgUrl('236', '20260930'), /参数非法/)
  assert.throws(() => epgUrl('235', 'bad'), /参数非法/)
})

check('按开始时间取当天，丢国歌与前一天的那档，同一时刻去重、重叠截断', () => {
  const programmes = parseProgrammes(NEWS_0929, '20260929')
  assert.deepEqual(programmes.map(item => item.title), ['扬州新闻', '新闻女生三把叨（重播）', '新闻联播', '天气预报', '星光剧场'])
  assert.deepEqual(programmes[0], { title: '扬州新闻', start: sh('2026-09-29 08:00:13'), stop: sh('2026-09-29 08:30:13') })
  assert.equal(programmes[2].stop, sh('2026-09-29 19:37:13'))
  // 天气预报原本到 22:30:15，截到下一档 22:27:15
  assert.equal(programmes[3].stop, sh('2026-09-29 22:27:15'))
  // 跨零点的末档保留原结束时间
  assert.equal(programmes[4].stop, sh('2026-09-30 00:24:39'))
  assert.deepEqual(parseProgrammes(ok([]), '20260929'), [])
})

check('平台拒绝与改版都报错，不静默给空节目单', () => {
  assert.throws(
    () => parseProgrammes({ currTime: '20260929220340', message: '传入的json数据不正确', state: 2002, totalCount: 0 }, '20260929'),
    error => error.code === 2002 && /传入的json数据不正确/.test(error.message),
  )
  assert.throws(() => parseProgrammes({ state: 1000, data: {} }, '20260929'), /结构不符合预期/)
  assert.throws(() => parseProgrammes([], '20260929'), /结构不符合预期/)
  assert.throws(() => parseProgrammes(ok([row('甲', '2026-09-29 08:00', '2026-09-29 09:00')]), '20260929'), /时间格式异常/)
})

await checkAsync('programmes() 走注入的 fetch；HTTP 错误与非 JSON 抛错', async () => {
  const fetchImpl = async (url, init) => {
    assert.equal(url, epgUrl('235', '20260929'))
    assert.equal(init.redirect, 'manual')
    assert.match(init.headers['User-Agent'], /Chrome/)
    return new Response(JSON.stringify(NEWS_0929))
  }
  assert.equal((await yangzhouEpg.programmes('235', '20260929', { fetchImpl })).length, 5)
  await assert.rejects(
    yangzhouEpg.programmes('235', '20260929', { fetchImpl: async () => new Response('x', { status: 502 }) }),
    /HTTP 502/,
  )
  await assert.rejects(
    yangzhouEpg.programmes('235', '20260929', { fetchImpl: async () => new Response('<html>云盾</html>') }),
    /不是 JSON/,
  )
})

console.log(`\n全部通过：${passed} ✅`)
