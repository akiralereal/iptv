#!/usr/bin/env node
/**
 * 「忽略源自带分组」回归测试（issue #110）
 *
 * 不变量：
 *  1) resolveSubscriptionGroup —— 勾选 ignoreGroups 的源，频道自带分组/源默认分组一律不采用，
 *     落「未分组」进生成管道；未勾选的源行为与 #69 完全一致（零行为变化）。
 *  2) buildSourceFallbackMap / matchFallbackByMap —— 只收录「勾选忽略 + 有 id + 默认分组有效」
 *     的源；按频道 source-ids 首个命中的源胜。
 *  3) applyConfig —— 未分组频道：关键字规则优先；规则未命中时忽略源的频道回填该源默认分组；
 *     非忽略源/无归属的频道保持现状（留在未分组）；单频道手动移动优先级仍最高。
 *
 * 运行： node scripts/test-ignore-source-groups.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { resolveSubscriptionGroup } from '../utils/externalSources.js'
import { buildSourceFallbackMap, matchFallbackByMap } from '../utils/sourceGroupFallback.js'
import { applyConfig } from '../utils/playlistConfig.js'
import { dataPath } from '../utils/paths.js'

for (const k of ['log', 'info', 'warn']) {
  const orig = console[k]
  console[k] = (...a) => { if (a.some(x => typeof x === 'string' && /应用播放列表配置|配置应用完成/.test(x))) return; orig.apply(console, a) }
}

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('忽略源自带分组回归测试 (issue #110)')

// 1) 刷新时定组：忽略源的频道一律落「未分组」
check('resolveSubscriptionGroup：勾选忽略 → 自带分组/默认分组都不采用', () => {
  assert.equal(resolveSubscriptionGroup({ group: '央视' }, { ignoreGroups: true }), '未分组')
  assert.equal(resolveSubscriptionGroup({ group: '央视' }, { ignoreGroups: true, group: '我的订阅' }), '未分组')
  assert.equal(resolveSubscriptionGroup({ group: '' }, { ignoreGroups: true, group: '我的订阅' }), '未分组')
})
check('resolveSubscriptionGroup：未勾选/非法值 → 行为与 #69 一致', () => {
  assert.equal(resolveSubscriptionGroup({ group: '央视' }, { group: '体育' }), '央视')
  assert.equal(resolveSubscriptionGroup({ group: '未分组' }, { ignoreGroups: false, group: '我的港台' }), '我的港台')
  assert.equal(resolveSubscriptionGroup({ group: '央视' }, { ignoreGroups: 'yes', group: '体育' }), '央视')
})

// 2) 兜底映射（纯逻辑，无 I/O）
const SOURCES = [
  { id: 's1', ignoreGroups: true, group: '我的订阅' },
  { id: 's2', ignoreGroups: true, group: '未分组' },      // 默认分组无效 → 不进映射
  { id: 's3', ignoreGroups: true, group: '  ' },          // 空白 → 不进映射
  { id: 's4', group: '港台' },                            // 未勾选忽略 → 不进映射
  { ignoreGroups: true, group: '有组无id' },              // 无稳定 id → 不进映射
]
check('buildSourceFallbackMap：只收录勾选忽略且默认分组有效的源', () => {
  const map = buildSourceFallbackMap(SOURCES)
  assert.deepEqual([...map.entries()], [['ext:s1', '我的订阅']])
  assert.equal(buildSourceFallbackMap(null).size, 0)
})
check('matchFallbackByMap：按 source-ids 首个命中胜、无命中为 null', () => {
  const map = new Map([['ext:s1', '我的订阅'], ['ext:s9', '备用组']])
  assert.equal(matchFallbackByMap(['ext:s9', 'ext:s1'], map), '备用组')
  assert.equal(matchFallbackByMap(['ext:s404', 'ext:s1'], map), '我的订阅')
  assert.equal(matchFallbackByMap(['ext:s404'], map), null)
  assert.equal(matchFallbackByMap([], map), null)
  assert.equal(matchFallbackByMap(null, map), null)
})

// 3) applyConfig 集成（写临时规则/源配置文件，测完还原；两个模块都按 mtime 缓存，写后即新。
//    各写一次、不重复写，避免同毫秒快写让 mtime 缓存吃到旧内容的偶发。）
const RP = dataPath('group-keyword-rules.json')
const SP = dataPath('external-sources.json')
const rulesBackup = existsSync(RP) ? readFileSync(RP) : null
const sourcesBackup = existsSync(SP) ? readFileSync(SP) : null
try {
  writeFileSync(RP, JSON.stringify([{ group: '央视', keywords: ['CCTV'] }]))
  writeFileSync(SP, JSON.stringify({ enabled: true, sources: SOURCES }))

  const groups = () => ([
    { name: '未分组', channels: [
      { id: 'c1', name: 'CCTV1高清', sourceIds: ['ext:s1'] },   // 规则命中 → 央视（规则优先于兜底）
      { id: 'c2', name: '某地方台', sourceIds: ['ext:s1'] },    // 规则未命中 → 兜底进「我的订阅」
      { id: 'c3', name: '另一台', sourceIds: ['ext:s2'] },      // 来源默认分组无效 → 留未分组
      { id: 'c4', name: '路人台', sourceIds: [] },              // 无源归属 → 留未分组（现状不变）
      { id: 'c5', name: '手动台', sourceIds: ['ext:s1'] },      // 手动移动优先于兜底
    ] },
    { name: '体育', channels: [{ id: 'b1', name: 'CCTV5体育', sourceIds: ['ext:s1'] }] },
  ])
  const grpOf = (cfg, ch) => applyConfig(groups(), cfg).find(g => g.channels.some(c => c.name === ch))?.name

  check('applyConfig：规则命中优先于默认分组兜底', () => {
    assert.equal(grpOf({}, 'CCTV1高清'), '央视')
  })
  check('applyConfig：规则未命中 → 回填该源默认分组', () => {
    assert.equal(grpOf({}, '某地方台'), '我的订阅')
  })
  check('applyConfig：来源无有效兜底/无归属 → 留在未分组', () => {
    assert.equal(grpOf({}, '另一台'), '未分组')
    assert.equal(grpOf({}, '路人台'), '未分组')
  })
  check('applyConfig：源已分好组的频道不受影响', () => {
    assert.equal(grpOf({}, 'CCTV5体育'), '体育')
  })
  check('applyConfig：单频道手动移动优先级最高', () => {
    assert.equal(grpOf({ channelGroupMap: { '未分组::c5': '我的最爱' } }, '手动台'), '我的最爱')
  })
} finally {
  if (rulesBackup !== null) writeFileSync(RP, rulesBackup); else if (existsSync(RP)) unlinkSync(RP)
  if (sourcesBackup !== null) writeFileSync(SP, sourcesBackup); else if (existsSync(SP)) unlinkSync(SP)
}

console.log(`\n全部通过：${passed}/9 ✅`)
