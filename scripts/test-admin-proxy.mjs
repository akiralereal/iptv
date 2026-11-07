#!/usr/bin/env node
/** 从实际管理页提取函数，控制响应顺序复现测试与保存竞争；不启动服务、不访问外网。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
const html = readFileSync(new URL('../web/admin.html', import.meta.url), 'utf8')
const source = name => {
  const match = html.match(new RegExp(`^ {8}(?:async )?function ${name}\\([^]*?^ {8}\\}`, 'm'))
  assert.ok(match, name)
  return match[0]
}
function harness() {
  const elements = new Map()
  const element = id => {
    if (!elements.has(id)) {
      let text = ''
      elements.set(id, { value: '', checked: false, disabled: false,
        get textContent() { return text }, set textContent(value) { text = value },
        get innerHTML() { return text }, set innerHTML(value) { text = value },
      })
    }
    return elements.get(id)
  }
  element('sysPort').value = '1905'
  element('sysAdminPath').value = 'admin'
  const controls = ['sysPort', 'sysHost', 'sysPass', 'sysAdminPath', 'sysProgramInterval', 'sysEnableDisplayNameUnify', 'sysProxy', 'save', 'restart'].map(element)
  const pending = [], messages = []
  const context = vm.createContext({ AbortController, setTimeout, clearTimeout,
    document: { getElementById: element, querySelectorAll: () => controls },
    window: { location: { pathname: '/admin', origin: 'http://localhost' } },
    // resolve：接口正常回 JSON；respond：原样给一个响应对象（反代 / 穿透层替服务答的错误页）
    fetch: (url, options) => new Promise((resolve, reject) => pending.push({ url, options, resolve: value => resolve(jsonResponse(value)), respond: resolve, reject })),
    showStatus: (message, type) => messages.push({ message, type }),
    applySaveDirtyMarks() {}, escapeHtml: value => String(value),
  })
  vm.runInContext(`const API_PREFIX = ''; let systemConfig = { port: 1905 }; const dirtySaveScopes = new Set();
    let systemConfigEditVersion = 0, systemConfigSaving = false, proxyEditVersion = 0, proxySaving = false, proxyTestSequence = 0, proxyTestController = null;
    ${['setSaveDirty', 'invalidateProxyTest', 'readJsonResponse', 'testProxy', 'saveSystemConfig', 'saveProxyConfig', 'proxyHostsHtml'].map(source).join('\n')}`, context)
  const inputCode = html.match(/id="sysProxy" oninput="([^"]+)"/)[1]
  return { context, element, controls, pending, messages,
    input(value) { element('sysProxy').value = value; vm.runInContext(inputCode, context) },
    dirty: (scope = 'proxy') => vm.runInContext(`dirtySaveScopes.has('${scope}')`, context),
  }
}
const jsonResponse = value => ({ status: 200, headers: { get: name => name === 'content-type' ? 'application/json;charset=UTF-8' : null }, text: async () => JSON.stringify(value) })
const htmlResponse = (status, body) => ({ status, headers: { get: name => name === 'content-type' ? 'text/html;charset=UTF-8' : null }, text: async () => body })
const success = { success: true, via: 'input', results: [{ name: 'YouTube', ok: true, ms: 1 }] }
{
  const h = harness()
  h.input('proxy-a:7890')
  const a = h.context.testProxy()
  const requestA = h.pending.shift()
  h.input('proxy-b:7890')
  assert.equal(requestA.options.signal.aborted, true)
  assert.equal(h.element('sysProxyResult').textContent, '')
  const b = h.context.testProxy()
  const requestB = h.pending.shift()
  requestA.resolve(success) // 即使被取消的请求迟到，也不能结束 B 的加载状态
  await a
  assert.equal(h.element('sysProxyTestBtn').disabled, true)
  assert.doesNotMatch(h.element('sysProxyResult').textContent, /能连上/)
  requestB.resolve(success)
  await b
  assert.match(h.element('sysProxyResult').innerHTML, /能连上/)
  h.input('proxy-c:7890')
  assert.equal(h.element('sysProxyResult').textContent, '')
  assert.equal(h.element('sysProxyTestBtn').disabled, false)
}
{
  const h = harness()
  h.input('proxy-a:7890')
  const pending = h.context.testProxy()
  h.input('proxy-b:7890')
  h.pending.shift().reject(new Error('旧请求失败'))
  await pending
  assert.equal(h.element('sysProxyResult').textContent, '', '旧错误也不能覆盖新输入')
}
for (const ok of [true, false]) {
  const h = harness()
  h.input('proxy-a:7890')
  h.element('sysHost').disabled = true
  const save = h.context.saveProxyConfig()
  assert.ok(h.controls.every(control => control.disabled), '保存期间阻止继续编辑和重复提交')
  assert.equal(await h.context.saveProxyConfig(), false)
  assert.equal(h.pending.length, 1)
  h.pending.shift().resolve({ success: ok, message: ok ? '已保存' : '保存失败', entry: '/admin', apiPrefix: '' })
  assert.equal(await save, ok)
  assert.equal(h.dirty(), !ok)
  assert.equal(h.element('sysHost').disabled, true, '恢复原先禁用状态')
  assert.equal(h.element('sysProxy').disabled, false)
}
{
  const h = harness()
  h.input('proxy-a:7890')
  const save = h.context.saveProxyConfig()
  const request = h.pending.shift()
  h.input('proxy-b:7890') // 其他代码即使绕过 disabled 修改表单，也不能误清 dirty 或继续重启
  assert.deepEqual(JSON.parse(request.options.body), { proxy: 'proxy-a:7890' }, '只提交 proxy，不带系统配置标签的字段')
  request.resolve({ success: true, message: '已保存', entry: '/admin', apiPrefix: '' })
  assert.equal(await save, false)
  assert.equal(h.dirty(), true)
  assert.match(h.messages.at(-1).message, /后续修改尚未保存/)
}
{
  const h = harness()
  h.input('proxy-a:7890')
  const save = h.context.saveProxyConfig()
  h.pending.shift().reject(new Error('offline'))
  assert.equal(await save, false)
  assert.equal(h.element('save').disabled, false)
  assert.equal(h.dirty(), true)
}
{
  // 反代 / 内网穿透层替服务回了 502 页：提示要带状态码、类型和页面文字，
  // 不能只剩浏览器那句（Safari「The string did not match the expected pattern」）
  const h = harness()
  h.input('proxy-a:7890')
  const save = h.context.saveProxyConfig()
  h.pending.shift().respond(htmlResponse(502, '<html><head><title>502 Bad Gateway</title><style>h1{}</style></head><body><center><h1>502 Bad Gateway</h1></center><hr><center>nginx/1.24.0</center></body></html>'))
  assert.equal(await save, false)
  assert.equal(h.messages.at(-1).type, 'error')
  assert.match(h.messages.at(-1).message, /^保存失败: 服务回复不是 JSON（HTTP 502 text\/html）：502 Bad Gateway 502 Bad Gateway nginx\/1\.24\.0；多半是反代、内网穿透层回的页面，或服务正在重启$/)
  assert.equal(h.dirty(), true)
}
{
  // 入口密码不对时服务回 403 文本；空回复也要说明
  const h = harness()
  h.input('proxy-a:7890')
  const test = h.context.testProxy()
  h.pending.shift().respond({ status: 403, headers: { get: () => 'text/plain;charset=UTF-8' }, text: async () => '访问令牌无效或已停用' })
  await test
  assert.match(h.element('sysProxyResult').innerHTML, /测试失败：服务回复不是 JSON（HTTP 403 text\/plain）：访问令牌无效或已停用；/)
  const save = h.context.saveProxyConfig()
  h.pending.shift().respond({ status: 200, headers: { get: () => null }, text: async () => '' })
  assert.equal(await save, false)
  assert.match(h.messages.at(-1).message, /服务回复不是 JSON（HTTP 200 未标类型），内容为空；/)
}
{
  // 总结行先说代理本身通不通；「代理已接通」的失败项带一句断在代理之后的提示
  const h = harness()
  h.input('proxy-a:7890')
  let test = h.context.testProxy()
  h.pending.shift().resolve({ success: true, via: 'input', proxyReachable: true, results: [
    { name: 'YouTube', ok: true, ms: 1 },
    { name: '澳门（澳广视）', ok: false, stage: 'target', hosts: ['tdm.com.mo'], message: '代理已接通，往对方站点的连接被断开（ECONNRESET）' },
    { name: '海外频道（DW）', ok: false, stage: 'target', message: '代理已接通，对方站点超时没有响应' }] })
  await test
  let html = h.element('sysProxyResult').innerHTML
  assert.match(html, /经输入的代理：<strong class="ok">代理可用，1\/3 项能连上<\/strong>/)
  assert.match(html, /✗ 澳门（澳广视）：代理已接通，往对方站点的连接被断开（ECONNRESET）/)
  assert.match(html, /断在代理之后.*把下面列的域名加进走代理的规则/)
  // 带了 hosts 的失败项写出要放行的域名；没带的（旧服务端）只有通用提示
  assert.match(html, /澳门（澳广视） 需放行：<code>tdm.com.mo<\/code>/)
  assert.doesNotMatch(html, /海外频道（DW） 需放行/)
  test = h.context.testProxy()
  h.pending.shift().resolve({ success: true, via: 'input', proxyReachable: true, results: [
    { name: 'YouTube', ok: true, ms: 1 },
    { name: '澳门（澳广视）', ok: false, stage: 'target', message: '代理已接通，往对方站点的连接被断开（ECONNRESET）' }] })
  await test
  html = h.element('sysProxyResult').innerHTML
  assert.match(html, /断在代理之后.*改分流规则或换节点后再测/)
  assert.doesNotMatch(html, /需放行|下面列的域名/)
  test = h.context.testProxy()
  h.pending.shift().resolve({ success: true, via: 'input', proxyReachable: false, results: [{ name: 'YouTube', ok: false, stage: 'proxy', message: '连不上代理：端口没开' }] })
  await test
  html = h.element('sysProxyResult').innerHTML
  assert.match(html, /<strong class="fail">连不上代理<\/strong>/)
  assert.doesNotMatch(html, /断在代理之后|需放行/)
  h.input('')
  test = h.context.testProxy()
  h.pending.shift().resolve({ success: true, via: '', proxyReachable: null, results: [{ name: 'YouTube', ok: false, stage: '', message: '超时没有响应' }] })
  await test
  html = h.element('sysProxyResult').innerHTML
  assert.match(html, /留空，使用直连：<strong class="fail">1 项都没连上<\/strong>/)
  assert.doesNotMatch(html, /代理可用|断在代理之后/)
}
{
  // 两个标签各存各的：系统配置的保存不带 proxy、不清代理的未保存标记
  const h = harness()
  h.input('proxy-a:7890')
  const save = h.context.saveSystemConfig()
  const request = h.pending.shift()
  assert.equal('proxy' in JSON.parse(request.options.body), false)
  request.resolve({ success: true, message: '已保存', entry: '/admin', apiPrefix: '' })
  assert.equal(await save, true)
  assert.equal(h.dirty('proxy'), true, '代理改动仍待保存')
}
{
  // 「网络代理」说明里可展开的放行名单：按模块声明列，Telegram 推送固定最后；没名单就不渲染
  const h = harness()
  const html = h.context.proxyHostsHtml({
    proxyModules: [{ id: 'tdm', name: '澳门', hosts: ['tdm.com.mo'] }, { id: 'x', name: '没名单的旧模块' }, { id: 'overseas', name: '海外频道', hosts: ['akamaized.net', 'amagi.tv'] }],
    proxyTelegramHosts: ['telegram.org'],
  })
  assert.match(html, /^<div>澳门：<code>tdm.com.mo<\/code><\/div><div>海外频道：<code>akamaized.net amagi.tv<\/code><\/div><div>Telegram 消息推送：<code>telegram.org<\/code><\/div><div>按域名后缀匹配/)
  assert.doesNotMatch(html, /没名单的旧模块/)
  assert.equal(h.context.proxyHostsHtml({}), '')
  assert.equal(h.context.proxyHostsHtml({ proxyModules: [{ id: 'x', name: 'x' }] }), '')
}
console.log('✓ test-admin-proxy: stale responses, cancellation, save locking, edit tracking, retry, non-JSON replies, separate proxy save, test summary and allow-list hints')
