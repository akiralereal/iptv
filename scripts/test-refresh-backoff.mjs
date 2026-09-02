#!/usr/bin/env node
/** 抓取失败退避测试：指数退避、上限取源自己的刷新间隔、成功清零；内置源 needsRefresh 接入。 */
import assert from 'node:assert/strict'

import { FailureBackoff, backoffMinutes } from '../utils/refreshBackoff.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('抓取失败退避测试')

check('退避分钟数：10 → 20 → 40 → …，上限为源自己的刷新间隔', () => {
  assert.equal(backoffMinutes(1, 60), 10)
  assert.equal(backoffMinutes(2, 60), 20)
  assert.equal(backoffMinutes(3, 60), 40)
  assert.equal(backoffMinutes(4, 60), 60)
  assert.equal(backoffMinutes(9, 60), 60)
  assert.equal(backoffMinutes(5, 240), 160)
  assert.equal(backoffMinutes(6, 240), 240)
  // 刷新间隔比基数还短：至少等一个基数，避免退化成每 5 分钟一次
  assert.equal(backoffMinutes(1, 5), 10)
  assert.equal(backoffMinutes(0, 60), 10)
})

check('失败记录累加、成功清零、窗口内 isCooling 为真', () => {
  const backoff = new FailureBackoff()
  const now = 1_000_000
  assert.equal(backoff.isCooling('a', now), false)
  const first = backoff.record('a', 60, { now, error: '超时' })
  assert.equal(first.count, 1)
  assert.equal(first.waitMinutes, 10)
  assert.equal(backoff.isCooling('a', now + 9 * 60 * 1000), true)
  assert.equal(backoff.isCooling('a', now + 10 * 60 * 1000), false)
  const second = backoff.record('a', 60, { now })
  assert.equal(second.count, 2)
  assert.equal(second.waitMinutes, 20)
  assert.equal(backoff.get('a').lastError, '')
  backoff.clear('a')
  assert.equal(backoff.isCooling('a', now), false)
  assert.equal(backoff.get('a'), null)
})

// 内置源管理器是 import 即读盘的单例；把数据目录指到临时目录再引入
process.env.mdataDir = `${process.env.TMPDIR || '/tmp'}/iptv-test-backoff-${process.pid}`
process.env.mbuiltInSourcesUrl = ''
const { default: builtInSourceManager } = await import('../utils/builtInSources.js')

check('内置源：抓取失败进入退避后 needsRefresh 为假，退避结束恢复为真', () => {
  const source = { id: 'test-fetch', name: '测试源', mode: 'fetch', refreshInterval: 60 }
  delete builtInSourceManager.cache[source.id]
  assert.equal(builtInSourceManager.needsRefresh(source), true, '没缓存应需要刷新')
  builtInSourceManager.noteFailure(source, '未找到m3u8链接')
  assert.equal(builtInSourceManager.needsRefresh(source), false, '刚失败应处于退避')
  const entry = builtInSourceManager.backoff.get(source.id)
  assert.equal(entry.count, 1)
  entry.nextRetryAt = Date.now() - 1
  assert.equal(builtInSourceManager.needsRefresh(source), true, '退避结束应重新抓取')
  builtInSourceManager.backoff.clear(source.id)
})

console.log(`\n全部通过：${passed} 项`)
