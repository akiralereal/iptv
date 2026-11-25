#!/usr/bin/env node
/**
 * 外部 EPG 源每轮完整更新都重新下载 —— 回归测试
 *
 * 以前按源自己的「间隔(分钟)」（默认 720）判断要不要重下：完整更新 8 小时一轮，每次都差几个
 * 小时没到点，实际隔 16 小时左右才重下，零点补刷也多半跳过，只发当天节目单的源新一天的节目
 * 迟迟不出来（用户看到的就是「设置的 EPG 不自动更新」）。
 *
 * 不变量：
 * 1. 本轮开始之前下载的源，本轮重新下载——老配置里留着的 refreshInterval 不再挡；
 * 2. 同一轮里「优先于官方节目单」的源预取过一次，正式聚合不再下第二次；下一轮照常重下；
 * 3. 下载失败沿用上次缓存，状态记失败、上次成功时间不动；
 * 4. 后台接口不再写入也不再改 refreshInterval。
 *
 * 源用本机临时 HTTP 服务，不连外网。
 *
 * 运行： node scripts/test-epg-refresh.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DATA_DIR = mkdtempSync(join(tmpdir(), 'iptv-epg-refresh-'))
process.env.mdataDir = DATA_DIR
process.env.mblank = 'true'

const { aggregateExternalEpg, loadOverrideKeys, loadEpgConfig } = await import('../utils/epgAggregator.js')
const { addEpgSourceAPI, updateEpgSourceAPI } = await import('../utils/epgSourcesAPI.js')

let passed = 0
const checkAsync = async (n, fn) => { await fn(); passed++; console.log('  ✅ ' + n) }

// XMLTV 时间：UTC
const xmltvTime = ms => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000'
const xmlWith = title => {
  const now = Date.now()
  return `<?xml version="1.0"?>
<tv>
  <channel id="sx"><display-name lang="zh">测试卫视</display-name></channel>
  <programme channel="sx" start="${xmltvTime(now - 3600e3)}" stop="${xmltvTime(now + 3600e3)}"><title lang="zh">${title}</title></programme>
</tv>`
}

// 本机 XMLTV 源：记下请求次数，内容和状态码随测试改
let served = { status: 200, body: xmlWith('新一天的节目') }
let hits = 0
const server = createServer((req, res) => {
  hits++
  res.writeHead(served.status, { 'Content-Type': 'application/xml' })
  res.end(served.status === 200 ? served.body : 'error')
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const URL_BASE = `http://127.0.0.1:${server.address().port}/epg.xml`

const SOURCES_PATH = join(DATA_DIR, 'epg-sources.json')
const EIGHT_HOURS_AGO = new Date(Date.now() - 8 * 3600e3).toISOString()
const writeSources = sources => writeFileSync(SOURCES_PATH, JSON.stringify({ enabled: true, sources }, null, 2))
// 升级上来的老配置：带 refreshInterval 720，8 小时前下过一次，缓存里是前一天的节目
const legacySource = overrides => ({
  name: '外部源', url: URL_BASE, enabled: true, format: 'auto', refreshInterval: 720, priority: 10,
  lastUpdated: EIGHT_HOURS_AGO, lastStatus: 'ok', ...overrides,
})
const seedCache = (name, index, xml) => {
  mkdirSync(join(DATA_DIR, 'epg-cache'), { recursive: true })
  writeFileSync(join(DATA_DIR, 'epg-cache', `${name}_${index}.xml`), gzipSync(Buffer.from(xml, 'utf-8')))
}
const aggregate = async opts => {
  const bak = join(DATA_DIR, 'playback.xml.bak')
  writeFileSync(bak, '<tv>\n')
  const result = await aggregateExternalEpg(bak, ['测试卫视'], new Set(), opts)
  return { result, out: readFileSync(bak, 'utf-8') }
}

console.log('外部 EPG 源每轮重新下载回归测试')

try {
  await checkAsync('8 小时前下过、老配置间隔 720 分钟：这一轮照样重新下载，拿到新一天的节目', async () => {
    writeSources([legacySource()])
    seedCache('外部源', 0, xmlWith('前一天的节目'))
    hits = 0
    const runStartedAt = Date.now()
    const { result, out } = await aggregate({ runStartedAt })
    assert.equal(hits, 1, '应当重新下载一次')
    assert.equal(result.appended, 1)
    assert.match(out, /新一天的节目/)
    assert.doesNotMatch(out, /前一天的节目/)
    const s = loadEpgConfig().sources[0]
    assert.equal(s.lastStatus, 'ok')
    assert.ok(Date.parse(s.lastUpdated) >= runStartedAt, '上次下载时间更新到本轮')
  })

  await checkAsync('同一轮里「优先于官方节目单」预取过，正式聚合不再下第二次；下一轮再重下', async () => {
    writeSources([legacySource({ overrideOfficial: true })])
    seedCache('外部源', 0, xmlWith('前一天的节目'))
    hits = 0
    const runStartedAt = Date.now()
    const keys = await loadOverrideKeys({ runStartedAt })
    assert.ok(keys.size > 0, '预取后应让出该频道')
    assert.equal(hits, 1)
    const { out } = await aggregate({ runStartedAt, overrideKeys: keys })
    assert.equal(hits, 1, '同一轮不重复下载')
    assert.match(out, /新一天的节目/)

    await new Promise(r => setTimeout(r, 5))
    served = { status: 200, body: xmlWith('再下一轮的节目') }
    const next = Date.now()
    await loadOverrideKeys({ runStartedAt: next })
    const { out: out2 } = await aggregate({ runStartedAt: next, overrideKeys: keys })
    assert.equal(hits, 2, '下一轮重新下载一次')
    assert.match(out2, /再下一轮的节目/)
  })

  await checkAsync('下载失败：沿用上次缓存，状态记失败，上次成功时间不动', async () => {
    writeSources([legacySource()])
    seedCache('外部源', 0, xmlWith('缓存里的节目'))
    served = { status: 500, body: '' }
    hits = 0
    const { result, out } = await aggregate({ runStartedAt: Date.now() })
    assert.equal(hits, 1)
    assert.equal(result.appended, 1)
    assert.match(out, /缓存里的节目/)
    const s = loadEpgConfig().sources[0]
    assert.match(s.lastStatus, /失败/)
    assert.equal(s.lastUpdated, EIGHT_HOURS_AGO)
  })

  await checkAsync('后台接口不再写入、也不再改 refreshInterval', async () => {
    writeSources([])
    const added = addEpgSourceAPI({ name: '新源', url: 'https://example.com/e.xml', refreshInterval: 60 })
    assert.equal(added.success, true)
    assert.equal('refreshInterval' in added.data.sources[0], false)
    const updated = updateEpgSourceAPI(0, { refreshInterval: 30, priority: 3 })
    assert.equal(updated.success, true)
    assert.equal('refreshInterval' in updated.data.sources[0], false)
    assert.equal(updated.data.sources[0].priority, 3)
  })
} finally {
  server.close()
}

console.log(`\n全部通过：${passed} ✅`)
