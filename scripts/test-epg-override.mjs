#!/usr/bin/env node
/**
 * 外部源「优先于官方节目单」（overrideOfficial）回归测试
 *
 * 不变量：
 * 1. 只认源里还有没播完节目的频道——停更只剩旧缓存的源，自动让回咪咕 / 模块官方节目单；
 * 2. 没勾的源、总开关关着时，一个频道都不抢；
 * 3. 外部源之间，勾了的排在最前，哪怕它的 priority 数字更大；
 * 4. 模块节目单把这些频道让出来；
 * 5. 后台接口能存取这个开关，默认关。
 *
 * 全程离线：源不到期只读缓存。
 *
 * 运行： node scripts/test-epg-override.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DATA_DIR = mkdtempSync(join(tmpdir(), 'iptv-epg-override-'))
process.env.mdataDir = DATA_DIR
process.env.mblank = 'true'

const { aggregateExternalEpg, loadOverrideKeys } = await import('../utils/epgAggregator.js')
const { addEpgSourceAPI, updateEpgSourceAPI } = await import('../utils/epgSourcesAPI.js')
const { channelKeysWithCurrentProgrammes, parseXmltvTime } = await import('../utils/epgParse.js')
const { appendModuleEpg } = await import('../utils/moduleEpg.js')
const { normalizeKey } = await import('../utils/channelNormalize.js')

let passed = 0
const check = (n, fn) => { fn(); passed++; console.log('  ✅ ' + n) }
const checkAsync = async (n, fn) => { await fn(); passed++; console.log('  ✅ ' + n) }

const SOURCES_PATH = join(DATA_DIR, 'epg-sources.json')
const writeSources = sources => writeFileSync(SOURCES_PATH, JSON.stringify({ enabled: true, sources }, null, 2))
const writeConfig = config => writeFileSync(SOURCES_PATH, JSON.stringify(config, null, 2))
const seedCache = (name, index, xml) => {
  mkdirSync(join(DATA_DIR, 'epg-cache'), { recursive: true })
  writeFileSync(join(DATA_DIR, 'epg-cache', `${name}_${index}.xml`), gzipSync(Buffer.from(xml, 'utf-8')))
}
// 不到期：只读缓存、不联网
const source = overrides => ({
  name: '源', url: 'https://example.invalid/e.xml', enabled: true, format: 'auto',
  refreshInterval: 720, priority: 10, lastUpdated: new Date().toISOString(), lastStatus: 'ok',
  ...overrides,
})

// 2026-09-25 19:00（上海）；「现在」取 18:00
const NOW = Date.parse('2026-09-25T10:00:00Z')
const xml = channels => `<?xml version="1.0"?>\n<tv>\n${channels.map(([id, name]) =>
  `  <channel id="${id}"><display-name lang="zh">${name}</display-name></channel>`).join('\n')}\n${channels.map(([id, , title, start, stop]) =>
  `  <programme channel="${id}" start="${start} +0800" stop="${stop} +0800"><title lang="zh">${title}</title></programme>`).join('\n')}\n</tv>`

console.log('外部源「优先于官方节目单」回归测试')

check('XMLTV 时间按自带时区换算，不带时区按 UTC，解不出为 NaN', () => {
  assert.equal(parseXmltvTime('20260925190000 +0800'), Date.parse('2026-09-25T11:00:00Z'))
  assert.equal(parseXmltvTime('20260925190000 +0900'), Date.parse('2026-09-25T10:00:00Z'))
  assert.equal(parseXmltvTime('20260925190000'), Date.parse('2026-09-25T19:00:00Z'))
  assert.ok(Number.isNaN(parseXmltvTime('')))
  assert.ok(Number.isNaN(parseXmltvTime('昨晚')))
})

check('只认还有没播完节目的频道', () => {
  const keys = channelKeysWithCurrentProgrammes(xml([
    ['1', '甘肃卫视', '晚间新闻', '20260925190000', '20260925193000'],
    ['2', '河南卫视', '早间新闻', '20260925070000', '20260925073000'],
  ]), NOW)
  // 频道 id 本身也算配对键（与外部聚合的配对一致），这里只看频道名
  assert.ok(keys.has(normalizeKey('甘肃卫视')))
  assert.ok(!keys.has(normalizeKey('河南卫视')), '只剩播完节目的频道不算')
})

await checkAsync('预取：勾了的源只抢它此刻有节目的频道；没勾的源、总开关关着时一个不抢', async () => {
  writeSources([
    source({ name: '优先源', overrideOfficial: true, priority: 50 }),
    source({ name: '普通源', url: 'https://example.invalid/plain.xml', priority: 1 }),
  ])
  // 缓存序号按「勾了的在前」的顺序：优先源 0、普通源 1
  seedCache('优先源', 0, xml([
    ['1', '甘肃卫视', '优先源·甘肃', '20260925190000', '20260925193000'],
    ['2', '河南卫视', '优先源·河南（已播完）', '20260925070000', '20260925073000'],
  ]))
  seedCache('普通源', 1, xml([['9', '湖南卫视', '普通源·湖南', '20260925190000', '20260925193000']]))
  const keys = await loadOverrideKeys({ now: NOW })
  assert.ok(keys.has(normalizeKey('甘肃卫视')))
  assert.ok(!keys.has(normalizeKey('河南卫视')), '只剩播完节目的频道让回官方')
  assert.ok(!keys.has(normalizeKey('湖南卫视')), '没勾的源不抢')

  writeSources([source({ name: '优先源', overrideOfficial: false })])
  assert.equal((await loadOverrideKeys({ now: NOW })).size, 0)

  writeConfig({ enabled: false, sources: [source({ name: '优先源', overrideOfficial: true })] })
  assert.equal((await loadOverrideKeys({ now: NOW })).size, 0)
})

await checkAsync('外部源之间：勾了的排在最前，哪怕 priority 数字更大', async () => {
  writeSources([
    source({ name: '普通源', url: 'https://example.invalid/plain.xml', priority: 1 }),
    source({ name: '优先源', overrideOfficial: true, priority: 50 }),
  ])
  seedCache('优先源', 0, xml([['1', '甘肃卫视', '优先源·甘肃', '20260925190000', '20260925193000']]))
  seedCache('普通源', 1, xml([['1', '甘肃卫视', '普通源·甘肃', '20260925190000', '20260925193000']]))
  const bak = join(DATA_DIR, 'playback.xml.bak')
  writeFileSync(bak, '<tv>\n')
  const result = await aggregateExternalEpg(bak, ['甘肃卫视'], new Set())
  assert.equal(result.appended, 1)
  const out = readFileSync(bak, 'utf-8')
  assert.match(out, /优先源·甘肃/)
  assert.doesNotMatch(out, /普通源·甘肃/)
})

await checkAsync('模块节目单把让出来的频道跳过', async () => {
  const bak = join(DATA_DIR, 'module.xml.bak')
  writeFileSync(bak, '')
  const fake = {
    name: '假模块',
    epg: {
      days: 1,
      channels: () => [{ ref: 'fake-1', name: '甘肃卫视', key: 'gs' }, { ref: 'fake-2', name: '甘肃少儿', key: 'se' }],
      async programmes(key) { return [{ title: `${key} 官方节目`, start: NOW, stop: NOW + 1800000 }] },
    },
  }
  const result = await appendModuleEpg(bak, [
    { ref: 'fake-1', name: '甘肃卫视' },
    { ref: 'fake-2', name: '甘肃少儿' },
  ], new Set(), { now: NOW, resolveModule: () => fake, skipKeys: new Set([normalizeKey('甘肃卫视')]) })
  assert.deepEqual(result, { appended: 1, failed: 0 })
  const out = readFileSync(bak, 'utf-8')
  assert.match(out, /se 官方节目/)
  assert.doesNotMatch(out, /gs 官方节目/)
})

check('后台接口存取开关，默认关', () => {
  writeSources([])
  const added = addEpgSourceAPI({ name: '我的源', url: 'https://example.invalid/mine.xml' })
  assert.equal(added.success, true)
  assert.equal(added.data.sources[0].overrideOfficial, false)
  const withFlag = addEpgSourceAPI({ name: '覆盖源', url: 'https://example.invalid/over.xml', overrideOfficial: true })
  assert.equal(withFlag.data.sources[1].overrideOfficial, true)
  assert.equal(updateEpgSourceAPI(0, { overrideOfficial: true }).data.sources[0].overrideOfficial, true)
  assert.equal(updateEpgSourceAPI(0, { overrideOfficial: false }).data.sources[0].overrideOfficial, false)
  // 只认布尔 true，别的值一律当关
  assert.equal(updateEpgSourceAPI(1, { overrideOfficial: 'yes' }).data.sources[1].overrideOfficial, false)
})

rmSync(DATA_DIR, { recursive: true, force: true })
console.log(`\n全部通过：${passed} ✅`)
