#!/usr/bin/env node
/**
 * 吉林广电节目单（央视网）回归测试：只有延边卫视出节目单，ref 与模块频道表对得上；
 * 朝鲜语节目名原样保留。请求参数与解析走 utils/cntvEpg.js（解析细节在 test-beijing-epg.mjs 里覆盖）。全部离线。
 *
 * 运行： node scripts/test-jlntv-epg.mjs
 */
import assert from 'node:assert/strict'

import jlntvEpg, { EPG_CHANNELS } from '../extractors/jlntv/epg.js'
import { BROADCAST_CHANNELS } from '../extractors/jlntv/api.js'
import { getModule, resolverFor, validateModule } from '../extractors/registry.js'
import { CNTV_EPG_API } from '../utils/cntvEpg.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }
const shanghai = text => Date.parse(`${text.replace(' ', 'T')}+08:00`)
const reply = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json;charset=utf-8' } })

// GET ?c=yanbian&serviceId=tvcctv&d=20260925：开头两条与最后一条（实测 27 条，节目名是朝鲜语）
const YANBIAN_0925 = { data: { yanbian: { isLive: '', liveSt: 0, channelName: '延边卫视', lvUrl: '', vip_flag: 0, list: [
  { title: '드라마', startTime: 1790268600, endTime: 1790271300, showTime: '00:50' },
  { title: '끝', startTime: 1790271300, endTime: 1790290800, showTime: '01:35' },
  { title: '연변뉴스', startTime: 1790348400, endTime: 1790351940, showTime: '23:00' },
] } } }

console.log('吉林广电节目单（央视网）测试')

check('只有延边卫视出节目单，ref 与模块频道表一致，能路由回本模块', () => {
  const module = getModule('jlntv')
  assert.equal(module.epg, jlntvEpg)
  assert.equal(module.capabilities.epg, true)
  assert.doesNotThrow(() => validateModule(module))
  assert.deepEqual(jlntvEpg.channels(), [{ ref: 'jlntv-yanbian', name: '延边卫视', key: 'yanbian' }])
  assert.equal(EPG_CHANNELS.length, 1)
  const yanbian = BROADCAST_CHANNELS.find(channel => channel.ref === 'jlntv-yanbian')
  assert.equal(yanbian.name, '延边卫视')
  assert.ok(module.claimsRef('jlntv-yanbian'))
  assert.equal(resolverFor('jlntv-yanbian')?.epg, jlntvEpg)
})

await checkAsync('按代号 yanbian 请求央视网，朝鲜语节目名原样保留', async () => {
  const calls = []
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return reply(YANBIAN_0925) }
  const items = await jlntvEpg.programmes('yanbian', '20260925', { fetchImpl })
  assert.equal(calls.length, 1)
  const url = new URL(calls[0].url)
  assert.equal(`${url.origin}${url.pathname}`, CNTV_EPG_API)
  assert.deepEqual(Object.fromEntries(url.searchParams), { c: 'yanbian', serviceId: 'tvcctv', d: '20260925' })
  assert.deepEqual(items.map(item => item.title), ['드라마', '끝', '연변뉴스'])
  assert.equal(items[0].start, shanghai('2026-09-25 00:50:00'))
  assert.equal(items.at(-1).stop, shanghai('2026-09-26 00:00:00'))
})

console.log(`\n全部通过：${passed} ✅`)
