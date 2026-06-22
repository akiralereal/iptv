#!/usr/bin/env node
/**
 * 移动频道后隐藏的回归测试（issue #42）
 *
 * 不变量：隐藏 key 必须用频道「真实原始分组」(originalGroup)，即 `${originalGroup}::${id}`，
 * 与服务端 applyConfig 的隐藏判定一致。移动过的频道其显示分组 ≠ 原始分组，
 * 若按显示分组算 key（旧 bug），隐藏对它不生效。
 *
 * 运行： node scripts/test-move-hide.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { applyConfig } from '../utils/playlistConfig.js'

for (const k of ['log', 'info', 'warn']) {
  const orig = console[k]
  console[k] = (...a) => { if (a.some(x => typeof x === 'string' && /应用播放列表配置|配置应用完成/.test(x))) return; orig.apply(console, a) }
}

const groups = () => ([
  { name: 'A', channels: [{ id: 'x1', name: 'X' }] },
  { name: 'C', channels: [{ id: 'y1', name: 'Y' }] },
])
const base = () => ({ channelGroupMap: {}, channelRenameMap: {}, channelOrder: {}, hiddenChannels: [],
  customGroups: [{ name: 'B' }], groupOrder: [], deletedGroups: [], groupRenameMap: {}, groupSortMode: {} })
const shows = (cfg, name) => applyConfig(groups(), cfg).some(g => g.channels.some(c => c.name === name))

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('移动后隐藏回归测试 (issue #42)')

check('移动 A→B 后，X 显示在 B', () => {
  const cfg = base(); cfg.channelGroupMap = { 'A::x1': 'B' }
  assert.equal(shows(cfg, 'X'), true)
})

check('用「原始分组」key (A::x1) 隐藏 → 生效（X 不再显示）', () => {
  const cfg = base(); cfg.channelGroupMap = { 'A::x1': 'B' }; cfg.hiddenChannels = ['A::x1']
  assert.equal(shows(cfg, 'X'), false)
})

check('用「显示分组」key (B::x1) 隐藏 → 不生效（复现旧 bug，前端不可这样算）', () => {
  const cfg = base(); cfg.channelGroupMap = { 'A::x1': 'B' }; cfg.hiddenChannels = ['B::x1']
  assert.equal(shows(cfg, 'X'), true)
})

check('原分组 A 被搬空后，仍能用 A::x1 正确隐藏 X', () => {
  // A 只有 x1，移走后 A 在显示层为空；隐藏仍按原始分组 A 算 key
  const cfg = base(); cfg.channelGroupMap = { 'A::x1': 'B' }; cfg.hiddenChannels = ['A::x1']
  assert.equal(shows(cfg, 'X'), false)
})

// 批量移动同类不变量：再次移动「已移动过」的频道，必须改写原始分组那条键 A::x1
const inGroup = (cfg, ch, grp) => applyConfig(groups(), cfg).find(g => g.name === grp)?.channels.some(c => c.name === ch)

check('再次移动 B→C：改写 A::x1=C → X 落在 C', () => {
  const cfg = base(); cfg.customGroups = [{ name: 'B' }, { name: 'C2' }]; cfg.channelGroupMap = { 'A::x1': 'C2' }
  assert.equal(inGroup(cfg, 'X', 'C2'), true)
})

check('旧 bug 形态（孤儿键 B::x1=C2）→ X 仍卡在 B（前端不可这样写）', () => {
  const cfg = base(); cfg.customGroups = [{ name: 'B' }, { name: 'C2' }]; cfg.channelGroupMap = { 'A::x1': 'B', 'B::x1': 'C2' }
  assert.equal(inGroup(cfg, 'X', 'B'), true)
  assert.equal(inGroup(cfg, 'X', 'C2'), false)
})

check('移回原组：删除 A::x1 → X 回到 A', () => {
  const cfg = base() // 无 channelGroupMap = 已删除归类
  assert.equal(inGroup(cfg, 'X', 'A'), true)
})

console.log(`\n全部通过：${passed}/7 ✅`)
