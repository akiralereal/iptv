#!/usr/bin/env node
/**
 * 源刷新的「内容到底变没变」判定（issue #222）。
 *
 * 5 分钟一轮的源检查此前只要有源「刷新成功」就重写一遍播放列表：广西每 30 分钟、
 * 一批 4 小时周期的模块到点就各重写一次一字未变的列表，每次五十多行日志；远程内置源
 * 配置每 5 分钟拉一次，没变也打一行「已更新」。用户看到的就是「一直在更新」。
 *
 * 不变量：
 *  1) hasChangedResult —— 只有「成功且内容变了」才触发重新生成；没标 changed 的按变了算。
 *  2) 抓取模块 / 内置源 / 外部源刷新结果里的 changed 如实反映输出有没有变。
 *  3) 远程内置源配置没变时不写盘、不打「已更新」。
 *
 * 运行： node scripts/test-refresh-change-detect.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'iptv-change-detect-'))
process.env.mdataDir = TMP
// 远程地址保持默认（非空），否则 refreshRemoteConfig 直接返回、测不到；拉取本身会被桩掉，不联网
delete process.env.mbuiltInSourcesUrl

const { hasChangedResult } = await import('../utils/channelMerger.js')
const { ExternalSourceManager, BUILT_IN_SUBSCRIPTIONS } = await import('../utils/externalSources.js')
const { default: builtInSourceManager } = await import('../utils/builtInSources.js')

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

/** 跑 fn，期间收集 console.log 输出（printGreen 等都走它） */
async function captureLogs(fn) {
  const lines = []
  const orig = console.log
  console.log = (...args) => { lines.push(args.join(' ')) }
  try {
    await fn()
  } finally {
    console.log = orig
  }
  return lines
}

console.log('源刷新变化判定测试 (issue #222)')

try {
  check('hasChangedResult：只有成功且内容变了才算', () => {
    assert.equal(hasChangedResult(undefined), false)
    assert.equal(hasChangedResult({ success: true, message: '无需更新' }), false)
    assert.equal(hasChangedResult({ results: [] }), false)
    assert.equal(hasChangedResult({ results: [{ success: true, changed: false }] }), false,
      '刷新成功但内容没变，不该重写播放列表')
    assert.equal(hasChangedResult({ results: [{ success: false, changed: true }] }), false,
      '失败的刷新不触发重新生成')
    assert.equal(hasChangedResult({ results: [{ success: true, changed: false }, { success: true, changed: true }] }), true)
  })

  check('hasChangedResult：没标 changed 的成功结果按「变了」算（宁可多生成，不漏新地址）', () => {
    assert.equal(hasChangedResult({ results: [{ success: true }] }), true)
  })

  // ---- 外部源 ----
  await checkAsync('外部源：抓回同一个地址 → changed:false；换了地址 → changed:true', async () => {
    writeFileSync(join(TMP, 'external-sources.json'), JSON.stringify({
      enabled: true, includeInPlaylists: true, updateOnStartup: true,
      sources: [{ id: 'aaaa1111', name: '测试台', group: '测试', mode: 'fetch', enabled: true,
        webUrl: 'https://example.com/live.html', m3u8Url: 'https://cdn/a.m3u8' }],
      seededBuiltInUrls: BUILT_IN_SUBSCRIPTIONS.map(s => s.subscriptionUrl),
      retiredBuiltInsV1: true,
    }))
    const mgr = new ExternalSourceManager()
    let next = 'https://cdn/a.m3u8'
    // 桩掉真正的网页抓取（要起 Chromium），只模拟它写回 m3u8Url
    mgr.updateSource = async (index) => {
      mgr.sources.sources[index].m3u8Url = next
      return { success: true, m3u8Url: next }
    }
    const same = await mgr.updateAllSources({ forceAll: true })
    assert.equal(same.length, 1)
    assert.equal(same[0].changed, false, '地址没变')

    next = 'https://cdn/b.m3u8'
    const moved = await mgr.updateAllSources({ forceAll: true })
    assert.equal(moved[0].changed, true, '地址换了')
  })

  await checkAsync('外部源：订阅内容没变 → changed:false；多了频道 → changed:true', async () => {
    writeFileSync(join(TMP, 'external-sources.json'), JSON.stringify({
      enabled: true, includeInPlaylists: true, updateOnStartup: true,
      sources: [{ id: 'bbbb2222', name: '订阅', group: '订阅', mode: 'subscription', enabled: true,
        subscriptionUrl: 'https://example.com/a.m3u',
        parsedChannels: [{ name: 'A', url: 'https://cdn/a.m3u8', group: '订阅' }] }],
      seededBuiltInUrls: BUILT_IN_SUBSCRIPTIONS.map(s => s.subscriptionUrl),
      retiredBuiltInsV1: true,
    }))
    const mgr = new ExternalSourceManager()
    let channels = [{ name: 'A', url: 'https://cdn/a.m3u8', group: '订阅' }]
    mgr.updateSource = async (index) => {
      // 真实路径是整份换成新解析出来的数组（新对象），内容相同也该判为没变
      mgr.sources.sources[index].parsedChannels = channels.map(c => ({ ...c }))
      return { success: true, channelCount: channels.length }
    }
    assert.equal((await mgr.updateAllSources({ forceAll: true }))[0].changed, false)

    channels = [...channels, { name: 'B', url: 'https://cdn/b.m3u8', group: '订阅' }]
    assert.equal((await mgr.updateAllSources({ forceAll: true }))[0].changed, true)
  })

  // ---- 内置源 ----
  await checkAsync('内置源：抓回的直播地址和缓存一样 → changed:false；首次 / 换了 → changed:true', async () => {
    const saved = {
      refreshRemoteConfig: builtInSourceManager.refreshRemoteConfig,
      extractWithFallback: builtInSourceManager.extractWithFallback,
      saveCache: builtInSourceManager.saveCache,
      sources: builtInSourceManager.sources,
      cache: builtInSourceManager.cache,
    }
    let next = 'https://hls/live.m3u8?sign=1'
    builtInSourceManager.refreshRemoteConfig = async () => {}
    builtInSourceManager.saveCache = () => {}
    builtInSourceManager.extractWithFallback = async () => ({ m3u8Url: next, webUrl: 'https://a.com/w.html' })
    builtInSourceManager.sources = { enabled: true, sources: [
      { id: 'vl', name: '测试源', group: '体育', mode: 'fetch', enabled: true, webUrl: 'https://a.com/w.html' },
    ] }
    builtInSourceManager.cache = {}
    try {
      const first = await builtInSourceManager.runFetchSources({ forceAll: true })
      assert.equal(first.results[0].changed, true, '之前没缓存，抓到就是新内容')

      const second = await builtInSourceManager.runFetchSources({ forceAll: true })
      assert.equal(second.results[0].success, true)
      assert.equal(second.results[0].changed, false, '纬来体育这类源的地址多日不变，不该每小时重写播放列表')

      next = 'https://hls/live.m3u8?sign=2'
      const third = await builtInSourceManager.runFetchSources({ forceAll: true })
      assert.equal(third.results[0].changed, true)
    } finally {
      Object.assign(builtInSourceManager, saved)
    }
  })

  await checkAsync('远程内置源配置没变：不写盘、不打「已更新」；变了才写、才打', async () => {
    const saved = {
      fetchRemoteText: builtInSourceManager.fetchRemoteText,
      remoteConfigPath: builtInSourceManager.remoteConfigPath,
      sources: builtInSourceManager.sources,
    }
    const config = { enabled: true, sources: [
      { id: 'd1', name: '直连台', group: '测试', mode: 'direct', enabled: true, m3u8Url: 'https://cdn/d.m3u8' },
    ] }
    let remote = JSON.stringify(config, null, 2) // 远程文件带缩进：比的是内容，不是原文
    builtInSourceManager.fetchRemoteText = async () => remote
    builtInSourceManager.remoteConfigPath = join(TMP, 'built-in-sources-remote-test.json')
    builtInSourceManager.sources = JSON.parse(JSON.stringify(config))
    try {
      const quiet = await captureLogs(() => builtInSourceManager.refreshRemoteConfig())
      assert.deepEqual(quiet, [], `没变时不该有任何日志，实际：${quiet.join(' | ')}`)
      assert.equal(existsSync(builtInSourceManager.remoteConfigPath), false, '没变时不该写缓存文件')

      remote = JSON.stringify({ ...config, sources: [...config.sources,
        { id: 'd2', name: '新台', group: '测试', mode: 'direct', enabled: true, m3u8Url: 'https://cdn/e.m3u8' }] })
      const loud = await captureLogs(() => builtInSourceManager.refreshRemoteConfig())
      assert.ok(loud.some(line => line.includes('内置源远程配置已更新: 2 个源')), `变了要打日志，实际：${loud.join(' | ')}`)
      assert.equal(existsSync(builtInSourceManager.remoteConfigPath), true, '变了要写缓存文件')
      assert.equal(builtInSourceManager.sources.sources.length, 2, '新配置要生效')
    } finally {
      Object.assign(builtInSourceManager, saved)
    }
  })
} finally {
  rmSync(TMP, { recursive: true, force: true })
}

console.log(`\n全部通过：${passed} 项`)
