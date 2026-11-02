#!/usr/bin/env node
/**
 * 后台「批量开关」弹窗的回归测试（issue #189）。
 * 从 admin.html 提取实际函数，在 node:vm 里配最小 DOM 替身跑完整流程：勾选 → 摘要 →
 * bulkToggle 请求体 → 成功关窗 / 失败留窗换基准。不启动应用、不访问网络；
 * 服务端的校验与「失败 ⇒ 开关没变」由 test-extractors.mjs 覆盖。
 * 运行：node scripts/test-admin-bulk-toggle.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const admin = readFileSync(new URL('../web/admin.html', import.meta.url), 'utf8')
const functionSource = name => {
  // 顶层函数按相同缩进收尾，与 test-admin-prompt.mjs 一致。
  const source = admin.match(new RegExp(`^ {8}(?:async )?function ${name}\\([^]*?^ {8}\\}`, 'm'))
  assert.ok(source, `admin.html 中找不到 ${name}`)
  return source[0]
}
const plain = value => JSON.parse(JSON.stringify(value))
let passed = 0
const check = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

const BULK_FUNCTIONS = [
  'extractorBulkSnapshot', 'extractorBulkSections', 'extractorBulkSetItems', 'extractorBulkChanges',
  'extractorBulkSummary', 'extractorBulkWarning', 'extractorBulkBody', 'extractorBulkRebase',
  'openExtractorBulk', 'closeExtractorBulk', 'renderExtractorBulk', 'paintExtractorBulk',
  'toggleExtractorBulkItem', 'setExtractorBulkSection', 'setExtractorBulkAll', 'resetExtractorBulk',
  'syncExtractorBulkBase', 'applyExtractorBulk', 'extractorBulkBlocked',
]
const SHARED_FUNCTIONS = ['escapeHtml', 'extractorCategories', 'applyExtractorResult']

// 模块清单仿 getState()：分类齐全，海外两个默认关；gdtv 故意不带 category，应按免账号处理
const MODULES = [
  ['migu', '咪咕视频', 'account', true], ['fengshows', '凤凰卫视', 'account', true],
  ['yangshipin', '央视频', 'account', true], ['sichuan', '四川', 'account', true],
  ['bilibili-live', 'B站直播', 'live', true], ['huya-live', '虎牙直播', 'live', true],
  ['ipanda', '熊猫频道', 'standard', true], ['gdtv', '广东', undefined, true], ['hbtv', '湖北', 'standard', true],
  ['overseas', '海外频道', 'overseas', false], ['tdm', '澳门', 'overseas', false],
]
const ALL_ON_FLAGS = { enableBuiltInSources: true, enableBuiltInSubscriptions: true }
const stateOf = (overrides = {}, contentFlags = ALL_ON_FLAGS, extra = {}) => ({
  corrupt: null,
  modules: MODULES.map(([id, name, category, enabled]) => ({
    id, name, ...(category ? { category } : {}), enabled: id in overrides ? overrides[id] : enabled,
    // 同 getState()：咪咕的开关代理到 system-config.json
    ...(id === 'migu' ? { enabledProxied: true } : {}),
  })),
  contentFlags: { ...contentFlags },
  ...extra,
})

const unescapeHtml = s => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[e]))
const makeButton = () => ({ disabled: false, focused: 0, focus() { this.focused++ } })

/**
 * 最小 DOM：弹窗正文的 innerHTML 一被赋值就按真实标记解析出「节 / 复选框 / 计数 / 节按钮」，
 * 所以 paint 读写的是 render 实际产出的结构，而不是测试自己拼的。
 */
function bulkHarness(initialState, { post } = {}) {
  const statuses = [], posts = [], reloads = [], externalRenders = []
  let sections = []
  const toolButtons = [makeButton(), makeButton(), makeButton()]
  const closeButton = makeButton()
  const opener = makeButton()
  const body = {
    scrollTop: 42,
    html: '',
    get innerHTML() { return this.html },
    set innerHTML(html) {
      this.html = html
      sections = html.split('<section').slice(1).map(chunk => {
        const id = unescapeHtml(chunk.match(/data-bulk-section="([^"]*)"/)[1])
        const section = { id, dataset: { bulkSection: id }, count: { textContent: '' } }
        section.buttons = [makeButton(), makeButton()].map(button => Object.assign(button, { closest: () => section }))
        section.inputs = [...chunk.matchAll(/<input[^>]*data-bulk-kind="([^"]*)" data-bulk-id="([^"]*)"/g)].map(([, kind, itemId]) => {
          const item = { dataset: {} }
          return { dataset: { bulkKind: unescapeHtml(kind), bulkId: unescapeHtml(itemId) }, checked: false, disabled: false, item, closest: () => item }
        })
        section.querySelectorAll = selector => { assert.equal(selector, 'input[data-bulk-id]'); return section.inputs }
        section.querySelector = selector => { assert.equal(selector, '[data-bulk-count]'); return section.count }
        return section
      })
    },
  }
  const modal = {
    style: { display: 'none' }, attrs: {},
    setAttribute(key, value) { this.attrs[key] = value },
    querySelector: selector => { assert.equal(selector, '.extractor-modal-close'); return closeButton },
    querySelectorAll(selector) {
      if (selector === '[data-bulk-section]') return sections
      assert.match(selector, /\.extractor-bulk-tools button/)
      assert.match(selector, /\.extractor-bulk-section-actions button/)
      return [...toolButtons, ...sections.flatMap(section => section.buttons)]
    },
  }
  const elements = {
    extractorBulkModal: modal, extractorBulkBody: body,
    extractorBulkSummary: { textContent: '' }, extractorBulkWarning: { textContent: '', hidden: true },
    extractorBulkCorrupt: { hidden: true }, extractorBulkApply: Object.assign(makeButton(), { disabled: true, textContent: '应用' }),
  }
  const document = {
    getElementById: id => elements[id] || null,
    querySelector: selector => (selector === '#extractorFilter .extractor-bulk-btn' ? opener
      : selector === '#extractorBulkModal .extractor-modal-close' ? closeButton : null),
  }
  const h = { statuses, posts, reloads, externalRenders, modal, body, elements, opener, closeButton, toolButtons, nextReloadState: null }
  const context = vm.createContext({
    document,
    setTimeout: fn => fn(),
    showStatus: (message, type) => statuses.push([message, type]),
    extractorPost: async request => {
      posts.push(plain(request))
      return post ? post(request, h) : { success: true, data: initialState }
    },
    // 真 loadExtractors 重拉成功后走 renderExtractors；这里同步模拟，状态由各用例给
    loadExtractors: () => {
      reloads.push(true)
      if (h.nextReloadState) { context.extractorsState = h.nextReloadState; context.renderExtractors() }
    },
    renderExternalSources: () => externalRenders.push(true),
    // 真 renderExtractors 在两条提前 return 之前就调 syncExtractorBulkBase（下面有静态检查）
    renderExtractors: () => context.syncExtractorBulkBase(),
  })
  vm.runInContext([
    'var extractorsState = null, extractorBulkBase = null, extractorBulkDraft = null, extractorBulkBusy = false, extractorBulkSession = 0;',
    ...[...SHARED_FUNCTIONS, ...BULK_FUNCTIONS].map(functionSource),
  ].join('\n'), context)
  context.extractorsState = initialState
  Object.assign(h, {
    context,
    sections: () => sections,
    section: id => sections.find(section => section.id === id),
    input: id => sections.flatMap(section => section.inputs).find(input => input.dataset.bulkId === id),
    click: (id, checked) => { const input = h.input(id); input.checked = checked; context.toggleExtractorBulkItem(input) },
    summary: () => elements.extractorBulkSummary.textContent,
    apply: () => context.applyExtractorBulk(),
    isOpen: () => modal.style.display === 'block',
  })
  return h
}

await check('分类元数据抽成 extractorCategories：卡片区与弹窗共用，test-extractors 的切片检查仍成立', () => {
  const start = admin.indexOf('const categories = [')
  assert.ok(start > 0)
  const block = admin.slice(start, admin.indexOf('];', start))
  const ids = [...block.matchAll(/id: '([^']+)'/g)].map(match => match[1])
  assert.deepEqual(ids, ['account', 'live', 'standard', 'overseas'])
  const render = functionSource('renderExtractors')
  assert.match(render, /const categories = extractorCategories\(\);/)
  assert.doesNotMatch(render, /const categories = \[/, '分类只能有一份')
  // 弹窗基准的同步要在「拿不到 #extractorList / 零模块」两条提前 return 之前
  assert.ok(render.indexOf('syncExtractorBulkBase();') > 0)
  assert.ok(render.indexOf('syncExtractorBulkBase();') < render.indexOf('if (!box) return;'))
  const context = vm.createContext({})
  vm.runInContext(functionSource('extractorCategories'), context)
  assert.deepEqual(plain(context.extractorCategories()).map(c => [c.id, c.title]),
    [['account', '账号与授权'], ['live', '网络直播平台'], ['standard', '免账号模块'], ['overseas', '海外']])
})

await check('弹窗标记沿用提醒列表的模式：dialog 语义、关闭按钮、Esc 与遮罩关闭、提示文案', () => {
  const tag = admin.match(/<div class="modal" id="extractorBulkModal"[^>]*>/)?.[0]
  assert.ok(tag, '缺 extractorBulkModal')
  for (const attr of ['role="dialog"', 'aria-modal="true"', 'aria-hidden="true"', 'aria-labelledby="extractorBulkTitle"']) assert.ok(tag.includes(attr), attr)
  assert.match(admin, /<h3 id="extractorBulkTitle">批量开关<\/h3>/)
  assert.match(admin, /class="extractor-modal-close" onclick="closeExtractorBulk\(\)"/)
  assert.ok(admin.includes('勾选要保留的来源，点「应用」一次保存；没勾的关闭，配置原样保留，随时可以开回来。'))
  for (const action of ['setExtractorBulkAll(true)">全选', 'setExtractorBulkAll(false)">全不选', 'resetExtractorBulk()"']) assert.ok(admin.includes(action), action)
  assert.match(admin, /id="extractorBulkApply" onclick="applyExtractorBulk\(\)"/)
  assert.ok(admin.includes("if (event.target === document.getElementById('extractorBulkModal')) closeExtractorBulk();"))
  assert.ok(admin.includes("const modal = document.getElementById('extractorBulkModal');\n            if (event.key === 'Escape' && modal && modal.style.display === 'block') closeExtractorBulk();"))
  // 本仓库只用自己的 showConfirm / showPrompt，不弹浏览器原生框
  for (const name of BULK_FUNCTIONS) assert.doesNotMatch(functionSource(name), /\b(?:window\.)?(?:prompt|confirm|alert)\(/, name)
})

await check('入口按钮跟筛选同一行但不进筛选组；零模块时整行为空，:empty 规则照旧隐藏', () => {
  const bar = { innerHTML: 'stale' }
  const context = vm.createContext({ document: { getElementById: id => (id === 'extractorFilter' ? bar : null) }, extractorFilter: 'all' })
  vm.runInContext(functionSource('renderExtractorFilter'), context)
  context.renderExtractorFilter([])
  assert.equal(bar.innerHTML, '')
  context.renderExtractorFilter(stateOf().modules)
  const group = bar.innerHTML.match(/<div class="extractor-filter-group" role="group" aria-label="按开关筛选模块">([^]*?)<\/div>/)
  assert.ok(group, '筛选按钮仍要在 role=group 里')
  assert.equal((group[1].match(/extractor-filter-btn/g) || []).length, 3)
  assert.doesNotMatch(group[1], /openExtractorBulk/)
  const after = bar.innerHTML.slice(bar.innerHTML.indexOf(group[0]) + group[0].length)
  assert.match(after, /class="extractor-filter-btn extractor-bulk-btn"[^>]*onclick="openExtractorBulk\(\)">批量开关<\/button>/)
  assert.doesNotMatch(admin, /id="extractorFilter" role="group"/, '外层不再整体标成筛选组')
})

await check('快照与分节：缺省内置源视为开，分类顺序同卡片区，未登记分类收进「其他」，内置源殿后', () => {
  const h = bulkHarness(stateOf())
  const snapshot = plain(h.context.extractorBulkSnapshot({ modules: [{ id: 'a', enabled: 1 }, { id: 'b' }] }))
  assert.deepEqual(snapshot, { modules: { a: true, b: false }, flags: { enableBuiltInSources: true, enableBuiltInSubscriptions: true } })
  assert.deepEqual(plain(h.context.extractorBulkSnapshot({ modules: [], contentFlags: { enableBuiltInSubscriptions: false } })).flags,
    { enableBuiltInSources: true, enableBuiltInSubscriptions: false })
  const state = stateOf()
  state.modules.push({ id: 'future', name: '新分类模块', category: 'brand-new', enabled: true })
  const sections = plain(h.context.extractorBulkSections(state))
  assert.deepEqual(sections.map(s => [s.id, s.title]),
    [['account', '账号与授权'], ['live', '网络直播平台'], ['standard', '免账号模块'], ['overseas', '海外'], ['__other', '其他'], ['__builtin', '内置源']])
  assert.deepEqual(sections[2].items.map(item => item.id), ['ipanda', 'gdtv', 'hbtv'], '没写分类的按免账号处理')
  assert.deepEqual(sections[5].items, [
    { kind: 'flag', id: 'enableBuiltInSources', name: '内置单频道源' },
    { kind: 'flag', id: 'enableBuiltInSubscriptions', name: '内置订阅源（精选频道）' },
  ])
  // 没有模块的分类不出空节
  assert.deepEqual(plain(h.context.extractorBulkSections({ modules: [{ id: 'x', name: 'X', category: 'live' }] })).map(s => s.id), ['live', '__builtin'])
})

await check('issue #189：全不选后只勾回央视频 / 凤凰 / 咪咕，一次请求只带真正要改的', async () => {
  const after = stateOf({ sichuan: false, 'bilibili-live': false, 'huya-live': false, ipanda: false, gdtv: false, hbtv: false },
    { enableBuiltInSources: false, enableBuiltInSubscriptions: false })
  const h = bulkHarness(stateOf(), { post: () => ({ success: true, data: after }) })
  h.context.openExtractorBulk()
  assert.equal(h.isOpen(), true)
  assert.equal(h.modal.attrs['aria-hidden'], 'false')
  assert.equal(h.closeButton.focused, 1, '打开后焦点给关闭按钮')
  assert.equal(h.body.scrollTop, 0)
  assert.equal(h.summary(), '没有改动')
  assert.equal(h.elements.extractorBulkApply.disabled, true)
  assert.equal(h.section('account').count.textContent, '已选 4/4')
  assert.equal(h.section('overseas').count.textContent, '已选 0/2')
  assert.equal(h.section('__builtin').count.textContent, '已选 2/2')
  assert.match(h.body.innerHTML, /自定义源[^<]*「自定义源」标签/, '说明自定义源在自己的标签里管')

  h.context.setExtractorBulkAll(false)
  assert.equal(h.summary(), '将关闭 11 个', '9 个开着的模块 + 2 个内置源；本来就关的海外不算')
  assert.equal(h.elements.extractorBulkWarning.hidden, false)
  assert.match(h.elements.extractorBulkWarning.textContent, /约 150 个精选频道/)
  for (const id of ['migu', 'fengshows', 'yangshipin']) h.click(id, true)
  assert.equal(h.summary(), '将关闭 8 个')
  assert.equal(h.section('account').count.textContent, '已选 3/4')
  assert.equal(h.input('migu').item.dataset.change, '', '勾回原状态的不标改动')
  assert.equal(h.input('sichuan').item.dataset.change, 'off')
  assert.equal(h.input('overseas').item.dataset.change, '')
  assert.equal(h.elements.extractorBulkApply.disabled, false)

  await h.apply()
  assert.deepEqual(h.posts, [{
    action: 'bulkToggle',
    modules: { sichuan: false, 'bilibili-live': false, 'huya-live': false, ipanda: false, gdtv: false, hbtv: false },
    contentFlags: { enableBuiltInSources: false, enableBuiltInSubscriptions: false },
  }])
  for (const value of [...Object.values(h.posts[0].modules), ...Object.values(h.posts[0].contentFlags)]) assert.equal(typeof value, 'boolean')
  assert.deepEqual(h.statuses, [['已关闭 8 个', 'success']])
  assert.equal(h.isOpen(), false, '成功后关窗')
  assert.equal(h.modal.attrs['aria-hidden'], 'true')
  assert.equal(h.context.extractorBulkDraft, null)
  assert.equal(h.opener.focused, 1, '焦点还给「批量开关」按钮')
  assert.equal(h.externalRenders.length, 1, '内置订阅源变了，自定义源卡片要重画')
  assert.equal(h.context.extractorsState, after)
})

await check('只改内置源时 modules 是空对象；只改模块时不带 contentFlags、也不重画自定义源', async () => {
  const flagsOnly = bulkHarness(stateOf())
  flagsOnly.context.openExtractorBulk()
  flagsOnly.click('enableBuiltInSources', false)
  assert.equal(flagsOnly.summary(), '将关闭 1 个')
  assert.equal(flagsOnly.elements.extractorBulkWarning.hidden, true, '只关单频道源不触发精选频道提醒')
  await flagsOnly.apply()
  assert.deepEqual(flagsOnly.posts, [{ action: 'bulkToggle', modules: {}, contentFlags: { enableBuiltInSources: false } }])
  assert.equal(flagsOnly.externalRenders.length, 0)

  const modulesOnly = bulkHarness(stateOf())
  modulesOnly.context.openExtractorBulk()
  modulesOnly.click('overseas', true)
  modulesOnly.click('huya-live', false)
  assert.equal(modulesOnly.summary(), '将启用 1 个、关闭 1 个')
  assert.equal(modulesOnly.input('overseas').item.dataset.change, 'on')
  await modulesOnly.apply()
  assert.deepEqual(modulesOnly.posts, [{ action: 'bulkToggle', modules: { overseas: true, 'huya-live': false } }])
  assert.equal('contentFlags' in modulesOnly.posts[0], false)
  assert.deepEqual(modulesOnly.statuses, [['已启用 1 个、关闭 1 个', 'success']])
  assert.equal(modulesOnly.externalRenders.length, 0)
})

await check('节内全选 / 全不选只动本节，「还原」回到打开时的服务端状态', () => {
  const h = bulkHarness(stateOf())
  h.context.openExtractorBulk()
  h.context.setExtractorBulkSection(h.section('live').buttons[1], false)
  assert.equal(h.section('live').count.textContent, '已选 0/2')
  assert.equal(h.section('account').count.textContent, '已选 4/4')
  assert.equal(h.summary(), '将关闭 2 个')
  h.context.setExtractorBulkSection(h.section('overseas').buttons[0], true)
  assert.equal(h.summary(), '将启用 2 个、关闭 2 个')
  h.context.resetExtractorBulk()
  assert.equal(h.summary(), '没有改动')
  assert.equal(h.elements.extractorBulkApply.disabled, true)
  assert.equal(h.input('overseas').checked, false)
  assert.equal(h.input('huya-live').checked, true)
  // 还原出来的是拷贝：再勾不会改坏基准
  h.click('migu', false)
  assert.equal(h.context.extractorBulkBase.modules.migu, true)
  h.context.closeExtractorBulk()
  assert.equal(h.isOpen(), false)
  assert.equal(h.posts.length, 0, '关掉即放弃，不发请求')
})

await check('配置文件损坏时：动到普通模块就提示并禁用「应用」、不发请求；只动咪咕和内置源照样能应用', async () => {
  const h = bulkHarness(stateOf({}, ALL_ON_FLAGS, { corrupt: { message: 'Unexpected token' } }))
  h.context.openExtractorBulk()
  assert.equal(h.elements.extractorBulkCorrupt.hidden, true, '没改动时不提示')
  h.context.setExtractorBulkAll(false)
  assert.equal(h.elements.extractorBulkCorrupt.hidden, false)
  assert.equal(h.elements.extractorBulkApply.disabled, true)
  await h.apply()
  assert.deepEqual(h.posts, [])

  // 服务端对这两类不碰 extractors.json：咪咕写 system-config.json，内置源也是
  h.context.resetExtractorBulk()
  h.click('migu', false)
  h.click('enableBuiltInSubscriptions', false)
  assert.equal(h.elements.extractorBulkCorrupt.hidden, true)
  assert.equal(h.elements.extractorBulkApply.disabled, false)
  await h.apply()
  assert.deepEqual(h.posts, [{ action: 'bulkToggle', modules: { migu: false }, contentFlags: { enableBuiltInSubscriptions: false } }])
})

await check('请求在路上：勾选和按钮全禁用、不重复提交；失败留窗、报错并重拉，按钮恢复', async () => {
  let resolve
  const h = bulkHarness(stateOf(), { post: () => new Promise(r => { resolve = r }) })
  h.context.openExtractorBulk()
  h.click('hbtv', false)
  const pending = h.apply()
  assert.equal(h.elements.extractorBulkApply.disabled, true)
  assert.equal(h.elements.extractorBulkApply.textContent, '应用中…')
  assert.ok(h.sections().every(section => section.inputs.every(input => input.disabled) && section.buttons.every(b => b.disabled)))
  assert.ok(h.toolButtons.every(button => button.disabled))
  await h.apply()
  assert.equal(h.posts.length, 1, '在路上时再点不重复提交')
  resolve({ success: false, message: '配置文件损坏' })
  await pending
  assert.equal(h.isOpen(), true, '失败留窗')
  assert.deepEqual(h.statuses, [['配置文件损坏', 'error']])
  assert.equal(h.reloads.length, 1)
  assert.equal(h.elements.extractorBulkApply.disabled, false)
  assert.equal(h.elements.extractorBulkApply.textContent, '应用')
  assert.equal(h.elements.extractorBulkApply.focused, 1, '应用中按钮被禁用、焦点掉到了 body；失败留窗时要拉回弹窗里')
  assert.equal(h.input('hbtv').disabled, false)
  assert.equal(h.summary(), '将关闭 1 个', '什么都没生效，草稿原样保留')
})

await check('断网或返回非 JSON：不卡在「应用中…」，按失败处理', async () => {
  const h = bulkHarness(stateOf(), { post: () => { throw new Error('Failed to fetch') } })
  h.context.openExtractorBulk()
  h.click('ipanda', false)
  await h.apply()
  assert.equal(h.context.extractorBulkBusy, false)
  assert.equal(h.isOpen(), true)
  assert.deepEqual(h.statuses, [['批量开关失败：Failed to fetch', 'error']])
  assert.equal(h.elements.extractorBulkApply.disabled, false)
})

await check('模块已存好、只有内置源没存上：重拉后换基准，摘要只剩没生效的部分', async () => {
  const h = bulkHarness(stateOf(), { post: () => ({ success: false, message: '模块开关已保存，但内置源开关保存失败：磁盘只读' }) })
  h.context.openExtractorBulk()
  h.click('sichuan', false)
  h.click('tdm', true)
  h.click('enableBuiltInSubscriptions', false)
  assert.equal(h.summary(), '将启用 1 个、关闭 2 个')
  h.nextReloadState = stateOf({ sichuan: false, tdm: true })
  await h.apply()
  assert.equal(h.isOpen(), true)
  assert.match(h.statuses[0][0], /模块开关已保存/)
  assert.equal(h.summary(), '将关闭 1 个')
  assert.equal(h.input('sichuan').checked, false, '用户的勾选保留')
  assert.equal(h.input('sichuan').item.dataset.change, '', '已生效的不再标改动')
  assert.equal(h.externalRenders.length, 1)
  h.posts.length = 0
  await h.apply()
  assert.deepEqual(h.posts, [{ action: 'bulkToggle', modules: {}, contentFlags: { enableBuiltInSubscriptions: false } }])
})

await check('请求没回来就关掉重开：旧请求成功不关新弹窗，新弹窗没动过的项跟着新状态走', async () => {
  let resolve
  const after = stateOf({ sichuan: false, 'huya-live': false })
  const h = bulkHarness(stateOf(), { post: () => new Promise(r => { resolve = r }) })
  h.context.openExtractorBulk()
  h.click('sichuan', false)
  h.click('huya-live', false)
  const pending = h.apply()
  h.context.closeExtractorBulk()
  h.context.openExtractorBulk()      // 基于旧状态打开：sichuan 仍显示为开
  assert.equal(h.input('sichuan').checked, true)
  h.click('hbtv', false)             // 新弹窗里用户自己改了一项
  resolve({ success: true, data: after })
  await pending
  assert.equal(h.isOpen(), true, '旧请求不关掉新开的弹窗')
  assert.equal(h.input('sichuan').checked, false, '没动过的项跟着新状态，不会变成「把刚关的开回来」')
  assert.equal(h.input('hbtv').checked, false, '新弹窗里改过的保留')
  assert.equal(h.summary(), '将关闭 1 个')
})

await check('换基准：新出现的模块按新状态补上，已下架的丢掉；下架的模块不会被提交', () => {
  const h = bulkHarness(stateOf())
  const base = { modules: { a: true, b: true, gone: true }, flags: { ...ALL_ON_FLAGS } }
  const draft = { modules: { a: false, b: true, gone: false }, flags: { enableBuiltInSources: false, enableBuiltInSubscriptions: true } }
  const next = { modules: { a: true, b: false, fresh: false }, flags: { enableBuiltInSources: true, enableBuiltInSubscriptions: false } }
  assert.deepEqual(plain(h.context.extractorBulkRebase(base, draft, next)), {
    modules: { a: false, b: false, fresh: false },
    flags: { enableBuiltInSources: false, enableBuiltInSubscriptions: false },
  })
  const changes = plain(h.context.extractorBulkChanges({ modules: { a: true }, flags: {} }, { modules: { a: false, unknown: false }, flags: {} }))
  assert.deepEqual(changes, { modules: { a: false }, contentFlags: {}, enable: 0, disable: 1 })
  assert.equal(h.context.extractorBulkSummary({ enable: 0, disable: 0 }), '没有改动')
  assert.equal(h.context.extractorBulkSummary({ enable: 3, disable: 0 }, '已'), '已启用 3 个')
})

await check('名字和 id 一律转义，id 只进 data-*，不拼进 onclick 的 JS 字符串', () => {
  const state = stateOf()
  state.modules.push({ id: `x"y'z`, name: '<img src=x onerror=alert(1)>', category: 'standard', enabled: true })
  const h = bulkHarness(state)
  h.context.openExtractorBulk()
  assert.doesNotMatch(h.body.innerHTML, /<img/)
  assert.ok(h.body.innerHTML.includes('&lt;img src=x onerror=alert(1)&gt;'))
  assert.ok(h.body.innerHTML.includes('data-bulk-id="x&quot;y&#39;z"'))
  for (const handler of h.body.innerHTML.matchAll(/on(?:click|change)="([^"]*)"/g)) {
    assert.match(handler[1], /^(?:toggleExtractorBulkItem\(this\)|setExtractorBulkSection\(this, (?:true|false)\))$/)
  }
  h.click(`x"y'z`, false)
  assert.equal(h.summary(), '将关闭 1 个')
})

console.log(`\n全部通过：${passed} 项`)
