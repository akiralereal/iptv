#!/usr/bin/env node
/** 成都节目单：按真实央视网响应裁剪的离线夹具。通用解析的边界另由北京节目单测试覆盖。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import epg from '../extractors/chengdu/epg.js'
import chengdu from '../extractors/chengdu/index.js'
import { CHANNELS } from '../extractors/chengdu/channels.js'

test('只有新闻综合、公共两路挂央视网 EPG，ref 与频道表精确对应', () => {
  assert.equal(chengdu.epg, epg)
  assert.equal(chengdu.capabilities.epg, true)
  assert.equal(epg.days, 2)
  assert.deepEqual(epg.channels().map(channel => channel.key), ['cdtv1', 'cdtv5'])
  for (const channel of epg.channels()) {
    assert.equal(CHANNELS.find(row => row.ref === channel.ref)?.name, channel.name)
  }
})

test('央视网真实节目解析：上海日期、时间、台名、末档补到零点', async () => {
  const fixtures = {
    cdtv1: { channelName: '成都新闻综合', list: [
      { title: '心灵会客室', startTime: 1792166400, endTime: 1792168080 },
      { title: '帮忙有一套', startTime: 1792250400, endTime: 1792252740 },
    ] },
    cdtv5: { channelName: '成都公共', list: [
      { title: '第一房产资讯', startTime: 1792166400, endTime: 1792167300 },
      { title: '第一品牌', startTime: 1792251600, endTime: 1792252740 },
    ] },
  }
  for (const { key } of epg.channels()) {
    const rows = await epg.programmes(key, '20261017', { fetchImpl: async (raw, options) => {
      const url = new URL(raw)
      assert.equal(url.origin + url.pathname, 'https://api.cntv.cn/epg/getEpgInfoByChannelNew')
      assert.deepEqual(Object.fromEntries(url.searchParams), { c: key, serviceId: 'tvcctv', d: '20261017' })
      assert.equal(options.redirect, 'manual')
      return new Response(JSON.stringify({ data: { [key]: fixtures[key] } }))
    } })
    assert.equal(rows.length, 2)
    assert.equal(rows[0].title, fixtures[key].list[0].title)
    assert.equal(rows[0].start, Date.parse('2026-10-17T00:00:00+08:00'))
    assert.equal(rows.at(-1).stop, Date.parse('2026-10-18T00:00:00+08:00'))
  }
  await assert.rejects(epg.programmes('cdtv2', '20261017'), /参数非法/)
})
