#!/usr/bin/env node
/**
 * 央视频登录态失效提醒（extractors/yangshipin/runtime.js 的失效记录）。
 *
 * 关联标记在官网判成未登录的那一刻就被删掉，原先「曾经登录过、现在掉了」这件事无从得知，
 * 会员频道就这么静默播不了。这里钉住：关联过的账号掉登录 / 掉 VIP 才提醒，从没关联过、
 * 一直不是 VIP 的不提醒；重新登录、VIP 回来就消；记录落盘、不含凭据。
 *
 * 运行： node scripts/test-yangshipin-login-alert.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DATA_DIR = mkdtempSync(join(tmpdir(), 'iptv-ysp-login-alert-'))
process.env.mdataDir = DATA_DIR
const { runtime, credentialRejected, LOGIN_LOST_NOTICE, VIP_LOST_NOTICE } = await import('../extractors/yangshipin/runtime.js')
const { getModule } = await import('../extractors/registry.js')

const remember = status => runtime.loginLink.remember(status)
const vip = { authenticated: true, account: { nickname: '测试账号', vip: true } }
const plain = { authenticated: true, account: { nickname: '测试账号', vip: false } }
const out = { authenticated: false, account: null }

let passed = 0
function test(name, fn) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

test('从没关联过的部署读到未登录不提醒', () => {
  remember(out)
  assert.equal(credentialRejected(), '')
  assert.equal(existsSync(runtime.loginLost.markerPath), false)
})

test('关联过的账号掉登录即提醒，记录落盘且不含凭据；重新登录即消', () => {
  remember(vip)
  assert.equal(credentialRejected(), '')
  remember(out)
  assert.equal(credentialRejected(), LOGIN_LOST_NOTICE)
  assert.match(LOGIN_LOST_NOTICE, /10 个会员频道/)
  const marker = runtime.loginLost.markerPath
  assert.ok(marker.startsWith(DATA_DIR), '记录必须落在数据目录')
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(marker, 'utf8'))).sort(), ['lostAt', 'nickname', 'reason', 'wasVip'])
  // 关联标记已删，再读到未登录也不会把失效记录清掉
  remember(out)
  assert.equal(credentialRejected(), LOGIN_LOST_NOTICE)
  remember(vip)
  assert.equal(credentialRejected(), '')
  assert.equal(existsSync(marker), false)
})

// 每个场景从干净状态起：没有关联标记、没有失效记录
const reset = () => { for (const path of [runtime.loginLink.markerPath, runtime.loginLost.markerPath]) rmSync(path, { force: true }) }

test('一直不是 VIP 的账号不提醒', () => {
  reset()
  remember(plain)
  remember(plain)
  assert.equal(credentialRejected(), '')
})

test('VIP 从有到无才提醒，要一直提醒到 VIP 回来', () => {
  reset()
  remember(vip)
  remember(plain)
  assert.equal(credentialRejected(), VIP_LOST_NOTICE)
  remember(plain)
  assert.equal(credentialRejected(), VIP_LOST_NOTICE)
  remember(vip)
  assert.equal(credentialRejected(), '')
})

test('原是 VIP 的账号掉登录后重新登录、却已不是 VIP，同样算 VIP 失效', () => {
  reset()
  remember(vip)
  remember(out)
  assert.equal(credentialRejected(), LOGIN_LOST_NOTICE)
  remember(plain)
  assert.equal(credentialRejected(), VIP_LOST_NOTICE)
  remember(vip)
  assert.equal(credentialRejected(), '')
})

test('模块把失效记录交给后台提醒中心', () => {
  const ysp = getModule('yangshipin')
  assert.equal(typeof ysp.credentialRejected, 'function')
  reset()
  remember(vip)
  remember(out)
  assert.equal(ysp.credentialRejected({}), LOGIN_LOST_NOTICE)
  remember(vip)
  assert.equal(ysp.credentialRejected({}), '')
})

console.log(`\n全部通过：${passed} ✓`)
process.exit(0)   // runtime.js 的保活定时器已 unref，这里显式退出免得等后台会话
