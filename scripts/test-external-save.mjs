#!/usr/bin/env node
/**
 * 外部源整份保存不得抹掉服务端账本。
 *
 * 后台的每一次保存（编辑源 / 换序 / 导入订阅 / 抓取并保存…）都把前端那份
 * externalConfig 整个 POST 回来，而前端的 normalizeExternalConfig 只保留
 * { enabled, includeInPlaylists, updateOnStartup, sources } 四个键；
 * saveSources 又是 writeJsonFileSync 整份覆盖。于是配置里两个**前端根本不知道
 * 其存在**的服务端账本会被静默抹掉：
 *
 *   · seededBuiltInUrls —— 「哪些内置订阅已播种过」。它是 README 承诺的
 *     「已添加的可在源管理删除，删后不再复活」的唯一凭据。
 *   · retiredBuiltInsV1 —— 「退役迁移已跑过」的标记，而退役迁移会**删源**。
 *
 * 两者都是静默失败：保存成功、界面正常，坏事发生在下一次启动。所以钉在这里。
 *
 * 运行： node scripts/test-external-save.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'iptv-extsave-test-'))
process.env.mdataDir = TMP

const { ExternalSourceManager, BUILT_IN_SUBSCRIPTIONS, DEFAULT_CUSTOM_SUBSCRIPTIONS } = await import('../utils/externalSources.js')

const P = join(TMP, 'external-sources.json')
const BUILT_IN_URL = BUILT_IN_SUBSCRIPTIONS[0].subscriptionUrl
// 默认自定义订阅「来源于网络」：夹具里标成已播种，免得它在这些与它无关的场景里冒出来
const DEFAULT_URL = DEFAULT_CUSTOM_SUBSCRIPTIONS[0].source.subscriptionUrl
const RETIRED_URL = 'https://raw.githubusercontent.com/YueChan/Live/refs/heads/main/GNTV.m3u'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }

const read = () => JSON.parse(readFileSync(P, 'utf-8'))
const write = (o) => writeFileSync(P, JSON.stringify(o, null, 2))

/** 前端 normalizeExternalConfig 的等价物：只留这四个键。 */
const asFrontendCopy = (config) => ({
  enabled: true,
  includeInPlaylists: config.includeInPlaylists !== false,
  updateOnStartup: config.updateOnStartup !== false,
  sources: config.sources,
})

console.log('外部源整份保存测试')

// ---- 场景一：用户删掉内置订阅后，后台随便保存一次，重启不得让它复活 ----
check('删掉内置订阅 →（后台保存一次）→ 重启，不复活', () => {
  write({
    enabled: true, includeInPlaylists: true, updateOnStartup: true,
    sources: [{ name: '我自己的源', mode: 'direct', enabled: true, m3u8Url: 'http://x/y.m3u8', id: 'aaaa1111' }],
    seededBuiltInUrls: [BUILT_IN_URL],     // 已播种过 → 用户是"删掉"而不是"没装过"
    seededDefaultSubscriptions: [DEFAULT_URL],
    retiredBuiltInsV1: true,
  })

  const mgr = new ExternalSourceManager()
  // 后台保存：前端副本不含 seededBuiltInUrls
  mgr.saveSources(asFrontendCopy(read()))
  assert.deepEqual(read().seededBuiltInUrls, [BUILT_IN_URL], '保存把已播种账本抹掉了')

  // 重启
  const restarted = new ExternalSourceManager()
  const names = restarted.sources.sources.map(s => s.name)
  assert.ok(!names.includes('精选频道'), `已删除的内置订阅复活了：${names.join(', ')}`)
  assert.deepEqual(names, ['我自己的源'])
})

// ---- 场景二：退役标记不得被抹掉，否则退役迁移重跑会删掉用户手动加回的源 ----
check('保存不抹掉 retiredBuiltInsV1 → 用户手动加回的已退役订阅不被再删一次', () => {
  write({
    enabled: true, includeInPlaylists: true, updateOnStartup: true,
    // 用户明知它已退役，仍手动加了回来
    sources: [{ name: '我要的旧港澳源', mode: 'subscription', enabled: true, subscriptionUrl: RETIRED_URL, id: 'bbbb2222' }],
    seededBuiltInUrls: [BUILT_IN_URL],
    seededDefaultSubscriptions: [DEFAULT_URL],
    retiredBuiltInsV1: true,
  })

  const mgr = new ExternalSourceManager()
  mgr.saveSources(asFrontendCopy(read()))
  assert.equal(read().retiredBuiltInsV1, true, '保存把退役迁移标记抹掉了')

  const restarted = new ExternalSourceManager()
  const names = restarted.sources.sources.map(s => s.name)
  assert.ok(names.includes('我要的旧港澳源'), `用户手动加回的源被退役迁移删掉了：${names.join(', ')}`)
})

// ---- 边界：只补账本键，不得替调用方"补回"它有意删掉的东西 ----
// 这条才是真正守住「只补账本键、不做全量合并」的那道闸。
// 上一版把这个意思写在了下面那条用例的名字里，但那条其实**零分辨力**：
// asFrontendCopy 每次都把四个用户可见键全部显式写出，`sources[key] === undefined`
// 永远不成立，于是把实现换成「合并所有缺失键」也照样全绿（已实测）。
// 要有分辨力，调用方桩必须**省略**一个用户可见键。
check('★ 调用方省略了用户可见键时，不得用旧值补回去（否则等于全量合并）', () => {
  write({
    enabled: true, includeInPlaylists: true, updateOnStartup: true,
    sources: [{ name: 'A', mode: 'direct', enabled: true, m3u8Url: 'http://a/', id: 'aaaa0001' }],
    seededBuiltInUrls: [BUILT_IN_URL],
    seededDefaultSubscriptions: [DEFAULT_URL],
    retiredBuiltInsV1: true,
  })
  const mgr = new ExternalSourceManager()
  // 只带 sources，其余用户可见键一个不给
  mgr.saveSources({ sources: [{ name: 'A', mode: 'direct', enabled: true, m3u8Url: 'http://a/', id: 'aaaa0001' }] })

  const after = read()
  assert.equal(after.updateOnStartup, undefined,
    'updateOnStartup 被旧值补回来了 —— 说明补键逻辑退化成了全量合并')
  assert.equal(after.includeInPlaylists, undefined,
    'includeInPlaylists 被旧值补回来了 —— 说明补键逻辑退化成了全量合并')
  // 账本键仍必须补回
  assert.deepEqual(after.seededBuiltInUrls, [BUILT_IN_URL])
  assert.equal(after.retiredBuiltInsV1, true)
})

check('只补服务端账本键，sources 等字段仍以调用方为准', () => {
  write({
    enabled: true, includeInPlaylists: true, updateOnStartup: true,
    sources: [
      { name: 'A', mode: 'direct', enabled: true, m3u8Url: 'http://a/', id: 'aaaa0001' },
      { name: 'B', mode: 'direct', enabled: true, m3u8Url: 'http://b/', id: 'bbbb0002' },
    ],
    seededBuiltInUrls: [BUILT_IN_URL],
    seededDefaultSubscriptions: [DEFAULT_URL],
    retiredBuiltInsV1: true,
  })
  const mgr = new ExternalSourceManager()
  // 用户删掉了 B
  const copy = asFrontendCopy(read())
  copy.sources = copy.sources.filter(s => s.name !== 'B')
  copy.updateOnStartup = false          // 顺带改一个用户可见设置
  mgr.saveSources(copy)

  const after = read()
  assert.deepEqual(after.sources.map(s => s.name), ['A'], 'B 不该被"补"回来')
  assert.equal(after.updateOnStartup, false, '用户改的设置不该被覆盖')
  assert.deepEqual(after.seededBuiltInUrls, [BUILT_IN_URL], '账本键该保住')
})

check('调用方显式带了账本键时以调用方为准（导入配置等路径）', () => {
  write({
    enabled: true, includeInPlaylists: true, updateOnStartup: true,
    sources: [], seededBuiltInUrls: [BUILT_IN_URL], seededDefaultSubscriptions: [DEFAULT_URL], retiredBuiltInsV1: true,
  })
  const mgr = new ExternalSourceManager()
  mgr.saveSources({
    enabled: true, includeInPlaylists: true, updateOnStartup: true,
    sources: [], seededBuiltInUrls: [], retiredBuiltInsV1: true,
  })
  assert.deepEqual(read().seededBuiltInUrls, [], '显式传空数组应当被尊重，不能被旧值盖回去')
})

// ---- 默认自定义订阅「来源于网络」：新装 / 升级各播一次，作为普通自定义源出现，删了不复活 ----
const isFromTheWeb = (s) => /\/from-the-web\/from-the-web\.m3u$/.test(s.subscriptionUrl || '')

check('新装：「来源于网络」和精选频道一起出现，是普通订阅源（不是内置订阅）', () => {
  rmSync(P, { force: true })
  const mgr = new ExternalSourceManager()
  const web = mgr.sources.sources.filter(isFromTheWeb)
  assert.equal(web.length, 1)
  assert.equal(web[0].name, '来源于网络')
  assert.equal(web[0].mode, 'subscription')
  assert.ok(web[0].id, '要有稳定 id，配置档才能按源筛')
  assert.deepEqual(read().seededDefaultSubscriptions, [DEFAULT_URL])
})

check('升级：老配置里没有 → 补一次，排在最后', () => {
  write({
    enabled: true, includeInPlaylists: true, updateOnStartup: true,
    sources: [{ name: '我自己的源', mode: 'direct', enabled: true, m3u8Url: 'http://x/y.m3u8', id: 'aaaa1111' }],
    seededBuiltInUrls: [BUILT_IN_URL], retiredBuiltInsV1: true,
  })
  const names = new ExternalSourceManager().sources.sources.map(s => s.name)
  assert.deepEqual(names, ['我自己的源', '来源于网络'])
})

check('升级：自己加过（任何写法）→ 只记账，不重复加', () => {
  write({
    enabled: true, includeInPlaylists: true, updateOnStartup: true,
    sources: [{ name: '海外', mode: 'subscription', enabled: true, id: 'cccc3333',
      subscriptionUrl: 'https://raw.githubusercontent.com/akiralereal/iptv/refs/heads/main/from-the-web/from-the-web.m3u' }],
    seededBuiltInUrls: [BUILT_IN_URL], retiredBuiltInsV1: true,
  })
  new ExternalSourceManager()
  const after = read()
  assert.deepEqual(after.sources.map(s => s.name), ['海外'], '用户改过名的那条要保留，不能再多一条')
  assert.deepEqual(after.seededDefaultSubscriptions, [DEFAULT_URL])
})

check('删掉「来源于网络」→ 后台保存一次 → 重启，不复活', () => {
  rmSync(P, { force: true })
  const mgr = new ExternalSourceManager()
  const copy = asFrontendCopy(read())
  copy.sources = copy.sources.filter(s => !isFromTheWeb(s))
  mgr.saveSources(copy)
  assert.deepEqual(read().seededDefaultSubscriptions, [DEFAULT_URL], '保存把账本抹掉了')
  const names = new ExternalSourceManager().sources.sources.map(s => s.name)
  assert.ok(!names.includes('来源于网络'), `删掉的复活了：${names.join(', ')}`)
})

rmSync(TMP, { recursive: true, force: true })
console.log(`全部通过：${passed}/${passed} ✅`)
