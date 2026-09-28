#!/usr/bin/env node
/**
 * 咪咕节目单（utils/playback.js）回归测试：取今天与明天两天、跨零点去重、单天失败的处理、
 * 央视网分支；日期与时间按上海算，与运行机器的时区无关。全程离线（注入假的取数函数）。
 *
 * 运行： node scripts/test-playback-epg.mjs   （或 npm test；另在 TZ=UTC、TZ=America/Los_Angeles 下各跑一次）
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { updatePlaybackData } from '../utils/playback.js'

let passed = 0
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

// 上海 2026-09-26 00:30：刚过零点，本机在 UTC / 洛杉矶时还是 25 日
const NOW = Date.parse('2026-09-26T00:30:00+08:00')
const at = s => Date.parse(`${s}+08:00`)

const requested = []
// routes：URL 片段 → 响应体；值为 null 时模拟请求失败（fetchUrl 失败返回 undefined、不抛）
const fakeFetchJson = routes => async url => {
  requested.push(url)
  const hit = Object.entries(routes).find(([part]) => url.includes(part))
  if (!hit) throw new Error(`测试没有准备这个地址：${url}`)
  return hit[1] ?? undefined
}
const migu = items => ({ body: { program: [{ content: items.map(([contName, s, e]) => ({ contName, startTime: at(s), endTime: at(e) })) }] } })

const dir = mkdtempSync(join(tmpdir(), 'playback-epg-'))
let fileNo = 0
const run = async (program, routes) => {
  requested.length = 0
  const file = join(dir, `${++fileNo}.xml`)
  const result = await updatePlaybackData(program, file, 6000, { now: NOW, fetchJson: fakeFetchJson(routes) })
  let xml = ''
  try { xml = readFileSync(file, 'utf8') } catch {}
  return { result, xml }
}

console.log('咪咕节目单测试')

try {
  await checkAsync('咪咕：取今天与明天（按上海日期），跨零点那条只留一条，按开始时间排好', async () => {
    const { result, xml } = await run({ name: '江苏卫视', pID: '623899368' }, {
      '/623899368/20260926': migu([
        ['非诚勿扰', '2026-09-26T21:20:00', '2026-09-26T22:30:00'],
        ['晚间新闻 & <天气>', '2026-09-26T22:30:00', '2026-09-27T00:10:00'],
        ['早间剧场', '2026-09-26T06:00:00', '2026-09-26T07:00:00'],
      ]),
      '/623899368/20260927': migu([
        ['晚间新闻 & <天气>', '2026-09-26T22:30:00', '2026-09-27T00:10:00'],
        ['午夜剧场', '2026-09-27T00:10:00', '2026-09-27T01:00:00'],
      ]),
    })
    assert.equal(result, true)
    assert.deepEqual(requested.map(url => url.match(/\/(\d{8})$/)[1]), ['20260926', '20260927'])
    assert.equal(xml.match(/<channel id=/g).length, 1)
    assert.deepEqual([...xml.matchAll(/start="(\d{14}) \+0800"/g)].map(m => m[1]),
      ['20260926060000', '20260926212000', '20260926223000', '20260927001000'])
    assert.match(xml, /<title lang="zh">晚间新闻 &amp; &lt;天气&gt;<\/title>/)
    assert.match(xml, /start="20260926223000 \+0800" stop="20260927001000 \+0800"/)
  })

  await checkAsync('明天取不到：照写今天的，仍算已覆盖', async () => {
    const { result, xml } = await run({ name: '湖南卫视', pID: '635491149' }, {
      '/635491149/20260926': migu([['体育新闻', '2026-09-26T18:00:00', '2026-09-26T18:30:00']]),
      '/635491149/20260927': null,
    })
    assert.equal(result, true)
    assert.equal(xml.match(/<programme /g).length, 1)
  })

  await checkAsync('今天取不到：抛出去由调用方计数，明天有也不写', async () => {
    let xml = ''
    await assert.rejects(async () => {
      ({ xml } = await run({ name: '东南卫视', pID: '608780' }, {
        '/608780/20260926': null,
        '/608780/20260927': migu([['午夜剧场', '2026-09-27T00:10:00', '2026-09-27T01:00:00']]),
      }))
    }, /节目单接口无响应/)
    assert.equal(xml, '')
  })

  await checkAsync('今天没节目：返回 false 让给模块与外部源，不写空频道', async () => {
    const { result, xml } = await run({ name: '海南卫视', pID: '947472' }, {
      '/947472/20260926': { body: { program: [{ content: [] }] } },
      '/947472/20260927': migu([['午夜剧场', '2026-09-27T00:10:00', '2026-09-27T01:00:00']]),
    })
    assert.equal(result, false)
    assert.equal(xml, '')
  })

  await checkAsync('CCTV 各台走央视网：同样取两天，秒级时间戳换算正确', async () => {
    const cntv = (st, et, t) => ({ t, st: at(st) / 1000, et: at(et) / 1000 })
    const { result, xml } = await run({ name: 'CCTV2财经', pID: '631780532' }, {
      'd=20260926&c=cctv2': { cctv2: { program: [cntv('2026-09-26T00:00:00', '2026-09-26T00:30:00', '赢在AI+')] } },
      'd=20260927&c=cctv2': { cctv2: { program: [cntv('2026-09-27T00:00:00', '2026-09-27T00:40:00', '一槌定音')] } },
    })
    assert.equal(result, true)
    assert.ok(requested.every(url => url.startsWith('https://api.cntv.cn/epg/epginfo3?')))
    assert.deepEqual([...xml.matchAll(/start="(\d{14}) \+0800" stop="(\d{14})/g)].map(m => `${m[1]}-${m[2]}`),
      ['20260926000000-20260926003000', '20260927000000-20260927004000'])
  })
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n通过 ${passed} 项`)
