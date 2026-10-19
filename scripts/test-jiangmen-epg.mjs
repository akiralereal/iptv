import test from 'node:test'
import assert from 'node:assert/strict'
import epg, { parseEpg, parseProgrammes, dayRange } from '../extractors/jiangmen/epg.js'
import { CHANNEL, EPG_URL } from '../extractors/jiangmen/protocol.js'
import { channelXml, providerProgrammes, xmltvTime } from '../utils/epgXmltv.js'

// 官网 2026-10-18 真实响应字段与剧集标题。
const row = { liveid: '4x3T0dO', name: '一代匠师 34', start_time: '2026-10-18 07:32:00', end_time: '2026-10-18 08:30:00' }
const tomorrow = { ...row, start_time: '2026-10-19 07:32:00', end_time: '2026-10-19 08:30:00' }
const jsonp = data => `liveList.jsonpCallback(${JSON.stringify(data)});`

test('JSONP 严格按数据解析，注入代码、其他回调与错误结构都拒绝', () => {
  assert.deepEqual(parseEpg(jsonp([row])), [row])
  for (const text of [jsonp([row]) + 'alert(1)', 'otherCallback([])', 'liveList.jsonpCallback({})', 'liveList.jsonpCallback(process.exit())']) {
    assert.throws(() => parseEpg(text))
  }
})

test('正式频道按 ref 配对，今明两天使用官方具体剧名、集数和北京时间', async () => {
  assert.equal(epg.days, 2)
  assert.deepEqual(epg.channels(), [{ ref: 'jiangmen-1', name: '江门综合', key: '4x3T0dO' }])
  const programmes = await providerProgrammes(epg, CHANNEL.upstreamId, {
    now: Date.parse('2026-10-18T12:00:00Z'), fetchImpl: async (url, options) => {
      assert.equal(url, EPG_URL)
      assert.equal(options.redirect, 'manual')
      return new Response(jsonp([tomorrow, row, row]))
    },
  })
  assert.equal(programmes.length, 2)
  assert.equal(programmes[0].title, '一代匠师 34')
  assert.equal(xmltvTime(programmes[0].start), '20261018073200 +0800')
  assert.equal(xmltvTime(programmes[1].stop), '20261019083000 +0800')
  assert.match(channelXml('江门综合', programmes), /channel="江门综合" start="20261018073200 \+0800"/)
  assert.deepEqual(parseProgrammes([row], '20261019'), [], '缺哪一天就留空，不套用其他日期')
})

test('过滤错台、空名、占位和非法时段，去重并截断重叠，保留跨日节目与空档', () => {
  const later = { ...row, name: '下一档', start_time: '2026-10-18 08:20:00', end_time: '2026-10-18 09:00:00' }
  const cross = { ...row, name: '跨日', start_time: '2026-10-18 23:45:00', end_time: '2026-10-19 00:15:00' }
  const invalid = [{ ...row, liveid: 'BRXH74E' }, { ...row, name: '' }, { ...row, name: '精彩节目' },
    { ...row, start_time: '2026-02-30 07:32:00' }, { ...row, end_time: row.start_time }]
  const rows = parseProgrammes([later, cross, tomorrow, ...invalid, row, row], '20261018')
  assert.deepEqual(rows.map(r => r.title), ['一代匠师 34', '下一档', '跨日'])
  assert.equal(rows[0].stop, rows[1].start)
  assert.equal(xmltvTime(rows[2].stop), '20261019001500 +0800')
})

test('参数、接口与 JSONP 错误明确失败，官方当天无数据留空', async () => {
  assert.throws(() => dayRange('20260230'))
  await assert.rejects(epg.programmes('wrong', '20261018'))
  await assert.rejects(epg.programmes(CHANNEL.upstreamId, '20261018', { fetchImpl: async () => new Response('', { status: 403 }) }))
  await assert.rejects(epg.programmes(CHANNEL.upstreamId, '20261018', { fetchImpl: async () => new Response('<html>error</html>') }))
  assert.deepEqual(await epg.programmes(CHANNEL.upstreamId, '20261018', { fetchImpl: async () => new Response(jsonp([])) }), [])
})
