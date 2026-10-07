#!/usr/bin/env node
/**
 * 澳广视（TDM）官方节目单：一份是一个播出日（07:00 → 次日凌晨），上海某一天要用前一天与当天两份拼出来；
 * 结束时间取下一档开始（跨两份也接上）。夹具按 2026-10-05 / 10-06 澳视澳门的真实响应裁剪。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import epg, { dayWindow, EPG_API, macauTime, parseRows, programmesForDay } from '../extractors/tdm/epg.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

const row = (date, title) => ({ id: null, programmeId: 1, type: 'LIST', date, title, isLive: false })
const LISTS = {
  '2026-10-05': [
    row('2026-10-05 07:00:00', '早晨新聞'),
    row('2026-10-06 04:25:00', '澳門早晨精華錄'),
    row('2026-10-06 04:47:00', '重播風火台'),
    row('2026-10-06 05:17:00', '“你問我答”粵澳法律直播間 '),
    row('2026-10-06 05:25:00', '耀眼的你啊'),
  ],
  '2026-10-06': [
    row('2026-10-06 07:00:00', '早晨新聞'),
    row('2026-10-06 08:00:00', '澳門早晨'),
    row('2026-10-06 09:00:00', 'TDM 新視點'),
    row('2026-10-07 04:25:00', '澳門早晨精華錄'),
    row('2026-10-07 05:25:00', '耀眼的你啊'),
  ],
}
const hm = ms => new Date(ms + 8 * 3600e3).toISOString().slice(5, 16).replace('T', ' ')

function fakeFetch(calls = [], { failDate } = {}) {
  return async url => {
    calls.push(url)
    const match = /\/program-list\/(\d{4}-\d{2}-\d{2})\?channelId=(\d+)&type=0$/.exec(url)
    assert.ok(match && url.startsWith(EPG_API), url)
    if (match[1] === failDate) return { ok: false, status: 500, body: null }
    return { ok: true, status: 200, json: async () => ({ message: 'OK', data: LISTS[match[1]] || [] }) }
  }
}

console.log('澳广视（TDM）节目单测试')

check('日期：上海日期 → 当天窗口与前一天、当天的接口日期；非法日期拒绝', () => {
  const window = dayWindow('20261006')
  assert.equal(window.today, '2026-10-06')
  assert.equal(window.yesterday, '2026-10-05')
  assert.equal(window.end - window.start, 24 * 3600e3)
  assert.equal(hm(window.start), '10-06 00:00')
  assert.equal(dayWindow('20260301').yesterday, '2026-02-28')
  for (const bad of ['2026106', '20261306', '20260230', '', null]) assert.throws(() => dayWindow(bad), /参数非法/)
  assert.equal(hm(macauTime('2026-10-06 07:00:00')), '10-06 07:00')
  assert.ok(Number.isNaN(macauTime('2026/10/06 07:00')))
})

check('解析：没有标题或时间的丢掉，结构不对抛错', () => {
  assert.deepEqual(parseRows({ data: [row('2026-10-06 07:00:00', ' 早晨新聞 '), row('bad', 'x'), row('2026-10-06 08:00:00', '')] }),
    [{ start: macauTime('2026-10-06 07:00:00'), title: '早晨新聞' }])
  assert.throws(() => parseRows({ data: null }), /格式异常/)
})

await checkAsync('上海这一天 = 前一天单子的凌晨几档 + 当天单子；跨两份的结束时间接上', async () => {
  const calls = []
  const list = await epg.programmes('1', '20261006', { fetchImpl: fakeFetch(calls) })
  assert.equal(calls.length, 2)
  assert.deepEqual(list.map(item => `${hm(item.start)}-${hm(item.stop)} ${item.title}`), [
    '10-06 04:25-10-06 04:47 澳門早晨精華錄',
    '10-06 04:47-10-06 05:17 重播風火台',
    '10-06 05:17-10-06 05:25 “你問我答”粵澳法律直播間',
    '10-06 05:25-10-06 07:00 耀眼的你啊',
    '10-06 07:00-10-06 08:00 早晨新聞',
    '10-06 08:00-10-06 09:00 澳門早晨',
    '10-06 09:00-10-07 04:25 TDM 新視點',
  ])
})

await checkAsync('前一天那份取不到不连累当天；当天那份取不到才失败；频道号不对拒绝', async () => {
  const list = await epg.programmes('1', '20261006', { fetchImpl: fakeFetch([], { failDate: '2026-10-05' }) })
  assert.equal(list[0].title, '早晨新聞')
  await assert.rejects(epg.programmes('1', '20261006', { fetchImpl: fakeFetch([], { failDate: '2026-10-06' }) }), /HTTP 500/)
  await assert.rejects(epg.programmes('99', '20261006', { fetchImpl: fakeFetch() }), /参数非法/)
})

check('最后一档没有下一档时记 30 分钟；同一开始时间只留一条', () => {
  const window = dayWindow('20261007')
  const items = programmesForDay([
    { start: macauTime('2026-10-07 23:30:00'), title: '晚間新聞' },
    { start: macauTime('2026-10-07 23:30:00'), title: '晚間新聞（重复）' },
  ], window)
  assert.deepEqual(items.map(item => [item.title, (item.stop - item.start) / 60000]), [['晚間新聞', 30]])
})

check('频道表：六套都有节目单，键是接口频道号；提供者只引用模块内文件', () => {
  assert.deepEqual(epg.channels().map(channel => `${channel.name}:${channel.key}`),
    ['澳视澳门:1', '澳视葡文:2', '澳门体育:6', '澳门资讯:5', '澳门综艺:7', '澳门-Macau:8'])
  const source = readFileSync(fileURLToPath(new URL('../extractors/tdm/epg.js', import.meta.url)), 'utf8')
  assert.deepEqual([...source.matchAll(/^import .* from '([^']+)'/gm)].map(m => m[1]), ['./channels.js'])
})

console.log(`\n全部通过：${passed} ✅`)
