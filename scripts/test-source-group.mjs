#!/usr/bin/env node
/**
 * 订阅源「默认分组」回退回归测试（issue #69 跟进）
 *
 * 不变量（resolveSubscriptionGroup）：
 *  - 频道自带分组（group-title / #genre#）优先，源默认分组不覆盖它；
 *  - 频道无分组——空串（txt 无 #genre#）或占位「未分组」（m3u 无 group-title 解析所填）——
 *    一并视作未分组，回退到源配置的默认分组 source.group；
 *  - 源也没设默认分组时，仍是「未分组」（向后兼容，零行为变化）。
 *
 * 关键点：m3u 解析对无 group-title 的频道填的是字符串「未分组」（不是空串），
 * 旧的 `ch.group || source.group` 会被它短路，导致默认分组对 m3u 失效——本测试守住修复。
 *
 * 运行： node scripts/test-source-group.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { resolveSubscriptionGroup } from '../utils/externalSources.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('订阅源默认分组回退回归测试 (issue #69 跟进)')

check('频道自带分组优先：源默认分组不覆盖', () => {
  assert.equal(resolveSubscriptionGroup({ group: '央视' }, { group: '体育' }), '央视')
  assert.equal(resolveSubscriptionGroup({ group: '港澳台' }, { group: '未分组' }), '港澳台')
})

check('m3u 无分组（占位「未分组」）→ 回退源默认分组（修复点）', () => {
  assert.equal(resolveSubscriptionGroup({ group: '未分组' }, { group: '我的港台' }), '我的港台')
})

check('txt 无分组（空串）→ 回退源默认分组', () => {
  assert.equal(resolveSubscriptionGroup({ group: '' }, { group: '我的港台' }), '我的港台')
  assert.equal(resolveSubscriptionGroup({ group: undefined }, { group: '我的港台' }), '我的港台')
})

check('源未设默认分组 → 仍「未分组」（向后兼容）', () => {
  assert.equal(resolveSubscriptionGroup({ group: '未分组' }, { group: '未分组' }), '未分组')
  assert.equal(resolveSubscriptionGroup({ group: '未分组' }, {}), '未分组')
  assert.equal(resolveSubscriptionGroup({ group: '' }, { group: '' }), '未分组')
})

check('边界：缺参数也不抛、回落「未分组」', () => {
  assert.equal(resolveSubscriptionGroup(null, { group: '体育' }), '体育')
  assert.equal(resolveSubscriptionGroup({ group: '央视' }, null), '央视')
  assert.equal(resolveSubscriptionGroup(null, null), '未分组')
})

console.log(`\n全部通过：${passed}/5 ✅`)
