#!/usr/bin/env node
/**
 * EPG.md 状态表与代码一致性检查：每个注册的模块都在表里且只出现一次，
 * 标「已接入」的恰好是挂了 epg 的模块。新增子模块忘了更新记录，这里会提醒。
 *
 * 运行： node scripts/test-epg-doc.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { listModules } from '../extractors/registry.js'

const STATUSES = new Set(['已接入', '咪咕自带', '无官方节目单', '不适用', '未调研'])

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }

const doc = readFileSync(fileURLToPath(new URL('../EPG.md', import.meta.url)), 'utf8')
const table = doc.split('<!-- epg-status:start -->')[1]?.split('<!-- epg-status:end -->')[0] || ''
const rows = [...table.matchAll(/^\|\s*`([^`]+)`\s*\|[^|]*\|\s*([^|]+?)\s*\|/gm)].map(m => ({ id: m[1], status: m[2] }))

console.log('EPG.md 状态表一致性检查')

check('状态表存在且状态只用约定的几种', () => {
  assert.ok(rows.length, 'EPG.md 里没找到 epg-status 标记之间的表格')
  for (const row of rows) assert.ok(STATUSES.has(row.status), `${row.id} 的状态「${row.status}」不在约定里`)
})

check('每个注册的模块都在表里，且只出现一次；表里没有已不存在的模块', () => {
  const ids = rows.map(row => row.id)
  const duplicated = ids.filter((id, index) => ids.indexOf(id) !== index)
  assert.deepEqual(duplicated, [], `重复：${duplicated.join(', ')}`)
  const registered = listModules().map(module => module.id)
  const missing = registered.filter(id => !ids.includes(id))
  assert.deepEqual(missing, [], `EPG.md 还没记这些模块：${missing.join(', ')}`)
  const stale = ids.filter(id => !registered.includes(id))
  assert.deepEqual(stale, [], `EPG.md 里这些模块已不存在：${stale.join(', ')}`)
})

check('标「已接入」的恰好是挂了 epg 的模块', () => {
  const status = new Map(rows.map(row => [row.id, row.status]))
  for (const module of listModules()) {
    const documented = status.get(module.id) === '已接入'
    assert.equal(documented, Boolean(module.epg),
      module.epg ? `${module.id} 已挂 epg，EPG.md 要标「已接入」` : `${module.id} 没挂 epg，EPG.md 不能标「已接入」`)
  }
})

console.log(`\n全部通过：${passed} ✅`)
