import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import mod from '../extractors/yancheng/index.js'
import epg, { parseProgrammes } from '../extractors/yancheng/epg.js'
import { CHANNELS, dateRange } from '../extractors/yancheng/protocol.js'
import { xmltvTime } from '../utils/epgXmltv.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/yancheng.json', import.meta.url)))
test('官方节目单按 ref 配对，显式北京时间，过滤精彩视频和串联包装', async () => {
  const catalog = await mod.fetch({}, { fetchImpl: async () => Response.json(fixture.channels) })
  assert.equal(epg.days, 2)
  assert.deepEqual(epg.channels().map(c => c.ref), catalog.groups[0].dataList.map(c => c.deferredRef))
  const programmes = await epg.programmes(CHANNELS[0].id, '20261023', { fetchImpl: async endpoint => {
    const url = new URL(endpoint)
    assert.equal(url.searchParams.get('date'), '2026-10-23')
    assert.equal(url.searchParams.get('topic_id'), CHANNELS[0].id)
    return Response.json({ error_code: 200, result: fixture.one })
  } })
  assert.ok(programmes.length > 10)
  assert.ok(programmes.every(p => !/精彩视频|导视/.test(p.title)))
  const news = programmes.find(p => p.title === '重播：盐城新闻')
  assert.equal(xmltvTime(news.start), '20261023073008 +0800')
  assert.equal(xmltvTime(news.stop), '20261023075508 +0800')
  assert.deepEqual(parseProgrammes(fixture.one, CHANNELS[0], '20261024'), [])
  assert.deepEqual(parseProgrammes(fixture.one, CHANNELS[1], '20261023'), [])
})

test('去重、截断重叠、保留空档和未开放时段的真实节目', () => {
  const row = fixture.one.find(r => r.title === '重播：盐城新闻')
  const rows = [row, row, { ...row, title: '后续节目', star_time_timestamp: row.star_time_timestamp + 600 }, { ...row, title: '短片', end_time_timestamp: row.star_time_timestamp + 30 }, { ...row, title: '非法', end_time_timestamp: row.star_time_timestamp - 1 }]
  const result = parseProgrammes(rows, CHANNELS[0], '20261023')
  assert.equal(result.length, 2)
  assert.equal(result[0].stop, result[1].start)
  assert.ok(parseProgrammes([{ ...row, can_play: 0 }], CHANNELS[0], '20261023').length)
})

test('空表为空，错误与非法参数明确失败', async () => {
  assert.throws(() => dateRange('20260230'))
  await assert.rejects(epg.programmes('bad', '20261023'))
  await assert.rejects(epg.programmes(CHANNELS[0].id, '20261023', { fetchImpl: async () => Response.json({ error_code: 500 }) }))
  await assert.rejects(epg.programmes(CHANNELS[0].id, '20261023', { fetchImpl: async () => new Response('', { status: 403 }) }))
  assert.deepEqual(await epg.programmes(CHANNELS[0].id, '20261023', { fetchImpl: async () => Response.json({ error_code: 200, result: [] }) }), [])
})
