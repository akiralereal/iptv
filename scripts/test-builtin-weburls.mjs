#!/usr/bin/env node
/**
 * 内置源多抓取网址测试：候选清单归一化（webUrl + webUrls）、重试顺序（上次成功优先 +
 * 每轮上限）、远程配置变更后的抓取缓存失效判定。
 */
import assert from 'node:assert/strict'

import builtInSourceManager, {
  getWebUrlCandidates,
  orderWebUrlCandidates,
  shouldInvalidateFetchCache
} from '../utils/builtInSources.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('内置源多抓取网址测试')

check('候选清单：主地址在前，webUrls 追加在后，去重且去掉空白', () => {
  assert.deepEqual(getWebUrlCandidates({ webUrl: 'https://a.com/x.html' }), ['https://a.com/x.html'])
  assert.deepEqual(
    getWebUrlCandidates({ webUrl: 'https://a.com/x.html', webUrls: ['  https://b.com/x.html  ', 'https://a.com/x.html'] }),
    ['https://a.com/x.html', 'https://b.com/x.html']
  )
  // 只写 webUrls 也能工作（但线上旧版本只认 webUrl，配置里不该这么写）
  assert.deepEqual(getWebUrlCandidates({ webUrls: ['https://b.com/x.html'] }), ['https://b.com/x.html'])
})

check('候选清单：非 http(s) / 非字符串 / 缺配置一律剔除', () => {
  assert.deepEqual(getWebUrlCandidates({ webUrl: '', webUrls: ['', '  ', null, 42, 'ftp://a.com', '/x.html'] }), [])
  assert.deepEqual(getWebUrlCandidates({}), [])
  assert.deepEqual(getWebUrlCandidates(null), [])
})

check('重试顺序：上次抓成功的地址排最前，其余保持配置顺序', () => {
  const list = ['https://a.com', 'https://b.com', 'https://c.com']
  assert.deepEqual(orderWebUrlCandidates(list, 'https://c.com'), ['https://c.com', 'https://a.com', 'https://b.com'])
  // 没有上次成功记录、或它已从清单里移除时，回到配置顺序
  assert.deepEqual(orderWebUrlCandidates(list, undefined), list)
  assert.deepEqual(orderWebUrlCandidates(list, 'https://gone.com'), list)
})

check('重试顺序：每轮最多试 maxAttemptsPerRun 个（默认 3）', () => {
  const list = ['1', '2', '3', '4', '5'].map(n => `https://${n}.com`)
  assert.equal(orderWebUrlCandidates(list, undefined).length, 3)
  assert.deepEqual(orderWebUrlCandidates(list, undefined, 2), ['https://1.com', 'https://2.com'])
  // 非法上限退回默认，0/负数至少试一个
  assert.equal(orderWebUrlCandidates(list, undefined, 'abc').length, 3)
  assert.equal(orderWebUrlCandidates(list, undefined, 0).length, 3)
  assert.equal(orderWebUrlCandidates(list, undefined, -1).length, 1)
})

check('缓存失效：只是追加备用地址时不清缓存（别白白重抓）', () => {
  const old = { webUrl: 'https://a.com' }
  const next = { webUrl: 'https://a.com', webUrls: ['https://a.com', 'https://b.com'] }
  assert.equal(shouldInvalidateFetchCache(old, next, { m3u8Url: 'x', webUrl: 'https://a.com' }), false)
  // 升级前写的老缓存没记 webUrl：退回比对主地址
  assert.equal(shouldInvalidateFetchCache(old, next, { m3u8Url: 'x' }), false)
})

check('缓存失效：缓存所用的地址被移出清单时必须重抓', () => {
  const old = { webUrl: 'https://a.com', webUrls: ['https://a.com', 'https://b.com'] }
  const next = { webUrl: 'https://c.com', webUrls: ['https://c.com', 'https://b.com'] }
  assert.equal(shouldInvalidateFetchCache(old, next, { m3u8Url: 'x', webUrl: 'https://a.com' }), true)
  // 缓存来自 b，b 还在清单里 → 继续用
  assert.equal(shouldInvalidateFetchCache(old, next, { m3u8Url: 'x', webUrl: 'https://b.com' }), false)
  // 老缓存没记 webUrl 且主地址换了 → 重抓
  assert.equal(shouldInvalidateFetchCache(old, next, { m3u8Url: 'x' }), true)
})

check('缓存失效：没有缓存不用清；新配置一个地址都没有则清掉', () => {
  assert.equal(shouldInvalidateFetchCache({ webUrl: 'https://a.com' }, { webUrl: 'https://b.com' }, null), false)
  assert.equal(shouldInvalidateFetchCache({ webUrl: 'https://a.com' }, {}, { m3u8Url: 'x', webUrl: 'https://a.com' }), true)
})

check('远程配置更新：按上述判据逐源清缓存，只追加备胎的那个源不受影响', () => {
  const saveCache = builtInSourceManager.saveCache
  const cache = builtInSourceManager.cache
  const sources = builtInSourceManager.sources
  builtInSourceManager.saveCache = () => {}   // 单测不碰真实数据目录
  try {
    builtInSourceManager.sources = { enabled: true, sources: [
      { id: 'keep', name: '追加备胎源', mode: 'fetch', webUrl: 'https://a.com' }, // 只追加备胎
      { id: 'moved', name: '换站源', mode: 'fetch', webUrl: 'https://old.com' }, // 主地址被换掉
      { id: 'direct', mode: 'direct', m3u8Url: 'https://d.com/x.m3u8' }
    ] }
    builtInSourceManager.cache = {
      keep: { m3u8Url: 'k', webUrl: 'https://a.com' },
      moved: { m3u8Url: 'm', webUrl: 'https://old.com' },
      direct: { m3u8Url: 'd' }
    }
    builtInSourceManager.invalidateChangedFetchCaches({ sources: [
      { id: 'keep', mode: 'fetch', webUrl: 'https://a.com', webUrls: ['https://a.com', 'https://b.com'] },
      { id: 'moved', name: '换站源', mode: 'fetch', webUrl: 'https://new.com' },
      { id: 'direct', mode: 'direct', m3u8Url: 'https://d2.com/x.m3u8' }
    ] })
    assert.ok(builtInSourceManager.cache.keep, '只追加备胎不该清缓存')
    assert.equal(builtInSourceManager.cache.moved, undefined, '主地址换掉应清缓存')
    assert.ok(builtInSourceManager.cache.direct, '直连源不参与抓取缓存失效判定')
  } finally {
    builtInSourceManager.saveCache = saveCache
    builtInSourceManager.cache = cache
    builtInSourceManager.sources = sources
  }
})

console.log(`\n全部通过：${passed} 项`)
