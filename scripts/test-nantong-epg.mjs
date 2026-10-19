import test from 'node:test'
import assert from 'node:assert/strict'
import epg, { normalizePrograms } from '../extractors/nantong/epg.js'
import { CHANNELS } from '../extractors/nantong/api.js'
import { channelXml, xmltvTime } from '../utils/epgXmltv.js'

// 从 2026-10-18 官网 getBroadcastList 裁剪，不依赖播放状态筛节目。
const row = { programName: '电视剧', programStatus: 2, startTime: '2026-10-18 20:10:00', endTime: '2026-10-18 22:00:00', status: 2, isRecord: 1 }
const past = { ...row, status: 3, isRecord: 2, programName: '南通新闻', startTime: '2026-10-18 07:00:00', endTime: '2026-10-18 07:35:00' }
const future = { ...row, status: 1, programName: '大家有约', startTime: '2026-10-18 22:00:00', endTime: '2026-10-18 22:30:00' }
const payload = { state: 1000, currTime: '20261018203000', data: [future, row, past, row] }
const request = async (key = '1', day = '20261018', body = payload) => epg.programmes(key, day, {
  fetchImpl: async (url, options) => {
    assert.equal(options.redirect, 'manual')
    const values = new URLSearchParams(options.body)
    assert.equal(values.get('service'), 'getBroadcastList')
    assert.equal(JSON.parse(values.get('params')).id, CHANNELS.find(c => c.id === key).upstreamId)
    assert.ok(values.get('butelSign'))
    return Response.json(body)
  },
})

test('三套按 ref 对应官方节目，保留过去、未来及受限节目并生成北京时间 XMLTV', async () => {
  assert.equal(epg.days, 1)
  assert.deepEqual(epg.channels().map(c => c.ref), CHANNELS.map(c => c.ref))
  const items = await request()
  assert.deepEqual(items.map(r => r.title), ['南通新闻', '电视剧', '大家有约'])
  assert.equal(xmltvTime(items[1].start), '20261018201000 +0800')
  assert.equal(xmltvTime(items[1].stop), '20261018220000 +0800')
  assert.match(channelXml('南通新闻综合', items), /channel="南通新闻综合" start="20261018201000 \+0800"/)
  assert.deepEqual(await request('1', '20261019'), [], '不得把服务器今天的节目套到明天')
  assert.deepEqual(await request('1', '20261018', { ...payload, data: [] }), [])
})

test('丢弃非法时段、空名和未发布节目，不补造空档或过期节目', () => {
  const invalid = [null, { programName: '' }, { programStatus: 1 }, { startTime: '2026-02-30 20:10:00' },
    { startTime: '2026-10-18 22:00:00' }, { startTime: '2026-10-18 25:00:00' },
    { startTime: '2026-10-17 20:10:00' }, { endTime: '2026-10-19 01:00:00' }]
    .map(change => change === null ? null : { ...row, ...change })
  const now = Date.parse('2026-10-18T12:30:00Z')
  assert.equal(normalizePrograms({ ...payload, data: [...invalid, row] }, CHANNELS[0], now).length, 1)
  assert.throws(() => normalizePrograms(payload, CHANNELS[0], now + 86400000))
})

test('参数、官方错误和超时明确失败，不把错误当空节目', async () => {
  await assert.rejects(request('4'))
  await assert.rejects(request('1', '20260230'))
  await assert.rejects(request('1', '20261018', { state: 500 }))
  await assert.rejects(epg.programmes('1', '20261018', { fetchImpl: async () => new Response('', { status: 403 }) }), /HTTP 403/)
  await assert.rejects(epg.programmes('1', '20261018', { fetchImpl: async () => { throw new DOMException('timeout', 'AbortError') } }), /timeout/)
})
