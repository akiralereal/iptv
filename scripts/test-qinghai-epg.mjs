#!/usr/bin/env node
/**
 * 青海节目单（央视网）回归测试：只有青海卫视出节目单，ref 与模块频道表对得上；
 * 请求参数与解析走 utils/cntvEpg.js（解析细节在 test-beijing-epg.mjs 里覆盖）。全部离线。
 *
 * 运行： node scripts/test-qinghai-epg.mjs
 */
import assert from 'node:assert/strict'

import qinghaiEpg, { EPG_CHANNELS } from '../extractors/qinghai/epg.js'
import { CHANNELS } from '../extractors/qinghai/api.js'
import { getModule, resolverFor, validateModule } from '../extractors/registry.js'
import { CNTV_EPG_API } from '../utils/cntvEpg.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }
const shanghai = text => Date.parse(`${text.replace(' ', 'T')}+08:00`)
const reply = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json;charset=utf-8' } })

// GET ?c=qinghai&serviceId=tvcctv&d=20261008：开头两条与最后一条（实测 33 条）
const QINGHAI_1008 = { data: { qinghai: { isLive: '昆仑眼', liveSt: 1791466200, channelName: '青海卫视', lvUrl: '', vip_flag: 0, list: [
  { title: '征战达喀尔', startTime: 1791392640, endTime: 1791394440, showTime: '01:04' },
  { title: '电视剧', startTime: 1791394440, endTime: 1791397020, showTime: '01:34' },
  { title: '挑战果岭', startTime: 1791474000, endTime: 1791475140, showTime: '23:40' },
] } } }

console.log('青海节目单（央视网）测试')

check('只有青海卫视出节目单，ref 与模块频道表一致，能路由回本模块', () => {
  const module = getModule('qinghai')
  assert.equal(module.epg, qinghaiEpg)
  assert.equal(module.capabilities.epg, true)
  assert.doesNotThrow(() => validateModule(module))
  assert.deepEqual(qinghaiEpg.channels(), [{ ref: 'qinghai-qhws', name: '青海卫视', key: 'qinghai' }])
  assert.equal(EPG_CHANNELS.length, 1)
  assert.equal(CHANNELS.find(channel => channel.ref === 'qinghai-qhws')?.name, '青海卫视')
  assert.ok(module.claimsRef('qinghai-qhws'))
  assert.equal(resolverFor('qinghai-qhws')?.epg, qinghaiEpg)
  // 经济生活、都市、安多卫视央视网与央视频都没收，不在提供者里
  assert.equal(CHANNELS.length, 4)
})

await checkAsync('按代号 qinghai 请求央视网，时间戳换毫秒、23:59 接到 24:00', async () => {
  const calls = []
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return reply(QINGHAI_1008) }
  const items = await qinghaiEpg.programmes('qinghai', '20261008', { fetchImpl })
  assert.equal(calls.length, 1)
  const url = new URL(calls[0].url)
  assert.equal(`${url.origin}${url.pathname}`, CNTV_EPG_API)
  assert.deepEqual(Object.fromEntries(url.searchParams), { c: 'qinghai', serviceId: 'tvcctv', d: '20261008' })
  assert.deepEqual(items.map(item => item.title), ['征战达喀尔', '电视剧', '挑战果岭'])
  assert.equal(items[0].start, shanghai('2026-10-08 01:04:00'))
  assert.equal(items.at(-1).stop, shanghai('2026-10-09 00:00:00'))
  await assert.rejects(qinghaiEpg.programmes('qinghai', '20261008', { fetchImpl: async () => reply({ errcode: '1001', msg: 'params error' }) }), /params error/)
})

console.log(`\n全部通过：${passed} ✅`)
