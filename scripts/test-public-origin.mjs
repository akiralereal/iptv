#!/usr/bin/env node
/**
 * 订阅里的本机地址按访问来源选（README「公网地址」一节）：
 *
 *   1) 内网直连（Host 是内网地址、没有转发头）：用 Host，不走公网；
 *   2) 反代改写了 Host 为后端内网地址、只带 X-Forwarded-For（Lucky 等）：访问者是公网 IP 且填了公网地址时，
 *      用公网地址 —— 以前会写成 192.168.x.x，外网拉得到列表、播不了；
 *   3) 访问者是内网 IP（家里经反代访问）、没填公网地址、公网地址不是 http(s):// 开头：照旧用 Host；
 *   4) 带 X-Forwarded-Host / Host 本身是域名：不受影响。
 *
 * 运行： node scripts/test-public-origin.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cameFromInternet, isLanHostHeader, proxiedPublicBase } from '../utils/publicOrigin.js'

let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

const MHOST = 'https://iptv.example.cc:16666'
const LAN = '192.168.1.5:1905'

check('Host 是否内网：沿用原来的前缀判断', () => {
  for (const h of ['localhost:1905', '127.0.0.1:1905', LAN, '10.0.0.2', '172.17.0.2:1905']) assert.equal(isLanHostHeader(h), true, h)
  for (const h of ['iptv.example.cc:16666', '203.0.113.9:1905', '', undefined]) assert.equal(isLanHostHeader(h), false, String(h))
})

check('访问者来源：公网 IPv4 / IPv6、带端口的写法都认', () => {
  assert.equal(cameFromInternet({ 'x-forwarded-for': '203.0.113.9' }), true)
  assert.equal(cameFromInternet({ 'x-forwarded-for': '203.0.113.9, 192.168.1.1' }), true, '取第一段')
  assert.equal(cameFromInternet({ 'x-forwarded-for': '2408:8207:1234::5' }), true, 'IPv6（DDNS 走 IPv6 的就是这种）')
  assert.equal(cameFromInternet({ 'x-forwarded-for': '[2408:8207:1234::5]:443' }), true)
  assert.equal(cameFromInternet({ 'x-forwarded-for': '203.0.113.9:5678' }), true)
  assert.equal(cameFromInternet({ 'x-forwarded-for': '::ffff:203.0.113.9' }), true)
  assert.equal(cameFromInternet({ 'x-real-ip': '203.0.113.9' }), true, '只带 X-Real-IP')
})

check('访问者来源：内网、没有转发头、写的不是 IP 都不算公网', () => {
  for (const ip of ['192.168.1.20', '10.0.0.3', '172.17.0.1', '127.0.0.1', '100.100.1.1', 'fd00::1', 'fe80::1', '::1', 'unknown']) {
    assert.equal(cameFromInternet({ 'x-forwarded-for': ip }), false, ip)
  }
  assert.equal(cameFromInternet({}), false)
  assert.equal(cameFromInternet({ 'x-forwarded-for': '' , 'x-real-ip': '' }), false)
})

check('公网地址覆盖：只在「Host 内网 + 无 X-Forwarded-Host + 公网访问者 + 填了 http(s) 公网地址」时生效', () => {
  const lucky = { host: LAN, 'x-forwarded-for': '203.0.113.9' }
  assert.equal(proxiedPublicBase(lucky, MHOST), MHOST)
  assert.equal(proxiedPublicBase(lucky, `${MHOST}/`), MHOST, '去掉末尾斜杠')
  assert.equal(proxiedPublicBase(lucky, ''), '', '没填公网地址')
  assert.equal(proxiedPublicBase(lucky, 'iptv.example.cc:16666'), '', '环境变量写了裸域名：不拼出没有协议的地址')
  assert.equal(proxiedPublicBase({ host: LAN }, MHOST), '', '内网直连')
  assert.equal(proxiedPublicBase({ host: LAN, 'x-forwarded-for': '192.168.1.20' }, MHOST), '', '家里经反代访问')
  assert.equal(proxiedPublicBase({ ...lucky, 'x-forwarded-host': 'iptv.example.cc:16666' }, MHOST), '', '带了 X-Forwarded-Host 走原规则')
  assert.equal(proxiedPublicBase({ host: 'iptv.example.cc:16666', 'x-forwarded-for': '203.0.113.9' }, MHOST), '', 'Host 本身是域名走原规则')
})

// 订阅全链路：子进程 + 临时数据目录，interfaceStr 读的是 config.js 里的 mhost
function channelLines(mhost, requests) {
  const dir = mkdtempSync(join(tmpdir(), 'iptv-public-origin-'))
  try {
    const script = `
import { writeFileSync } from 'node:fs'
import { dataPath } from './utils/paths.js'
writeFileSync(dataPath('interface.txt'), ['#EXTM3U', '#EXTINF:-1 tvg-id="CCTV1" tvg-name="CCTV1" group-title="央视",CCTV1', '\${replace}/608807420', ''].join('\\n'))
const { interfaceStr } = await import('./utils/appUtils.js')
const out = ${JSON.stringify(requests)}.map(headers => String(interfaceStr('/m3u', headers, '', '', 'default').content).split('\\n').find(l => l.endsWith('/608807420')))
console.log('RESULT' + JSON.stringify(out))
`
    const env = { ...process.env, mdataDir: dir }
    if (mhost) env.mhost = mhost
    else delete env.mhost
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script],
      { env, cwd: process.cwd(), encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    return JSON.parse(stdout.slice(stdout.lastIndexOf('RESULT') + 6))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

check('订阅：反代改写 Host 时频道地址用公网地址，其余情况不变', () => {
  const [lanDirect, lucky, luckyRealIp, lanViaProxy, withForwardedHost, domainHost] = channelLines(MHOST, [
    { host: LAN },
    { host: LAN, 'x-forwarded-for': '2408:8207:1234::5' },
    { host: LAN, 'x-real-ip': '203.0.113.9' },
    { host: LAN, 'x-forwarded-for': '192.168.1.20' },
    { host: LAN, 'x-forwarded-host': 'other.example.cc', 'x-forwarded-for': '203.0.113.9' },
    { host: 'iptv.example.cc:16666' },
  ])
  assert.equal(lanDirect, `http://${LAN}/608807420`, '内网直连')
  assert.equal(lucky, `${MHOST}/608807420`, 'Lucky 式反代（IPv6 访问者）')
  assert.equal(luckyRealIp, `${MHOST}/608807420`, '只带 X-Real-IP 的反代')
  assert.equal(lanViaProxy, `http://${LAN}/608807420`, '家里经反代访问')
  assert.equal(withForwardedHost, `${MHOST}/608807420`, '带 X-Forwarded-Host：原规则（非内网即用公网地址）')
  assert.equal(domainHost, `${MHOST}/608807420`, 'Host 是域名：原规则')
})

check('订阅：没填公网地址时反代改写 Host 照旧用 Host（没有更好的地址可用）', () => {
  const [lucky] = channelLines('', [{ host: LAN, 'x-forwarded-for': '203.0.113.9' }])
  assert.equal(lucky, `http://${LAN}/608807420`)
})

console.log(`\n全部通过：${passed}/${passed} ✅`)
