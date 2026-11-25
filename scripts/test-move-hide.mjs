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
import { readFileSync } from 'node:fs'
import { applyConfig, collectGroupConflicts } from '../utils/playlistConfig.js'

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

// ---- 「已隐藏」区：移动后再隐藏的台要单独列出、能恢复 ----
// hiddenAreaGroups 在前端（web/admin.html），按「同缩进的收尾 }」原样抽出来，和服务端 applyConfig 对照着跑
const admin = readFileSync(new URL('../web/admin.html', import.meta.url), 'utf8')
const extract = name => {
  const m = admin.match(new RegExp(`^ {8}function ${name}\\([\\s\\S]*?^ {8}\\}$`, 'm'))
  assert.ok(m, `web/admin.html 里找不到 ${name}`)
  return m[0]
}
const adminFns = new Function(`
  let myPlaylistConfig, myPlaylistOriginalData, myPlaylistHiddenCustomGroups
  const isSystemAnnouncementGroup = () => false
  ${['isGroupHiddenByConfig', 'isChannelHiddenById', 'channelMovedTo', 'hiddenCustomGroupNames',
     'setCustomGroupHidden', 'hiddenAreaChannelKey', 'hiddenAreaGroups'].map(extract).join('\n')}
  return {
    hiddenArea: (cfg, data, served = []) => {
      myPlaylistConfig = cfg; myPlaylistOriginalData = data; myPlaylistHiddenCustomGroups = served
      return hiddenAreaGroups()
    },
    setCustomGroupHidden,
    hiddenAreaChannelKey,
  }
`)()
const { hiddenArea, setCustomGroupHidden, hiddenAreaChannelKey } = adminFns
const groups3 = () => ([
  { name: 'A', channels: [{ id: 'x1', name: 'X1' }, { id: 'x2', name: 'X2' }, { id: 'x3', name: 'X3' }] },
  { name: 'C', channels: [{ id: 'y1', name: 'Y' }] },
])
// 「已隐藏」区的视图：['A', ['X3']] / ['A (隐藏频道)', ['X1']]
const area = cfg => hiddenArea(cfg, groups3()).map(g => [g.name + (g.isPartialDelete ? ' (隐藏频道)' : ''), g.channels.map(c => c.name)])
const visible = cfg => Object.fromEntries(applyConfig(groups3(), cfg).map(g => [g.name, g.channels.map(c => c.name)]))

check('原分组没整组隐藏：A→B 后隐藏 X1 → 列在「A (隐藏频道)」', () => {
  const cfg = base(); cfg.channelGroupMap = { 'A::x1': 'B' }; cfg.hiddenChannels = ['A::x1']
  assert.deepEqual(area(cfg), [['A (隐藏频道)', ['X1']]])
})

for (const rule of ['A', 'A*']) {
  check(`原分组整组隐藏（${rule}）：移走又隐藏的 X1 单独一条，移走没隐藏的 X2 不混进整组条目`, () => {
    const cfg = base()
    cfg.deletedGroups = [rule]
    cfg.channelGroupMap = { 'A::x1': 'B', 'A::x2': 'B' }
    cfg.hiddenChannels = ['A::x1']
    assert.deepEqual(area(cfg), [['A', ['X3']], ['A (隐藏频道)', ['X1']]])
    assert.deepEqual(visible(cfg).B, ['X2'])
    // 「恢复」= 去掉 A::x1 这条隐藏 → 回到隐藏前移去的 B
    cfg.hiddenChannels = []
    assert.deepEqual(visible(cfg).B.sort(), ['X1', 'X2'])
    assert.deepEqual(area(cfg), [['A', ['X3']]])
  })
}

check('整组隐藏前就单独隐藏、没移动过的 → 只在整组条目里，不重复列', () => {
  const cfg = base(); cfg.deletedGroups = ['A']; cfg.hiddenChannels = ['A::x3']
  assert.deepEqual(area(cfg), [['A', ['X1', 'X2', 'X3']]])
})

check('整组隐藏的分组被全部移空 → 整组条目仍在（还能恢复这条规则），频道数 0', () => {
  const cfg = base(); cfg.deletedGroups = ['A']
  cfg.channelGroupMap = { 'A::x1': 'B', 'A::x2': 'B', 'A::x3': 'B' }
  assert.deepEqual(area(cfg), [['A', []]])
})

// ---- 自定义分组整组隐藏：customGroups[].hidden，按「最终落到哪个分组」判 ----
// 服务端 applyConfig 和前端 setCustomGroupHidden / hiddenAreaGroups 串起来跑：前端写配置、服务端出列表、前端用服务端给的那份列「已隐藏」
const groups4 = () => ([
  { name: 'A', channels: [{ id: 'x1', name: 'X1' }, { id: 'x2', name: 'X2' }] },
  { name: 'C', channels: [{ id: 'y1', name: 'Y' }] },
  // 自定义源直接把分组写成自定义分组名时，interface.txt 里就有一个同名的源分组
  { name: '收藏', channels: [{ id: 'z1', name: 'Z' }] },
])
const withServed = cfg => {
  const served = []
  const shown = applyConfig(groups4(), cfg, { hiddenCustomGroups: served })
  return { shown: Object.fromEntries(shown.map(g => [g.name, g.channels.map(c => c.name)])), order: shown.map(g => g.name), served }
}
const favCfg = () => {
  const cfg = base()
  cfg.customGroups = [{ name: '收藏' }, { name: '空组' }]
  cfg.groupOrder = ['收藏', 'A', '空组', 'C']
  cfg.channelGroupMap = { 'A::x1': '收藏' }
  return cfg
}

check('隐藏自定义分组：移进来的、源里同名分组的频道都不输出，空分组也不补；别的分组不受影响', () => {
  const cfg = favCfg()
  setCustomGroupHidden(cfg, '收藏', true)
  setCustomGroupHidden(cfg, '空组', true)
  const { shown, served } = withServed(cfg)
  assert.deepEqual(shown, { A: ['X2'], C: ['Y'] })
  assert.deepEqual(served.map(g => [g.name, g.channels.map(c => c.name).sort()]), [['收藏', ['X1', 'Z']], ['空组', []]])
  // 服务端给的频道带着原始分组，前端按它拼 key，拿条目名「收藏」拼会写成 收藏::x1 这种孤儿键
  assert.equal(hiddenAreaChannelKey(served[0], 'x1'), 'A::x1')
  assert.equal(hiddenAreaChannelKey(served[0], 'z1'), '收藏::z1')
})

check('「已隐藏」区：自定义分组排在整组隐藏的源分组之后、单独隐藏的频道之前；单独隐藏过的不重复列', () => {
  const cfg = favCfg()
  cfg.channelGroupMap['C::y1'] = '收藏'
  cfg.hiddenChannels = ['C::y1']
  cfg.deletedGroups = ['A']
  setCustomGroupHidden(cfg, '收藏', true)
  setCustomGroupHidden(cfg, '空组', true)
  const { served } = withServed(cfg)
  const view = hiddenArea(cfg, groups4(), served)
    .map(g => [g.name + (g.isPartialDelete ? ' (隐藏频道)' : g.isCustomHidden ? ' (自定义)' : ''), g.channels.map(c => c.name).sort()])
  assert.deepEqual(view, [['A', ['X2']], ['收藏 (自定义)', ['X1', 'Z']], ['空组 (自定义)', []], ['C (隐藏频道)', ['Y']]])
})

check('恢复自定义分组：频道和位置原样回来，配置里不留 hidden 字段', () => {
  const cfg = favCfg()
  const before = withServed(cfg)
  setCustomGroupHidden(cfg, '收藏', true)
  setCustomGroupHidden(cfg, '收藏', false)
  assert.deepEqual(cfg.customGroups, [{ name: '收藏' }, { name: '空组' }])
  assert.deepEqual(withServed(cfg).shown, before.shown)
  assert.deepEqual(withServed(cfg).order, before.order)
})

check('从隐藏的自定义分组里移出频道（按原始分组写 channelGroupMap）→ 出现在目标分组', () => {
  const cfg = favCfg()
  setCustomGroupHidden(cfg, '收藏', true)
  const { served } = withServed(cfg)
  cfg.channelGroupMap[hiddenAreaChannelKey(served[0], 'x1')] = 'C'
  cfg.channelGroupMap[hiddenAreaChannelKey(served[0], 'z1')] = 'C'
  assert.deepEqual(withServed(cfg).shown.C.sort(), ['X1', 'Y', 'Z'])
  assert.deepEqual(withServed(cfg).served[0].channels, [])
})

check('老格式字符串条目：隐藏时转成对象，恢复后不带 hidden', () => {
  const cfg = base(); cfg.customGroups = ['收藏', '其它']; cfg.channelGroupMap = { 'A::x1': '收藏' }
  setCustomGroupHidden(cfg, '收藏', true)
  assert.deepEqual(cfg.customGroups, [{ name: '收藏', hidden: true }, '其它'])
  assert.equal('收藏' in withServed(cfg).shown, false)
  setCustomGroupHidden(cfg, '收藏', false)
  assert.deepEqual(cfg.customGroups, [{ name: '收藏' }, '其它'])
  assert.deepEqual(withServed(cfg).shown['收藏'].sort(), ['X1', 'Z'])
})

check('隐藏的自定义分组仍占着名字：再建同名分组会被服务端拦下', () => {
  const cfg = favCfg()
  setCustomGroupHidden(cfg, '空组', true)
  // 和保存接口一样只看「这次新引入」的重名（样例里「收藏」本来就和源分组同名，是旧冲突）
  const existing = new Set(collectGroupConflicts(groups4(), cfg).map(c => c.name))
  cfg.customGroups.push({ name: '空组' })
  assert.deepEqual(collectGroupConflicts(groups4(), cfg).map(c => c.name).filter(n => !existing.has(n)), ['空组'])
})

check('源分组的通配隐藏（体育-*）管不到同前缀的自定义分组，自定义分组的隐藏也不写进 deletedGroups', () => {
  const cfg = base()
  cfg.customGroups = [{ name: '体育-收藏' }]
  cfg.channelGroupMap = { 'A::x1': '体育-收藏' }
  cfg.deletedGroups = ['体育-*']
  assert.deepEqual(withServed(cfg).shown['体育-收藏'], ['X1'])
  setCustomGroupHidden(cfg, '体育-收藏', true)
  assert.deepEqual(cfg.deletedGroups, ['体育-*'])
  assert.equal('体育-收藏' in withServed(cfg).shown, false)
})

// ---- 批量整组隐藏（「只保留此分组」和左栏多选共用 groupHidePlanItem + writeGroupHidePlan）----
// 前端拿服务端出的显示列表逐组算计划、写配置，再交给服务端 applyConfig 看这些分组是不是真的不见了
const planFns = new Function(`
  let myPlaylistConfig, myPlaylistOriginalData
  const isSystemAnnouncementGroup = g => g?.name === '公告'
  ${['isGroupHiddenByConfig', 'getCustomGroupNames', 'isCustomGroupName', 'setCustomGroupHidden',
     'groupHidePlanItem', 'writeGroupHidePlan', 'groupHideLeftoverChannels'].map(extract).join('\n')}
  return {
    planFor: (cfg, data, names) => {
      myPlaylistConfig = cfg; myPlaylistOriginalData = data
      return names.map(name => groupHidePlanItem({ name, channels: [] }))
    },
    writeGroupHidePlan,
    groupHideLeftoverChannels,
  }
`)()
const groups5 = () => ([
  { name: '央视', channels: [{ id: 'a1', name: 'CCTV1' }] },
  { name: '卫视', channels: [{ id: 'b1', name: '湖南' }] },
  { name: '体育-今天', channels: [{ id: 'c1', name: '赛事' }] },
  { name: '电影', channels: [{ id: 'd1', name: '片' }] },
])
const base5 = () => ({ ...base(), customGroups: [] })   // base() 带的空自定义分组 B 会出现在列表里
const shown5 = cfg => Object.fromEntries(applyConfig(groups5(), cfg).map(g => [g.name, g.channels.map(c => c.name)]))
const hideBatch = (cfg, names) => {
  const plan = planFns.planFor(cfg, groups5(), names)
  planFns.writeGroupHidePlan(cfg, plan.filter(item => !item.skip))
  return plan
}

check('批量隐藏两个源分组：按原始分组名写 deletedGroups，改名和 groupOrder 不动，恢复后原样回来', () => {
  const cfg = base5()
  cfg.groupRenameMap = { 卫视: '地方台' }
  cfg.groupOrder = ['电影', '地方台', '央视', '体育-今天']
  const before = applyConfig(groups5(), cfg).map(g => g.name)
  hideBatch(cfg, ['地方台', '电影'])
  assert.deepEqual(cfg.deletedGroups, ['卫视', '电影'])
  assert.deepEqual(Object.keys(shown5(cfg)).sort(), ['体育-今天', '央视'].sort())
  assert.deepEqual(cfg.groupRenameMap, { 卫视: '地方台' })
  assert.deepEqual(cfg.groupOrder, ['电影', '地方台', '央视', '体育-今天'])
  cfg.deletedGroups = []
  assert.deepEqual(applyConfig(groups5(), cfg).map(g => g.name), before)
})

check('改名套改名（央视→卫视、卫视→省台）：隐藏显示名「卫视」只藏原来的央视，「省台」留着', () => {
  const cfg = base5()
  cfg.groupRenameMap = { 央视: '卫视', 卫视: '省台' }
  const plan = hideBatch(cfg, ['卫视'])
  assert.deepEqual(plan, [{ name: '卫视', originals: ['央视'] }])
  assert.equal('卫视' in shown5(cfg), false)
  assert.deepEqual(shown5(cfg)['省台'], ['湖南'])
})

check('不能整组隐藏的跳过：未分组、公告、只由移入频道凑成的分组、原分组已被规则盖住的', () => {
  const cfg = base5()
  cfg.deletedGroups = ['体育-*']
  cfg.channelGroupMap = { '央视::a1': '体育-今天', '电影::d1': '新组' }
  const plan = hideBatch(cfg, ['未分组', '公告', '新组', '体育-今天'])
  assert.deepEqual(plan.map(item => [item.name, item.skip]),
    [['未分组', 'ungrouped'], ['公告', 'announcement'], ['新组', 'synthetic'], ['体育-今天', 'covered']])
  // 规则已经盖住的不补「体育-今天」精确条目，凑出来的「新组」也不写（免得以后源里真出现同名分组被悄悄藏掉）
  assert.deepEqual(cfg.deletedGroups, ['体育-*'])
})

check('批量里带自定义分组：打 hidden 标记、不写 deletedGroups；重复隐藏不留重复条目', () => {
  const cfg = base5()
  cfg.customGroups = [{ name: '收藏' }]
  cfg.channelGroupMap = { '央视::a1': '收藏' }
  cfg.deletedGroups = ['电影']
  hideBatch(cfg, ['收藏', '卫视'])
  hideBatch(cfg, ['卫视'])
  assert.deepEqual(cfg.customGroups, [{ name: '收藏', hidden: true }])
  assert.deepEqual(cfg.deletedGroups, ['电影', '卫视'])
  assert.deepEqual(Object.keys(shown5(cfg)), ['体育-今天'])
})

// ---- 单个「隐藏分组」按钮：与批量同一套计划，另外先预判哪些频道会留下 ----
// 以前按钮直接把显示名写进 deletedGroups：凑出来的分组提示「已隐藏」却原样还在，还留下一条会误伤同名源分组的记录
const hideOne = (cfg, name) => {
  const group = applyConfig(groups5(), cfg).find(g => g.name === name)
  const leftovers = planFns.groupHideLeftoverChannels(group, cfg).map(c => c.name)
  const [plan] = planFns.planFor(cfg, groups5(), [name])
  if (!plan.skip && leftovers.length < group.channels.length) planFns.writeGroupHidePlan(cfg, [plan])
  return { plan, leftovers }
}

check('单个隐藏：改过名、有移入频道的源分组只藏自己的频道，预判留下的正是服务端还显示的那些', () => {
  const cfg = base5()
  cfg.groupRenameMap = { 卫视: '地方台' }
  cfg.channelGroupMap = { '央视::a1': '地方台' }
  const { plan, leftovers } = hideOne(cfg, '地方台')
  assert.deepEqual(plan, { name: '地方台', originals: ['卫视'] })
  assert.deepEqual(leftovers, ['CCTV1'])
  assert.deepEqual(shown5(cfg)['地方台'], leftovers)
  // 不再把显示名「地方台」本身写进去（以后源里真出现「地方台」会被悄悄藏掉），改名也留着
  assert.deepEqual(cfg.deletedGroups, ['卫视'])
  assert.deepEqual(cfg.groupRenameMap, { 卫视: '地方台' })
})

check('单个隐藏：只由移入频道凑成的分组不写任何配置，频道全算留下', () => {
  const cfg = base5()
  cfg.channelGroupMap = { '电影::d1': '新组' }
  const { plan, leftovers } = hideOne(cfg, '新组')
  assert.equal(plan.skip, 'synthetic')
  assert.deepEqual(leftovers, ['片'])
  assert.deepEqual(cfg.deletedGroups, [])
  assert.deepEqual(shown5(cfg)['新组'], ['片'])
})

console.log(`\n全部通过：${passed}/25 ✅`)
