#!/usr/bin/env node
/**
 * 关键字自动分组回归测试（issue #69）
 *
 * 不变量：
 *  1) matchGroupByRules —— 子串包含、大小写不敏感、首条命中胜、空关键字/空分组名不误命中。
 *  2) applyConfig —— 关键字规则「只对未分组生效」：源已分好的分组不动；单频道手动移动优先级
 *     高于关键字；未命中的频道留在「未分组」。
 *
 * 运行： node scripts/test-group-keyword.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { matchGroupByRules } from '../utils/groupRulesAPI.js'
import { applyConfig } from '../utils/playlistConfig.js'
import { dataPath } from '../utils/paths.js'

for (const k of ['log', 'info', 'warn']) {
  const orig = console[k]
  console[k] = (...a) => { if (a.some(x => typeof x === 'string' && /应用播放列表配置|配置应用完成/.test(x))) return; orig.apply(console, a) }
}

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('关键字自动分组回归测试 (issue #69)')

// 1) 纯匹配逻辑（无 I/O）
const RULES = [
  { group: '央视', keywords: ['CCTV', '央视'] },
  { group: '卫视', keywords: ['卫视'] },
  { group: '影视', keywords: ['电影', '影院', '电视剧'] },
]
check('matchGroupByRules：子串 / 大小写 / 无命中', () => {
  assert.equal(matchGroupByRules('CCTV1高清', RULES), '央视')
  assert.equal(matchGroupByRules('cctv5体育', RULES), '央视')        // 大小写不敏感
  assert.equal(matchGroupByRules('央视新闻', RULES), '央视')
  assert.equal(matchGroupByRules('湖南卫视', RULES), '卫视')
  assert.equal(matchGroupByRules('HBO电影', RULES), '影视')
  assert.equal(matchGroupByRules('凤凰中文', RULES), null)           // 无命中
  assert.equal(matchGroupByRules('', RULES), null)
})
check('matchGroupByRules：首条命中胜（顺序敏感）', () => {
  const r1 = [{ group: '体育', keywords: ['CCTV5'] }, { group: '央视', keywords: ['CCTV'] }]
  assert.equal(matchGroupByRules('CCTV5体育', r1), '体育')           // 第一条先命中
  const r2 = [{ group: '央视', keywords: ['CCTV'] }, { group: '体育', keywords: ['CCTV5'] }]
  assert.equal(matchGroupByRules('CCTV5体育', r2), '央视')           // 顺序反过来 → 第一条命中
})
check('matchGroupByRules：空关键字 / 空分组名不误命中', () => {
  assert.equal(matchGroupByRules('任意频道', [{ group: 'X', keywords: [''] }]), null)
  assert.equal(matchGroupByRules('任意频道', [{ group: '', keywords: ['任意'] }]), null)
})

// 2) applyConfig 集成（写临时规则文件，测完还原；getKeywordGroupRules 按 mtime 缓存，写后即新）
const RP = dataPath('group-keyword-rules.json')
const backup = existsSync(RP) ? readFileSync(RP) : null
try {
  writeFileSync(RP, JSON.stringify(RULES))
  const groups = () => ([
    { name: '未分组', channels: [
      { id: 'a1', name: 'CCTV1高清' },
      { id: 'a2', name: '湖南卫视' },
      { id: 'a3', name: '某独立台' },
    ] },
    { name: '体育', channels: [{ id: 'b1', name: 'CCTV5体育' }] },
  ])
  const grpOf = (cfg, ch) => applyConfig(groups(), cfg).find(g => g.channels.some(c => c.name === ch))?.name

  check('未分组频道按关键字归位（CCTV1高清→央视、湖南卫视→卫视）', () => {
    assert.equal(grpOf({}, 'CCTV1高清'), '央视')
    assert.equal(grpOf({}, '湖南卫视'), '卫视')
  })
  check('未命中的频道留在「未分组」', () => {
    assert.equal(grpOf({}, '某独立台'), '未分组')
  })
  check('源已分好组的频道不被关键字改动（CCTV5体育 留在 体育，不进 央视）', () => {
    assert.equal(grpOf({}, 'CCTV5体育'), '体育')
  })
  check('单频道手动移动优先级高于关键字（a1→我的最爱）', () => {
    assert.equal(grpOf({ channelGroupMap: { '未分组::a1': '我的最爱' } }, 'CCTV1高清'), '我的最爱')
  })
} finally {
  if (backup) writeFileSync(RP, backup)
  else if (existsSync(RP)) unlinkSync(RP)
}

console.log(`\n全部通过：${passed}/7 ✅`)
