#!/usr/bin/env node
/**
 * 外部 EPG 配对认频道别名回归测试（issue #144）
 *
 * 不变量：
 * 1. 频道设了别名（channel-aliases.json），外部源按规范名配对，节目单写成规范名——与播放列表 tvg-id 一致；
 * 2. 咪咕 / 模块节目单已覆盖的（它们记原名的 key），外部源不再重复写；
 * 3. 没设别名的频道照旧按原名配。
 *
 * 全程离线：源不到期只读缓存。
 *
 * 运行： node scripts/test-epg-alias.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DATA_DIR = mkdtempSync(join(tmpdir(), 'iptv-epg-alias-'))
process.env.mdataDir = DATA_DIR
process.env.mblank = 'true'

const { aggregateExternalEpg } = await import('../utils/epgAggregator.js')
const { normalizeKey } = await import('../utils/channelNormalize.js')

let passed = 0
const checkAsync = async (n, fn) => { await fn(); passed++; console.log('  ✅ ' + n) }

// issue 里的原样：订阅频道名「NHK総合（東京）」，外部 XMLTV 的 display-name 是「NHK東京・総合」
writeFileSync(join(DATA_DIR, 'channel-aliases.json'), JSON.stringify({ 'NHK東京・総合': ['NHK総合（東京）'] }))
writeFileSync(join(DATA_DIR, 'epg-sources.json'), JSON.stringify({ enabled: true, sources: [{
  name: '日本', url: 'https://example.invalid/jp.xml', enabled: true, format: 'auto',
  refreshInterval: 720, priority: 10, lastUpdated: new Date().toISOString(), lastStatus: 'ok',
}] }))
mkdirSync(join(DATA_DIR, 'epg-cache'), { recursive: true })
writeFileSync(join(DATA_DIR, 'epg-cache', '日本_0.xml'), gzipSync(Buffer.from(`<?xml version="1.0"?>
<tv>
  <channel id="NHK東京・総合_jp"><display-name lang="ja">NHK東京・総合</display-name></channel>
  <channel id="テレビ東京_jp"><display-name lang="ja">テレビ東京</display-name></channel>
  <programme channel="NHK東京・総合_jp" start="20260928190000 +0900" stop="20260928200000 +0900"><title lang="ja">ニュース7</title></programme>
  <programme channel="テレビ東京_jp" start="20260928190000 +0900" stop="20260928200000 +0900"><title lang="ja">ワールドビジネスサテライト</title></programme>
</tv>`, 'utf-8')))

const run = async (names, covered = new Set()) => {
  const bak = join(DATA_DIR, 'playback.xml.bak')
  writeFileSync(bak, '<tv>\n')
  const result = await aggregateExternalEpg(bak, names, covered)
  return { result, out: readFileSync(bak, 'utf-8') }
}

console.log('外部 EPG 配对认频道别名回归测试 (issue #144)')

await checkAsync('设了别名：按规范名配上，频道 id 写规范名', async () => {
  const { result, out } = await run(['NHK総合（東京）'])
  assert.equal(result.appended, 1)
  assert.match(out, /<channel id="NHK東京・総合">/)
  assert.match(out, /<programme channel="NHK東京・総合"[^>]*><title lang="ja">ニュース7/)
})

await checkAsync('已由咪咕 / 模块覆盖（原名 key）的不重复写', async () => {
  const { result, out } = await run(['NHK総合（東京）'], new Set([normalizeKey('NHK総合（東京）')]))
  assert.equal(result.appended, 0)
  assert.doesNotMatch(out, /ニュース7/)
})

await checkAsync('没设别名的照旧按原名配', async () => {
  const { result, out } = await run(['テレビ東京'])
  assert.equal(result.appended, 1)
  assert.match(out, /<channel id="テレビ東京">/)
})

rmSync(DATA_DIR, { recursive: true, force: true })
console.log(`\n全部通过：${passed} ✅`)
