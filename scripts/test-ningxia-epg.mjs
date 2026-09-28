#!/usr/bin/env node
/**
 * 宁夏官方节目单（黄河云）回归测试：字段换算、按上海日期过滤、同刻去重与重叠截断、
 * 三套共用一次请求的缓存、错误路径、频道对齐。样本按 2026-09-25 官方接口的真实响应裁剪，字段原样保留。
 *
 * 运行： node scripts/test-ningxia-epg.mjs
 *       TZ=UTC node scripts/test-ningxia-epg.mjs
 */
import assert from 'node:assert/strict'

import ningxiaEpg, { EPG_API, createProvider, dayInfo, parsePayload } from '../extractors/ningxia/epg.js'
import { CHANNELS } from '../extractors/ningxia/api.js'
import { getModule } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }
const sh = text => Date.parse(`${text.replace(' ', 'T')}+08:00`)
const sec = text => sh(text) / 1000

const row = (index, name, from, to) => ({
  index, name, stimestamp: sec(from), otimestamp: sec(to),
  stime: from.replace(/-/g, '/') + ':00', otime: to.replace(/-/g, '/') + ':00',
  times: from.slice(11), timeo: to.slice(11), url: 'https://hls.nxhhy.cn/record/live/nxws/2026-09-25/vod.m3u8', replay: 1, live: 0,
})
const menu = (ename, playbill) => ({ id: '90006', types: 'tvpro', typename: '电视节目单', ename, name: ename, signame: `${ename}1M`, playbill })
const PAYLOAD = {
  errcode: 200, errmsg: '',
  data: {
    appid: 'nxtv-tv',
    menu: [
      // 真实开头与结尾；中间故意放一条同刻重复、一条越过下一档开始
      menu('nxws', [
        row(0, '次黄金档剧场:我是刑警23', '2026-09-25 00:17', '2026-09-25 01:02'),
        row(1, '宁夏新闻联播', '2026-09-25 19:30', '2026-09-25 20:10'),
        row(2, '宁夏新闻联播', '2026-09-25 19:30', '2026-09-25 20:00'),
        row(3, '黄金剧场', '2026-09-25 20:05', '2026-09-25 21:40'),
        row(4, '次黄金档剧场:我是刑警26', '2026-09-25 23:19', '2026-09-25 23:54'),
      ]),
      menu('nxgg', [row(0, '经济30分', '2026-09-25 00:30', '2026-09-25 01:00'), row(1, '宁夏新闻联播', '2026-09-25 23:00', '2026-09-25 23:30')]),
      menu('nxwl', [row(0, '静屏', '2026-09-25 00:00', '2026-09-25 07:00'), row(1, '星空剧场:平凡的世界15、16、17', '2026-09-25 20:55', '2026-09-25 23:30')]),
      // 不是电视节目单的栏目、不认识的频道都跳过
      { types: 'news', ename: 'nxws', playbill: [row(0, '不该出现', '2026-09-25 01:00', '2026-09-25 02:00')] },
      menu('nxjj', [row(0, '测试卡', '2026-09-25 00:00', '2026-09-26 00:00')]),
    ],
  },
}
const reply = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html; charset=UTF-8' } })

console.log('宁夏节目单测试')

check('模块挂上节目单，三套频道按代号对齐，只取今天', () => {
  assert.equal(getModule('ningxia').epg, ningxiaEpg)
  assert.equal(ningxiaEpg.days, 1)
  assert.deepEqual(ningxiaEpg.channels(), [
    { ref: 'ningxia-nxws', name: '宁夏卫视', key: 'nxws' },
    { ref: 'ningxia-nxgg', name: '宁夏公共', key: 'nxgg' },
    { ref: 'ningxia-nxwl', name: '宁夏文旅', key: 'nxwl' },
  ])
  assert.deepEqual(ningxiaEpg.channels().map(row => row.name), CHANNELS.map(row => row.name))
})

check('上海日期换算与运行机器时区无关', () => {
  assert.deepEqual(dayInfo('20260925'), { start: sh('2026-09-25 00:00'), end: sh('2026-09-26 00:00') })
  assert.throws(() => dayInfo('20260931'))
  assert.throws(() => dayInfo('2026-09-25'))
})

check('秒级时间戳换毫秒；同刻只留一条、重叠截到下一档；不认识的栏目与频道跳过', () => {
  const all = parsePayload(PAYLOAD)
  assert.deepEqual([...all.keys()], ['nxws', 'nxgg', 'nxwl'])
  assert.deepEqual(all.get('nxws'), [
    { title: '次黄金档剧场:我是刑警23', start: sh('2026-09-25 00:17'), stop: sh('2026-09-25 01:02') },
    { title: '宁夏新闻联播', start: sh('2026-09-25 19:30'), stop: sh('2026-09-25 20:05') },
    { title: '黄金剧场', start: sh('2026-09-25 20:05'), stop: sh('2026-09-25 21:40') },
    { title: '次黄金档剧场:我是刑警26', start: sh('2026-09-25 23:19'), stop: sh('2026-09-25 23:54') },
  ])
  assert.equal(all.get('nxwl')[0].title, '静屏')
})

check('接口报错、改版或一条都读不出时抛错，不当成「当天没发」', () => {
  assert.throws(() => parsePayload({ errcode: 500, errmsg: 'busy' }), /接口报错：busy/)
  assert.throws(() => parsePayload({ errcode: 200, data: {} }), /格式异常/)
  assert.throws(() => parsePayload({ errcode: 200, data: { menu: [] } }), /格式异常/)
  assert.throws(() => parsePayload({ errcode: 200, data: { menu: [menu('nxws', [{ name: '坏数据' }])] } }), /格式异常/)
})

await checkAsync('三套共用一次请求；按日期过滤，别的日子返回空；10 分钟后重新取、失败不缓存', async () => {
  let clock = 0
  let calls = 0
  const provider = createProvider({ now: () => clock })
  const fetchImpl = async (url, init) => {
    calls++
    assert.equal(url, EPG_API)
    assert.equal(init.redirect, 'manual')
    return reply(PAYLOAD)
  }
  assert.equal((await provider.programmes('nxws', '20260925', { fetchImpl })).length, 4)
  assert.equal((await provider.programmes('nxgg', '20260925', { fetchImpl })).length, 2)
  assert.deepEqual(await provider.programmes('nxwl', '20260926', { fetchImpl }), [])
  assert.equal(calls, 1)
  clock = 10 * 60 * 1000
  await provider.programmes('nxws', '20260925', { fetchImpl })
  assert.equal(calls, 2)

  let failing = true
  const flaky = async () => (failing ? new Response('x', { status: 502 }) : reply(PAYLOAD))
  const fresh = createProvider({ now: () => 0 })
  await assert.rejects(fresh.programmes('nxws', '20260925', { fetchImpl: flaky }), /HTTP 502/)
  failing = false
  assert.equal((await fresh.programmes('nxws', '20260925', { fetchImpl: flaky })).length, 4)
})

await checkAsync('参数非法与非 JSON 响应都拒绝', async () => {
  const provider = createProvider()
  await assert.rejects(provider.programmes('nxjj', '20260925', { fetchImpl: async () => reply(PAYLOAD) }), /参数非法/)
  await assert.rejects(provider.programmes('nxws', '20260925', { fetchImpl: async () => new Response('<html>waf</html>') }), /不是 JSON/)
})

console.log(`\n全部通过：${passed} ✅`)
