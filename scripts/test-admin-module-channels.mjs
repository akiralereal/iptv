#!/usr/bin/env node
/**
 * 源管理模块详情里的频道名单：开着的模块点频道名看只读详情（issue #164 的名单 + 本次的点击）。
 * 从 admin.html 提取实际函数在 node:vm 里跑，不启动应用、不访问网络。
 * 运行：node scripts/test-admin-module-channels.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const admin = readFileSync(new URL('../web/admin.html', import.meta.url), 'utf8')
const functionSource = name => {
  const source = admin.match(new RegExp(`^ {8}(?:async )?function ${name}\\([^]*?^ {8}\\}`, 'm'))
  assert.ok(source, `admin.html 中找不到 ${name}`)
  return source[0]
}
let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }

// 播放列表原始全集：同一模块两个市都有「新闻综合」，另有别的模块同名台、咪咕同名台
const ORIGINAL = [
  { name: '四川', channels: [
    { id: 'sc-1', name: '新闻综合', originalGroup: '四川', sourceIds: ['xt:sichuan-cities'] },
    { id: 'sc-2', name: '四川卫视', originalGroup: '四川', sourceIds: ['xt:sichuan', 'migu'] },
  ] },
  { name: '成都', channels: [
    { id: 'cd-1', name: '新闻综合', originalGroup: '成都', sourceIds: ['xt:sichuan-cities'] },
    { id: 'cd-2', name: '新闻综合', originalGroup: '成都', sourceIds: ['xt:chengdu'] },
  ] },
  { name: '卫视', channels: [
    { id: 'ws-1', name: '四川卫视', originalGroup: '卫视', sourceIds: ['migu'] },
  ] },
]
// 当前档：成都那个「新闻综合」被隐藏了
const CURRENT = ORIGINAL.map(g => ({ ...g, channels: g.channels.filter(ch => ch.id !== 'cd-1') }))

function harness() {
  const opened = []
  const statuses = []
  const context = {
    myPlaylistOriginalData: ORIGINAL,
    myPlaylistData: CURRENT,
    showChannelDetail: (...args) => opened.push(args),
    showStatus: (msg, type) => statuses.push([msg, type]),
  }
  vm.createContext(context)
  for (const name of ['escapeHtml', 'extractorChannelsHtml', 'findModuleChannel', 'openModuleChannelDetail']) {
    vm.runInContext(functionSource(name), context)
  }
  return { context, opened, statuses }
}

const moduleOf = (overrides = {}) => ({
  id: 'sichuan-cities', sourceId: 'xt:sichuan-cities', enabled: true, health: { status: 'ok' },
  channelGroups: [{ name: '四川', channels: ['新闻综合'] }, { name: '成都', channels: ['新闻综合', '还没进列表'] }],
  ...overrides,
})

check('按来源 + 原始分组对上同名台，别的模块同名台不串', () => {
  const { context } = harness()
  assert.equal(context.findModuleChannel('xt:sichuan-cities', '成都', '新闻综合').id, 'cd-1')
  assert.equal(context.findModuleChannel('xt:sichuan-cities', '四川', '新闻综合').id, 'sc-1')
  assert.equal(context.findModuleChannel('xt:chengdu', '成都', '新闻综合').id, 'cd-2')
})

check('分组对不上时按来源退回第一个同名台（模块分组被归到省里等）', () => {
  const { context } = harness()
  assert.equal(context.findModuleChannel('xt:sichuan-cities', '不存在的分组', '新闻综合').id, 'sc-1')
  // 多源合并后的频道带着每个来源的标记，咪咕名单也能对上
  assert.equal(context.findModuleChannel('migu', '卫视', '四川卫视').id, 'ws-1')
  assert.equal(context.findModuleChannel('xt:sichuan', '四川', '四川卫视').id, 'sc-2')
  assert.equal(context.findModuleChannel('', '四川', '新闻综合'), null)
  assert.equal(context.findModuleChannel('xt:sichuan-cities', '成都', '还没进列表'), null)
})

check('开着的模块：找得到的频道是按钮，找不到的保持纯文字，并提示可点', () => {
  const { context } = harness()
  const html = context.extractorChannelsHtml(moduleOf())
  assert.equal((html.match(/<button type="button" class="extractor-channel-chip"/g) || []).length, 2)
  assert.match(html, /<span class="extractor-channel-chip" title="还没进列表：播放列表里没有这一路，不能查看详情">还没进列表<\/span>/)
  assert.match(html, /点频道名查看详情/)
  assert.match(html, /openModuleChannelDetail\(&quot;xt:sichuan-cities&quot;, &quot;成都&quot;, &quot;新闻综合&quot;\)/)
})

check('关着的模块：名单只是缓存，一律不可点、不提示', () => {
  const { context } = harness()
  const html = context.extractorChannelsHtml(moduleOf({ enabled: false }))
  assert.doesNotMatch(html, /<button/)
  assert.doesNotMatch(html, /点频道名查看详情/)
  assert.doesNotMatch(html, /不能查看详情/)
  assert.match(html, /关闭前抓到的频道/)
})

check('旧服务端没给 sourceId：不可点，不报错', () => {
  const { context } = harness()
  const html = context.extractorChannelsHtml(moduleOf({ sourceId: undefined }))
  assert.doesNotMatch(html, /<button/)
})

check('点开是只读详情；当前档隐藏的标未显示', () => {
  const { context, opened } = harness()
  context.openModuleChannelDetail('xt:sichuan-cities', '四川', '新闻综合')
  context.openModuleChannelDetail('xt:sichuan-cities', '成都', '新闻综合')
  assert.deepEqual(JSON.parse(JSON.stringify(opened)), [
    ['sc-1', false, { readOnly: true }],
    ['cd-1', true, { readOnly: true }],
  ])
})

check('列表刷新后频道没了：提示而不是打开空详情', () => {
  const { context, opened, statuses } = harness()
  context.openModuleChannelDetail('xt:sichuan-cities', '成都', '还没进列表')
  assert.equal(opened.length, 0)
  assert.equal(statuses.length, 1)
  assert.equal(statuses[0][1], 'error')
})

check('只读详情不渲染任何编辑入口', () => {
  const detail = functionSource('showChannelDetail')
  // 编辑区、别名、编辑按钮都要被 readOnly 挡住
  assert.match(detail, /if \(readOnly\) \{[^]*?\} else if \(!isDeleted\) \{/)
  assert.match(detail, /!channel\.epgMatched && !readOnly/)
  assert.match(detail, /sourceType === 'external' && !readOnly/)
})

console.log(`\n✅ 源管理频道名单测试全部通过（${passed} 项）`)
