#!/usr/bin/env node
/**
 * 甘肃广电节目单（央视网）回归测试：只有甘肃卫视出节目单，ref 与模块频道表对得上；
 * 请求参数与解析走 utils/cntvEpg.js（解析细节在 test-beijing-epg.mjs 里覆盖）。全部离线。
 *
 * 运行： node scripts/test-gansu-epg.mjs
 */
import assert from 'node:assert/strict'

import gansuEpg, { EPG_CHANNELS } from '../extractors/gansu/epg.js'
import { CHANNELS } from '../extractors/gansu/api.js'
import { getModule, resolverFor, validateModule } from '../extractors/registry.js'
import { CNTV_EPG_API } from '../utils/cntvEpg.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }
const shanghai = text => Date.parse(`${text.replace(' ', 'T')}+08:00`)
const reply = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json;charset=utf-8' } })

// GET ?c=gansu&serviceId=tvcctv&d=20260925：开头两条与最后一条（实测 37 条）
const GANSU_0925 = { data: { gansu: { isLive: '', liveSt: 0, channelName: '甘肃卫视', lvUrl: '', vip_flag: 0, list: [
  { title: '纪录30分', startTime: 1790268600, endTime: 1790270760, showTime: '00:50' },
  { title: '甘肃新闻', startTime: 1790270760, endTime: 1790272200, showTime: '01:26' },
  { title: '电视剧', startTime: 1790348400, endTime: 1790351940, showTime: '23:00' },
] } } }

console.log('甘肃广电节目单（央视网）测试')

check('只有甘肃卫视出节目单，ref 与模块频道表一致，能路由回本模块', () => {
  const module = getModule('gansu')
  assert.equal(module.epg, gansuEpg)
  assert.equal(module.capabilities.epg, true)
  assert.doesNotThrow(() => validateModule(module))
  const providers = gansuEpg.channels()
  assert.deepEqual(providers, [{ ref: 'gansu-1', name: '甘肃卫视', key: 'gansu' }])
  assert.equal(EPG_CHANNELS.length, 1)
  const satellite = CHANNELS.find(channel => channel.ref === 'gansu-1')
  assert.equal(satellite.name, '甘肃卫视')
  assert.ok(module.claimsRef('gansu-1'))
  assert.equal(resolverFor('gansu-1')?.epg, gansuEpg)
  // 地面频道官方没有节目单，不在提供者里
  assert.equal(CHANNELS.length, 6)
})

await checkAsync('按代号 gansu 请求央视网，时间戳换毫秒、23:59 接到 24:00', async () => {
  const calls = []
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return reply(GANSU_0925) }
  const items = await gansuEpg.programmes('gansu', '20260925', { fetchImpl })
  assert.equal(calls.length, 1)
  const url = new URL(calls[0].url)
  assert.equal(`${url.origin}${url.pathname}`, CNTV_EPG_API)
  assert.deepEqual(Object.fromEntries(url.searchParams), { c: 'gansu', serviceId: 'tvcctv', d: '20260925' })
  assert.deepEqual(items.map(item => item.title), ['纪录30分', '甘肃新闻', '电视剧'])
  assert.equal(items[0].start, shanghai('2026-09-25 00:50:00'))
  assert.equal(items.at(-1).stop, shanghai('2026-09-26 00:00:00'))
  await assert.rejects(gansuEpg.programmes('gansu', '20260925', { fetchImpl: async () => reply({ errcode: '1001', msg: 'params error' }) }), /params error/)
})

console.log(`\n全部通过：${passed} ✅`)
