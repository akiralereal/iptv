#!/usr/bin/env node
/**
 * 默认 EPG 源升级 + 缓存兼容回归测试（issue #124）
 *
 * 背景：老的内置默认源 epg.51zmt.top 现在对 e.xml.gz / difang.xml.gz / cc.xml.gz 返回同一份
 *   文件，只剩 101 个频道（央视 + 卫视）、2 天节目，地方台一个都补不到。换默认源时，
 *   老部署的 data/epg-sources.json 里已经写死了老地址，只改内置默认对他们不生效。
 *
 * 不变量：
 * 1. 新装写入新的内置默认源；
 * 2. 「一字未改的内置默认源」原地升级到新地址，并清空运行状态（触发立即重新下载）；
 * 3. 用户改过名 / 改过地址 / 自己加的源一律不动——迁移只认「名字还是默认EPG + 地址还是老地址」；
 * 4. 被用户关掉的默认源升级后仍是关闭状态（不能借升级偷偷打开）；
 * 5. 缓存改 gzip 落盘后，老部署里已有的明文缓存仍能直接读（不作废、不重下）。
 *
 * 全程离线：不到期的源只读缓存，不联网。
 *
 * 运行： node scripts/test-epg-source-migrate.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DATA_DIR = mkdtempSync(join(tmpdir(), 'iptv-epg-migrate-'))
process.env.mdataDir = DATA_DIR
process.env.mblank = 'true'

const LEGACY_URL = 'http://epg.51zmt.top:8000/e.xml.gz'
const SOURCES_PATH = join(DATA_DIR, 'epg-sources.json')

const { aggregateExternalEpg } = await import('../utils/epgAggregator.js')

let passed = 0
const check = (n, fn) => { fn(); passed++; console.log('  ✅ ' + n) }
const readSources = () => JSON.parse(readFileSync(SOURCES_PATH, 'utf-8')).sources
const writeSources = sources => writeFileSync(SOURCES_PATH, JSON.stringify({ enabled: true, sources }, null, 2))

// 不到期的源只读缓存，据此让整个测试离线跑
function seedCache(name, index, xml, { gzip }) {
  mkdirSync(join(DATA_DIR, 'epg-cache'), { recursive: true })
  const file = join(DATA_DIR, 'epg-cache', `${name}_${index}.xml`)
  writeFileSync(file, gzip ? gzipSync(Buffer.from(xml, 'utf-8')) : Buffer.from(xml, 'utf-8'))
}
const XML = `<?xml version="1.0"?>
<tv>
  <channel id="7"><display-name lang="zh">吉林都市</display-name></channel>
  <programme channel="7" start="20260908000000 +0800" stop="20260908010000 +0800"><title>都市新前程</title></programme>
</tv>`

const fresh = source => ({
  name: '默认EPG', url: LEGACY_URL, enabled: true, format: 'auto',
  refreshInterval: 720, priority: 10,
  lastUpdated: '2026-09-06T00:00:00.000Z', lastStatus: 'ok', channelCount: 101, matchedCount: 34,
  ...source
})

console.log('默认 EPG 源升级 + 缓存兼容回归测试 (issue #124)')

// 触发一次聚合即会加载（并按需迁移）配置；pending 为空时不会联网
const runAggregate = async (names = [], covered = new Set()) => {
  const bak = join(DATA_DIR, `playback-${Math.random().toString(36).slice(2)}.xml.bak`)
  writeFileSync(bak, '<tv>\n')
  const res = await aggregateExternalEpg(bak, names, covered)
  return { res, out: readFileSync(bak, 'utf-8') }
}

// 尚无配置文件 → loadEpgConfig 落盘内置默认
await runAggregate()
check('新装：写入的默认源地址不再是老的 51zmt', () => {
  const sources = readSources()
  assert.equal(sources.length, 1)
  assert.equal(sources[0].name, '默认EPG')
  assert.notEqual(sources[0].url, LEGACY_URL)
  assert.match(sources[0].url, /^https:\/\//)
})

const NEW_URL = readSources()[0].url

writeSources([fresh()])
await runAggregate()
check('老部署里一字未改的默认源就地升级，并清空运行状态', () => {
  const s = readSources()[0]
  assert.equal(s.url, NEW_URL)
  assert.equal(s.lastUpdated, null)      // 清空 → 立即重新下载
  assert.equal(s.lastStatus, null)
  assert.equal(s.channelCount, 0)
  assert.equal(s.matchedCount, 0)
  assert.equal(s.priority, 10)           // 用户可调项保持不变
  assert.equal(s.refreshInterval, 720)
})

writeSources([fresh({ enabled: false })])
await runAggregate()
check('被关掉的默认源升级后仍是关闭状态', () => {
  const s = readSources()[0]
  assert.equal(s.url, NEW_URL)
  assert.equal(s.enabled, false)
})

writeSources([
  fresh({ name: '我的EPG' }),                       // 改过名
  fresh({ url: 'http://epg.51zmt.top:8000/cc.xml.gz' }), // 改过地址
  fresh({ name: '备用', url: 'https://example.invalid/e.xml' }),
])
await runAggregate()
check('改过名 / 改过地址 / 自己加的源一律不动', () => {
  const s = readSources()
  assert.equal(s[0].url, LEGACY_URL)
  assert.equal(s[0].name, '我的EPG')
  assert.equal(s[1].url, 'http://epg.51zmt.top:8000/cc.xml.gz')
  assert.equal(s[2].url, 'https://example.invalid/e.xml')
})

// 缓存兼容：源未到期 → 只读缓存，不联网
for (const [label, gzip] of [['明文（老部署遗留）', false], ['gzip（新写入）', true]]) {
  writeSources([fresh({ name: '缓存源', url: NEW_URL, lastUpdated: new Date().toISOString() })])
  seedCache('缓存源', 0, XML, { gzip })
  const { res, out } = await runAggregate(['吉林都市'])
  check(`缓存兼容：${label} 缓存能直接解析出节目单`, () => {
    assert.equal(res.appended, 1)
    assert.match(out, /<channel id="吉林都市">/)
    assert.match(out, /都市新前程/)
  })
}

console.log(`\n全部通过：${passed} 组 ✅`)
