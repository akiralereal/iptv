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
    let body = null
    try { body = init.body ? JSON.parse(init.body) : null } catch { /* 自定义接口的表单 / 纯文本 */ }
    calls.push({ url, method: init.method, headers: init.headers, raw: init.body, body })
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
const failed = id => ({ id: `module-failed:${id}`, level: 'error', title: `${id}抓取失败`, text: '超时' })
const pass = { id: 'users-no-pass', level: 'warning', title: '没设访问密码，一人一源没生效', text: '…' }
const evalOf = (alerts, extra = {}) => ({ alerts, activeIds: alerts.map(a => a.id), initial: false, ...extra })

console.log('消息推送回归测试')

// ── 消息格式与签名 ─────────────────────────────────────────────────────────
const message = { raised: [{ id: 'a', level: 'error', title: '标题', text: '正文' }], resolved: [], host: '' }
const FULL = '【iPTV】标题\n❗ 标题\n正文'

await test('企微 / Bark / 通用 Webhook 的请求体（默认详细样式）', () => {
  assert.deepEqual(buildRequest({ type: 'wecom', url: 'https://w/x' }, message).body, { msgtype: 'text', text: { content: FULL } })
  assert.deepEqual(buildRequest({ type: 'bark', url: 'https://api.day.app/K' }, message).body, { title: '【iPTV】标题', body: '❗ 标题\n正文', group: 'iPTV' })
  const hook = buildRequest({ type: 'webhook', url: 'https://h' }, message, 0).body
  assert.equal(hook.title, '【iPTV】标题')
  assert.deepEqual(hook.raised, [{ id: 'a', level: 'error', title: '标题', text: '正文' }])
  assert.deepEqual(hook.resolved, [])
  assert.equal(hook.test, false)
  assert.equal(hook.sentAt, '1970-01-01T00:00:00.000Z')
})

await test('飞书签名：以「时间戳\\n密钥」为 key、对空串 HMAC-SHA256', () => {
  const now = 1_700_000_000_123
  const { body } = buildRequest({ type: 'feishu', url: 'https://f', secret: 'S' }, message, now)
  assert.equal(body.timestamp, '1700000000')
  assert.equal(body.sign, createHmac('sha256', '1700000000\nS').update('').digest('base64'))
  assert.deepEqual(body.content, { text: FULL })
  assert.equal('sign' in buildRequest({ type: 'feishu', url: 'https://f' }, message).body, false, '没填密钥不签名')
  const card = buildRequest({ type: 'feishu', url: 'https://f', secret: 'S', template: 'card' }, message, now).body
  assert.equal(card.msg_type, 'interactive')
  assert.ok(card.sign, '卡片也签名')
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
  assert.equal('parse_mode' in official.body, false)
  assert.equal(buildRequest({ type: 'telegram', botToken: '1:A', chatId: '1', apiBase: 'https://tg.example.com/' }, message).url,
    'https://tg.example.com/bot1:A/sendMessage')
})

// ── 企业微信应用：先换 access_token 再发 ───────────────────────────────────
let corpSeq = 0
const wecomApp = (extra = {}) => ({ type: 'wecomApp', corpId: `ww${++corpSeq}`, agentId: '1000002', secret: 'APPSECRET', ...extra })
/** 假的企业微信：gettoken 发 TOKEN<n>，message/send 按 sendReply 回 */
function fakeWecom(sendReply = () => ({ errcode: 0, errmsg: 'ok' }), tokenReply) {
  let issued = 0
  return fakeFetch((url, n) => url.includes('/cgi-bin/gettoken')
    ? { status: 200, body: tokenReply ? tokenReply() : { errcode: 0, access_token: `TOKEN${++issued}`, expires_in: 7200 } }
    : { status: 200, body: sendReply(url, n) })
}

await test('企业微信应用：请求体发纯文本，默认 @all，卡片按详细发，可换反代', () => {
  const { url, body } = buildRequest(wecomApp(), message, 0, 'T/1')
  assert.equal(url, 'https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=T%2F1')
  assert.deepEqual(body, { touser: '@all', msgtype: 'text', agentid: 1000002, text: { content: FULL } })
  const card = buildRequest(wecomApp({ toUser: 'ZhangSan|LiSi', template: 'card', apiBase: 'https://wx.example.com/' }), message, 0, 'T')
  assert.equal(card.url, 'https://wx.example.com/cgi-bin/message/send?access_token=T')
  assert.equal(card.body.touser, 'ZhangSan|LiSi')
  assert.equal(card.body.msgtype, 'text', '应用的 Markdown 在微信插件里显示不了，不给卡片')
  assert.equal(buildRequest(wecomApp({ toUser: ' ZhangSan | LiSi |' }), message, 0, 'T').body.touser, 'ZhangSan|LiSi', '去掉 | 两边的空格')
  assert.equal(buildRequest(wecomApp({ toUser: ' | ' }), message, 0, 'T').body.touser, '@all')
})

await test('企业微信应用：正文按 2048 字节截断，不切坏汉字', () => {
  const alerts = Array.from({ length: 8 }, (_, i) => ({ level: 'error', title: `第 ${i} 个模块登录凭证已失效`, text: '登录态已失效，会员频道暂时播不了；请在后台重新登录或导入登录态。'.repeat(3) }))
  const content = buildRequest(wecomApp(), { raised: alerts, host: 'http://nas:1905' }, 0, 'T').body.text.content
  assert.ok(Buffer.byteLength(content) <= 2048, `${Buffer.byteLength(content)} 字节`)
  assert.ok(Buffer.byteLength(content) > 2040, '尽量用满')
  assert.ok(content.endsWith('…'))
  assert.equal(content.includes('\uFFFD'), false)
  assert.equal(buildRequest(wecomApp(), message, 0, 'T').body.text.content, FULL, '没超的不动')
})

await test('企业微信应用：先 GET 换 token 再 POST 发；token 缓存到快过期才重换', async () => {
  const channel = wecomApp({ apiBase: 'https://wx.example.com' })
  const fetchImpl = fakeWecom()
  assert.deepEqual(await sendToChannel(channel, message, { fetchImpl, now: 0 }), { ok: true, message: '' })
  assert.equal(fetchImpl.calls[0].method, 'GET')
  assert.equal(fetchImpl.calls[0].url, `https://wx.example.com/cgi-bin/gettoken?corpid=${channel.corpId}&corpsecret=APPSECRET`)
  assert.equal(fetchImpl.calls[1].method, 'POST')
  assert.equal(fetchImpl.calls[1].url, 'https://wx.example.com/cgi-bin/message/send?access_token=TOKEN1')
  await sendToChannel(channel, message, { fetchImpl, now: 60 * 60 * 1000 })
  assert.equal(fetchImpl.calls.length, 3, '一小时后还用缓存的 token')
  assert.match(fetchImpl.calls[2].url, /access_token=TOKEN1$/)
  await sendToChannel(channel, message, { fetchImpl, now: 2 * 60 * 60 * 1000 - 4 * 60 * 1000 })
  assert.equal(fetchImpl.calls.length, 5, '离过期不到 5 分钟就重换')
  assert.match(fetchImpl.calls[4].url, /access_token=TOKEN2$/)
  await sendToChannel({ ...channel, secret: 'NEWSECRET' }, message, { fetchImpl, now: 2 * 60 * 60 * 1000 })
  assert.match(fetchImpl.calls[5].url, /corpsecret=NEWSECRET$/, '改了 Secret 不用旧 token')
})

await test('企业微信应用：缓存的 token 被作废时换一次新的重发，再失败就报错', async () => {
  const channel = wecomApp()
  await sendToChannel(channel, message, { fetchImpl: fakeWecom(), now: 0 })
  const retried = fakeWecom((url, n) => n === 1 ? { errcode: 42001, errmsg: 'access_token expired' } : { errcode: 0 })
  assert.equal((await sendToChannel(channel, message, { fetchImpl: retried, now: 1000 })).ok, true)
  assert.deepEqual(retried.calls.map(c => c.method), ['POST', 'GET', 'POST'])
  assert.match(retried.calls[2].url, /access_token=TOKEN1$/)
  const dead = fakeWecom(() => ({ errcode: 40014, errmsg: 'invalid access_token' }))
  const result = await sendToChannel(channel, message, { fetchImpl: dead, now: 2000 })
  assert.equal(result.ok, false)
  assert.match(result.message, /^40014 invalid access_token/)
  assert.equal(dead.calls.length, 3, '只重试一次')
})

await test('企业微信应用：常见配置错误给中文提示；错误里不带 Secret 和 access_token', async () => {
  const wrongSecret = await sendToChannel(wecomApp(), message, { fetchImpl: fakeWecom(undefined, () => ({ errcode: 40001, errmsg: 'invalid credential' })) })
  assert.equal(wrongSecret.ok, false)
  assert.match(wrongSecret.message, /^40001 Secret 不对/)
  const noToken = await sendToChannel(wecomApp(), message, { fetchImpl: fakeWecom(undefined, () => ({ errcode: 0 })) })
  assert.match(noToken.message, /没换到 access_token/)
  const ip = await sendToChannel(wecomApp(), message, {
    fetchImpl: fakeWecom(() => ({ errcode: 60020, errmsg: 'not allow to access from your ip, hint: [1], from ip: 203.0.113.7, more info at https://open.work.weixin.qq.com/devtool/query?e=60020' })),
  })
  assert.equal(ip.message, '60020 服务器 IP 不在这个应用的「企业可信IP」里（本机出口 IP 203.0.113.7）')
  const users = await sendToChannel(wecomApp({ toUser: '张三' }), message, { fetchImpl: fakeWecom(() => ({ errcode: 81013, errmsg: 'user & party & tag all invalid' })) })
  assert.match(users.message, /^81013 接收人都不在/)
  const leakChannel = wecomApp()
  await sendToChannel(leakChannel, message, { fetchImpl: fakeWecom() })
  const leak = await sendToChannel(leakChannel, message, {
    fetchImpl: fakeFetch(() => new Error('connect ETIMEDOUT https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=TOKEN1&debug=1')),
  })
  assert.equal(leak.ok, false)
  assert.equal(leak.message.includes('TOKEN1'), false)
  const leakSecret = await sendToChannel(wecomApp(), message, {
    fetchImpl: fakeFetch(() => new Error('connect ETIMEDOUT https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=ww1&corpsecret=APPSECRET')),
  })
  assert.equal(leakSecret.message.includes('APPSECRET'), false)
})

await test('正文过长截断', () => {
  const long = buildRequest({ type: 'wecom', url: 'https://w' }, { raised: [{ level: 'error', title: 't', text: 'x'.repeat(5000) }] }).body.text.content
  assert.ok(long.length < 1900)
  assert.ok(long.endsWith('…'))
})

// ── 消息样式 ───────────────────────────────────────────────────────────────
const two = {
  host: 'http://nas:1905',
  raised: [{ id: 'c', level: 'error', title: '央视频登录凭证已失效', text: '要重新登录 <b>' }],
  resolved: [{ id: 'r', title: '广东抓取失败' }],
}

await test('简洁样式：每条一行、不带说明', () => {
  const content = buildRequest({ type: 'wecom', url: 'https://w', template: 'compact' }, two).body.text.content
  assert.equal(content, '【iPTV】央视频登录凭证已失效\n❗ 央视频登录凭证已失效\n✅ 已恢复：广东抓取失败\n\n来自 http://nas:1905')
})

await test('卡片样式：飞书是带颜色标题栏的消息卡片', () => {
  const { card } = buildRequest({ type: 'feishu', url: 'https://f', template: 'card' }, two).body
  assert.equal(card.header.template, 'red')
  assert.equal(card.header.title.content, '【iPTV】央视频登录凭证已失效')
  assert.equal(card.elements[0].tag, 'markdown')
  assert.match(card.elements[0].content, /^\*\*❗ 央视频登录凭证已失效\*\*\n要重新登录/)
  assert.match(card.elements[0].content, /\*\*✅ 已恢复：广东抓取失败\*\*$/)
  assert.deepEqual(card.elements[1], { tag: 'note', elements: [{ tag: 'plain_text', content: '来自 http://nas:1905' }] })
  const recovered = buildRequest({ type: 'feishu', url: 'https://f', template: 'card' }, { resolved: [{ title: 'x' }] }).body.card
  assert.equal(recovered.header.template, 'green')
  const warning = buildRequest({ type: 'feishu', url: 'https://f', template: 'card' }, { raised: [{ level: 'warning', title: 'w', text: '' }] }).body.card
  assert.equal(warning.header.template, 'orange')
})

await test('卡片样式：企微 / 钉钉发 Markdown，Telegram 发 HTML 并转义', () => {
  const wecom = buildRequest({ type: 'wecom', url: 'https://w', template: 'card' }, two).body
  assert.equal(wecom.msgtype, 'markdown')
  assert.match(wecom.markdown.content, /^\*\*【iPTV】央视频登录凭证已失效\*\*\n\n\*\*❗/)
  assert.match(wecom.markdown.content, /<font color="comment">来自 http:\/\/nas:1905<\/font>$/)
  const ding = buildRequest({ type: 'dingtalk', url: 'https://d', template: 'card' }, two).body
  assert.equal(ding.msgtype, 'markdown')
  assert.equal(ding.markdown.title, '【iPTV】央视频登录凭证已失效')
  assert.match(ding.markdown.text, /^### 【iPTV】/)
  const tg = buildRequest({ type: 'telegram', botToken: '1:A', chatId: '1', template: 'card' }, two).body
  assert.equal(tg.parse_mode, 'HTML')
  assert.match(tg.text, /^<b>【iPTV】央视频登录凭证已失效<\/b>/)
  assert.match(tg.text, /要重新登录 &lt;b&gt;/, '正文里的尖括号要转义，否则 Telegram 拒收')
})

await test('Bark / 通用 Webhook 选了卡片按详细发；测试消息各样式都能排', () => {
  const bark = buildRequest({ type: 'bark', url: 'https://api.day.app/K', template: 'card' }, two).body
  assert.match(bark.body, /^❗ 央视频登录凭证已失效\n要重新登录/)
  for (const template of ['detailed', 'compact', 'card']) {
    const body = buildRequest({ type: 'feishu', url: 'https://f', template }, { test: true, channelName: '家', host: 'h' }).body
    const text = JSON.stringify(body)
    assert.match(text, /测试消息/)
    assert.match(text, /「家」配置正确/)
    if (template === 'card') assert.equal(body.card.header.template, 'green')
  }
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

// ── 自定义接口 ─────────────────────────────────────────────────────────────
const custom = (extra = {}) => ({ type: 'custom', url: 'https://push.example.com/send', token: 'TK', ...extra })

await test('自定义接口：JSON 模板只替换字符串值，引号和换行转义正确', () => {
  const tricky = { raised: [{ level: 'error', title: '名字带 "引号"', text: '第一行\n第二行' }], host: 'http://nas:1905' }
  const req = buildRequest(custom({ body: '{"token": "{{token}}", "title": "{{ title }}", "content": "{{content}}", "n": 5, "list": ["{{token}}"]}' }), tricky)
  assert.equal(req.method, 'POST')
  assert.equal(req.headers['Content-Type'], 'application/json;charset=UTF-8')
  const body = JSON.parse(req.body)
  assert.deepEqual(body, {
    token: 'TK', title: '【iPTV】名字带 "引号"', content: '❗ 名字带 "引号"\n第一行\n第二行\n\n来自 http://nas:1905', n: 5, list: ['TK'],
  })
})

await test('自定义接口：{{markdown}} 段间空行；简洁样式同时作用于 {{content}} 和 {{markdown}}', async () => {
  const md = JSON.parse(buildRequest(custom({ body: '{"m": "{{markdown}}"}' }), two).body).m
  assert.equal(md, '**❗ 央视频登录凭证已失效**\n\n要重新登录 <b>\n\n**✅ 已恢复：广东抓取失败**\n\n> 来自 http://nas:1905')
  const compact = JSON.parse(buildRequest(custom({ template: 'compact', body: '{"c": "{{content}}", "m": "{{markdown}}"}' }), two).body)
  assert.equal(compact.c, '❗ 央视频登录凭证已失效\n✅ 已恢复：广东抓取失败\n\n来自 http://nas:1905')
  assert.equal(compact.m, '**❗ 央视频登录凭证已失效**\n\n**✅ 已恢复：广东抓取失败**\n\n> 来自 http://nas:1905')
  const { templateOf } = await import('../utils/notify.js')
  assert.equal(templateOf({ type: 'custom', template: 'card' }), 'detailed', '自定义接口没有卡片样式')
})

await test('自定义接口：表单与纯文本请求体、地址里的占位符按 URL 编码', () => {
  const form = buildRequest(custom({ url: 'https://sctapi.ftqq.com/{{token}}.send', bodyType: 'form', body: 'title={{title}}&desp={{content}}' }), message)
  assert.equal(form.url, 'https://sctapi.ftqq.com/TK.send')
  assert.equal(form.headers['Content-Type'], 'application/x-www-form-urlencoded;charset=UTF-8')
  assert.deepEqual(Object.fromEntries(new URLSearchParams(form.body)), { title: '【iPTV】标题', desp: '❗ 标题\n正文' })
  const text = buildRequest(custom({ bodyType: 'text', body: '{{title}}：{{content}}' }), message)
  assert.equal(text.headers['Content-Type'], 'text/plain;charset=UTF-8')
  assert.equal(text.body, '【iPTV】标题：❗ 标题\n正文')
  const get = buildRequest(custom({ method: 'GET', url: 'https://x/push?t={{title}}&k={{token}}' }), message)
  assert.equal(get.method, 'GET')
  assert.equal(get.body, undefined)
  assert.equal(get.url, `https://x/push?t=${encodeURIComponent('【iPTV】标题')}&k=TK`)
  assert.equal(buildRequest(custom(), message).body, undefined, '没填请求体就不带')
})

await test('自定义接口：请求头替换占位符，中文按 RFC 2047 编码，名称不分大小写顶掉默认值', () => {
  const req = buildRequest(custom({ body: '{}', headers: 'Authorization: Bearer {{token}}\n\ncontent-type: application/vnd.x+json\nTitle: {{title}}' }), message)
  assert.equal(req.headers.Authorization, 'Bearer TK')
  assert.equal(req.headers['content-type'], 'application/vnd.x+json')
  assert.equal('Content-Type' in req.headers, false)
  assert.equal(req.headers.Title, `=?UTF-8?B?${Buffer.from('【iPTV】标题').toString('base64')}?=`)
})

await test('自定义接口：发出去的请求原样带上方法、请求头和请求体', async () => {
  const fetchImpl = fakeFetch()
  const result = await sendToChannel(custom({ bodyType: 'form', body: 'a={{token}}', headers: 'User-Agent: mine' }), message, { fetchImpl })
  assert.equal(result.ok, true)
  const [call] = fetchImpl.calls
  assert.equal(call.method, 'POST')
  assert.equal(call.raw, 'a=TK')
  assert.deepEqual(call.headers, { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'User-Agent': 'mine' })
})

await test('自定义接口：按成功条件判断「HTTP 200 但其实失败」；错误里不带密钥', async () => {
  const send = (extra, reply) => sendToChannel(custom({ body: '{"t": "{{token}}"}', ...extra }), message, { fetchImpl: fakeFetch(() => reply) })
  assert.equal((await send({}, { status: 200, body: { code: 903 } })).ok, true, '没填成功条件只看状态码')
  assert.equal((await send({ success: 'code=200' }, { status: 200, body: { code: 200, msg: '请求成功' } })).ok, true)
  assert.equal((await send({ success: 'data.ok == "true"' }, { status: 200, body: { data: { ok: true } } })).ok, true, '支持多级字段、== 和引号')
  const wrong = await send({ success: 'code=200' }, { status: 200, body: { code: 903, msg: '无效的用户token' } })
  assert.deepEqual(wrong, { ok: false, message: '返回 code=903，不是 200：无效的用户token' })
  assert.equal((await send({ success: 'code=0' }, { status: 200, body: {} })).message, '返回里没有 code，不是 0')
  assert.equal((await send({ success: 'code=0' }, { status: 200, body: 'OK' })).message, '返回的不是 JSON，判断不了「code=0」：OK')
  assert.equal((await send({}, { status: 401, body: { message: 'unauthorized' } })).message, 'HTTP 401：unauthorized')
  const leak = await send({ success: 'code=0' }, { status: 200, body: { code: 1, msg: 'bad token TK' } })
  assert.equal(leak.message.includes('TK'), false)
})

await test('自定义接口：保存时校验模板；密钥打码、留空保持不变，地址和模板可见', async () => {
  const n = makeNotifier()
  assert.throws(() => n.addChannel({ type: 'custom' }), /请求地址/)
  assert.throws(() => n.addChannel(custom({ body: '{"t": {{title}}}' })), /不是合法的 JSON/)
  assert.throws(() => n.addChannel(custom({ body: '{"t": "{{titel}}"}' })), /不认识的占位符 \{\{titel\}\}/)
  assert.throws(() => n.addChannel(custom({ headers: 'Bearer {{token}}' })), /请求头第 1 行/)
  assert.throws(() => n.addChannel(custom({ method: 'GET', body: '{}' })), /GET 请求不带请求体/)
  assert.throws(() => n.addChannel(custom({ success: 'code' })), /成功条件/)
  assert.throws(() => n.addChannel(custom({ token: '', headers: 'Authorization: Bearer {{token}}' })), /请填写「密钥 \/ Token」/)
  n.addChannel(custom({ token: '', url: 'https://ntfy.sh/', body: '{"topic": "t", "message": "{{content}}"}' }))   // 没用 {{token}} 的不要求填
  n.addChannel(custom({ bodyType: 'form', body: 'a={{content}}' }))   // 表单不按 JSON 校验
  const id = n.addChannel(custom({ name: 'PushPlus', method: 'PATCH', bodyType: 'xml', body: '{"token": "{{token}}"}', success: 'code=200' }))
  const listed = n.publicChannels().find(c => c.id === id)
  assert.equal('token' in listed, false)
  assert.deepEqual(listed.secretsSet, { token: true })
  assert.equal(listed.url, 'https://push.example.com/send')
  assert.equal(listed.body, '{"token": "{{token}}"}')
  assert.equal('method' in listed, false, '不认识的请求方式不存，按 POST 发')
  assert.equal('bodyType' in listed, false)
  n.updateChannel(id, { token: '', success: '' })
  const stored = JSON.parse(readFileSync(n.channelsPath, 'utf-8')).channels.find(c => c.id === id)
  assert.equal(stored.token, 'TK')
  assert.equal('success' in stored, false)
})

await test('自定义接口：后台接口带上说明和示例，示例都能通过校验', async () => {
  const { CHANNEL_TYPES } = await import('../utils/notify.js')
  const n = makeNotifier()
  for (const preset of CHANNEL_TYPES.custom.presets) {
    assert.doesNotThrow(() => n.addChannel({ type: 'custom', token: 'T', ...preset.values }), preset.name)
    for (const field of CHANNEL_TYPES.custom.fields.filter(f => !f.secret)) assert.ok(field.key in preset.values, `${preset.name} 缺 ${field.key}`)
  }
  const pushplus = CHANNEL_TYPES.custom.presets.find(p => p.name === 'PushPlus').values
  const body = JSON.parse(buildRequest({ type: 'custom', token: 'T', ...pushplus }, message).body)
  assert.deepEqual(body, { token: 'T', title: '【iPTV】标题', content: '**❗ 标题**\n\n正文', template: 'markdown' })
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

await test('后台点过「知道了」的提醒不推，恢复时也不推', async () => {
  const fetchImpl = fakeFetch()
  const n = makeNotifier(fetchImpl)
  n.addChannel({ type: 'wecom', url: 'https://w/1' })
  const seen = { ...failed('beidou'), level: 'warning', dismissed: true }
  await n.handleEvaluation(evalOf([seen]))
  assert.equal(fetchImpl.calls.length, 0)
  await n.handleEvaluation(evalOf([]))
  assert.equal(fetchImpl.calls.length, 0, '恢复不报')
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

await test('模块抓取失败、官方故障都不推，恢复也不报；同时出现的凭证失效照推', async () => {
  const fetchImpl = fakeFetch()
  const n = makeNotifier(fetchImpl)
  n.addChannel({ type: 'wecom', url: 'https://w/1' })
  await n.handleEvaluation(evalOf([failed('gdtv'), { ...failed('liaoning'), level: 'warning' }]))
  await n.handleEvaluation(evalOf([failed('gdtv')]))
  assert.equal(fetchImpl.calls.length, 0)
  await n.handleEvaluation(evalOf([]))
  assert.equal(fetchImpl.calls.length, 0, '恢复不报')
  await n.handleEvaluation(evalOf([failed('gdtv'), cred()]))
  assert.equal(fetchImpl.calls.length, 1)
  assert.doesNotMatch(fetchImpl.calls[0].body.text.content, /gdtv/)
  assert.match(fetchImpl.calls[0].body.text.content, /migu登录凭证已失效/)
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
  assert.throws(() => n.addChannel({ type: 'wecomApp', corpId: 'ww1', agentId: '1000002' }), /Secret/)
  assert.throws(() => n.addChannel({ type: 'wecomApp', corpId: 'ww1', agentId: 'abc', secret: 'S' }), /AgentId 是一串数字/)
  assert.throws(() => n.addChannel({ type: 'wecomApp', corpId: 'ww1', agentId: '1', secret: 'S', apiBase: 'wx.example.com' }), /http/)
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
  const appId = n.addChannel({ type: 'wecomApp', corpId: 'ww1', agentId: '1000002', secret: 'S', toUser: 'ZhangSan' })
  const [app] = n.publicChannels()
  assert.equal(app.name, '企业微信应用')
  assert.equal(app.corpId, 'ww1')
  assert.equal(app.agentId, '1000002')
  assert.equal(app.toUser, 'ZhangSan')
  assert.equal('secret' in app, false)
  assert.deepEqual(app.secretsSet, { secret: true })
  n.updateChannel(appId, { secret: '', toUser: '' })
  const storedApp = JSON.parse(readFileSync(n.channelsPath, 'utf-8')).channels[0]
  assert.equal(storedApp.secret, 'S', 'Secret 留空保持不变')
  assert.equal('toUser' in storedApp, false, '接收人清空 = 发给所有人')
})

await test('样式随渠道保存、可修改；未知样式与不支持卡片的类型退回详细', async () => {
  const { templateOf } = await import('../utils/notify.js')
  const n = makeNotifier()
  const id = n.addChannel({ type: 'feishu', url: 'https://f/hook', template: 'card' })
  assert.equal(n.publicChannels()[0].template, 'card')
  n.updateChannel(id, { template: 'compact' })
  assert.equal(n.publicChannels()[0].template, 'compact')
  n.updateChannel(id, { template: 'detailed' })
  assert.equal('template' in JSON.parse(readFileSync(n.channelsPath, 'utf-8')).channels[0], false, '默认值不落盘')
  n.updateChannel(id, { template: 'fancy' })
  assert.equal(templateOf(n.publicChannels()[0]), 'detailed')
  assert.equal(templateOf({ type: 'bark', template: 'card' }), 'detailed')
  assert.equal(templateOf({ type: 'telegram', template: 'card' }), 'card')
  assert.equal(templateOf({ type: 'wecomApp', template: 'card' }), 'detailed')
  assert.equal(templateOf({ type: 'wecomApp', template: 'compact' }), 'compact')
})

await test('测试消息：发到指定渠道并记录结果', async () => {
  const fetchImpl = fakeFetch()
  const n = makeNotifier(fetchImpl, 'http://nas:1905')
  const id = n.addChannel({ type: 'bark', name: '手机', url: 'https://api.day.app/K' })
  const result = await n.testChannel(id)
  assert.equal(result.ok, true)
  assert.equal(fetchImpl.calls[0].body.title, '【iPTV】测试消息')
  assert.match(fetchImpl.calls[0].body.body, /「手机」配置正确/)
  assert.match(fetchImpl.calls[0].body.body, /来自 http:\/\/nas:1905/)
  assert.equal(n.publicChannels()[0].lastResult.ok, true)
  const wecomFetch = fakeWecom()
  const app = makeNotifier(wecomFetch, 'http://nas:1905')
  const appId = app.addChannel({ ...wecomApp({ toUser: 'ZhangSan' }), name: '企微应用' })
  assert.equal((await app.testChannel(appId)).ok, true)
  const sent = wecomFetch.calls.at(-1).body
  assert.equal(sent.touser, 'ZhangSan')
  assert.match(sent.text.content, /^【iPTV】测试消息\n收到这条说明「企微应用」配置正确/)
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
