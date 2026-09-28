#!/usr/bin/env node
/**
 * 模块自带节目单回归测试：央视频 protobuf 解码、零依赖公共件、iptv 侧衔接的优先级与失败隔离。
 *
 * 运行： node scripts/test-module-epg.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import yangshipinEpg, { EPG_API, decodeProgrammes } from '../extractors/yangshipin/epg.js'
import { buildChannels } from '../extractors/yangshipin/channels.js'
import { getModule, validateModule } from '../extractors/registry.js'
import { channelXml, mapSettled, providerProgrammes, shanghaiDays, xmltvTime } from '../utils/epgXmltv.js'
import { appendModuleEpg } from '../utils/moduleEpg.js'
import { epgChannelId } from '../utils/epgAggregator.js'
import { normalizeKey } from '../utils/channelNormalize.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

// 按央视频节目单的字段号手工编码 protobuf：顶层 1 = 状态码、2 = 节目；节目里 1 id、2 名、3/4 起止秒
const varint = n => {
  const out = []
  while (n >= 128) { out.push((n % 128) | 128); n = Math.floor(n / 128) }
  out.push(n)
  return Buffer.from(out)
}
const field = (no, value) => {
  if (typeof value === 'number') return Buffer.concat([varint(no * 8), varint(value)])
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
  return Buffer.concat([varint(no * 8 + 2), varint(bytes.length), bytes])
}
const programme = ({ title, st, et }) => Buffer.concat([
  field(1, '22452412'), field(2, title), field(3, st), field(4, et), field(5, '19:00'), field(7, Math.max(0, et - st)),
])
const epgFile = items => Buffer.concat([field(1, 200), ...items.map(item => field(2, programme(item)))])

// 2026-09-25 19:00 / 19:30（上海）
const NEWS = { title: '新闻联播', st: 1790334000, et: 1790335800 }
const FOCUS = { title: '焦点访谈 & <特别节目>', st: 1790335800, et: 1790337600 }

console.log('模块节目单测试')

check('央视频 protobuf：取出节目名与起止时间，残缺节目跳过', () => {
  const buf = epgFile([FOCUS, NEWS, { title: '', st: 1, et: 2 }, { title: '倒挂', st: 10, et: 5 }])
  assert.deepEqual(decodeProgrammes(buf), [
    { title: FOCUS.title, start: FOCUS.st * 1000, stop: FOCUS.et * 1000 },
    { title: NEWS.title, start: NEWS.st * 1000, stop: NEWS.et * 1000 },
  ])
  assert.deepEqual(decodeProgrammes(field(1, 200)), [])
  assert.throws(() => decodeProgrammes(epgFile([NEWS]).subarray(0, 20)), /截断/)
})

check('央视频每个频道（含会员频道）都登记了节目单 key', () => {
  const refs = yangshipinEpg.channels().map(channel => channel.ref)
  assert.deepEqual(refs, buildChannels().map(channel => channel.deferredRef))
  assert.ok(yangshipinEpg.channels().every(channel => /^\d+$/.test(channel.key) && channel.name))
  assert.equal(getModule('yangshipin').epg, yangshipinEpg)
})

await checkAsync('央视频按 livePid + 上海日期取，当天没发（404）返回空、其它错误抛出', async () => {
  let requested = ''
  const ok = await yangshipinEpg.programmes('600190407', '20260925', {
    fetchImpl: async url => { requested = url; return new Response(epgFile([FOCUS, NEWS])) },
  })
  assert.equal(requested, `${EPG_API}600190407/20260925`)
  assert.deepEqual(ok.map(item => item.title), [NEWS.title, FOCUS.title], '按开始时间排序')
  assert.deepEqual(await yangshipinEpg.programmes('600213139', '20260925', {
    fetchImpl: async () => new Response('NoSuchKey', { status: 404 }),
  }), [])
  await assert.rejects(yangshipinEpg.programmes('600190407', '20260925', {
    fetchImpl: async () => new Response('', { status: 503 }),
  }), /HTTP 503/)
  await assert.rejects(yangshipinEpg.programmes('../x', '20260925', { fetchImpl: async () => { throw new Error('不应请求') } }), /参数非法/)
})

check('上海日期与 XMLTV 时间与运行机器的时区无关', () => {
  // 2026-09-24 23:59:59 / 09-25 00:00:00（上海）
  assert.deepEqual(shanghaiDays(Date.parse('2026-09-24T15:59:59Z'), 2), ['20260924', '20260925'])
  assert.deepEqual(shanghaiDays(Date.parse('2026-09-24T16:00:00Z'), 1), ['20260925'])
  assert.equal(xmltvTime(NEWS.st * 1000), '20260925190000 +0800')
})

check('写出的 XMLTV 片段转义节目名与频道 id', () => {
  const xml = channelXml('A&B台', [{ title: FOCUS.title, start: FOCUS.st * 1000, stop: FOCUS.et * 1000 }])
  assert.match(xml, /<channel id="A&amp;B台">/)
  assert.match(xml, /<programme channel="A&amp;B台" start="20260925193000 \+0800" stop="20260925200000 \+0800">/)
  assert.match(xml, /<title lang="zh">焦点访谈 &amp; &lt;特别节目&gt;<\/title>/)
})

await checkAsync('多天合并去重排序，单天失败不连累其它天，全失败才抛', async () => {
  const provider = {
    days: 2,
    async programmes(key, day) {
      if (key === 'down') throw new Error('接口挂了')
      if (day === '20260926') throw new Error('明天还没发')
      return [{ title: '跨日节目', start: 2, stop: 3 }, { title: '早间', start: 1, stop: 2 }, { title: '跨日节目', start: 2, stop: 3 }]
    },
  }
  const now = Date.parse('2026-09-25T02:00:00Z')
  assert.deepEqual((await providerProgrammes(provider, 'ok', { now })).map(item => item.title), ['早间', '跨日节目'])
  await assert.rejects(providerProgrammes(provider, 'down', { now }), /接口挂了/)
  const settled = await mapSettled([1, 2, 3], 2, async n => { if (n === 2) throw new Error('x'); return n * 10 })
  assert.deepEqual(settled.map(result => result.status), ['fulfilled', 'rejected', 'fulfilled'])
  assert.equal(settled[2].value, 30)
})

await checkAsync('咪咕已覆盖的跳过，同名只取一次，写成的记入已覆盖，失败只影响该频道', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iptv-module-epg-'))
  const bak = join(dir, 'playback.xml.bak')
  writeFileSync(bak, '')
  try {
    const requested = []
    const fetchImpl = async url => {
      requested.push(String(url))
      if (String(url).includes('/600002475/')) throw new Error('socket hang up')
      return new Response(epgFile([NEWS]))
    }
    const covered = new Set([normalizeKey('CCTV1综合')])
    const result = await appendModuleEpg(bak, [
      { ref: 'ysp-cctv1', name: 'CCTV1综合' },           // 咪咕已覆盖
      { ref: 'ysp-shanxiws2', name: '山西卫视' },
      { ref: 'ysp-shanxiws2', name: '山西卫视' },         // 同名第二次出现
      { ref: 'ysp-hnws', name: '湖南卫视' },              // 取失败
      { ref: 'nmtv-satellite', name: '内蒙古卫视' },      // 模块没有节目单
      { ref: 'nobody', name: '无主频道' },
    ], covered, { now: Date.parse('2026-09-25T02:00:00Z'), fetchImpl })
    assert.deepEqual(result, { appended: 1, failed: 1 })
    assert.ok(requested.every(url => !url.includes('/600001859/')), '咪咕已覆盖的不再请求')
    assert.equal(requested.filter(url => url.includes('/600190407/')).length, 2, '山西卫视只取一次（今天 + 明天）')
    assert.ok(covered.has(normalizeKey('山西卫视')))
    assert.ok(!covered.has(normalizeKey('湖南卫视')), '没取到的留给外部源')
    const xml = readFileSync(bak, 'utf8')
    assert.equal((xml.match(/<channel id=/g) || []).length, 1)
    assert.match(xml, new RegExp(`<channel id="${epgChannelId('山西卫视')}">`))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await checkAsync('同名频道来自不同模块时，前一个官方没发或取失败就换下一个', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iptv-module-epg-'))
  const bak = join(dir, 'playback.xml.bak')
  writeFileSync(bak, '')
  try {
    const provider = (id, behaviour) => ({
      name: id,
      epg: {
        days: 1,
        channels: () => [{ ref: `${id}-gx`, name: '国学频道', key: id }, { ref: `${id}-news`, name: '新闻', key: `${id}-news` }],
        async programmes(key) {
          const mode = behaviour[key]
          if (mode === 'throw') throw new Error(`${key} 挂了`)
          return mode === 'empty' ? [] : [{ title: `${key} 的节目`, start: NEWS.st * 1000, stop: NEWS.et * 1000 }]
        },
      },
    })
    const modules = {
      a: provider('a', { a: 'empty', 'a-news': 'throw' }),
      b: provider('b', { b: 'ok', 'b-news': 'ok' }),
    }
    const covered = new Set()
    const result = await appendModuleEpg(bak, [
      { ref: 'a-gx', name: '国学频道' },
      { ref: 'b-gx', name: '国学频道' },
      { ref: 'a-news', name: '新闻' },
      { ref: 'b-news', name: '新闻HD' },
    ], covered, { resolveModule: ref => modules[ref.split('-')[0]] })
    assert.deepEqual(result, { appended: 2, failed: 0 })
    const xml = readFileSync(bak, 'utf8')
    assert.match(xml, /b 的节目/)
    assert.match(xml, /b-news 的节目/)
    assert.doesNotMatch(xml, /a 的节目|a-news 的节目/)
    // 同组名字的输出 id 各写一份（开着归一时收敛成一个），播放列表里哪个 tvg-id 都对得上
    const ids = [...xml.matchAll(/<channel id="([^"]+)">/g)].map(m => m[1])
    const expected = new Set(['国学频道', ...new Set(['新闻', '新闻HD'].map(epgChannelId))].map(epgChannelId))
    assert.deepEqual(new Set(ids), expected)
    assert.equal(ids.length, expected.size, '同一个 id 只写一份')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await checkAsync('直链频道没有 ref：按来源模块 + 频道名精确对上，别的模块同名不串', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iptv-module-epg-'))
  const bak = join(dir, 'playback.xml.bak')
  writeFileSync(bak, '')
  try {
    const plain = {
      name: '直链台',
      epg: {
        days: 1,
        channels: () => [{ ref: 'plain-1', name: '黑龙江都市', key: 'dushi' }],
        async programmes(key) { return [{ title: `${key} 的节目`, start: NEWS.st * 1000, stop: NEWS.et * 1000 }] },
      },
    }
    const result = await appendModuleEpg(bak, [
      { sourceId: 'xt:plain', name: '黑龙江都市' },
      { sourceId: 'xt:plain', name: '黑龙江都市HD' },   // 模块登记表里没有这个名字
      { sourceId: 'xt:other', name: '黑龙江都市' },     // 别的模块（没有节目单）
    ], new Set(), {
      resolveModule: () => { throw new Error('直链频道不该按 ref 找模块') },
      moduleForSource: sourceId => (sourceId === 'xt:plain' ? plain : undefined),
    })
    assert.deepEqual(result, { appended: 1, failed: 0 })
    assert.match(readFileSync(bak, 'utf8'), /dushi 的节目/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('注册表拒绝不完整的节目单提供者', () => {
  const base = { id: 'fake', fetch: async () => ({ groups: [] }) }
  assert.throws(() => validateModule({ ...base, epg: { channels: () => [] } }), /channels\(\) 与 programmes\(\)/)
  assert.doesNotThrow(() => validateModule({ ...base, epg: yangshipinEpg }))
})

console.log(`\n全部通过：${passed} ✅`)
