#!/usr/bin/env node
/**
 * 提醒中心（utils/alerts.js）回归测试。
 *
 * 判断「哪些算提醒」从 admin.html 挪到了服务端，后台页只拉 /api/alerts 显示。这里钉住：
 *  1. collectAlerts 与原前端判断逐条一致（关掉的模块不报、凭证失效优先于抓取失败、
 *     EPG 停用老源 / 失败、没设密码只在有一人一源用户时报、配置损坏、error 排在前面）；
 *  2. AlertTracker 只在状态变化时报事件：同一条不重复报、换措辞不算新事件、重启不重报；
 *  3. 模块类提醒要有证据才算恢复（关了模块、换了配置、之后又抓过一轮），
 *     重启后内存里的「播放时发现凭证被拒」暂时看不到时不能误报「已恢复」；
 *  4. ExtractorManager#alertSnapshot 和后台卡片（getState）对凭证失效的判断一致。
 *
 * 运行： node scripts/test-alerts.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DATA_DIR = mkdtempSync(join(tmpdir(), 'iptv-alerts-'))
process.env.mdataDir = DATA_DIR
const { collectAlerts, publicAlert, AlertTracker } = await import('../utils/alerts.js')

let passed = 0
async function test(name, fn) {
  await fn()
  passed++
  console.log(`  ✓ ${name}`)
}

const mod = (id, health = {}, extra = {}) => ({
  id, name: id.toUpperCase(), category: 'standard', enabled: true, configKey: 'k1',
  health: { status: 'ok', lastError: '', lastAttemptAt: 0, channelCount: 0, usingCachedChannels: false, credentialRejected: '', ...health },
  ...extra,
})
const ids = alerts => alerts.map(a => a.id)

console.log('提醒中心回归测试')

// ── 1. collectAlerts 与原前端判断一致 ───────────────────────────────────────
await test('关掉的模块不报；凭证失效优先于抓取失败', () => {
  const alerts = collectAlerts({ extractors: { corrupt: null, modules: [
    mod('off', { status: 'failed', credentialRejected: '坏了' }, { enabled: false }),
    mod('both', { status: 'failed', credentialRejected: 'Token 被拒' }),
  ] } })
  assert.deepEqual(ids(alerts), ['module-credential:both'])
  assert.equal(alerts[0].title, 'BOTH登录凭证已失效')
  assert.equal(alerts[0].text, 'Token 被拒')
  assert.deepEqual(alerts[0].target, { kind: 'module', moduleId: 'both' })
})

await test('抓取失败 / 被风控：标题区分，沿用缓存时写明频道数', () => {
  const alerts = collectAlerts({ extractors: { corrupt: null, modules: [
    mod('a', { status: 'failed', lastError: '超时', usingCachedChannels: true, channelCount: 16 }),
    mod('b', { status: 'risk' }),
    mod('c', { status: 'empty' }),
  ] } })
  assert.deepEqual(ids(alerts), ['module-failed:a', 'module-failed:b'])
  assert.equal(alerts[0].title, 'A抓取失败')
  assert.match(alerts[0].text, /^超时；暂时沿用上次抓到的 16 个频道。会自动重试/)
  assert.equal(alerts[1].title, 'B被风控')
  assert.match(alerts[1].text, /^最近一次抓取没有成功。/)
})

await test('EPG：聚合关闭不报；停用老源是 warning；失败是 error；单源关闭不报', () => {
  const legacy = ['https://e.erw.cc/all.xml.gz']
  const sources = [
    { name: '老源', url: ' https://e.erw.cc/all.xml.gz ' },
    { name: '坏源', url: 'https://x/e.xml', lastStatus: '失败: HTTP 404' },
    { name: '关掉的', url: 'https://y/e.xml', enabled: false, lastStatus: '失败: x' },
    { name: '好源', url: 'https://z/e.xml', lastStatus: 'ok' },
  ]
  assert.deepEqual(collectAlerts({ epg: { enabled: false, sources }, epgLegacyUrls: legacy }), [])
  const alerts = collectAlerts({ epg: { enabled: true, sources }, epgLegacyUrls: legacy })
  // error 排在 warning 前面
  assert.deepEqual(ids(alerts), ['epg-failed:https://x/e.xml', 'epg-legacy:https://e.erw.cc/all.xml.gz'])
  assert.equal(alerts[0].text, '失败: HTTP 404')
  assert.equal(alerts[1].level, 'warning')
  assert.deepEqual(alerts[1].target, { kind: 'epg' })
})

await test('没设访问密码只在已有一人一源用户时报', () => {
  assert.deepEqual(collectAlerts({ passSet: false, userCount: 0 }), [])
  assert.deepEqual(collectAlerts({ passSet: true, userCount: 3 }), [])
  const alerts = collectAlerts({ passSet: false, userCount: 1 })
  assert.deepEqual(ids(alerts), ['users-no-pass'])
  assert.deepEqual(alerts[0].target, { kind: 'password' })
})

await test('配置损坏排第一；同级保持收集顺序', () => {
  const alerts = collectAlerts({
    extractors: { corrupt: { message: 'x' }, modules: [mod('a', { status: 'failed' }), mod('b', { credentialRejected: 'y' })] },
    passSet: false, userCount: 1,
  })
  assert.deepEqual(ids(alerts), ['extractors-corrupt', 'module-failed:a', 'module-credential:b', 'users-no-pass'])
})

await test('给后台的形态不带 configKey', () => {
  const [alert] = collectAlerts({ extractors: { corrupt: null, modules: [mod('a', { credentialRejected: 'y' })] } })
  assert.equal(alert.configKey, 'k1')
  assert.equal('configKey' in publicAlert(alert), false)
})

// ── 2/3. AlertTracker 状态变化 ─────────────────────────────────────────────
function makeTracker(statePath, state) {
  let clock = 1000
  const tracker = new AlertTracker({ statePath, gather: async () => state.inputs, now: () => clock, log: false })
  const events = []
  tracker.onChange(event => events.push(event))
  return { tracker, events, tick: (ms = 60_000) => { clock += ms } }
}

await test('第一次运行标 initial；同一条只报一次；换措辞不算新事件', async () => {
  const statePath = join(DATA_DIR, 'state-1.json')
  const state = { inputs: { extractors: { corrupt: null, modules: [mod('a', { status: 'failed', lastError: 'e1' })] } } }
  const { tracker, events, tick } = makeTracker(statePath, state)
  await tracker.evaluate()
  assert.equal(events.length, 1)
  assert.equal(events[0].initial, true)
  assert.deepEqual(events[0].raised.map(a => a.id), ['module-failed:a'])
  assert.equal('configKey' in events[0].raised[0], false)
  tick()
  state.inputs.extractors.modules[0].health.lastError = 'e2'
  await tracker.evaluate()
  assert.equal(events.length, 1, '措辞变了不发新事件')
  assert.match(JSON.parse(readFileSync(statePath, 'utf-8')).active['module-failed:a'].text, /^e2/)
  assert.equal(tracker.list()[0].text.startsWith('e2'), true)
})

await test('重启后（新实例读状态文件）不重报，也不标 initial', async () => {
  const statePath = join(DATA_DIR, 'state-2.json')
  const state = { inputs: { passSet: false, userCount: 1 } }
  await makeTracker(statePath, state).tracker.evaluate()
  const second = makeTracker(statePath, state)
  await second.tracker.evaluate()
  assert.equal(second.events.length, 0)
  state.inputs.passSet = true
  await second.tracker.evaluate()
  assert.equal(second.events.length, 1)
  assert.equal(second.events[0].initial, false)
  assert.deepEqual(second.events[0].resolved.map(a => a.id), ['users-no-pass'], '非模块提醒消失即恢复')
})

await test('模块提醒消失但没有证据（重启后内存结论丢了）：不算恢复', async () => {
  const statePath = join(DATA_DIR, 'state-3.json')
  const m = mod('migu', { credentialRejected: 'Token 被拒', lastAttemptAt: 500 })
  const state = { inputs: { extractors: { corrupt: null, modules: [m] } } }
  await makeTracker(statePath, state).tracker.evaluate()   // since = 1000
  // 模拟重启：内存里的「播放时被拒」没了，但模块还没重新抓过、配置也没换
  const restarted = makeTracker(statePath, state)
  m.health.credentialRejected = ''
  await restarted.tracker.evaluate()
  assert.equal(restarted.events.length, 0, '不能误报已恢复')
  assert.deepEqual(restarted.tracker.list(), [], '后台显示照当前结论（与原先一致）')
  assert.ok(JSON.parse(readFileSync(statePath, 'utf-8')).active['module-credential:migu'], '仍记为未恢复')
  // 又抓过一轮、检查通过 → 恢复
  m.health.lastAttemptAt = 5000
  await restarted.tracker.evaluate()
  assert.deepEqual(restarted.events.map(e => e.resolved.map(a => a.id)), [['module-credential:migu']])
})

await test('换了凭证（生效配置摘要变了）或关掉模块：立即算恢复', async () => {
  const statePath = join(DATA_DIR, 'state-4.json')
  const a = mod('a', { credentialRejected: 'x' })
  const b = mod('b', { status: 'failed' })
  const state = { inputs: { extractors: { corrupt: null, modules: [a, b] } } }
  const { tracker, events } = makeTracker(statePath, state)
  await tracker.evaluate()
  a.health.credentialRejected = ''
  a.configKey = 'k2'
  b.enabled = false
  await tracker.evaluate()
  assert.deepEqual(events[1].resolved.map(r => r.id).sort(), ['module-credential:a', 'module-failed:b'])
  assert.equal(events[1].resolved[0].since, 1000)
})

await test('恢复后再出现：重新报一次', async () => {
  const statePath = join(DATA_DIR, 'state-5.json')
  const state = { inputs: { passSet: false, userCount: 1 } }
  const { tracker, events } = makeTracker(statePath, state)
  await tracker.evaluate()
  state.inputs.userCount = 0
  await tracker.evaluate()
  state.inputs.userCount = 2
  await tracker.evaluate()
  assert.deepEqual(events.map(e => [e.raised.length, e.resolved.length]), [[1, 0], [0, 1], [1, 0]])
})

await test('订阅方抛错不影响评估与其他订阅方；并发评估合并成一轮', async () => {
  const statePath = join(DATA_DIR, 'state-6.json')
  let gathers = 0
  const tracker = new AlertTracker({ statePath, log: false, gather: async () => { gathers++; return { passSet: false, userCount: 1 } } })
  const seen = []
  tracker.onChange(() => { throw new Error('boom') })
  tracker.onChange(event => seen.push(event))
  const [r1, r2] = await Promise.all([tracker.evaluate(), tracker.evaluate()])
  assert.equal(gathers, 1)
  assert.equal(r1, r2)
  assert.equal(seen.length, 1)
})

// ── 4. 与后台卡片同一口径（真实 ExtractorManager） ─────────────────────────
await test('alertSnapshot 与 getState 对凭证失效的判断一致（央视频失效记录）', async () => {
  const { runtime } = await import('../extractors/yangshipin/runtime.js')
  const { ExtractorManager } = await import('../utils/extractorManager.js')
  runtime.loginLink.remember({ authenticated: true, account: { nickname: '测试', vip: true } })
  runtime.loginLink.remember({ authenticated: false, account: null })
  const manager = new ExtractorManager().load()
  const card = manager.getState().modules.find(m => m.id === 'yangshipin')
  const snap = manager.alertSnapshot().modules.find(m => m.id === 'yangshipin')
  assert.ok(card.health.credentialRejected, '前提：后台卡片显示失效')
  assert.equal(snap.health.credentialRejected, card.health.credentialRejected)
  assert.equal(snap.enabled, card.enabled)
  assert.match(snap.configKey, /^[0-9a-f]{16}$/)
  const alerts = collectAlerts({ extractors: manager.alertSnapshot() })
  assert.ok(alerts.some(a => a.id === 'module-credential:yangshipin'))
  // 快照不带配置和频道名单（只给提醒用，轻量）
  assert.equal('config' in snap, false)
  assert.equal('channelGroups' in snap, false)
})

rmSync(DATA_DIR, { recursive: true, force: true })
assert.equal(existsSync(DATA_DIR), false)
console.log(`\n全部 ${passed} 项通过`)
