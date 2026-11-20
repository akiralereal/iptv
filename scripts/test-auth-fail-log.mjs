#!/usr/bin/env node
/**
 * 访问密码拒绝日志（「身份认证失败」）：
 *
 *   1) 行里有被拒路径、来源 IP、播放器 UA，用户能自己看出是哪台设备拿什么地址来的；
 *   2) 路径打码：旧密码 / 大小写打错的密码 / 令牌 / 咪咕账号段不进日志，固定路由词和最后一段保留；
 *   3) 同一来源同一路径每分钟一行，下一行带上其间又被拒的次数；换路径或换设备照常打。
 *
 * 运行： node scripts/test-auth-fail-log.mjs
 */
import assert from 'node:assert/strict'
import { authFailLogLine, maskAuthFailPath, resetAuthFailLog } from '../utils/authFailLog.js'

const PASS = 'Secret123'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

// 2) 路径打码
assert.equal(maskAuthFailPath('/', PASS), '/')
assert.equal(maskAuthFailPath('/m3u', PASS), '/m3u', '没带密码：原样显示')
assert.equal(maskAuthFailPath('/cctv1', PASS), '/cctv1')
assert.equal(maskAuthFailPath('/oldpass/m3u', PASS), '/***/m3u', '旧密码段打码')
assert.equal(maskAuthFailPath('/secret123/m3u', PASS), '/***/m3u', '大小写打错的密码段打码')
assert.equal(maskAuthFailPath('/SECRET123', PASS), '/***', '只差大小写的密码即使在最后一段也打码')
assert.equal(maskAuthFailPath('/12345678/abcdef0123/m3u', PASS), '/***/***/m3u', '历史地址的咪咕账号段打码')
assert.equal(maskAuthFailPath('/u/AbCdEfGh12345678', PASS), '/u/***', '令牌段在最后也打码')
assert.equal(maskAuthFailPath('/u/AbCdEfGh12345678/m3u', PASS), '/u/***/m3u')
assert.equal(maskAuthFailPath('/logos/CCTV1.png', PASS), '/logos/CCTV1.png', '固定路由词保留')
assert.equal(maskAuthFailPath('/oldpass/proxy/s0123456789abcdef.ts', PASS), '/***/proxy/s0123456789abcdef.ts')
assert.equal(maskAuthFailPath(`/${'x'.repeat(200)}`, PASS).length, 61, '超长段截断')
assert.equal(maskAuthFailPath('/a%0d%0a\r\nb', PASS), '/a%0d%0a  b', '控制字符换成空格，不会折行')

// 1) 日志内容
resetAuthFailLog()
const client = { ip: '2409:8a00::1', ua: UA }
const t0 = 1_000_000
const first = authFailLogLine({ method: 'GET', urlPath: '/oldpass/m3u', pass: PASS, client, now: t0 })
assert.ok(first.startsWith('身份认证失败（地址没带访问密码或密码不对）：GET /***/m3u｜2409:8a00::1 UA:Mozilla/5.0'), first)
assert.ok(!first.includes('oldpass'), '旧密码不进日志')
assert.ok(!first.includes('又被拒'), '第一条不带次数')

// 3) 限频：每 4 秒两条，一分钟内只打第一条
let printed = 0
for (let t = t0 + 10; t < t0 + 60_000; t += 4_100) {
  if (authFailLogLine({ method: 'GET', urlPath: '/oldpass/m3u', pass: PASS, client, now: t })) printed++
  if (authFailLogLine({ method: 'GET', urlPath: '/oldpass/m3u', pass: PASS, client, now: t + 8 })) printed++
}
assert.equal(printed, 0, '一分钟内同一来源同一路径不再打')
const next = authFailLogLine({ method: 'GET', urlPath: '/oldpass/m3u', pass: PASS, client, now: t0 + 60_000 })
assert.ok(next.endsWith('（距上一条又被拒 30 次）'), next)
assert.equal(authFailLogLine({ method: 'GET', urlPath: '/oldpass/m3u', pass: PASS, client, now: t0 + 60_001 }), null, '打完重新计时')

// 换路径、换设备照常打
assert.ok(authFailLogLine({ method: 'GET', urlPath: '/cctv1', pass: PASS, client, now: t0 + 60_002 }), '换路径照常打')
assert.ok(authFailLogLine({ method: 'GET', urlPath: '/oldpass/m3u', pass: PASS, client: { ip: '192.168.1.20', ua: 'okhttp/4.9' }, now: t0 + 60_003 }), '换设备照常打')

// 没有 UA / IP 也能打
resetAuthFailLog()
assert.ok(authFailLogLine({ method: 'HEAD', urlPath: '/m3u', pass: PASS, client: {}, now: t0 }).endsWith('｜未知 UA:无UA'))

console.log('test-auth-fail-log: ok')
