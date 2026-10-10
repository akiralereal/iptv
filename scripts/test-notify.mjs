#!/usr/bin/env node
/**
 * 消息推送（utils/notify.js）回归测试。
 *
 * 钉住作者定的规则：
 *  1. 升级后第一次运行就已存在的提醒是老问题：不推，它们恢复时也不推；
 *  2. 抓取失败连续两次才推，其余提醒出现即推；同一条没恢复前只推一次；
 *  3. 推过的恢复时推「已恢复」，没推过的恢复不推；
 *  4. 没配渠道时不记新提醒（配好后补发）；一轮多条合成一条消息；
 * 以及各家的消息格式 / 签名、「HTTP 200 但其实失败」的判断、错误信息不泄露地址与 Token、
 * 后台接口打码与「留空保持不变」。不联网：fetch 全部注入。
 *
 * 运行： node scripts/test-notify.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DATA_DIR = mkdtempSync(join(tmpdir(), 'iptv-notify-'))
process.env.mdataDir = DATA_DIR
const { Notifier, buildRequest, sendToChannel, formatMessage } = await import('../utils/notify.js')
const { AlertTracker } = await import('../utils/alerts.js')

let passed = 0
async function test(name, fn) {
  await fn()
  passed++
  console.log(`  ✓ ${name}`)
}

/** 记下请求、按脚本回包的假 fetch */
function fakeFetch(reply = () => ({ status: 200, body: { errcode: 0 } })) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    const r = reply(url, calls.length)
    if (r instanceof Error) throw r
    return { status: r.status, text: async () => typeof r.body === 'string' ? r.body : JSON.stringify(r.body) }
  }
  fn.calls = calls
  return fn
}

let seq = 0
function makeNotifier(fetchImpl = fakeFetch(), host = '') {
  seq++
  return new Notifier({
    channelsPath: join(DATA_DIR, `channels-${seq}.json`),
    statePath: join(DATA_DIR, `state-${seq}.json`),
    fetchImpl, host: () => host, log: false,
  })
}

const cred = (id = 'migu') => ({ id: `module-credential:${id}`, level: 'error', title: `${id}登录凭证已失效`, text: 'Token 被拒' })
const failed = (id, failures) => ({ id: `module-failed:${id}`, level: 'error', title: `${id}抓取失败`, text: '超时', failures })
const pass = { id: 'users-no-pass', level: 'warning', title: '没设访问密码，一人一源没生效', text: '…' }
const evalOf = (alerts, extra = {}) => ({ alerts, activeIds: alerts.map(a => a.id), initial: false, ...extra })

console.log('消息推送回归测试')

// ── 消息格式与签名 ─────────────────────────────────────────────────────────
const message = { title: '【iPTV】标题', text: '正文' }

await test('企微 / Bark / 通用 Webhook 的请求体', () => {
  assert.deepEqual(buildRequest({ type: 'wecom', url: 'https://w/x' }, message).body, { msgtype: 'text', text: { content: '【iPTV】标题\n正文' } })
  assert.deepEqual(buildRequest({ type: 'bark', url: 'https://api.day.app/K' }, message).body, { title: '【iPTV】标题', body: '正文', group: 'iPTV' })
  const hook = buildRequest({ type: 'webhook', url: 'https://h' }, { ...message, raised: [{ id: 'a' }] }, 0).body
  assert.equal(hook.title, '【iPTV】标题')
  assert.deepEqual(hook.raised, [{ id: 'a' }])
  assert.deepEqual(hook.resolved, [])
  assert.equal(hook.sentAt, '1970-01-01T00:00:00.000Z')
})

await test('飞书签名：以「时间戳\\n密钥」为 key、对空串 HMAC-SHA256', () => {
  const now = 1_700_000_000_123
  const { body } = buildRequest({ type: 'feishu', url: 'https://f', secret: 'S' }, message, now)
  assert.equal(body.timestamp, '1700000000')
  assert.equal(body.sign, createHmac('sha256', '1700000000\nS').update('').digest('base64'))
  assert.deepEqual(body.content, { text: '【iPTV】标题\n正文' })
  assert.equal('sign' in buildRequest({ type: 'feishu', url: 'https://f' }, message).body, false, '没填密钥不签名')
})

await test('钉钉加签：以密钥为 key、对「毫秒时间戳\\n密钥」签名并拼进地址', () => {
  const now = 1_700_000_000_123
  const { url } = buildRequest({ type: 'dingtalk', url: 'https://d/robot/send?access_token=T', secret: 'SEC1' }, message, now)
  const sign = encodeURIComponent(createHmac('sha256', 'SEC1').update(`${now}\nSEC1`).digest('base64'))
  assert.equal(url, `https://d/robot/send?access_token=T&timestamp=${now}&sign=${sign}`)
})

await test('Telegram：默认官方地址，可换反代（去掉末尾斜杠）', () => {
  const official = buildRequest({ type: 'telegram', botToken: '1:A', chatId: '-100' }, message)
  assert.equal(official.url, 'https://api.telegram.org/bot1:A/sendMessage')
  assert.equal(official.body.chat_id, '-100')
  assert.equal(buildRequest({ type: 'telegram', botToken: '1:A', chatId: '1', apiBase: 'https://tg.example.com/' }, message).url,
    'https://tg.example.com/bot1:A/sendMessage')
})

await test('正文过长截断', () => {
  const long = buildRequest({ type: 'wecom', url: 'https://w' }, { title: 't', text: 'x'.repeat(5000) }).body.text.content
  assert.ok(long.length < 1900)
  assert.ok(long.endsWith('…'))
})

await test('「HTTP 200 但其实失败」按各家的返回判断；错误里不带地址和 Token', async () => {
  const cases = [
    ['wecom', { errcode: 93000, errmsg: 'invalid webhook url' }, /93000 invalid webhook url/],
    ['dingtalk', { errcode: 310000, errmsg: 'sign not match' }, /310000/],
    ['feishu', { code: 19021, msg: 'sign match fail' }, /19021/],
    ['feishu', { StatusCode: 0 }, null],
    ['telegram', { ok: false, description: 'Bad Request: chat not found' }, /chat not found/],
    ['bark', { code: 400, message: 'failed to get device token' }, /device token/],
    ['webhook', 'OK', null],
  ]
  for (const [type, body, expected] of cases) {
    const channel = { type, url: 'https://x/hook?key=SECRET', botToken: '1:A', chatId: '1' }
    const result = await sendToChannel(channel, message, { fetchImpl: fakeFetch(() => ({ status: 200, body })) })
    if (expected) { assert.equal(result.ok, false, type); assert.match(result.message, expected) }
    else assert.equal(result.ok, true, type)
  }
  const tg = { type: 'telegram', botToken: '123:SECRET', chatId: '1' }
  const leak = await sendToChannel(tg, message, { fetchImpl: fakeFetch(() => new Error('connect ETIMEDOUT https://api.telegram.org/bot123:SECRET/sendMessage')) })
  assert.equal(leak.ok, false)
  assert.equal(leak.message.includes('SECRET'), false)
  const http = await sendToChannel({ type: 'wecom', url: 'https://w' }, message, { fetchImpl: fakeFetch(() => ({ status: 404, body: { errmsg: 'not found' } })) })
  assert.match(http.message, /^HTTP 404：not found$/)
})

await test('一轮多条合成一条；带上服务器地址', () => {
  const m = formatMessage({ raised: [cred(), pass], resolved: [{ id: 'x', title: 'EPG 源坏了' }] }, 'http://192.168.1.2:1905')
  assert.equal(m.title, '【iPTV】2 条新提醒')
  assert.match(m.text, /❗ migu登录凭证已失效\nToken 被拒/)
  assert.match(m.text, /⚠️ 没设访问密码/)
  assert.match(m.text, /✅ 已恢复：EPG 源坏了/)
  assert.match(m.text, /来自 http:\/\/192\.168\.1\.2:1905$/)
  assert.equal(formatMessage({ resolved: [{ id: 'x', title: 'A' }] }).title, '【iPTV】已恢复：A')
})

// ── 推送规则 ───────────────────────────────────────────────────────────────
await test('升级后第一次运行的老问题不推，它们恢复时也不推', async () => {
  const fetchImpl = fakeFetch()
  const n = makeNotifier(fetchImpl)
  n.addChannel({ type: 'wecom', url: 'https://w/1' })
  await n.handleEvaluation(evalOf([cred(), pass], { initial: true }))
  assert.equal(fetchImpl.calls.length, 0)
  await n.handleEvaluation(evalOf([cred(), pass]))
  assert.equal(fetchImpl.calls.length, 0, '下一轮也不补发')
  await n.handleEvaluation(evalOf([pass]))
  assert.equal(fetchImpl.calls.length, 0, '老问题恢复不发')
  await n.handleEvaluation(evalOf([pass, cred()]))
  assert.equal(fetchImpl.calls.length, 1, '恢复后再出现是新问题，要发')
})

await test('凭证失效出现即推，只推一次；恢复时推「已恢复」', async () => {
  const fetchImpl = fakeFetch()
  const n = makeNotifier(fetchImpl)
  n.addChannel({ type: 'wecom', url: 'https://w/1' })
  await n.handleEvaluation(evalOf([cred()]))
  await n.handleEvaluation(evalOf([cred()]))
  assert.equal(fetchImpl.calls.length, 1)
  assert.match(fetchImpl.calls[0].body.text.content, /^【iPTV】migu登录凭证已失效/)
  // 还在 activeIds 里（等待确认恢复）时不算恢复
  await n.handleEvaluation({ alerts: [], activeIds: ['module-credential:migu'] })
  assert.equal(fetchImpl.calls.length, 1)
  await n.handleEvaluation(evalOf([]))
  assert.equal(fetchImpl.calls.length, 2)
  assert.match(fetchImpl.calls[1].body.text.content, /^【iPTV】已恢复：migu登录凭证已失效/)
})

await test('抓取失败连续两次才推；只失败一次就恢复的不推也不报恢复', async () => {
  const fetchImpl = fakeFetch()
  const n = makeNotifier(fetchImpl)
  n.addChannel({ type: 'wecom', url: 'https://w/1' })
  await n.handleEvaluation(evalOf([failed('gdtv', 1)]))
  assert.equal(fetchImpl.calls.length, 0)
  await n.handleEvaluation(evalOf([]))
  assert.equal(fetchImpl.calls.length, 0, '一闪而过')
  await n.handleEvaluation(evalOf([failed('gdtv', 1)]))
  await n.handleEvaluation(evalOf([failed('gdtv', 2)]))
  assert.equal(fetchImpl.calls.length, 1)
  assert.match(fetchImpl.calls[0].body.text.content, /gdtv抓取失败/)
  await n.handleEvaluation(evalOf([failed('gdtv', 3)]))
  assert.equal(fetchImpl.calls.length, 1, '第三次不再发')
  await n.handleEvaluation(evalOf([]))
  assert.match(fetchImpl.calls[1].body.text.content, /已恢复：gdtv抓取失败/)
})

await test('没配渠道时不记，配好后补发当前未处理的；关掉的渠道不发', async () => {
  const fetchImpl = fakeFetch()
  const n = makeNotifier(fetchImpl)
  await n.handleEvaluation(evalOf([cred()]))
  const id = n.addChannel({ type: 'wecom', url: 'https://w/1', enabled: false })
  await n.handleEvaluation(evalOf([cred()]))
  assert.equal(fetchImpl.calls.length, 0, '渠道关着')
  n.updateChannel(id, { enabled: true })
  await n.handleEvaluation(evalOf([cred()]))
  assert.equal(fetchImpl.calls.length, 1)
})

await test('多个渠道各发一份，结果分别记录；一个失败不影响另一个', async () => {
  const fetchImpl = fakeFetch(url => url.includes('bad') ? { status: 200, body: { errcode: 93000, errmsg: 'invalid' } } : { status: 200, body: { errcode: 0 } })
  const n = makeNotifier(fetchImpl)
  n.addChannel({ type: 'wecom', name: '好', url: 'https://w/good' })
  n.addChannel({ type: 'wecom', name: '坏', url: 'https://w/bad' })
  await n.handleEvaluation(evalOf([cred(), pass]))
  assert.equal(fetchImpl.calls.length, 2)
  assert.match(fetchImpl.calls[0].body.text.content, /^【iPTV】2 条新提醒/)
  const results = Object.fromEntries(n.publicChannels().map(c => [c.name, c.lastResult]))
  assert.equal(results['好'].ok, true)
  assert.equal(results['坏'].ok, false)
  assert.match(results['坏'].message, /93000/)
})

await test('同时进来的两轮评估串行处理，不会把同一条发两遍', async () => {
  const fetchImpl = fakeFetch()
  const n = makeNotifier(fetchImpl)
  n.addChannel({ type: 'wecom', url: 'https://w/1' })
  await Promise.all([n.handleEvaluation(evalOf([cred()])), n.handleEvaluation(evalOf([cred()]))])
  assert.equal(fetchImpl.calls.length, 1)
})

// ── 渠道配置 ───────────────────────────────────────────────────────────────
await test('添加校验必填与地址格式；后台列表打码；编辑时敏感字段留空保持不变', async () => {
  const n = makeNotifier()
  assert.throws(() => n.addChannel({ type: 'nope' }), /不支持/)
  assert.throws(() => n.addChannel({ type: 'telegram', botToken: '1:A' }), /Chat ID/)
  assert.throws(() => n.addChannel({ type: 'wecom', url: 'ftp://x' }), /http/)
  const id = n.addChannel({ type: 'feishu', name: '家', url: 'https://f/hook', secret: 'S' })
  const [listed] = n.publicChannels()
  assert.equal(listed.id, id)
  assert.match(id, /^[0-9a-f]{12}$/)
  assert.equal('url' in listed, false)
  assert.equal('secret' in listed, false)
  assert.deepEqual(listed.secretsSet, { url: true, secret: true })
  n.updateChannel(id, { name: '家里', url: '', secret: '' })
  const stored = JSON.parse(readFileSync(n.channelsPath, 'utf-8')).channels[0]
  assert.equal(stored.name, '家里')
  assert.equal(stored.url, 'https://f/hook')
  assert.equal(stored.secret, 'S')
  n.updateChannel(id, { url: 'https://f/new' })
  assert.equal(JSON.parse(readFileSync(n.channelsPath, 'utf-8')).channels[0].url, 'https://f/new')
  n.removeChannel(id)
  assert.deepEqual(n.publicChannels(), [])
})

await test('测试消息：发到指定渠道并记录结果', async () => {
  const fetchImpl = fakeFetch()
  const n = makeNotifier(fetchImpl, 'http://nas:1905')
  const id = n.addChannel({ type: 'bark', name: '手机', url: 'https://api.day.app/K' })
  const result = await n.testChannel(id)
  assert.equal(result.ok, true)
  assert.equal(fetchImpl.calls[0].body.title, '【iPTV】测试消息')
  assert.match(fetchImpl.calls[0].body.body, /手机/)
  assert.match(fetchImpl.calls[0].body.body, /来自 http:\/\/nas:1905/)
  assert.equal(n.publicChannels()[0].lastResult.ok, true)
})

// ── 和 AlertTracker 连起来 ─────────────────────────────────────────────────
await test('端到端：首次评估不推，之后新提醒推、恢复推', async () => {
  const fetchImpl = fakeFetch()
  const n = makeNotifier(fetchImpl)
  n.addChannel({ type: 'wecom', url: 'https://w/1' })
  const inputs = { passSet: false, userCount: 1 }
  const tracker = new AlertTracker({ statePath: join(DATA_DIR, 'tracker.json'), gather: async () => inputs, log: false })
  tracker.onEvaluate(evaluation => n.handleEvaluation(evaluation))
  const settle = async () => { await tracker.evaluate(); await new Promise(r => setTimeout(r, 0)); await n.queue }
  await settle()
  assert.equal(fetchImpl.calls.length, 0, '老问题')
  inputs.passSet = true
  await settle()
  assert.equal(fetchImpl.calls.length, 0, '老问题恢复')
  inputs.passSet = false
  await settle()
  assert.equal(fetchImpl.calls.length, 1)
  assert.match(fetchImpl.calls[0].body.text.content, /没设访问密码/)
  inputs.passSet = true
  await settle()
  assert.match(fetchImpl.calls[1].body.text.content, /已恢复：没设访问密码/)
})

rmSync(DATA_DIR, { recursive: true, force: true })
console.log(`\n全部 ${passed} 项通过`)
