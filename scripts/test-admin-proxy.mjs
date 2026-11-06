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
    fetch: (url, options) => new Promise((resolve, reject) => pending.push({ url, options, resolve: value => resolve({ json: async () => value }), reject })),
    showStatus: (message, type) => messages.push({ message, type }),
    applySaveDirtyMarks() {}, escapeHtml: value => String(value),
  })
  vm.runInContext(`const API_PREFIX = ''; let systemConfig = { port: 1905 }; const dirtySaveScopes = new Set();
    let systemConfigEditVersion = 0, systemConfigSaving = false, proxyTestSequence = 0, proxyTestController = null;
    ${['setSaveDirty', 'invalidateProxyTest', 'testProxy', 'saveSystemConfig'].map(source).join('\n')}`, context)
  const inputCode = html.match(/id="sysProxy" oninput="([^"]+)"/)[1]
  return { context, element, controls, pending, messages,
    input(value) { element('sysProxy').value = value; vm.runInContext(inputCode, context) },
    dirty: () => vm.runInContext("dirtySaveScopes.has('sysconfig')", context),
  }
}
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
  const save = h.context.saveSystemConfig()
  assert.ok(h.controls.every(control => control.disabled), '保存期间阻止继续编辑和重复提交')
  assert.equal(await h.context.saveSystemConfig(), false)
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
  const save = h.context.saveSystemConfig()
  const request = h.pending.shift()
  h.input('proxy-b:7890') // 其他代码即使绕过 disabled 修改表单，也不能误清 dirty 或继续重启
  assert.equal(JSON.parse(request.options.body).proxy, 'proxy-a:7890')
  request.resolve({ success: true, message: '已保存', entry: '/admin', apiPrefix: '' })
  assert.equal(await save, false)
  assert.equal(h.dirty(), true)
  assert.match(h.messages.at(-1).message, /后续修改尚未保存/)
}
{
  const h = harness()
  h.input('proxy-a:7890')
  const save = h.context.saveSystemConfig()
  h.pending.shift().reject(new Error('offline'))
  assert.equal(await save, false)
  assert.equal(h.element('save').disabled, false)
  assert.equal(h.dirty(), true)
}
console.log('✓ test-admin-proxy: stale responses, cancellation, save locking, edit tracking and retry')
