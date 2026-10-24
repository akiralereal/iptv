#!/usr/bin/env node
/** 退役北斗模块：升级、备份导入不复活沈阳/省台，大连频道和配置仍保留。 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const temp = mkdtempSync(join(tmpdir(), 'iptv-retired-beidou-'))
process.env.mdataDir = temp
process.env.mbuiltInSourcesUrl = ''
const { listModules, getModule, resolverFor } = await import('../extractors/registry.js')
const { ExtractorManager } = await import('../utils/extractorManager.js')
const write = (path, data) => writeFileSync(path, JSON.stringify(data))
const read = path => JSON.parse(readFileSync(path, 'utf8'))
let passed = 0
const check = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

const oldRefs = [
  'beidou-liaoning-c077b260424404846285cba1e1759280',
  'beidou-shenyang-d447fcc472f14c7f14872d4e26b12d8f',
  'beidou-shenyang-eaecc3f39a6e94f2ac6197c229b4cd6b',
  'beidou-shenyang-acb1a5713531ac7feb7836b1b4db442c',
]
const dalianRows = ['大连新闻综合', '大连生活', '大连文体'].map((name, i) => ({
  name, deferredRef: `dalian-${i + 7}`, proxyHls: true,
}))
const oldConfig = () => ({ enabled: true, customFlag: 'preserve', modules: {
  ...Object.fromEntries(listModules().map(module => [module.id, { enabled: module.id === 'dalian' }])),
  beidou: { enabled: true, config: {} },
  dalian: { enabled: true, config: {}, refreshMinutes: 5 },
  'future-module': { enabled: false, config: { keep: 'unknown modules are not retired' } },
} })
const oldCache = () => ({ modules: {
  beidou: { groups: [{ name: '辽宁', dataList: oldRefs.map(deferredRef => ({ name: '旧频道', deferredRef })) }],
    health: { status: 'failed', channelCount: 4, lastError: 'HTTP 405', warnings: ['HTTP 405'] } },
  dalian: { groups: [{ name: '辽宁', dataList: dalianRows }], health: { status: 'ok', channelCount: 3 } },
  anhui: { catalogVersion: getModule('anhui').catalogVersion,
    groups: [{ name: '安徽', dataList: [{ name: '安徽卫视', deferredRef: 'anhui-ahwssx' }] }],
    health: { status: 'ok', channelCount: 1 } },
} })

console.log('退役北斗模块迁移测试')
try {
  await check('注册表和播放路由移除省台、沈阳，独立大连三路及节目单保留', () => {
    assert.ok(!listModules().some(module => module.id === 'beidou'))
    assert.equal(getModule('beidou'), undefined)
    for (const ref of oldRefs) assert.equal(resolverFor(ref), null)
    const dalian = getModule('dalian')
    assert.equal(dalian.outputGroupName, '辽宁')
    assert.equal(dalian.capabilities.epg, true)
    assert.ok(dalian.epg)
    for (const row of dalianRows) assert.equal(resolverFor(row.deferredRef), dalian)
  })

  const manager = new ExtractorManager()
  const config = oldConfig()
  const cache = oldCache()
  write(manager.configPath, config)
  write(manager.cachePath, cache)
  await check('加载旧配置时移除退役模块配置、缓存和告警状态，保留其他源', () => {
    manager.load()
    assert.ok(!Object.hasOwn(manager.config.modules, 'beidou'))
    assert.ok(!Object.hasOwn(manager.cache.modules, 'beidou'))
    const storedConfig = read(manager.configPath)
    const storedCache = read(manager.cachePath)
    assert.ok(!Object.hasOwn(storedConfig.modules, 'beidou'))
    assert.ok(!Object.hasOwn(storedCache.modules, 'beidou'))
    assert.equal(storedConfig.customFlag, 'preserve')
    assert.deepEqual(storedConfig.modules.dalian, config.modules.dalian)
    assert.deepEqual(storedConfig.modules['future-module'], config.modules['future-module'])
    assert.deepEqual(storedCache.modules.anhui, cache.modules.anhui)
    assert.deepEqual(manager.getValidChannels().flatMap(group => group.dataList).map(row => [row.name, row.deferredRef]),
      dalianRows.map(row => [row.name, row.deferredRef]))
    assert.ok(!manager.getState().modules.some(module => module.id === 'beidou'))
  })

  await check('退役模块不能手动刷新；再次加载及导入旧备份也不会恢复它', async () => {
    assert.deepEqual(await manager.updateAll({ onlyId: 'beidou', forceAll: true }), { updated: false, results: [] })
    manager.reload()
    assert.ok(!Object.hasOwn(read(manager.configPath).modules, 'beidou'))
    write(manager.configPath, oldConfig())
    write(manager.cachePath, oldCache())
    manager.reload()
    assert.ok(!Object.hasOwn(read(manager.configPath).modules, 'beidou'))
    assert.ok(!Object.hasOwn(read(manager.cachePath).modules, 'beidou'))
    assert.deepEqual(manager.getValidChannels().flatMap(group => group.dataList).map(row => row.deferredRef),
      dalianRows.map(row => row.deferredRef))
  })

  await check('旧配置损坏时保留原文件，仍可移除退役频道缓存', () => {
    const broken = '{"modules":'
    writeFileSync(manager.configPath, broken)
    write(manager.cachePath, oldCache())
    manager.reload()
    assert.ok(manager.corrupt)
    assert.equal(readFileSync(manager.configPath, 'utf8'), broken)
    assert.equal(readFileSync(`${manager.configPath}.corrupt`, 'utf8'), broken)
    assert.ok(!Object.hasOwn(read(manager.cachePath).modules, 'beidou'))
  })
  console.log(`\n${passed} 项测试全部通过`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
