#!/usr/bin/env node
/**
 * 管理页居中输入弹窗的回归测试。
 * 从 admin.html 提取实际函数，使用最小 DOM 事件替身验证异步交互和原有保存边界；
 * 不启动应用、不访问网络。布局与原生 dialog 的焦点约束另由浏览器检查。
 * 运行：node scripts/test-admin-prompt.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const admin = readFileSync(new URL('../web/admin.html', import.meta.url), 'utf8')
const functionSource = name => {
  // 顶层函数按相同缩进收尾，与已有 test-group-rename-moved.mjs 一致。
  const source = admin.match(new RegExp(`^ {8}(?:async )?function ${name}\\([^]*?^ {8}\\}`, 'm'))
  assert.ok(source, `admin.html 中找不到 ${name}`)
  return source[0]
}
const plain = value => JSON.parse(JSON.stringify(value))
let passed = 0
const check = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

class DomEvent {
  constructor(type, properties = {}) {
    Object.assign(this, { type, bubbles: true, defaultPrevented: false, propagationStopped: false }, properties)
  }
  preventDefault() { this.defaultPrevented = true }
  stopPropagation() { this.propagationStopped = true }
}

function promptHarness() {
  const pendingClose = []
  const document = { activeElement: null }
  class Element {
    constructor(parent = null) { this.parent = parent; this.listeners = new Map(); this.value = ''; this.textContent = '' }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set())
      this.listeners.get(type).add(fn)
    }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn) }
    dispatchEvent(event) {
      for (const fn of [...(this.listeners.get(event.type) || [])]) fn(event)
      if (event.bubbles && !event.propagationStopped) this.parent?.dispatchEvent(event)
      return !event.defaultPrevented
    }
    focus() { document.activeElement = this }
    select() { this.selectionStart = 0; this.selectionEnd = this.value.length }
  }
  const parent = new Element()
  const opener = new Element(parent)
  opener.focus()
  const dialog = new Element(parent)
  dialog.open = false
  dialog.showModal = () => {
    assert.equal(dialog.open, false, '先前弹窗必须先关闭')
    dialog.opener = document.activeElement
    dialog.open = true
  }
  dialog.close = () => {
    if (!dialog.open) return
    dialog.open = false
    dialog.opener?.focus()
    // HTML dialog 的 close 事件异步送达，可能晚于下一次 showModal。
    pendingClose.push(() => dialog.dispatchEvent(new DomEvent('close', { bubbles: false })))
  }
  const form = new Element(dialog)
  const input = new Element(form)
  const cancel = new Element(form)
  const title = new Element(form)
  const elements = { promptDialog: dialog, promptForm: form, promptInput: input, promptCancel: cancel, promptTitle: title }
  document.getElementById = id => { assert.ok(id in elements, `未知元素 ${id}`); return elements[id] }
  const context = vm.createContext({ document })
  vm.runInContext(`let cancelActivePrompt = null;\n${functionSource('showPrompt')}`, context)
  const submit = () => form.dispatchEvent(new DomEvent('submit'))
  const key = (name, properties = {}) => {
    const event = new DomEvent('keydown', { key: name, ...properties })
    input.dispatchEvent(event)
    // 浏览器默认行为：未被取消的 Enter 提交、Escape 发出 cancel。
    if (!event.defaultPrevented) {
      if (name === 'Enter') submit()
      if (name === 'Escape') {
        const canceled = new DomEvent('cancel', { bubbles: false })
        dialog.dispatchEvent(canceled)
        if (!canceled.defaultPrevented) dialog.close()
      }
    }
    return event
  }
  return {
    ...elements, parent, opener, document, show: context.showPrompt, submit, key,
    cancel: () => cancel.dispatchEvent(new DomEvent('click')),
    flushClose: () => { while (pendingClose.length) pendingClose.shift()() },
  }
}

await check('确认返回原始文本，默认值选中并聚焦，标题按文本处理', async () => {
  const h = promptHarness()
  const promise = h.show('<img src=x>', '原分组')
  assert.equal(h.promptTitle.textContent, '<img src=x>')
  assert.equal(h.promptInput.value, '原分组')
  assert.equal(h.document.activeElement, h.promptInput)
  assert.equal(h.promptInput.selectionStart, 0)
  assert.equal(h.promptInput.selectionEnd, 3)
  h.promptInput.value = '  新分组  '
  h.submit()
  assert.equal(await promise, '  新分组  ', 'trim 仍由原来的业务函数决定')
  assert.equal(h.promptDialog.open, false)
  assert.equal(h.document.activeElement, h.opener)
  h.flushClose()
})

await check('空字符串确认与取消不同；按钮、Escape、外部 close 都返回 null', async () => {
  const h = promptHarness()
  let promise = h.show('输入')
  h.submit()
  assert.equal(await promise, '')
  for (const dismiss of [h.cancel, () => h.key('Escape'), () => h.promptDialog.close()]) {
    promise = h.show('输入', '旧值')
    dismiss()
    h.flushClose()
    assert.equal(await promise, null)
  }
})

await check('连续打开会结束旧 Promise，迟到的 close 不取消新弹窗，监听器不累积', async () => {
  const h = promptHarness()
  const first = h.show('第一次', '一')
  const second = h.show('第二次', '二')
  assert.equal(await first, null)
  h.flushClose()
  assert.equal(h.promptDialog.open, true)
  assert.equal(h.promptInput.value, '二')
  h.key('Enter')
  assert.equal(await second, '二')
  h.flushClose()
  for (let i = 0; i < 3; i++) {
    const promise = h.show('再次打开', String(i))
    h.cancel()
    assert.equal(await promise, null)
    h.flushClose()
  }
  for (const element of [h.promptDialog, h.promptForm, h.promptCancel]) {
    assert.equal([...element.listeners.values()].reduce((sum, handlers) => sum + handlers.size, 0), 0)
  }
})

await check('中文输入法 Enter/Escape 不提交或关闭，Escape 不传到背后的弹窗', async () => {
  const h = promptHarness()
  let parentEscapes = 0
  h.parent.addEventListener('keydown', event => { if (event.key === 'Escape') parentEscapes++ })
  const promise = h.show('新建分组')
  for (const properties of [{ isComposing: true }, { keyCode: 229 }]) {
    for (const name of ['Enter', 'Escape']) {
      const event = h.key(name, properties)
      assert.equal(event.defaultPrevented, true)
      assert.equal(h.promptDialog.open, true)
    }
  }
  h.promptInput.value = '新闻'
  h.key('Escape')
  assert.equal(await promise, null)
  assert.equal(parentEscapes, 0)
  h.flushClose()
})

function confirmHarness() {
  const h = promptHarness()
  const dialog = h.promptDialog
  const classes = new Set()
  dialog.classList = { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) }
  const elements = { confirmOverlay: dialog, confirmTitle: h.promptTitle, confirmMessage: { textContent: '' } }
  h.document.getElementById = id => { assert.ok(id in elements, `未知元素 ${id}`); return elements[id] }
  const context = vm.createContext({ document: h.document })
  vm.runInContext(`let confirmCallback = null;\n${functionSource('showConfirm')}\n${functionSource('hideConfirm')}`, context)
  const dialogTag = admin.match(/<dialog\b[^>]*\bid="confirmOverlay"[^>]*>/)
  assert.ok(dialogTag, '确认弹窗应使用原生 dialog 提供焦点约束')
  for (const type of ['cancel', 'close', 'keydown']) {
    const code = dialogTag[0].match(new RegExp(`on${type}="([^"]*)"`))?.[1]
    assert.ok(code, `确认弹窗缺少 ${type} 处理`)
    const handler = vm.runInContext(`(function(event) { ${code} })`, context)
    dialog.addEventListener(type, event => handler.call(dialog, event))
  }
  return { ...h, ...elements, show: context.showConfirm, hide: context.hideConfirm }
}

await check('确认弹窗保留 true/false，重复打开和迟到 close 不会遗留或误结束 Promise', async () => {
  const h = confirmHarness()
  const first = h.show('第一次内容', '删除分组')
  const second = h.show('第二次内容', '删除配置档')
  assert.equal(await first, false)
  h.flushClose()
  assert.equal(h.promptDialog.open, true)
  assert.equal(h.confirmTitle.textContent, '删除配置档')
  assert.equal(h.confirmMessage.textContent, '第二次内容')
  assert.equal(h.promptDialog.classList.contains('show'), true)
  h.hide(true)
  assert.equal(await second, true)
  assert.equal(h.promptDialog.classList.contains('show'), false)
  h.flushClose()
  const third = h.show('再次确认')
  h.hide(false)
  assert.equal(await third, false)
  h.flushClose()
})

await check('确认弹窗的 Escape 和外部 close 取消，IME 保护与父层 Escape 隔离有效', async () => {
  const h = confirmHarness()
  let parentEscapes = 0
  h.parent.addEventListener('keydown', event => { if (event.key === 'Escape') parentEscapes++ })
  let promise = h.show('删除配置档？')
  for (const properties of [{ isComposing: true }, { keyCode: 229 }]) {
    for (const key of ['Enter', 'Escape']) {
      assert.equal(h.key(key, properties).defaultPrevented, true)
      assert.equal(h.promptDialog.open, true)
    }
  }
  h.key('Escape')
  assert.equal(await promise, false)
  assert.equal(parentEscapes, 0)
  h.flushClose()
  promise = h.show('外部关闭')
  h.promptDialog.close()
  h.flushClose()
  assert.equal(await promise, false)
})

function callerHarness(answer, overrides = {}) {
  const requests = [], statuses = [], prompts = [], saves = [], reloads = [], switches = []
  const config = { customGroups: [{ name: '收藏' }], groupOrder: ['收藏'] }
  const context = vm.createContext({
    API_PREFIX: '', activeProfile: 'family', profileList: [{ id: 'family', name: '家庭' }],
    myPlaylistConfig: config, myPlaylistData: [{ name: '收藏', channels: [] }], myPlaylistOriginalData: [],
    showPrompt: async (...args) => { prompts.push(args); return answer },
    showConfirm: async (...args) => { prompts.push(args); return answer },
    showStatus: (...args) => statuses.push(args),
    fetch: async (url, options) => { requests.push({ url, ...options, body: JSON.parse(options.body) }); return { json: async () => ({ success: true }) } },
    loadProfiles: async () => reloads.push('profiles'),
    switchProfile: async id => switches.push(id),
    mpConfigUrl: () => '/api/my-playlist-config',
    loadMyPlaylist: async () => reloads.push('playlist'),
    resetChannelSearch: () => {}, renderMyPlaylist: () => {}, revealActiveGroupItem: () => {},
    groupNameExists: name => name === '已存在',
    isSystemAnnouncementGroup: group => group.name === '系统公告',
    isCustomGroupName: name => name === '收藏',
    remapManualGroupInExternalSources: async (...args) => saves.push(['remap', ...args]),
    saveMyPlaylist: async () => { saves.push(['playlist']); return { success: true } },
    notifyState: { channels: [{ id: 'push1', name: '测试推送' }] },
    notifyPost: async body => { saves.push(['notify', body]); return { success: true, data: { channels: [] } } },
    notifyEditingId: null, closeNotifyForm: () => {}, renderNotify: () => {}, toastSaved: () => {},
    ...overrides,
  })
  vm.runInContext([
    functionSource('rewriteConfigForGroupRename'), functionSource('renameProfilePrompt'),
    functionSource('addGroup'), functionSource('renameGroup'),
    functionSource('deleteProfilePrompt'), functionSource('deleteNotifyChannel'),
  ].join('\n'), context)
  return { context, requests, statuses, prompts, saves, reloads, switches, config }
}

await check('三个调用方取消时不发请求、不保存、不改配置', async () => {
  for (const [name, argument] of [['addGroup'], ['renameGroup', 0], ['renameProfilePrompt', 'family']]) {
    const h = callerHarness(null)
    const before = plain(h.config)
    await h.context[name](argument)
    assert.deepEqual(h.requests, [])
    assert.deepEqual(h.saves, [])
    assert.deepEqual(h.config, before)
    assert.deepEqual(h.statuses, [])
  }
})

await check('新建分组保持空值、重名校验和提交前 trim', async () => {
  for (const answer of ['', '  ', ' 已存在 ']) {
    const h = callerHarness(answer)
    await h.context.addGroup()
    assert.deepEqual(h.requests, [])
    assert.deepEqual(h.config.customGroups, [{ name: '收藏' }])
    if (answer.trim()) assert.match(h.statuses[0][0], /已存在/)
  }
  const h = callerHarness('  新闻  ')
  await h.context.addGroup()
  assert.equal(h.requests.length, 1)
  assert.deepEqual(plain(h.requests[0].body.customGroups), [{ name: '收藏' }, { name: '新闻' }])
  assert.deepEqual(plain(h.requests[0].body.groupOrder), ['收藏', '新闻'])
  assert.deepEqual(h.reloads, ['playlist'])
  assert.deepEqual(h.prompts[0], ['新建分组', ''])
})

await check('重命名分组保持预填、空值/同名/重名检查和保存步骤', async () => {
  for (const answer of ['', ' ', '收藏', ' 收藏 ', '已存在']) {
    const h = callerHarness(answer)
    await h.context.renameGroup(0)
    assert.deepEqual(h.saves, [])
    assert.deepEqual(h.requests, [])
    assert.equal(h.config.customGroups[0].name, '收藏')
    assert.deepEqual(h.prompts[0], ['重命名分组', '收藏'])
    if (answer === '已存在') assert.match(h.statuses[0][0], /已存在/)
  }
  const h = callerHarness('  常看  ')
  await h.context.renameGroup(0)
  assert.deepEqual(h.saves, [['remap', '收藏', '常看'], ['playlist']])
  assert.equal(h.config.customGroups[0].name, '常看')
  assert.deepEqual(h.reloads, ['playlist'])
})

await check('配置档保留空值、20 字限制、默认档保护，合法名称才发 POST', async () => {
  for (const answer of ['', '  ', '名'.repeat(21)]) {
    const h = callerHarness(answer)
    await h.context.renameProfilePrompt('family')
    assert.deepEqual(h.requests, [])
    assert.match(h.statuses[0][0], answer.trim() ? /20/ : /不能为空/)
    assert.deepEqual(h.prompts[0], ['重命名配置档显示名：', '家庭'])
  }
  const protectedProfile = callerHarness('可用名称')
  await protectedProfile.context.renameProfilePrompt('default')
  assert.deepEqual(protectedProfile.prompts, [])
  assert.deepEqual(protectedProfile.requests, [])
  assert.match(protectedProfile.statuses[0][0], /不可改名/)
  const h = callerHarness(`  ${'名'.repeat(20)}  `)
  await h.context.renameProfilePrompt('family')
  assert.equal(h.requests.length, 1)
  assert.deepEqual(plain(h.requests[0].body), { action: 'rename', id: 'family', name: '名'.repeat(20) })
  assert.equal(h.requests[0].method, 'POST')
  assert.deepEqual(h.reloads, ['profiles'])
})

await check('删除配置档和推送渠道取消时不保存，确认后保持原来的删除请求', async () => {
  for (const [name, id] of [['deleteProfilePrompt', 'family'], ['deleteNotifyChannel', 'push1']]) {
    const canceled = callerHarness(false)
    await canceled.context[name](id)
    assert.deepEqual(canceled.requests, [])
    assert.deepEqual(canceled.saves, [])
    assert.deepEqual(canceled.statuses, [])
    assert.deepEqual(canceled.switches, [])
    assert.equal(canceled.prompts.length, 1)
    const confirmed = callerHarness(true)
    await confirmed.context[name](id)
    if (name === 'deleteProfilePrompt') {
      assert.deepEqual(plain(confirmed.requests[0].body), { action: 'delete', id })
      assert.deepEqual(confirmed.reloads, ['profiles'])
      assert.deepEqual(confirmed.switches, ['default'])
      assert.deepEqual(confirmed.statuses, [['已删除配置档', 'success']])
    } else {
      assert.deepEqual(plain(confirmed.saves), [['notify', { action: 'remove', id }]])
    }
  }
})

await check('删除其他配置档只刷新列表，默认档在确认前受保护', async () => {
  const inactive = callerHarness(true, {
    profileList: [{ id: 'family', name: '家庭' }, { id: 'bedroom', name: '卧室' }],
  })
  await inactive.context.deleteProfilePrompt('bedroom')
  assert.equal(inactive.requests.length, 1)
  assert.deepEqual(plain(inactive.requests[0].body), { action: 'delete', id: 'bedroom' })
  assert.deepEqual(inactive.reloads, ['profiles'])
  assert.deepEqual(inactive.switches, [])
  assert.equal(inactive.context.activeProfile, 'family')
  assert.deepEqual(inactive.statuses, [['已删除配置档', 'success']])

  const protectedProfile = callerHarness(true)
  await protectedProfile.context.deleteProfilePrompt('default')
  assert.deepEqual(protectedProfile.prompts, [])
  assert.deepEqual(protectedProfile.requests, [])
  assert.deepEqual(protectedProfile.saves, [])
  assert.deepEqual(protectedProfile.reloads, [])
  assert.deepEqual(protectedProfile.switches, [])
  assert.deepEqual(protectedProfile.statuses, [['默认档不可删除', 'error']])
})

console.log(`\n全部通过：${passed} 项`)
