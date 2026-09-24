#!/usr/bin/env node
/**
 * 停用内置默认 EPG 源 + 缓存兼容回归测试（issue #124，erw 停止免费下载）
 *
 * 背景：内置默认源先后是 epg.51zmt.top（退化到只剩央视卫视，issue #124）与 e.erw.cc（2026-10-01
 *   起停止免费下载）。现在不再内置任何外部源，节目单默认由咪咕与各模块官方接口提供。
 *   老部署的 data/epg-sources.json 里还写着这些地址；下载失败后聚合会一直沿用最后一份缓存、
 *   配对又不看日期，留着只会挂上过期节目单，还把用户自己加的源挡在后面。
 *
 * 不变量：
 * 1. 新装：聚合开关开启，但不写入任何外部源；
 * 2. 「一字未改的内置默认源」（名字仍是默认EPG + 地址是停用地址之一）直接删掉，开着关着都删；
 * 3. 删掉的那条的缓存文件一并删除——否则后面的同名源挪到它的序号上会读到它的旧缓存；
 * 4. 用户改过名 / 改过地址 / 自己加的源一律不动；
 * 5. 没有任何源时聚合直接返回，不联网；
 * 6. 缓存改 gzip 落盘后，老部署里已有的明文缓存仍能直接读（不作废、不重下）。
 *
 * 全程离线：不到期的源只读缓存，不联网。
 *
 * 运行： node scripts/test-epg-source-migrate.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DATA_DIR = mkdtempSync(join(tmpdir(), 'iptv-epg-migrate-'))
process.env.mdataDir = DATA_DIR
process.env.mblank = 'true'

const ZMT_URL = 'http://epg.51zmt.top:8000/e.xml.gz'
const ERW_URL = 'https://e.erw.cc/all.xml.gz'
const MY_URL = 'https://example.invalid/e.xml'
const SOURCES_PATH = join(DATA_DIR, 'epg-sources.json')

const { aggregateExternalEpg, BUILT_IN_EPG_SOURCES, LEGACY_EPG_SOURCE_URLS } = await import('../utils/epgAggregator.js')

let passed = 0
const check = (n, fn) => { fn(); passed++; console.log('  ✅ ' + n) }
const readSources = () => JSON.parse(readFileSync(SOURCES_PATH, 'utf-8')).sources
const writeSources = sources => writeFileSync(SOURCES_PATH, JSON.stringify({ enabled: true, sources }, null, 2))
const cachePath = (name, index) => join(DATA_DIR, 'epg-cache', `${name}_${index}.xml`)

// 不到期的源只读缓存，据此让整个测试离线跑
function seedCache(name, index, xml, { gzip }) {
  mkdirSync(join(DATA_DIR, 'epg-cache'), { recursive: true })
  writeFileSync(cachePath(name, index), gzip ? gzipSync(Buffer.from(xml, 'utf-8')) : Buffer.from(xml, 'utf-8'))
}
const xmlFor = title => `<?xml version="1.0"?>
<tv>
  <channel id="7"><display-name lang="zh">吉林都市</display-name></channel>
  <programme channel="7" start="20260908000000 +0800" stop="20260908010000 +0800"><title>${title}</title></programme>
</tv>`

const source = overrides => ({
  name: '默认EPG', url: ERW_URL, enabled: true, format: 'auto',
  refreshInterval: 720, priority: 10,
  lastUpdated: new Date().toISOString(), lastStatus: 'ok', channelCount: 518, matchedCount: 160,
  ...overrides
})

console.log('停用内置默认 EPG 源 + 缓存兼容回归测试')

// 触发一次聚合即会加载（并按需迁移）配置；pending 为空或没有源时不会联网
const runAggregate = async (names = [], covered = new Set()) => {
  const bak = join(DATA_DIR, `playback-${Math.random().toString(36).slice(2)}.xml.bak`)
  writeFileSync(bak, '<tv>\n')
  const res = await aggregateExternalEpg(bak, names, covered)
  return { res, out: readFileSync(bak, 'utf-8') }
}

// 尚无配置文件 → loadEpgConfig 落盘默认配置
const first = await runAggregate(['吉林都市'])
check('新装：聚合开启，但不内置任何外部源，也不联网', () => {
  assert.deepEqual(BUILT_IN_EPG_SOURCES, [])
  const config = JSON.parse(readFileSync(SOURCES_PATH, 'utf-8'))
  assert.equal(config.enabled, true)
  assert.deepEqual(config.sources, [])
  assert.equal(first.res.appended, 0)
})

check('停用地址清单包含 51zmt 与 erw（后台据此提示）', () => {
  assert.deepEqual(LEGACY_EPG_SOURCE_URLS, [ZMT_URL, ERW_URL])
})

writeSources([
  source(),                                                  // 一字未改的 erw 默认源
  source({ name: '默认EPG', url: MY_URL, enabled: false }),  // 名字没改、地址改过：用户自己的，保留
])
seedCache('默认EPG', 0, xmlFor('erw 的过期节目'), { gzip: true })
await runAggregate(['吉林都市'])
check('一字未改的 erw 默认源删掉，缓存一并删（后面的同名源会挪到它的序号上）', () => {
  const s = readSources()
  assert.equal(s.length, 1)
  assert.equal(s[0].url, MY_URL)
  assert.equal(existsSync(cachePath('默认EPG', 0)), false)
})

writeSources([source({ url: ZMT_URL }), source({ enabled: false })])
await runAggregate()
check('51zmt 老默认源、被关掉的 erw 默认源同样删掉', () => {
  assert.deepEqual(readSources(), [])
})

writeSources([
  source({ name: '我的EPG' }),                         // 改过名
  source({ url: 'http://epg.51zmt.top:8000/cc.xml.gz' }), // 改过地址
  source({ name: '备用', url: MY_URL }),
])
await runAggregate()
check('改过名 / 改过地址 / 自己加的源一律不动', () => {
  const s = readSources()
  assert.equal(s.length, 3)
  assert.equal(s[0].url, ERW_URL)
  assert.equal(s[0].name, '我的EPG')
  assert.equal(s[1].url, 'http://epg.51zmt.top:8000/cc.xml.gz')
  assert.equal(s[2].url, MY_URL)
})

// 缓存兼容：源未到期 → 只读缓存，不联网
for (const [label, gzip] of [['明文（老部署遗留）', false], ['gzip（新写入）', true]]) {
  writeSources([source({ name: '缓存源', url: MY_URL })])
  seedCache('缓存源', 0, xmlFor('都市新前程'), { gzip })
  const { res, out } = await runAggregate(['吉林都市'])
  check(`缓存兼容：${label} 缓存能直接解析出节目单`, () => {
    assert.equal(res.appended, 1)
    assert.match(out, /<channel id="吉林都市">/)
    assert.match(out, /都市新前程/)
  })
}

console.log(`\n全部通过：${passed} 组 ✅`)
