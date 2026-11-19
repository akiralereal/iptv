#!/usr/bin/env node
/**
 * 咪咕节目单（utils/playback.js）回归测试：取今天与明天两天、跨零点去重、单天失败的处理、
 * 央视网分支；日期与时间按上海算，与运行机器的时区无关。全程离线（注入假的取数函数）。
 * 另测回看用的往日节目单（utils/epgHistory.js）：往前 6 天、存盘后不再重取、取不到与空的不存、
 * 滚出窗口的文件清掉。
 *
 * 运行： node scripts/test-playback-epg.mjs   （或 npm test；另在 TZ=UTC、TZ=America/Los_Angeles 下各跑一次）
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PAST_DAYS, pastShanghaiDays, updatePlaybackData } from '../utils/playback.js'
import { createEpgHistory } from '../utils/epgHistory.js'

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
const run = async (program, routes, { history, now = NOW } = {}) => {
  requested.length = 0
  const file = join(dir, `${++fileNo}.xml`)
  const result = await updatePlaybackData(program, file, 6000, { now, fetchJson: fakeFetchJson(routes), history })
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

  // ---- 回看用的往日节目单 ----
  const PAST = ['20260920', '20260921', '20260922', '20260923', '20260924', '20260925']
  const requestedDays = () => requested.map(url => url.match(/(\d{8})(?:$|&)/)[1])
  const starts = xml => [...xml.matchAll(/start="(\d{14}) \+0800"/g)].map(m => m[1])
  const iso = day => `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}`
  // 一台 8 天的假数据：每天一条 20:00 的节目，标题带日期
  const miguWeek = (pid, overrides = {}) => Object.fromEntries([...PAST, '20260926', '20260927'].map(day => [
    `/${pid}/${day}`,
    day in overrides ? overrides[day] : migu([[`剧场 ${day}`, `${iso(day)}T20:00:00`, `${iso(day)}T21:00:00`]]),
  ]))
  let historyNo = 0
  const newHistoryDir = () => join(dir, `history-${++historyNo}`)

  await checkAsync('往前 6 天按上海日期算：从最早那天排到昨天，不含今天', async () => {
    assert.equal(PAST_DAYS, 6)
    assert.deepEqual(pastShanghaiDays(NOW), PAST)
    // 上海 23:50 与次日 00:10 差一天
    assert.equal(pastShanghaiDays(at('2026-09-26T23:50:00')).at(-1), '20260925')
    assert.equal(pastShanghaiDays(at('2026-09-27T00:10:00')).at(-1), '20260926')
  })

  await checkAsync('给了存盘：今天、明天之外再取往前 6 天，全部写进节目单并按时间排好', async () => {
    const historyDir = newHistoryDir()
    const history = createEpgHistory(historyDir)
    const { result, xml } = await run({ name: '东方卫视', pID: '651632648' }, miguWeek('651632648'), { history })
    assert.equal(result, true)
    assert.deepEqual(requestedDays().slice(0, 2), ['20260926', '20260927'], '今天和明天先取')
    assert.deepEqual(requestedDays().slice(2).sort(), PAST)
    assert.deepEqual(starts(xml), [...PAST, '20260926', '20260927'].map(day => `${day}200000`))
    assert.equal(xml.match(/<channel id=/g).length, 1)
    // 没 flush 之前不落盘
    assert.equal(existsSync(historyDir), false)
    assert.deepEqual(history.flush(PAST), { added: 6 })
    assert.deepEqual(readdirSync(historyDir).sort(), PAST.map(day => `${day}.json`))
    assert.deepEqual(JSON.parse(readFileSync(join(historyDir, '20260925.json'), 'utf8')), {
      'migu:651632648': [['剧场 20260925', at('2026-09-25T20:00:00'), at('2026-09-25T21:00:00')]],
    })
  })

  await checkAsync('存过的不再取：下一轮（进程重启后也一样）只取今天与明天，往日的照样写出', async () => {
    const historyDir = newHistoryDir()
    const first = createEpgHistory(historyDir)
    await run({ name: '东方卫视', pID: '651632648' }, miguWeek('651632648'), { history: first })
    first.flush(PAST)
    // 新实例 = 重启；往日的地址一个都不给，真去取就会在假取数函数里抛出来
    const second = createEpgHistory(historyDir)
    const { result, xml } = await run({ name: '东方卫视', pID: '651632648' }, {
      '/651632648/20260926': migu([['剧场 今天', '2026-09-26T20:00:00', '2026-09-26T21:00:00']]),
      '/651632648/20260927': migu([['剧场 明天', '2026-09-27T20:00:00', '2026-09-27T21:00:00']]),
    }, { history: second })
    assert.equal(result, true)
    assert.deepEqual(requestedDays(), ['20260926', '20260927'])
    assert.deepEqual(starts(xml), [...PAST, '20260926', '20260927'].map(day => `${day}200000`))
    assert.deepEqual(second.flush(PAST), { added: 0 })
  })

  await checkAsync('过了一天：只补取「昨天」一天，最早那天滚出窗口并删掉文件', async () => {
    const historyDir = newHistoryDir()
    const first = createEpgHistory(historyDir)
    await run({ name: '东方卫视', pID: '651632648' }, miguWeek('651632648'), { history: first })
    first.flush(PAST)
    const tomorrow = at('2026-09-27T00:30:00')
    const second = createEpgHistory(historyDir)
    const { xml } = await run({ name: '东方卫视', pID: '651632648' }, {
      '/651632648/20260926': migu([['剧场 20260926', '2026-09-26T20:00:00', '2026-09-26T21:00:00']]),
      '/651632648/20260927': migu([['剧场 20260927', '2026-09-27T20:00:00', '2026-09-27T21:00:00']]),
      '/651632648/20260928': migu([['剧场 20260928', '2026-09-28T20:00:00', '2026-09-28T21:00:00']]),
    }, { history: second, now: tomorrow })
    assert.deepEqual(requestedDays(), ['20260927', '20260928', '20260926'])
    assert.equal(starts(xml)[0], '20260921200000', '20 日已滚出窗口，不再写出')
    assert.equal(starts(xml).length, 8)
    assert.deepEqual(second.flush(pastShanghaiDays(tomorrow)), { added: 1 })
    assert.deepEqual(readdirSync(historyDir).sort(),
      ['20260921', '20260922', '20260923', '20260924', '20260925', '20260926'].map(day => `${day}.json`))
  })

  await checkAsync('往日某天取不到或官方回空：不存、少那一天，下一轮只重试这两天', async () => {
    const historyDir = newHistoryDir()
    const first = createEpgHistory(historyDir)
    const { result, xml } = await run({ name: '江苏卫视', pID: '623899368' }, miguWeek('623899368', {
      '20260922': null,
      '20260924': { body: { program: [{ content: [] }] } },
    }), { history: first })
    assert.equal(result, true)
    assert.equal(starts(xml).length, 6)
    assert.deepEqual(first.flush(PAST), { added: 4 })
    assert.deepEqual(readdirSync(historyDir).sort(),
      ['20260920', '20260921', '20260923', '20260925'].map(day => `${day}.json`))
    const second = createEpgHistory(historyDir)
    const again = await run({ name: '江苏卫视', pID: '623899368' }, miguWeek('623899368'), { history: second })
    assert.deepEqual(requestedDays().slice(2).sort(), ['20260922', '20260924'])
    assert.equal(starts(again.xml).length, 8)
  })

  await checkAsync('今天取不到或今天没节目：不去取往日的', async () => {
    const history = createEpgHistory(newHistoryDir())
    await assert.rejects(() => run({ name: '东南卫视', pID: '608780' }, miguWeek('608780', { '20260926': null }), { history }),
      /节目单接口无响应/)
    assert.deepEqual(requestedDays(), ['20260926', '20260927'])
    const { result } = await run({ name: '海南卫视', pID: '947472' },
      miguWeek('947472', { '20260926': { body: { program: [{ content: [] }] } } }), { history })
    assert.equal(result, false)
    assert.deepEqual(requestedDays(), ['20260926', '20260927'])
    assert.deepEqual(history.flush(PAST), { added: 0 })
  })

  await checkAsync('昨天与今天都带着跨零点那条：只留一条', async () => {
    const history = createEpgHistory(newHistoryDir())
    const { xml } = await run({ name: '东方卫视', pID: '651632648' }, miguWeek('651632648', {
      '20260925': migu([
        ['剧场 20260925', '2026-09-25T20:00:00', '2026-09-25T21:00:00'],
        ['午夜档', '2026-09-25T23:56:00', '2026-09-26T00:40:00'],
      ]),
      '20260926': migu([
        ['午夜档', '2026-09-25T23:56:00', '2026-09-26T00:40:00'],
        ['剧场 20260926', '2026-09-26T20:00:00', '2026-09-26T21:00:00'],
      ]),
    }), { history })
    assert.equal(starts(xml).filter(start => start === '20260925235600').length, 1)
    assert.equal(starts(xml).length, 9)
  })

  await checkAsync('CCTV 各台往日的也取央视网，存盘的键与咪咕的分开', async () => {
    const historyDir = newHistoryDir()
    const history = createEpgHistory(historyDir)
    const cntvDay = day => ({ cctv2: { program: [{ t: `财经 ${day}`, st: at(`${iso(day)}T08:00:00`) / 1000, et: at(`${iso(day)}T09:00:00`) / 1000 }] } })
    const { result, xml } = await run({ name: 'CCTV2财经', pID: '631780532' },
      Object.fromEntries([...PAST, '20260926', '20260927'].map(day => [`d=${day}&c=cctv2`, cntvDay(day)])), { history })
    assert.equal(result, true)
    assert.equal(requested.length, 8)
    assert.ok(requested.every(url => url.startsWith('https://api.cntv.cn/epg/epginfo3?')))
    assert.deepEqual(starts(xml), [...PAST, '20260926', '20260927'].map(day => `${day}080000`))
    history.flush(PAST)
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(historyDir, '20260920.json'), 'utf8'))), ['cntv:cctv2'])
  })

  await checkAsync('存盘文件坏了、内容不对：当没存过重新取；写到一半的临时文件收尾时清掉', async () => {
    const historyDir = newHistoryDir()
    mkdirSync(historyDir, { recursive: true })
    writeFileSync(join(historyDir, '20260920.json'), '{"migu:651632648": [["剧场", 1')
    writeFileSync(join(historyDir, '20260921.json'), JSON.stringify({ 'migu:651632648': [['缺结束时间', 1]], other: 'x' }))
    writeFileSync(join(historyDir, '20260922.json'), '[]')
    writeFileSync(join(historyDir, '20260923.json.tmp'), '半截')
    writeFileSync(join(historyDir, '不相干.txt'), '别动我')
    const history = createEpgHistory(historyDir)
    assert.equal(history.get('migu:651632648', '20260920'), undefined)
    assert.equal(history.get('migu:651632648', '20260921'), undefined)
    assert.equal(history.get('migu:651632648', '20260922'), undefined)
    const { xml } = await run({ name: '东方卫视', pID: '651632648' }, miguWeek('651632648'), { history })
    assert.equal(starts(xml).length, 8)
    assert.deepEqual(history.flush(PAST), { added: 6 })
    assert.deepEqual(readdirSync(historyDir).sort(), [...PAST.map(day => `${day}.json`), '不相干.txt'].sort())
    assert.equal(createEpgHistory(historyDir).get('migu:651632648', '20260920')[0].title, '剧场 20260920')
  })

  await checkAsync('存盘目录写不了：flush 抛出给调用方记一行，节目单本身已经写出', async () => {
    const blocker = join(dir, 'not-a-dir')
    writeFileSync(blocker, '占着这个名字的是文件')
    const history = createEpgHistory(join(blocker, 'history'))
    const { result, xml } = await run({ name: '东方卫视', pID: '651632648' }, miguWeek('651632648'), { history })
    assert.equal(result, true)
    assert.equal(starts(xml).length, 8)
    assert.throws(() => history.flush(PAST))
  })
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n通过 ${passed} 项`)
