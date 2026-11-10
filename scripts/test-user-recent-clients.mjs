#!/usr/bin/env node
/**
 * 用户令牌「访问来源」记录：后台用户卡片靠它看源有没有被转给别人。
 *
 *   1) 来源 IP：直连只认 TCP 对端（客户端自己写的 X-Forwarded-For 不算）；对端是本机 / 内网（反代、Docker 网关）才取转发头；
 *   2) 按 IP 归并，每个 IP 只留最近 3 种 UA，最近用的排前；
 *   3) 最多留 20 个 IP，挤掉最久没来的；
 *   4) 重置令牌清空记录，旧数据（没有 recentClients 字段）照常记。
 *
 * 用独立临时数据目录跑，不碰真实数据。运行： node scripts/test-user-recent-clients.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'iptv-users-test-'))
process.env.mdataDir = DIR
// 旧版本存下的用户：没有 recentClients 字段
writeFileSync(join(DIR, 'users.json'), JSON.stringify({ users: [{ id: 'u_old', name: '老用户', token: 'oldtoken123', enabled: true }] }))

const { UserManager, viewerIp } = await import('../utils/userManager.js')

try {
  // 1) 来源 IP
  assert.equal(viewerIp('203.0.113.5', '1.2.3.4'), '203.0.113.5', '公网直连：伪造的转发头不算')
  assert.equal(viewerIp('::ffff:203.0.113.5', undefined), '203.0.113.5', 'IPv4 映射地址去掉前缀')
  assert.equal(viewerIp('127.0.0.1', '198.51.100.7, 10.0.0.1'), '198.51.100.7', '本机反代：取转发头第一段')
  assert.equal(viewerIp('172.17.0.1', '2001:db8::1'), '2001:db8::1', 'Docker 网关：取转发头')
  assert.equal(viewerIp('192.168.1.20', ''), '192.168.1.20', '内网直连、没有转发头：记对端')
  assert.equal(viewerIp('', ''), '未知')

  const mgr = new UserManager()
  const old = mgr.findByToken('oldtoken123')
  mgr.recordUsage(old, { ip: '203.0.113.5', ua: 'okhttp/4.9' })
  assert.equal(old.recentClients.length, 1, '旧数据没有字段也能记')
  mgr.recordUsage(old) // 不带来源（兼容旧调用）只累计请求数
  assert.equal(old.reqCount, 2)
  assert.equal(old.recentClients.length, 1)

  // 2) 按 IP 归并 + UA 去重、只留最近 3 种
  const { user } = mgr.addUser({ name: '家人' })
  const u = mgr.findByToken(user.token)
  for (const ua of ['TiviMate/5', 'ExoPlayer', 'TiviMate/5', 'VLC/3', 'APTV/1', 'Lavf/60\r\nX: y']) {
    mgr.recordUsage(u, { ip: '198.51.100.7', ua })
  }
  assert.equal(u.recentClients.length, 1)
  const entry = u.recentClients[0]
  assert.equal(entry.count, 6)
  assert.deepEqual(entry.uas, ['Lavf/60  X: y', 'APTV/1', 'VLC/3'], '最近用的排前、换行抹掉、只留 3 种')

  // 3) 上限 20 个 IP，挤掉最久没来的
  entry.lastSeenAt = '2000-01-01T00:00:00.000Z'
  for (let i = 0; i < 20; i++) mgr.recordUsage(u, { ip: `203.0.113.${i + 10}`, ua: 'x' })
  assert.equal(u.recentClients.length, 20)
  assert.ok(!u.recentClients.some(c => c.ip === '198.51.100.7'), '最久没来的被挤掉')
  assert.ok(u.recentClients.some(c => c.ip === '203.0.113.29'), '刚来的留下')

  // 落盘后重新加载仍在
  mgr.flushUsage()
  const reloaded = new UserManager().findByToken(user.token)
  assert.equal(reloaded.recentClients.length, 20)

  // 4) 重置令牌清空
  const r = mgr.regenToken(user.id)
  assert.equal(r.success, true)
  assert.deepEqual(mgr.findByToken(r.token).recentClients, [])

  console.log('✓ 用户访问来源记录')
} finally {
  rmSync(DIR, { recursive: true, force: true })
}
