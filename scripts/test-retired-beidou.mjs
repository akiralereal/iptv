#!/usr/bin/env node
/** 移除北斗、江门及「高校与场馆」（inst-*）：升级、备份导入不复活旧频道，其他来源仍保留。 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const temp = mkdtempSync(join(tmpdir(), 'iptv-retired-beidou-'))
process.env.mdataDir = temp
process.env.mbuiltInSourcesUrl = ''
const { listModules, getModule, resolverFor } = await import('../extractors/registry.js')
const { ExtractorManager } = await import('../utils/extractorManager.js')
const { collectAlerts } = await import('../utils/alerts.js')
const write = (path, data) => writeFileSync(path, JSON.stringify(data))
const read = path => JSON.parse(readFileSync(path, 'utf8'))
let passed = 0
const check = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

const retiredIds = ['beidou', 'jiangmen', 'inst-christies', 'inst-phillips']
const beidouRefs = [
  'beidou-liaoning-c077b260424404846285cba1e1759280',
  'beidou-shenyang-d447fcc472f14c7f14872d4e26b12d8f',
  'beidou-shenyang-eaecc3f39a6e94f2ac6197c229b4cd6b',
  'beidou-shenyang-acb1a5713531ac7feb7836b1b4db442c',
]
const christiesRefs = ['a', 'b', 'c'].map(char => `inst-christies-${char.repeat(24)}.mp4`)
const phillipsRefs = [`inst-phillips-${'d'.repeat(24)}.m3u8`]
const oldRefs = [...beidouRefs, 'jiangmen-1', ...christiesRefs, ...phillipsRefs]
const dalianRows = ['大连新闻综合', '大连生活', '大连文体'].map((name, i) => ({
  name, deferredRef: `dalian-${i + 7}`, proxyHls: true,
}))
const gdtvRows = [{ name: '广东卫视', deferredRef: 'gdtv-43', relayHls: true }]
const retainedRows = [...dalianRows, ...gdtvRows]
const oldConfig = () => ({ enabled: true, customFlag: 'preserve', modules: {
  ...Object.fromEntries(listModules().map(module => [module.id, { enabled: ['dalian', 'gdtv'].includes(module.id) }])),
  beidou: { enabled: true, config: {} },
  jiangmen: { enabled: true, config: {}, refreshMinutes: 1440 },
  'inst-christies': { enabled: true, config: {}, refreshMinutes: 60 },
  'inst-phillips': { enabled: true, config: {}, refreshMinutes: 60 },
  dalian: { enabled: true, config: {}, refreshMinutes: 5 },
  gdtv: { enabled: true, config: {}, refreshMinutes: 1440 },
  'future-module': { enabled: false, config: { keep: 'unknown modules are not retired' } },
} })
const oldCache = () => ({ modules: {
  beidou: { groups: [{ name: '辽宁', dataList: beidouRefs.map(deferredRef => ({ name: '旧频道', deferredRef })) }],
    health: { status: 'failed', channelCount: 4, lastError: 'HTTP 405', warnings: ['HTTP 405'] } },
  jiangmen: { groups: [{ name: '广东', dataList: [{ name: '江门综合', deferredRef: 'jiangmen-1', proxyHls: true }] }],
    health: { status: 'failed', channelCount: 1, lastError: '江门官方响应 HTTP 502', warnings: ['HTTP 502'] } },
  'inst-christies': { groups: [{ name: '佳士得', dataList: christiesRefs.map(deferredRef => ({ name: '[回放] 旧佳士得视频', deferredRef })) }],
    health: { status: 'failed', channelCount: 3, lastError: 'fetch failed', warnings: ['fetch failed'] } },
  'inst-phillips': { catalogVersion: 1,
    groups: [{ name: '富艺斯', dataList: phillipsRefs.map(deferredRef => ({ name: '[回放] 旧富艺斯视频', deferredRef })) }],
    health: { status: 'ok', channelCount: 1 } },
  dalian: { groups: [{ name: '辽宁', dataList: dalianRows }], health: { status: 'ok', channelCount: 3 } },
  gdtv: { catalogVersion: getModule('gdtv').catalogVersion,
    groups: [{ name: '广东', dataList: gdtvRows }], health: { status: 'ok', channelCount: 1 } },
  anhui: { catalogVersion: getModule('anhui').catalogVersion,
    groups: [{ name: '安徽', dataList: [{ name: '安徽卫视', deferredRef: 'anhui-ahwssx' }] }],
    health: { status: 'ok', channelCount: 1 } },
} })

const assertRetiredStateRemoved = manager => {
  for (const id of retiredIds) {
    assert.ok(!Object.hasOwn(manager.config.modules, id))
    assert.ok(!Object.hasOwn(manager.cache.modules, id))
    assert.ok(!Object.hasOwn(read(manager.configPath).modules, id))
    assert.ok(!Object.hasOwn(read(manager.cachePath).modules, id))
    assert.ok(!manager.getState().modules.some(module => module.id === id))
    assert.ok(!manager.alertSnapshot().modules.some(module => module.id === id))
    assert.ok(!collectAlerts({ extractors: manager.alertSnapshot() }).some(alert => alert.moduleId === id))
  }
}

console.log('移除北斗、江门、高校与场馆模块迁移测试')
try {
  await check('注册表和旧播放路由移除退役来源，独立大连、广东台保留', () => {
    for (const id of retiredIds) {
      assert.ok(!listModules().some(module => module.id === id))
      assert.equal(getModule(id), undefined)
    }
    for (const ref of oldRefs) assert.equal(resolverFor(ref), null)
    const dalian = getModule('dalian')
    assert.equal(dalian.outputGroupName, '辽宁')
    assert.equal(dalian.capabilities.epg, true)
    assert.ok(dalian.epg)
    for (const row of dalianRows) assert.equal(resolverFor(row.deferredRef), dalian)
    const gdtv = getModule('gdtv')
    assert.equal(gdtv.outputGroupName, '广东')
    assert.equal(gdtv.capabilities.epg, true)
    assert.ok(gdtv.epg)
    for (const row of gdtvRows) assert.equal(resolverFor(row.deferredRef), gdtv)
  })

  const manager = new ExtractorManager()
  const config = oldConfig()
  const cache = oldCache()
  write(manager.configPath, config)
  write(manager.cachePath, cache)
  await check('加载旧配置时移除退役模块配置、缓存和告警状态，保留其他源', () => {
    manager.load()
    assertRetiredStateRemoved(manager)
    const storedConfig = read(manager.configPath)
    const storedCache = read(manager.cachePath)
    assert.equal(storedConfig.customFlag, 'preserve')
    assert.deepEqual(storedConfig.modules.dalian, config.modules.dalian)
    assert.deepEqual(storedConfig.modules.gdtv, config.modules.gdtv)
    assert.deepEqual(storedConfig.modules['future-module'], config.modules['future-module'])
    assert.deepEqual(storedCache.modules.anhui, cache.modules.anhui)
    assert.deepEqual(storedCache.modules.gdtv, cache.modules.gdtv)
    assert.deepEqual(manager.getValidChannels().flatMap(group => group.dataList).map(row => [row.name, row.deferredRef]),
      retainedRows.map(row => [row.name, row.deferredRef]))
    assert.deepEqual(manager.getValidChannels().find(group => group.name === '广东').dataList.map(row => row.deferredRef), ['gdtv-43'])
  })

  await check('退役模块不能手动刷新；再次加载及导入旧备份也不会恢复它', async () => {
    for (const id of retiredIds) {
      assert.deepEqual(await manager.updateAll({ onlyId: id, forceAll: true }), { updated: false, results: [] })
    }
    manager.reload()
    assertRetiredStateRemoved(manager)
    write(manager.configPath, oldConfig())
    write(manager.cachePath, oldCache())
    manager.reload()
    assertRetiredStateRemoved(manager)
    assert.deepEqual(read(manager.configPath).modules.gdtv, config.modules.gdtv)
    assert.deepEqual(read(manager.cachePath).modules.gdtv, cache.modules.gdtv)
    assert.deepEqual(read(manager.configPath).modules.dalian, config.modules.dalian)
    assert.deepEqual(read(manager.configPath).modules['future-module'], config.modules['future-module'])
    assert.deepEqual(manager.getValidChannels().flatMap(group => group.dataList).map(row => row.deferredRef),
      retainedRows.map(row => row.deferredRef))
  })

  await check('旧配置损坏时保留原文件，仍可移除退役频道缓存', () => {
    const broken = '{"modules":'
    writeFileSync(manager.configPath, broken)
    write(manager.cachePath, oldCache())
    manager.reload()
    assert.ok(manager.corrupt)
    assert.equal(readFileSync(manager.configPath, 'utf8'), broken)
    assert.equal(readFileSync(`${manager.configPath}.corrupt`, 'utf8'), broken)
    for (const id of retiredIds) assert.ok(!Object.hasOwn(read(manager.cachePath).modules, id))
    assert.deepEqual(read(manager.cachePath).modules.gdtv, cache.modules.gdtv)
  })
  console.log(`\n${passed} 项测试全部通过`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
