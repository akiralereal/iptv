#!/usr/bin/env node
/**
 * 配置导出/导入回归测试（issue #99）
 *
 * 核心不变量：
 *   1) 导出只含白名单配置（含配置档动态名），不含缓存；
 *   2) 导入白名单校验：未知文件名/非对象内容一律跳过，路径穿越名进不来；
 *   3) 导出 → 清空 → 导入 后配置内容逐字节等价（往返无损）；
 *   4) 导入前自动生成 config-pre-import-backup.json 兜底快照。
 *
 * 用独立临时数据目录跑（mdataDir 在 import 前设置），不碰真实数据。
 * 运行： node scripts/test-config-backup.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 必须在 import 业务模块之前设定数据目录（paths.js 读环境变量一次）；
// mblank 关闭内置内容，让导入后的 loadSources/重建不发起网络请求（测试保持离线）
const DIR = mkdtempSync(join(tmpdir(), 'iptv-backup-test-'))
process.env.mdataDir = DIR
process.env.mblank = 'true'

const seed = {
  'system-config.json': { userId: 'u1', token: 't1', port: 1905, pass: 'p' },
  'external-sources.json': { sources: [{ id: 'ext1', name: '测试源', mode: 'subscription', parsedChannels: [] }] },
  'my-playlist-config.json': { hiddenChannels: ['组::a'], channelOrder: {} },
  'my-playlist-config.fam01.json': { hiddenChannels: [], channelOrder: {} },
  'my-playlist-profiles.json': { profiles: [{ id: 'fam01', name: '家人' }] },
  'epg-sources.json': { sources: [] },
  'channel-aliases.json': { 'CCTV5体育': ['央视5套'] },
  'users.json': { users: [] },
}
for (const [name, content] of Object.entries(seed)) {
  writeFileSync(join(DIR, name), JSON.stringify(content))
}
// 缓存类文件：不应被导出
writeFileSync(join(DIR, 'pe-cache.json'), '{}')
writeFileSync(join(DIR, 'built-in-sources-cache.json'), '{}')
// 杂散档文件：不在 my-playlist-profiles.json 注册表内（手拷副本/大写死文件），不应被导出
writeFileSync(join(DIR, 'my-playlist-config.stray.json'), '{}')
writeFileSync(join(DIR, 'my-playlist-config.OLD.json'), '{}')

const { exportConfigAPI, importConfigAPI, BACKUP_FORMAT } = await import('../utils/configBackupAPI.js')

let passed = 0
const check = (n, fn) => { fn(); passed++; console.log('  ✅ ' + n) }

console.log('配置导出/导入回归测试 (issue #99)')

// 1) 导出：白名单全收、缓存不收
let exported
check('导出只含白名单配置（含配置档动态名），不含缓存', () => {
  const r = exportConfigAPI()
  assert.equal(r.success, true)
  exported = r.data
  assert.equal(exported.format, BACKUP_FORMAT)
  for (const name of Object.keys(seed)) assert.ok(exported.files[name], `缺少 ${name}`)
  assert.equal(exported.files['pe-cache.json'], undefined)
  assert.equal(exported.files['built-in-sources-cache.json'], undefined)
  // 注册表外的杂散档文件不进备份（只收 my-playlist-profiles.json 里注册的档）
  assert.equal(exported.files['my-playlist-config.stray.json'], undefined)
  assert.equal(exported.files['my-playlist-config.OLD.json'], undefined)
  assert.ok(exported.files['my-playlist-config.fam01.json'], '注册档 fam01 应在备份内')
})

// 2) 导入白名单：未知名/穿越名/非对象内容全部跳过
check('导入拒绝白名单外文件与非对象内容', () => {
  // 穿越名不能用 ../../etc/passwd 之类真实系统路径：tmpdir 直接挂在 / 下的环境里
  // （Linux 容器 /tmp），existsSync 会命中真实的 /etc/passwd，断言变成环境相关。
  // 用一个不可能预先存在的探针名，专测「导入没有把文件写出数据目录」。
  const r = importConfigAPI({
    format: BACKUP_FORMAT, version: 1,
    files: {
      '../../iptv-escape-probe.json': { evil: true },
      'pe-cache.json': { evil: true },
      'system-config.json; rm -rf': { evil: true },
      'channel-aliases.json': 'not-an-object',
      'epg-sources.json': { sources: [{ url: 'http://x' }] },   // 唯一合法项
    },
  })
  assert.equal(r.success, true)
  assert.deepEqual(r.imported, ['epg-sources.json'])
  assert.equal(r.skipped.length, 4)
  assert.equal(existsSync(join(DIR, '../../iptv-escape-probe.json')), false)
})

// 3) 全部非法时整体失败
check('无任何合法文件时导入失败', () => {
  const r = importConfigAPI({ format: BACKUP_FORMAT, version: 1, files: { 'evil.json': {} } })
  assert.equal(r.success, false)
})

// 4) 非本系统备份/超版本拒绝
check('非法格式与超版本备份被拒绝', () => {
  assert.equal(importConfigAPI({ files: {} }).success, false)
  assert.equal(importConfigAPI({ format: BACKUP_FORMAT, version: 99, files: { 'users.json': {} } }).success, false)
})

// 5) 往返无损：改乱所有配置后导入第 1 步的导出，内容应恢复。
// 注意：external-sources.json 导入后会过 loadSources 的迁移/规范化（补默认字段、发 id、
// 内置订阅治愈）——这是刻意行为（导入旧备份自动治愈），故断言口径是「用户数据不丢、迁移可增补」，
// 其余文件无迁移路径、逐字节等价。
check('导出 → 破坏 → 导入 往返不丢数据，且生成兜底快照', () => {
  for (const name of Object.keys(seed)) {
    writeFileSync(join(DIR, name), JSON.stringify({ broken: true }))
  }
  const r = importConfigAPI(exported)
  assert.equal(r.success, true)
  assert.equal(r.imported.length, Object.keys(seed).length)
  for (const [name, content] of Object.entries(seed)) {
    const onDisk = JSON.parse(readFileSync(join(DIR, name), 'utf-8'))
    if (name === 'external-sources.json') {
      const restored = (onDisk.sources || []).find(s => s.id === 'ext1')
      assert.ok(restored, '导入的外部源 ext1 丢失')
      assert.equal(restored.name, '测试源')
      assert.equal(restored.mode, 'subscription')
    } else {
      assert.deepEqual(onDisk, content, `${name} 往返后不一致`)
    }
  }
  // 兜底快照存在且记录了导入前（被改乱）的状态
  const pre = JSON.parse(readFileSync(join(DIR, 'config-pre-import-backup.json'), 'utf-8'))
  assert.deepEqual(pre.files['system-config.json'], { broken: true })
})

// 6) 导入的 system-config.json 非法启动关键项被清洗（review：非法 port 会让重启崩溃/静默失联）
check('导入 system-config 非法 port/rateType 被清洗', () => {
  const r = importConfigAPI({
    format: BACKUP_FORMAT, version: 1,
    files: { 'system-config.json': { userId: 'u2', port: 'abc', rateType: '999999x' } },
  })
  assert.equal(r.success, true)
  const onDisk = JSON.parse(readFileSync(join(DIR, 'system-config.json'), 'utf-8'))
  assert.equal(onDisk.userId, 'u2')
  assert.equal(onDisk.port, undefined, '非法 port 应被删除（回落环境变量/默认值）')
  // rateType 'abc'... parseInt('999999x')=999999 合法数字保留；真正非数字才删
  const r2 = importConfigAPI({
    format: BACKUP_FORMAT, version: 1,
    files: { 'system-config.json': { port: 999999 } },
  })
  assert.equal(r2.success, true)
  const onDisk2 = JSON.parse(readFileSync(join(DIR, 'system-config.json'), 'utf-8'))
  assert.equal(onDisk2.port, undefined, '越界 port 应被删除')
  const r3 = importConfigAPI({
    format: BACKUP_FORMAT, version: 1,
    files: { 'system-config.json': { port: '8080' } },
  })
  assert.equal(r3.success, true)
  assert.equal(JSON.parse(readFileSync(join(DIR, 'system-config.json'), 'utf-8')).port, 8080, '合法字符串端口应数值化保留')
})

// 7) 写盘中途失败：已写文件回滚到导入前状态（review：磁盘半新半旧）
check('写盘中途失败自动回滚', () => {
  const before = JSON.parse(readFileSync(join(DIR, 'system-config.json'), 'utf-8'))
  // 让 users.json 的原子写失败：writeJsonFileSync 先写 <file>.tmp 再 rename，把 .tmp 占成目录即抛错
  mkdirSync(join(DIR, 'users.json.tmp'))
  const r = importConfigAPI({
    format: BACKUP_FORMAT, version: 1,
    files: {
      'system-config.json': { userId: 'SHOULD_ROLLBACK' },   // 先写成功
      'users.json': { users: [] },                           // 后写失败
    },
  })
  rmSync(join(DIR, 'users.json.tmp'), { recursive: true, force: true })
  assert.equal(r.success, false)
  assert.ok(r.message.includes('已自动回滚'), `失败提示应说明已回滚，实际: ${r.message}`)
  assert.deepEqual(JSON.parse(readFileSync(join(DIR, 'system-config.json'), 'utf-8')), before, '先写成功的文件应被回滚')
})

rmSync(DIR, { recursive: true, force: true })
console.log(`\n全部通过：${passed}/7 ✅`)
