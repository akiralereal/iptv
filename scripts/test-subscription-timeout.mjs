#!/usr/bin/env node
/**
 * 订阅拉取的超时与重试（issue #195 / #223）。
 *
 * 背景：
 *  - #195：原来 15 秒超时在拿到响应头后就清掉了。订阅服务器发完头、正文发一半停住时，
 *    这次拉取永远挂着；5 分钟一轮的源刷新有防重入锁，这一轮不结束，之后每轮都
 *    「上一轮源刷新检查尚未结束，跳过本次」——内置源、外部源、抓取模块的自动刷新全停。
 *  - #223：超时固定 15 秒、失败不重试，慢订阅拉不下来；有缓存时失败一次要等半个刷新间隔
 *   （默认 12 小时）才重拉。订阅源设置里加了 fetchTimeout（秒）/ fetchRetries。
 *
 * 不变量：
 *  - 正文中途停住：到点按「请求超时」失败，不挂住；
 *  - 正常订阅（正文慢慢发完、总时长在超时内）照常解析成功；
 *  - 不设重试时行为与改动前一致：失败一次就失败；
 *  - 只有可能下次就好的失败（超时、断连、5xx/429）才重试；404、解析不出频道不重试；
 *  - 重试次数、超时有上下限，乱填按默认，不会让一个源无限期拖住刷新；
 *  - 订阅失败后按 10、20、40…分钟递增退避（与网页抓取源同一张内存表），最长到刷新间隔，成功后清零；
 *    不改写 lastUpdated（后台卡片把它当「上次更新」显示），失败原因 / 下次重试时间走 fetchStatus 给卡片；
 *  - 超时提示按地址分：GitHub raw 只建议调超时，内置订阅不提示。
 *
 * 运行： node scripts/test-subscription-timeout.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'iptv-sub-timeout-test-'))
process.env.mdataDir = TMP

const { fetchAndParseM3u, subscriptionFetchOptions, subscriptionFailureHint, SUBSCRIPTION_FETCH_LIMITS,
  ExternalSourceManager, BUILT_IN_SUBSCRIPTIONS } = await import('../utils/externalSources.js')

const HEAD = '#EXTM3U\n#EXTINF:-1 group-title="测试",甲台\nhttp://127.0.0.1/a.m3u8\n'
const TAIL = '#EXTINF:-1 group-title="测试",乙台\nhttp://127.0.0.1/b.m3u8\n'

// 每个路径各自计数：/flaky/<key>/<n> 前 n 次 503；/stall-once/<key> 第一次停住；
// /always503/<key> 永远 503；/missing/<key> 404；/garbage/<key> 200 但不是播放列表
const hits = new Map()
const hitsOf = (path) => hits.get(path) || 0

const sockets = new Set()
const server = http.createServer((req, res) => {
  const path = req.url
  const n = hitsOf(path) + 1
  hits.set(path, n)
  const [, kind, , arg] = path.split('/')

  if (kind === 'flaky' && n <= Number(arg)) { res.writeHead(503); res.end('busy'); return }
  if (kind === 'always503') { res.writeHead(503); res.end('busy'); return }
  if (kind === 'missing') { res.writeHead(404); res.end('not found'); return }
  if (kind === 'garbage') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>hello</html>'); return }

  res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' })
  if (path === '/stall.m3u' || (kind === 'stall-once' && n === 1)) {
    res.write(HEAD) // 发了头和一部分正文就停住，不 end
    return
  }
  if (path === '/slow.m3u') {
    res.write(HEAD)
    setTimeout(() => res.end(TAIL), 300)
    return
  }
  res.end(HEAD + TAIL)
})
server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
await new Promise(r => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`

let passed = 0
const check = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

/** 给被测调用再套一层硬上限：修复前它会永远 pending，测试不能跟着挂住。结束后清掉计时器，免得拖住进程退出 */
const within = (promise, ms) => {
  let timer
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`超过 ${ms}ms 仍未结束（拉取被挂住）`)), ms)
  })
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}

// 测试里把重试前的等待压到几毫秒
const FAST = { retryDelayMs: 5 }

try {
  console.log('订阅拉取超时与重试（issue #195 / #223）')

  await check('正文中途停住：按超时失败，不挂住', async () => {
    const started = Date.now()
    await assert.rejects(
      within(fetchAndParseM3u(`${BASE}/stall.m3u`, { timeoutMs: 500 }), 5000),
      err => {
        assert.match(err.message, /请求超时/)
        assert.equal(err.timedOut, true)
        return true
      },
    )
    assert.ok(Date.now() - started < 3000, '应在超时附近结束')
  })

  await check('正文慢慢发完（在超时内）：照常解析', async () => {
    const channels = await within(fetchAndParseM3u(`${BASE}/slow.m3u`, { timeoutMs: 2000 }), 5000)
    assert.equal(channels.length, 2)
  })

  await check('正常订阅：不受影响', async () => {
    const channels = await within(fetchAndParseM3u(`${BASE}/ok.m3u`), 5000)
    assert.deepEqual(channels.map(c => c.name), ['甲台', '乙台'])
  })

  await check('不设重试：与改动前一致，503 一次就失败', async () => {
    await assert.rejects(fetchAndParseM3u(`${BASE}/flaky/a/1`), err => {
      assert.match(err.message, /HTTP 503/)
      assert.equal(err.timedOut, false)
      return true
    })
    assert.equal(hitsOf('/flaky/a/1'), 1)
  })

  await check('5xx 后重试：第三次拉到', async () => {
    const channels = await within(fetchAndParseM3u(`${BASE}/flaky/b/2`, { retries: 2, ...FAST }), 5000)
    assert.equal(channels.length, 2)
    assert.equal(hitsOf('/flaky/b/2'), 3)
  })

  await check('超时后重试：第二次拉到', async () => {
    const channels = await within(fetchAndParseM3u(`${BASE}/stall-once/c`, { timeoutMs: 300, retries: 1, ...FAST }), 5000)
    assert.equal(channels.length, 2)
    assert.equal(hitsOf('/stall-once/c'), 2)
  })

  await check('404、解析不出频道：重试也没用，只请求一次', async () => {
    await assert.rejects(fetchAndParseM3u(`${BASE}/missing/d`, { retries: 3, ...FAST }), /HTTP 404/)
    assert.equal(hitsOf('/missing/d'), 1)
    await assert.rejects(fetchAndParseM3u(`${BASE}/garbage/e`, { retries: 3, ...FAST }), /解析出任何频道/)
    assert.equal(hitsOf('/garbage/e'), 1)
  })

  await check('重试次数有上限：填 99 也最多重试 3 次，乱填按不重试', async () => {
    await assert.rejects(fetchAndParseM3u(`${BASE}/always503/f`, { retries: 99, ...FAST }), /第 4 次 HTTP 503/)
    assert.equal(hitsOf('/always503/f'), 1 + SUBSCRIPTION_FETCH_LIMITS.retries.max)
    await assert.rejects(fetchAndParseM3u(`${BASE}/always503/g`, { retries: 'abc', ...FAST }), /HTTP 503/)
    assert.equal(hitsOf('/always503/g'), 1)
  })

  await check('源设置换算：超时按秒、夹到 5–120，重试夹到 0–3，留空/乱填用默认', () => {
    assert.deepEqual(subscriptionFetchOptions({}), { userAgent: undefined, timeoutMs: 15000, retries: 0 })
    assert.deepEqual(subscriptionFetchOptions({ fetchTimeout: 45, fetchRetries: 2, userAgent: 'UA/1' }),
      { userAgent: 'UA/1', timeoutMs: 45000, retries: 2 })
    assert.equal(subscriptionFetchOptions({ fetchTimeout: '30' }).timeoutMs, 30000)
    assert.equal(subscriptionFetchOptions({ fetchTimeout: 1 }).timeoutMs, 5000)
    assert.equal(subscriptionFetchOptions({ fetchTimeout: 9999 }).timeoutMs, 120000)
    assert.equal(subscriptionFetchOptions({ fetchTimeout: 'abc' }).timeoutMs, 15000)
    assert.equal(subscriptionFetchOptions({ fetchTimeout: null }).timeoutMs, 15000)
    assert.equal(subscriptionFetchOptions({ fetchRetries: -1 }).retries, 0)
    assert.equal(subscriptionFetchOptions({ fetchRetries: 1.6 }).retries, 2)
    assert.equal(subscriptionFetchOptions({ fetchRetries: 10 }).retries, 3)
  })

  // ---- 走管理器：源设置里的重试生效；失败退避 ----
  const CACHED = [{ name: '旧台', url: 'http://127.0.0.1/old.m3u8', group: '测试' }]
  writeFileSync(join(TMP, 'external-sources.json'), JSON.stringify({
    enabled: true, includeInPlaylists: true, updateOnStartup: true,
    sources: [
      { id: 'retry001', name: '重试订阅', mode: 'subscription', enabled: true,
        subscriptionUrl: `${BASE}/flaky/m/1`, fetchRetries: 1 },
      { id: 'cache001', name: '有缓存订阅', mode: 'subscription', enabled: true,
        subscriptionUrl: `${BASE}/missing/n`, refreshInterval: 1440, parsedChannels: CACHED },
      { id: 'cache002', name: '短间隔订阅', mode: 'subscription', enabled: true,
        subscriptionUrl: `${BASE}/missing/o`, refreshInterval: 60, parsedChannels: CACHED },
      { id: 'slow0001', name: '慢订阅', mode: 'subscription', enabled: true,
        subscriptionUrl: `${BASE}/stall-once/p`, fetchTimeout: 5 },
    ],
  }))
  const mgr = new ExternalSourceManager()
  const indexOf = (id) => mgr.sources.sources.findIndex(s => s && s.id === id)
  const byId = (id) => mgr.sources.sources[indexOf(id)]
  const backoffOf = (id) => mgr.fetchBackoff.get(mgr.backoffKey(byId(id)))

  await check('管理器：用源里填的重试次数拉订阅', async () => {
    const r = await within(mgr.updateSubscriptionSource(indexOf('retry001')), 10000)
    assert.equal(r.success, true, r.message)
    assert.equal(byId('retry001').parsedChannels.length, 2)
    assert.equal(hitsOf('/flaky/m/1'), 2)
  })

  await check('有缓存时失败：保留旧频道、不动「上次更新」，按 10、20 分钟递增退避，卡片能看到失败原因', async () => {
    const before = byId('cache001').lastUpdated
    const r1 = await mgr.updateSubscriptionSource(indexOf('cache001'))
    assert.equal(r1.success, false)
    assert.deepEqual(byId('cache001').parsedChannels, CACHED)
    assert.equal(byId('cache001').lastUpdated, before, '失败不能改写上次更新时间：后台卡片直接显示它')
    assert.equal(byId('cache001')._failCount, undefined, '退避记在内存，不再落盘')
    assert.equal(backoffOf('cache001').count, 1)
    assert.equal(backoffOf('cache001').waitMinutes, 10)
    assert.equal(mgr.needsRefresh(byId('cache001')), false, '退避窗口内不重拉')

    await mgr.updateSubscriptionSource(indexOf('cache001'))
    assert.equal(backoffOf('cache001').count, 2)
    assert.equal(backoffOf('cache001').waitMinutes, 20)
    const status = mgr.fetchStatus()
    assert.equal(status.cache001.failCount, 2)
    assert.match(status.cache001.lastError, /HTTP 404/)
    assert.ok(new Date(status.cache001.nextRetryAt).getTime() > Date.now())
  })

  await check('退避最长到刷新间隔；拉成功后清零，卡片不再显示失败', async () => {
    for (let i = 0; i < 4; i++) await mgr.updateSubscriptionSource(indexOf('cache002'))
    assert.equal(backoffOf('cache002').waitMinutes, 60, '60 分钟间隔：10、20、40 之后封顶 60')

    byId('cache002').subscriptionUrl = `${BASE}/ok.m3u`
    const r = await mgr.updateSubscriptionSource(indexOf('cache002'))
    assert.equal(r.success, true, r.message)
    assert.equal(backoffOf('cache002'), null)
    assert.equal(mgr.fetchStatus().cache002, undefined)
    assert.equal(byId('cache002')._failCount, undefined)
  })

  await check('提示按地址分：GitHub raw 只建议调超时、内置订阅不提示、超时到顶不提示', async () => {
    const opts = { timeoutMs: 15000, retries: 0 }
    const timeout = Object.assign(new Error('x'), { timedOut: true })
    assert.match(subscriptionFailureHint(timeout, opts, { subscriptionUrl: 'https://example.com/a.m3u' }), /「拉取超时」或「失败重试」/)
    const mirrored = Object.assign(new Error('x'), { timedOut: true, mirrored: true })
    const hint = subscriptionFailureHint(mirrored, opts, { subscriptionUrl: 'https://raw.githubusercontent.com/a/b/c.m3u' })
    assert.match(hint, /5 条线路/)
    assert.doesNotMatch(hint, /或「失败重试」/)
    assert.equal(subscriptionFailureHint(timeout, opts, { subscriptionUrl: BUILT_IN_SUBSCRIPTIONS[0].subscriptionUrl }), '', '精选频道后台没有卡片，不提示')
    assert.equal(subscriptionFailureHint(timeout, { timeoutMs: 120000, retries: 0 }, { subscriptionUrl: 'https://example.com/a.m3u' }), '')
    assert.equal(subscriptionFailureHint(Object.assign(new Error('x'), { timedOut: false }), opts, {}), '')
  })

  await check('超时失败：提示可以调大「拉取超时」', async () => {
    const r = await within(mgr.updateSubscriptionSource(indexOf('slow0001')), 15000)
    assert.equal(r.success, false)
    assert.match(r.message, /请求超时/)
    assert.match(r.message, /调大「拉取超时」/)
    // 404 这类不是超时的失败不给这个提示
    const r404 = await mgr.updateSubscriptionSource(indexOf('cache001'))
    assert.doesNotMatch(r404.message, /拉取超时/)
  })

  console.log(`\n全部通过：${passed} 项`)
} finally {
  for (const s of sockets) s.destroy()
  server.close()
  rmSync(TMP, { recursive: true, force: true })
}
