#!/usr/bin/env node
/**
 * 按配置档过滤源 回归测试（issue #29/#68）
 *
 * 不变量：
 *  1) ensureSourceIds —— 外部源稳定 id：缺则补、已有保留、彼此唯一、幂等。
 *  2) dedupeAllChannels —— 组内 name+地址 去重保留第一个；重复命中时把归属并入
 *     保留者的 sourceIds 并集（多源提供的同一频道，禁用其一不误删）。
 *  3) applyConfig.disabledSources —— 黑名单语义：频道**所有**来源都被禁才隐藏；
 *     部分来源可用则保留；旧数据（无 sourceIds）不过滤；空黑名单不过滤。
 *
 * 运行： node scripts/test-source-filter.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureSourceIds, inheritExistingSourceIds } from '../utils/externalSources.js'
import { dedupeAllChannels, primarySourceId } from '../utils/channelMerger.js'
import { applyConfig } from '../utils/playlistConfig.js'

for (const k of ['log', 'info', 'warn']) {
  const orig = console[k]
  console[k] = (...a) => { if (a.some(x => typeof x === 'string' && /应用播放列表配置|配置应用完成|频道去重/.test(x))) return; orig.apply(console, a) }
}

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('按配置档过滤源 回归测试 (issue #29/#68)')

// 1) ensureSourceIds
check('ensureSourceIds：缺则补、已有保留、唯一、幂等', () => {
  const cfg = { sources: [{ name: 'A' }, { name: 'B', id: 'keep-me' }, { name: 'C' }] }
  assert.equal(ensureSourceIds(cfg), true)                    // 有补 → mutated
  assert.equal(cfg.sources[1].id, 'keep-me')                  // 已有 id 不动
  assert.ok(cfg.sources[0].id && cfg.sources[2].id)
  assert.notEqual(cfg.sources[0].id, cfg.sources[2].id)       // 唯一
  const snapshot = cfg.sources.map(s => s.id)
  assert.equal(ensureSourceIds(cfg), false)                   // 幂等：第二次无变化
  assert.deepEqual(cfg.sources.map(s => s.id), snapshot)
  assert.equal(ensureSourceIds(null), false)                  // 异常输入不炸
  assert.equal(ensureSourceIds({}), false)
})

// 2) dedupeAllChannels：去重 + 归属并集
check('dedupeAllChannels：重复频道归属并入保留者 sourceIds', () => {
  const groups = [{
    name: '体育',
    dataList: [
      { name: 'CCTV5', pID: '123' },                                   // 咪咕（隐式 migu）
      { name: 'CCTV5', url: 'http://a/1.m3u8', sourceId: 'ext:aa' },   // 外部A（地址不同 → 保留）
      { name: 'CCTV5', url: 'http://a/1.m3u8', sourceId: 'ext:bb' },   // 外部B（与A完全同 → 去重并入）
      { name: 'CCTV5', pID: '123' },                                   // 咪咕重复 → 去重
    ]
  }]
  const removed = dedupeAllChannels(groups)
  assert.equal(removed, 2)
  assert.equal(groups[0].dataList.length, 2)
  const extKept = groups[0].dataList.find(c => c.url)
  assert.deepEqual(extKept.sourceIds, ['ext:aa', 'ext:bb'])   // 并集：A 保留、B 并入
  const migu = groups[0].dataList.find(c => c.pID)
  assert.equal(primarySourceId(migu), 'migu')                 // 咪咕隐式识别
  assert.deepEqual(migu.sourceIds, ['migu'])                  // 同源重复归并为单元素集合（与写盘回退主来源等价）
})

// 3) applyConfig disabledSources 语义
const mk = (sourceIds) => sourceIds === undefined
  ? { id: 'x1', name: 'X' }
  : { id: 'x1', name: 'X', sourceIds }
const shows = (disabledSources, ch) => applyConfig(
  [{ name: 'G', channels: [{ ...ch, originalGroup: 'G' }] }],
  { disabledSources }
).some(g => g.channels.some(c => c.name === 'X'))

check('applyConfig：唯一来源被禁 → 隐藏', () => {
  assert.equal(shows(['ext:aa'], mk(['ext:aa'])), false)
  assert.equal(shows(['migu'], mk(['migu'])), false)
})
check('applyConfig：多源频道只要有一个来源可用 → 保留', () => {
  assert.equal(shows(['ext:aa'], mk(['ext:aa', 'migu'])), true)
  assert.equal(shows(['ext:aa', 'migu'], mk(['ext:aa', 'migu'])), false)  // 全禁才隐藏
})
check('applyConfig：旧数据（无/空 sourceIds）不过滤', () => {
  assert.equal(shows(['ext:aa'], mk(undefined)), true)
  assert.equal(shows(['ext:aa'], mk([])), true)
})
check('applyConfig：空黑名单 / 缺省配置不过滤', () => {
  assert.equal(shows([], mk(['ext:aa'])), true)
  assert.equal(shows(undefined, mk(['ext:aa'])), true)
})
check('applyConfig：禁源优先于手动移动（被禁源的频道即使移动过也隐藏）', () => {
  const groups = [{ name: 'G', channels: [{ id: 'x1', name: 'X', originalGroup: 'G', sourceIds: ['ext:aa'] }] }]
  const out = applyConfig(groups, { disabledSources: ['ext:aa'], channelGroupMap: { 'G::x1': '我的最爱' } })
  assert.equal(out.some(g => g.channels.some(c => c.name === 'X')), false)
})

// 4) 前端未回读旧副本整份保存 → 按「身份」继承已有 id，不漂移（saveSources 内部即此二连：先继承再发号）
check('inheritExistingSourceIds：无 id 旧副本按身份继承现有 id（防档↔源绑定孤儿）', () => {
  const current = { enabled: true, sources: [{ name: 'A源', subscriptionUrl: 'http://x/a.m3u', id: 'aaaa1111' }] }
  const incoming = { enabled: true, sources: [
    { name: 'A源', subscriptionUrl: 'http://x/a.m3u' },          // 同身份、无 id → 应继承 aaaa1111
    { name: 'B源', subscriptionUrl: 'http://x/b.m3u' },          // 新源 → 由 ensureSourceIds 发新号
  ] }
  inheritExistingSourceIds(incoming, current)
  assert.equal(incoming.sources[0].id, 'aaaa1111')               // 继承、不漂移
  assert.equal(incoming.sources[1].id, undefined)
  ensureSourceIds(incoming)
  assert.ok(incoming.sources[1].id && incoming.sources[1].id !== 'aaaa1111')  // 新号且不撞
  // 已带 id 的照原样：再次继承是幂等
  inheritExistingSourceIds(incoming, current)
  assert.equal(incoming.sources[0].id, 'aaaa1111')
})

// 5) 写盘属性 → 解析 → 过滤 → 输出剥离 全链路回环（子进程 + mdataDir 沙箱，正是揪出「逗号撞频道名解析」的用例）
check('回环：source-ids 写盘→解析→按档过滤→播放器输出剥离', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iptv-srcfilter-'))
  try {
    const script = `
import { writeFileSync } from 'node:fs'
import { dataPath } from './utils/paths.js'
writeFileSync(dataPath('interface.txt'), [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="频道A" tvg-name="频道A" tvg-logo="" source-ids="ext:t1" group-title="回环组",频道A',
  'http://x/1.m3u8',
  '#EXTINF:-1 tvg-id="频道B" tvg-name="频道B" tvg-logo="" group-title="回环组",频道B',
  'http://x/2.m3u8',
  '#EXTINF:-1 tvg-id="频道C" tvg-name="频道C" tvg-logo="" source-ids="ext:t1;migu" group-title="回环组",频道C',
  'http://x/3.m3u8',
].join('\\n') + '\\n')
const { parseInterfaceTxt, applyConfig } = await import('./utils/playlistConfig.js')
const groups = parseInterfaceTxt()
const g = groups.find(x => x.name === '回环组')
const C = g.channels.find(c => c.name === '频道C')
if (!C || JSON.stringify(C.sourceIds) !== JSON.stringify(['ext:t1','migu'])) throw new Error('多源解析失败(分隔符回归?)')
const names = applyConfig(groups, { disabledSources: ['ext:t1'] }).flatMap(x => x.channels.map(c => c.name))
if (names.includes('频道A') || !names.includes('频道B') || !names.includes('频道C')) throw new Error('过滤语义失败: ' + names)
const { interfaceStr } = await import('./utils/appUtils.js')
const body = String(interfaceStr('/m3u', { host: 'localhost:1905' }, '', '', 'default').content)
if (body.includes('source-ids')) throw new Error('输出泄漏内部属性')
console.log('ROUNDTRIP_OK')
`
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script],
      { env: { ...process.env, mdataDir: dir }, cwd: process.cwd(), encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    assert.ok(out.includes('ROUNDTRIP_OK'), '子进程回环未通过')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

console.log(`\n全部通过：${passed}/9 ✅`)
