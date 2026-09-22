#!/usr/bin/env node
/**
 * 分组改名后「移进来的频道」要跟着走的回归测试（issue #132）
 *
 * 不变量：channelGroupMap 的值存的是目标分组的**显示名**，且 applyConfig 里「单频道移动」
 * 优先级高于「分组重命名」。分组改名若不同步改写这些值，移进来的频道会留在旧名下，凭空撑起一个
 * 既不是源分组、也不是自定义分组的残留分组——它再怎么改名都不生效，界面却照样提示「已重命名」。
 *
 * 改写逻辑在前端（web/admin.html 的 rewriteConfigForGroupRename，纯函数）。这里把它原样抽出来，
 * 和服务端 applyConfig / collectGroupConflicts 串起来跑，测的是线上真正执行的那份代码。
 *
 * 运行： node scripts/test-group-rename-moved.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { applyConfig, collectGroupConflicts } from '../utils/playlistConfig.js'

for (const k of ['log', 'info', 'warn']) {
  const orig = console[k]
  console[k] = (...a) => { if (a.some(x => typeof x === 'string' && /应用播放列表配置|配置应用完成/.test(x))) return; orig.apply(console, a) }
}

// 函数体内的花括号都比函数本身缩进更深，按「同缩进的收尾 }」截取即可
const admin = readFileSync(new URL('../web/admin.html', import.meta.url), 'utf8')
const source = admin.match(/^ {8}function rewriteConfigForGroupRename\([\s\S]*?^ {8}\}$/m)
assert.ok(source, 'web/admin.html 里找不到 rewriteConfigForGroupRename')
const rewriteConfigForGroupRename = new Function(`${source[0]}; return rewriteConfigForGroupRename`)()

const groups = () => ([
  { name: '斗鱼', channels: [{ id: 'd1', name: '斗鱼一' }, { id: 'd2', name: '斗鱼二' }] },
  { name: '虎牙', channels: [{ id: 'h1', name: '虎牙一' }] },
  { name: 'B站', channels: [{ id: 'b1', name: 'B站一' }, { id: 'b2', name: 'B站二' }] },
])
const sourceNames = () => groups().map(g => g.name)
const base = () => ({ channelGroupMap: {}, channelRenameMap: {}, channelOrder: {}, hiddenChannels: [],
  customGroups: [], groupOrder: [], deletedGroups: [], groupRenameMap: {}, groupSortMode: {} })

// 应用配置后的「分组名 → 频道名」视图；空的自定义分组也在里面
const view = cfg => Object.fromEntries(applyConfig(groups(), cfg).map(g => [g.name, g.channels.map(c => c.name).sort()]))
const rename = (cfg, from, to, names = sourceNames()) => { rewriteConfigForGroupRename(cfg, from, to, names); return cfg }

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('分组改名带走移入频道回归测试 (issue #132)')

check('#132 原样：斗鱼频道全移进自定义分组，再把它改名回「斗鱼」→ 频道跟着走，不留旧名分组', () => {
  const cfg = base()
  cfg.customGroups = [{ name: 'B站&虎牙&斗鱼' }]
  cfg.channelGroupMap = { '斗鱼::d1': 'B站&虎牙&斗鱼', '斗鱼::d2': 'B站&虎牙&斗鱼' }
  rename(cfg, 'B站&虎牙&斗鱼', '斗鱼')
  const v = view(cfg)
  assert.deepEqual(v['斗鱼'], ['斗鱼一', '斗鱼二'])
  assert.equal('B站&虎牙&斗鱼' in v, false)
  // 服务端保存前的重名校验也得放行，否则这次改名会被整个拒掉
  assert.deepEqual(collectGroupConflicts(groups(), cfg), [])
})

check('源分组改过名、又移进了别组频道 → 再改名时移入频道一起走', () => {
  const cfg = base()
  cfg.groupRenameMap = { '虎牙': '虎牙X' }
  cfg.channelGroupMap = { 'B站::b1': '虎牙X' }
  rename(cfg, '虎牙X', '虎牙Y')
  const v = view(cfg)
  assert.deepEqual(v['虎牙Y'], ['B站一', '虎牙一'])
  assert.equal('虎牙X' in v, false)
  assert.deepEqual(cfg.groupRenameMap, { '虎牙': '虎牙Y' })
})

check('源分组改回原名 → 重命名记录删除，移入频道照样跟着回来', () => {
  const cfg = base()
  cfg.groupRenameMap = { '虎牙': '虎牙X' }
  cfg.channelGroupMap = { 'B站::b1': '虎牙X' }
  rename(cfg, '虎牙X', '虎牙')
  assert.deepEqual(view(cfg)['虎牙'], ['B站一', '虎牙一'])
  assert.deepEqual(cfg.groupRenameMap, {})
})

check('被隐藏的移入频道也要改写（按值遍历，不看当前是否可见）', () => {
  const cfg = base()
  cfg.customGroups = [{ name: '收藏' }]
  cfg.channelGroupMap = { 'B站::b1': '收藏', 'B站::b2': '收藏' }
  cfg.hiddenChannels = ['B站::b2']
  rename(cfg, '收藏', '常看')
  assert.equal(cfg.channelGroupMap['B站::b2'], '常看')
  cfg.hiddenChannels = []   // 恢复显示后应落在新名下，而不是把旧名分组又带出来
  const v = view(cfg)
  assert.deepEqual(v['常看'], ['B站一', 'B站二'])
  assert.equal('收藏' in v, false)
})

check('旧版本留下的残留分组：直接改名即可救回，误写的重命名记录一并清掉', () => {
  // 旧版本下「改自定义分组名 → 再对残留分组改名」两步之后盘上的真实状态
  const cfg = base()
  cfg.customGroups = [{ name: '斗鱼' }]
  cfg.channelGroupMap = { '斗鱼::d1': 'B站&虎牙&斗鱼', '斗鱼::d2': 'B站&虎牙&斗鱼' }
  cfg.groupRenameMap = { 'B站&虎牙&斗鱼': '斗鱼直播' }
  assert.deepEqual(view(cfg)['B站&虎牙&斗鱼'], ['斗鱼一', '斗鱼二'])   // 前提：残留分组确实存在

  rename(cfg, 'B站&虎牙&斗鱼', '斗鱼直播')
  const v = view(cfg)
  assert.deepEqual(v['斗鱼直播'], ['斗鱼一', '斗鱼二'])
  assert.equal('B站&虎牙&斗鱼' in v, false)
  assert.deepEqual(cfg.groupRenameMap, {})
  assert.deepEqual(collectGroupConflicts(groups(), cfg), [])
})

check('自定义分组与同名源分组合并显示时，改名只带走自定义那部分（源分组留在原名）', () => {
  const cfg = base()
  cfg.customGroups = [{ name: '虎牙' }]
  cfg.channelGroupMap = { 'B站::b1': '虎牙' }
  rename(cfg, '虎牙', '我的直播')
  const v = view(cfg)
  assert.deepEqual(v['我的直播'], ['B站一'])
  assert.deepEqual(v['虎牙'], ['虎牙一'])
  assert.deepEqual(cfg.groupRenameMap, {})
})

check('不相干的移动记录不受影响；排序相关的表跟着换名', () => {
  const cfg = base()
  cfg.customGroups = ['收藏', '其它']   // 老格式：字符串数组
  cfg.channelGroupMap = { 'B站::b1': '收藏', '虎牙::h1': '其它' }
  cfg.groupOrder = ['其它', '收藏']
  cfg.groupSortMode = { '收藏': 'name' }
  cfg.channelOrder = { '收藏': ['B站::b1'] }
  rename(cfg, '收藏', '常看')
  assert.deepEqual(cfg.customGroups, ['常看', '其它'])
  assert.deepEqual(cfg.channelGroupMap, { 'B站::b1': '常看', '虎牙::h1': '其它' })
  assert.deepEqual(cfg.groupOrder, ['其它', '常看'])
  assert.deepEqual(cfg.groupSortMode, { '常看': 'name' })
  assert.deepEqual(cfg.channelOrder, { '常看': ['B站::b1'] })
})

check('拿不到源分组全集（空数组）时不判残留分组，源分组改名照常写记录', () => {
  const cfg = base()
  rename(cfg, '虎牙', '虎牙X', [])
  assert.deepEqual(cfg.groupRenameMap, { '虎牙': '虎牙X' })
  assert.deepEqual(view(cfg)['虎牙X'], ['虎牙一'])
})

console.log(`\n全部通过：${passed} ✅`)
