import test from 'node:test'
import assert from 'node:assert/strict'
import epg, { dayRange, parseProgrammes, programmes } from '../extractors/shaoxing/epg.js'
import { xmltvTime } from '../utils/epgXmltv.js'

// 按 2026-10-17 官网真实节目单裁剪，时间戳为 Unix 秒，endtime 为字符串。
const payload = { state: true, data: [
  { name: '白天节目预告', starttime: 1792191600, endtime: '1792191660' },
  { name: '绍兴新闻联播', starttime: 1792191660, endtime: '1792193040' },
  { name: '电视剧', starttime: 1792196400, endtime: '1792200000' },
] }

test('官方今明两天节目单按 ref 精确映射，时间与播出表一致', async () => {
  assert.equal(epg.days, 2)
  assert.equal(epg.channels().length, 3)
  const items = await programmes('78', '20261017', { fetchImpl: async (endpoint, options) => {
    const url = new URL(endpoint)
    assert.equal(url.origin, 'https://app.shaoxing.com.cn')
    assert.equal(url.searchParams.get('stream_id'), '78')
    assert.equal(url.searchParams.get('start_time'), '1792166400')
    assert.equal(url.searchParams.get('end_time'), '1792252800')
    assert.equal(options.redirect, 'manual')
    return Response.json(payload)
  } })
  assert.deepEqual(items.map(item => item.title), ['绍兴新闻联播', '电视剧'])
  assert.equal(xmltvTime(items[0].start), '20261017070100 +0800')
  assert.equal(xmltvTime(items[0].stop), '20261017072400 +0800')
  assert.deepEqual(parseProgrammes(payload, '20261018'), [], '不得把今天套到明天')
})

test('过滤占位、短片、非法时段，重复去重、重叠截断并保留跨日节目', () => {
  const { start, end } = dayRange('20261017')
  const r = (name, a, b) => ({ name, starttime: a / 1000, endtime: String(b / 1000) })
  const data = [
    r('节目 A', start, start + 7200000), r('重复', start, start + 7200000),
    r('节目 B', start + 3600000, start + 7200000),
    r('精彩节目', start + 7200000, start + 10800000),
    r('短片', start + 10800000, start + 10830000),
    r('无效', start + 14400000, start + 10800000),
    r('跨日剧场', end - 600000, end + 600000),
    r('明天', end, end + 600000),
  ]
  const items = parseProgrammes({ state: true, data }, '20261017')
  assert.deepEqual(items.map(item => item.title), ['节目 A', '节目 B', '跨日剧场'])
  assert.equal(items[0].stop, items[1].start)
  assert.equal(items[2].stop, end + 600000)
})

test('非法参数及接口错误明确失败，空节目单保留为空', async () => {
  assert.throws(() => dayRange('20260230'))
  assert.throws(() => parseProgrammes({ state: false }, '20261017'))
  assert.deepEqual(parseProgrammes({ state: true, data: [] }, '20261017'), [])
  await assert.rejects(programmes('999', '20261017'))
  await assert.rejects(programmes('78', '20261017', { fetchImpl: async () => new Response('', { status: 403 }) }), /HTTP 403/)
})
