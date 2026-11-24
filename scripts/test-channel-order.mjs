#!/usr/bin/env node
/**
 * 组内手动排序的测试：没排过序的新线路排到同名线路后面
 *
 * 背景：channelOrder 按 `原始分组::频道ID` 存，订阅源的频道 ID 含播放地址。聚合订阅隔几小时换一批地址，
 * 换了地址的线路就成了「不在顺序表里」的新频道，以前一律掉到组尾——同一台的几条线路被拆开，
 * 后台「同名线路」面板里调好的先后也跟着乱。现在它紧跟在已排好的同名线路后面；没有同名的照旧排到组尾。
 *
 * 运行： node scripts/test-channel-order.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { applyConfig, sortChannelsByOrder } from '../utils/playlistConfig.js'

for (const k of ['log', 'info', 'warn']) {
  const orig = console[k]
  console[k] = (...a) => { if (a.some(x => typeof x === 'string' && /应用播放列表配置|配置应用完成/.test(x))) return; orig.apply(console, a) }
}

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const ch = (id, name, group = 'G') => ({ id, name, originalGroup: group })
const ids = list => list.map(c => c.id)

console.log('组内手动排序测试')

check('全都在顺序表里：按顺序表排', () => {
  const list = [ch('a', 'A'), ch('b', 'B'), ch('c', 'C')]
  assert.deepEqual(ids(sortChannelsByOrder(list, ['G::c', 'G::a', 'G::b'])), ['c', 'a', 'b'])
})

check('不在顺序表里、也没有同名的：按原相对顺序排到组尾（与以前一样）', () => {
  const list = [ch('x', 'X'), ch('a', 'A'), ch('y', 'Y'), ch('b', 'B')]
  assert.deepEqual(ids(sortChannelsByOrder(list, ['G::b', 'G::a'])), ['b', 'a', 'x', 'y'])
})

check('换了地址的同名线路：紧跟在已排好的同名线路后面，不掉到组尾', () => {
  const list = [ch('c1', 'CCTV1'), ch('c2', 'CCTV2'), ch('c3', 'CCTV3'), ch('c1new', 'CCTV1')]
  assert.deepEqual(ids(sortChannelsByOrder(list, ['G::c2', 'G::c1', 'G::c3'])), ['c2', 'c1', 'c1new', 'c3'])
})

check('同名排好的有好几条：跟在最后一条后面', () => {
  const list = [ch('a1', 'CCTV1'), ch('b', 'CCTV2'), ch('a2', 'CCTV1'), ch('a3', 'CCTV1')]
  assert.deepEqual(ids(sortChannelsByOrder(list, ['G::a2', 'G::a1', 'G::b'])), ['a2', 'a1', 'a3', 'b'])
})

check('同一台冒出两条新线路：都跟在后面，两条之间保持原相对顺序', () => {
  const list = [ch('a', 'CCTV1'), ch('n1', 'CCTV1'), ch('b', 'CCTV2'), ch('n2', 'CCTV1')]
  assert.deepEqual(ids(sortChannelsByOrder(list, ['G::a', 'G::b'])), ['a', 'n1', 'n2', 'b'])
})

check('同名比对去首尾空白、不分大小写', () => {
  const list = [ch('a', 'Love Nature'), ch('b', 'CNA'), ch('n', ' love nature ')]
  assert.deepEqual(ids(sortChannelsByOrder(list, ['G::a', 'G::b'])), ['a', 'n', 'b'])
})

check('同一 ID 在不同原始分组各算各的', () => {
  const list = [ch('p', 'CCTV5', '体育'), ch('p', 'CCTV5', '央视'), ch('q', 'CCTV6', '央视')]
  assert.deepEqual(sortChannelsByOrder(list, ['央视::q', '体育::p']).map(c => `${c.originalGroup}:${c.id}`),
    ['央视:q', '体育:p', '央视:p'])
})

check('顺序表里有重复项：取第一次出现的位置（与旧的 indexOf 一致）', () => {
  const list = [ch('a', 'A'), ch('b', 'B')]
  assert.deepEqual(ids(sortChannelsByOrder(list, ['G::b', 'G::a', 'G::b'])), ['b', 'a'])
})

check('不改输入数组', () => {
  const list = [ch('a', 'A'), ch('b', 'B')]
  sortChannelsByOrder(list, ['G::b', 'G::a'])
  assert.deepEqual(ids(list), ['a', 'b'])
})

check('经过 applyConfig：订阅换址后的新线路排在同名线路后面，排序跟当前显示名走', () => {
  const groups = [{ name: '央视', channels: [
    { id: 'm1', name: 'CCTV1' }, { id: 'm2', name: 'CCTV2' }, { id: 'm3', name: 'CCTV3' },
    { id: 'ext-new', name: 'CCTV1' },
    { id: 'ext-x', name: 'CCTV-2 电信' },
  ] }]
  const config = {
    channelGroupMap: {}, channelOrder: { '央视': ['央视::m3', '央视::m1', '央视::m2'] }, hiddenChannels: [],
    customGroups: [], groupOrder: [], deletedGroups: [], groupRenameMap: {}, groupSortMode: {},
    // 用户把这条改名成 CCTV2：按改后的显示名算同名
    channelRenameMap: { '央视::ext-x': 'CCTV2' },
  }
  const out = applyConfig(groups, config).find(g => g.name === '央视')
  assert.deepEqual(ids(out.channels), ['m3', 'm1', 'ext-new', 'm2', 'ext-x'])
})

check('经过 applyConfig：按名称自动排序的分组不受影响', () => {
  const groups = [{ name: 'A', channels: [{ id: '2', name: 'B台' }, { id: '1', name: 'A台' }, { id: '3', name: 'A台' }] }]
  const config = {
    channelGroupMap: {}, channelRenameMap: {}, channelOrder: { A: ['A::2', 'A::1'] }, hiddenChannels: [],
    customGroups: [], groupOrder: [], deletedGroups: [], groupRenameMap: {}, groupSortMode: { A: 'name' },
  }
  const out = applyConfig(groups, config).find(g => g.name === 'A')
  assert.deepEqual(out.channels.map(c => c.name), ['A台', 'A台', 'B台'])
})

console.log(`\n全部通过：${passed} 项`)
