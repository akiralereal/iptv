#!/usr/bin/env node
/**
 * utils/clientScanGuard.js 客户端批量探测防护。
 *
 * 场景取自 2026-09-25 共享实例的真实日志：扫描器 0.1~0.5 秒一个台、有的每台连打两次；
 * 观众几秒一次轮询同一个台；失败自动换台的播放器会把整组转圈。
 */
import assert from 'node:assert/strict'

import { SCAN_GUARD_DEFAULTS, createClientScanGuard } from '../utils/clientScanGuard.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }

const S = 1000
const C = 'ysp|1.2.3.4|okhttp/3.15'
const refs = Array.from({ length: 63 }, (_, i) => `ysp-ch${i + 1}`)

/** 顺序扫一遍：每台 hitsPerChannel 次、相邻请求隔 stepMs；返回放行/拒绝的统计。 */
function scan(guard, client, list, { start = 0, stepMs = 300, hitsPerChannel = 1 } = {}) {
  const allowed = new Set()
  let blocked = 0
  let now = start
  for (const ref of list) {
    for (let k = 0; k < hitsPerChannel; k++) {
      const verdict = guard.check(client, ref, now)
      if (verdict.allowed) allowed.add(ref); else blocked++
      now += stepMs
    }
  }
  return { allowed, blocked, end: now - stepMs }
}

check('默认参数与日志里的扫描节奏对得上', () => {
  assert.equal(SCAN_GUARD_DEFAULTS.distinctLimit, 6)
  assert.equal(SCAN_GUARD_DEFAULTS.windowMs, 10 * S)
  assert.equal(SCAN_GUARD_DEFAULTS.idleMs, 5 * S)
  assert.ok(SCAN_GUARD_DEFAULTS.runGapMs > SCAN_GUARD_DEFAULTS.windowMs, '看的连续性容忍要比「算又碰了一次」宽')
})

check('顺序扫 63 个台、每台连打两次：只放行前 5 个台，其余一枪不放；扫完 5 秒自动恢复', () => {
  const guard = createClientScanGuard()
  const { allowed, blocked, end } = scan(guard, C, refs, { stepMs: 300, hitsPerChannel: 2 })
  assert.equal(allowed.size, 5, '第 6 个不同的台触发判定，自己也被拒')
  assert.equal(blocked, (63 - 5) * 2)
  // 扫完不到 5 秒还在拦
  assert.equal(guard.check(C, 'ysp-ch64', end + 4 * S).allowed, false)
  // 5 秒没碰新台就解除；解除后窗口清零，接着换几个台也不会立刻被顶回去
  assert.equal(guard.check(C, 'ysp-ch65', end + 4 * S + 5 * S).allowed, true)
  for (let i = 0; i < 4; i++) assert.equal(guard.check(C, `ysp-ch7${i}`, end + 10 * S + i * S).allowed, true)
})

check('正常观众几秒一次轮询同一个台，无论多久都不会被当成扫描', () => {
  const guard = createClientScanGuard()
  for (const interval of [3 * S, 6 * S, 9 * S]) {
    const client = `${C}|${interval}`
    for (let now = 0; now <= 30 * 60 * S; now += interval) {
      assert.deepEqual(guard.check(client, 'ysp-cctv1', now), { allowed: true, scanning: false })
    }
  }
})

check('边看边后台刷预览图：正在看的台一直放行，扫描的台被拒', () => {
  const guard = createClientScanGuard()
  for (let now = 0; now < 30 * S; now += 3 * S) assert.equal(guard.check(C, 'ysp-cctv1', now).allowed, true)
  // 从 30 秒起播放器后台扫 60 个台（0.4 秒一个），观众的 cctv1 每 3 秒照常轮询穿插其中
  let now = 30 * S
  let scanAllowed = 0
  let scanBlocked = 0
  let nextPoll = 30 * S
  for (const ref of refs.slice(3)) {
    if (now >= nextPoll) {
      assert.equal(guard.check(C, 'ysp-cctv1', now).allowed, true, `轮询 @${now / S}s 不该被拒`)
      nextPoll += 3 * S
    }
    const verdict = guard.check(C, ref, now)
    if (verdict.allowed) scanAllowed++; else scanBlocked++
    now += 400
  }
  assert.equal(scanAllowed, 5)
  assert.equal(scanBlocked, 60 - 5)
  // 扫完以后观众继续看，也没事
  for (let t = now + 6 * S; t < now + 60 * S; t += 3 * S) assert.equal(guard.check(C, 'ysp-cctv1', t).allowed, true)
})

check('失败自动换台转圈：一圈超过 10 秒的列表整圈整圈地拦，不会因为「都不是新台」而放开', () => {
  const guard = createClientScanGuard()
  let start = 0
  const perPass = []
  for (let pass = 0; pass < 3; pass++) {
    const { allowed, end } = scan(guard, C, refs, { start, stepMs: 300 })
    perPass.push(allowed.size)
    start = end + 300
  }
  assert.deepEqual(perPass, [5, 0, 0])
  // 每台连打两次的转圈：判定前最早碰的一两个台会被当成「扫描前就在看」放行，属于已知的小漏
  const two = createClientScanGuard()
  start = 0
  let total = 0
  for (let pass = 0; pass < 3; pass++) {
    const { allowed, end } = scan(two, C, refs, { start, stepMs: 300, hitsPerChannel: 2 })
    total += allowed.size
    start = end + 300
  }
  assert.ok(total <= 5 + 2 * 2, `三圈共放行 ${total} 个台，不该超过 9`)
})

check('真人 10 秒内连换 6 个台会被误判，但停在第 7 个台上几秒就恢复', () => {
  const guard = createClientScanGuard()
  const zaps = ['a', 'b', 'c', 'd', 'e']
  zaps.forEach((ref, i) => assert.equal(guard.check(C, ref, i * S).allowed, true))
  // 第 6 个台：触发判定，当场被拒
  assert.equal(guard.check(C, 'f', 5 * S).allowed, false)
  // 停在 f 上，播放器 3 秒一次重试：5 秒内没再碰新台就解除
  assert.equal(guard.check(C, 'f', 8 * S).allowed, false)
  assert.equal(guard.check(C, 'f', 11 * S).allowed, true)
  assert.equal(guard.check(C, 'f', 14 * S).allowed, true)
})

check('两个台来回切不算扫描；同一个台停了 30 秒以上再回来算重新开始看', () => {
  const guard = createClientScanGuard()
  for (let i = 0; i < 20; i++) assert.equal(guard.check(C, i % 2 ? 'a' : 'b', i * 800).allowed, true)
  // a 看到 20 秒、停 40 秒、再回来：回来那一下本身算碰了一次新台，紧接着的扫描里 a 也不算
  // 「扫描前就在看」——要是断了 30 秒还沿用旧的开始时间，这里就会被放行
  const g2 = createClientScanGuard()
  for (let now = 0; now < 20 * S; now += 3 * S) g2.check(C, 'a', now)
  assert.equal(g2.check(C, 'a', 60 * S).allowed, true)
  const { allowed } = scan(g2, C, refs.slice(0, 10), { start: 60.5 * S, stepMs: 300 })
  assert.equal(allowed.size, 4, '回来那一下占了窗口里的一个名额')
  assert.equal(g2.check(C, 'a', 64 * S).allowed, false)
})

check('客户端之间、模块之间互不影响', () => {
  const guard = createClientScanGuard()
  scan(guard, 'ysp|1.1.1.1|ua', refs, { stepMs: 300 })
  assert.equal(guard.check('ysp|1.1.1.1|ua', 'ysp-ch70', 20 * S).allowed, false)
  assert.equal(guard.check('ysp|2.2.2.2|ua', 'ysp-ch70', 20 * S).allowed, true, '别的客户端照常')
  assert.equal(guard.check('ysp|1.1.1.1|other-ua', 'ysp-ch70', 20 * S).allowed, true, '同 IP 不同 UA 是另一个客户端')
  assert.equal(guard.check('hbtv|1.1.1.1|ua', 'hbtv-1', 20 * S).allowed, true, '别的模块照常')
})

check('拦截期间每 10 秒才提示打一次日志，并带上计数', () => {
  const guard = createClientScanGuard()
  const { end } = scan(guard, C, refs.slice(0, 6), { stepMs: 300 })
  const first = guard.check(C, 'ysp-x1', end + 100)
  assert.equal(first.allowed, false)
  assert.equal(first.announce, false, '触发那一次已经提示过了')
  // 每 2 秒碰一个新台，保持在扫描状态里
  for (const t of [2, 4, 6, 8]) {
    const verdict = guard.check(C, `ysp-y${t}`, end + t * S)
    assert.equal(verdict.allowed, false)
    assert.equal(verdict.announce, false)
  }
  const later = guard.check(C, 'ysp-x2', end + 10 * S)
  assert.equal(later.allowed, false)
  assert.equal(later.announce, true)
  assert.ok(later.blocked >= 6)
  assert.ok(later.distinct >= 1)
  assert.equal(guard.check(C, 'ysp-x3', end + 10 * S + 100).announce, false)
})

check('表有上限、闲置客户端会被忘掉', () => {
  const guard = createClientScanGuard({ maxClients: 100 })
  for (let i = 0; i < 150; i++) guard.check(`c${i}`, 'x', 0)
  assert.ok(guard.size <= 100, `超上限后应整表丢弃，现在 ${guard.size}`)
  const g2 = createClientScanGuard()
  g2.check('old', 'x', 0)
  for (let i = 0; i < 300; i++) g2.check(`fresh${i % 5}`, 'x', 11 * 60 * S)
  assert.equal(g2.size, 5, '10 分钟没请求的客户端在清理时被删掉')
})

check('畸形入参一律放行、绝不抛', () => {
  const guard = createClientScanGuard()
  for (const args of [['', 'x'], ['c', ''], [null, 'x'], ['c', undefined], [42, 'x'], ['c', 'x', NaN], ['c', 'x', 'later']]) {
    assert.equal(guard.check(...args).allowed, true)
  }
  assert.equal(guard.size <= 1, true)
})

console.log(`\n全部通过：${passed} 项`)
