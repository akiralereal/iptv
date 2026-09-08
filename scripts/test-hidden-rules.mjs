#!/usr/bin/env node
/**
 * 按名字长期屏蔽频道的规则匹配测试（issue #123）
 *
 * 背景：hiddenChannels 按 `原始分组::频道ID` 存，而频道 ID 含播放地址——上游换路径就换 ID，
 * 那条隐藏静默失效。另有一类频道（每天重建的赛事 / 事件直播）根本没有稳定 ID，
 * 逐条隐藏对它们没意义。规则按**名字**匹配，两种情况都盖得住。
 *
 * 最危险的失败模式：空 value 的规则。'' 会让 includes('') 恒为真，一条手滑存下的空规则
 * 将清空整份播放列表。normalizeHiddenRules 必须在存盘与匹配两侧都把它丢掉——本文件钉死这条。
 *
 * 运行： node scripts/test-hidden-rules.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { normalizeHiddenRules, matchHiddenRule } from '../utils/hiddenRules.js'
import { applyConfig, collectGroupConflicts } from '../utils/playlistConfig.js'

for (const k of ['log', 'info', 'warn']) {
  const orig = console[k]
  console[k] = (...a) => { if (a.some(x => typeof x === 'string' && /应用播放列表配置|配置应用完成/.test(x))) return; orig.apply(console, a) }
}

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const hit = (names, rules) => matchHiddenRule(names, rules) !== null

console.log('按名字屏蔽频道的规则匹配测试 (issue #123)')

// ── 安全底线：空规则永不命中 ───────────────────────────────────────────────
check('空 value 的规则被丢弃，绝不命中（否则一条空规则清空整份播放列表）', () => {
  for (const bad of [[{ value: '' }], [{ value: '   ' }], [''], ['   '], [{ mode: 'exact' }]]) {
    assert.deepEqual(normalizeHiddenRules(bad), [], `未丢弃: ${JSON.stringify(bad)}`)
    assert.equal(hit('CCTV1综合', bad), false, `空规则命中了: ${JSON.stringify(bad)}`)
  }
})

check('规则数组本身非法（null / 非数组 / 元素是数字）→ 一律不命中，不抛错', () => {
  for (const bad of [null, undefined, 'CCTV', {}, [null], [123], [[]]]) {
    assert.equal(hit('CCTV1综合', bad), false)
  }
  assert.deepEqual(normalizeHiddenRules(null), [])
})

check('频道名为空 / 非字符串 → 不命中（不能让无名频道被任意规则扫掉）', () => {
  const rules = [{ value: 'CCTV', mode: 'contains' }]
  for (const bad of [[], [''], ['   '], [null], [undefined], [123]]) {
    assert.equal(hit(bad, rules), false)
  }
})

// ── exact：一键「永久屏蔽此频道名」用的形态 ────────────────────────────────
check('exact：整名相等才命中', () => {
  const rules = [{ value: 'CCTV5+体育赛事', mode: 'exact' }]
  assert.equal(hit('CCTV5+体育赛事', rules), true)
  assert.equal(hit('CCTV5体育', rules), false)
  assert.equal(hit('CCTV5+体育赛事高清', rules), false, 'exact 不得退化成前缀匹配')
})

check('exact 不误伤：屏蔽 CCTV5 不得连 CCTV5+ 一起带走', () => {
  const rules = [{ value: 'CCTV5', mode: 'exact' }]
  assert.equal(hit('CCTV5', rules), true)
  assert.equal(hit('CCTV5+体育赛事', rules), false)
})

check('exact 命中时返回那条规则本身（界面要标注「按规则隐藏」）', () => {
  const r = matchHiddenRule('CCTV5', [{ value: 'CCTV5', mode: 'exact' }])
  assert.deepEqual(r, { value: 'CCTV5', mode: 'exact' })
})

// ── contains：手输、一次盖住一批 ───────────────────────────────────────────
check('contains：子串命中', () => {
  const rules = [{ value: '购物', mode: 'contains' }]
  assert.equal(hit('优购物', rules), true)
  assert.equal(hit('家家购物', rules), true)
  assert.equal(hit('CCTV1综合', rules), false)
})

check('缺省 mode 按 contains 解释；裸字符串规则同样按 contains', () => {
  assert.equal(hit('优购物', [{ value: '购物' }]), true)
  assert.equal(hit('优购物', ['购物']), true)
  assert.deepEqual(normalizeHiddenRules(['购物']), [{ value: '购物', mode: 'contains' }])
})

check('大小写不敏感（两种 mode 都是）', () => {
  assert.equal(hit('cctv5+体育赛事', [{ value: 'CCTV5+体育赛事', mode: 'exact' }]), true)
  assert.equal(hit('CCTV5+体育赛事', [{ value: 'cctv5', mode: 'contains' }]), true)
})

check('规则与频道名两侧都去空白（用户粘贴时常带首尾空格）', () => {
  assert.equal(hit('  CCTV5  ', [{ value: 'CCTV5', mode: 'exact' }]), true)
  assert.equal(hit('CCTV5', [{ value: '  CCTV5  ', mode: 'exact' }]), true)
})

// ── 多名字：原始名与重命名后的显示名，任一命中 ──────────────────────────────
check('重命名过的频道：按原始名配的规则仍然命中', () => {
  const rules = [{ value: 'CCTV5+体育赛事', mode: 'exact' }]
  assert.equal(hit(['CCTV5+体育赛事', '体育台'], rules), true)
})

check('重命名过的频道：按界面上改后的名字配的规则也命中', () => {
  const rules = [{ value: '体育台', mode: 'exact' }]
  assert.equal(hit(['CCTV5+体育赛事', '体育台'], rules), true)
})

// ── 规整：去重、保序、混合形态 ─────────────────────────────────────────────
check('同模式同值去重（大小写不同视为同一条），不同模式各留一条', () => {
  assert.deepEqual(
    normalizeHiddenRules([{ value: 'CCTV5' }, { value: 'cctv5' }, { value: 'CCTV5', mode: 'exact' }]),
    [{ value: 'CCTV5', mode: 'contains' }, { value: 'CCTV5', mode: 'exact' }]
  )
})

check('非法 mode 一律落到 contains（不静默丢规则，也不放行未知语义）', () => {
  assert.deepEqual(normalizeHiddenRules([{ value: 'X', mode: 'regex' }]), [{ value: 'X', mode: 'contains' }])
})

check('多条规则：任一命中即可，返回第一条命中的', () => {
  const rules = [{ value: '购物', mode: 'contains' }, { value: 'CCTV5', mode: 'exact' }]
  assert.deepEqual(matchHiddenRule('CCTV5', rules), { value: 'CCTV5', mode: 'exact' })
  assert.equal(hit('CCTV1综合', rules), false)
})

// ── 接线：规则必须真的作用到播放列表上 ─────────────────────────────────────
// 纯匹配对了不代表接线对——applyConfig 的判定、collectGroupConflicts 的占名判定
// 是两处独立的调用点，任一漏接都会变成隐性 bug（前者规则不生效，后者分组改名被误锁）。
const groups = (id = 'ext-aaa') => ([
  { name: '央视', channels: [{ id, name: 'CCTV5+体育赛事' }, { id: 'ext-keep', name: 'CCTV1综合' }] },
  { name: '购物', channels: [{ id: 'ext-shop', name: '优购物' }] },
])
const cfg = (over = {}) => ({
  channelGroupMap: {}, channelRenameMap: {}, channelOrder: {}, hiddenChannels: [],
  customGroups: [], groupOrder: [], deletedGroups: [], groupRenameMap: {}, groupSortMode: {},
  hiddenRules: [], ...over
})
const names = (c, id) => applyConfig(groups(id), c).flatMap(g => g.channels.map(ch => ch.name))

check('接线：exact 规则真的把频道从播放列表里去掉，其它频道不受影响', () => {
  const out = names(cfg({ hiddenRules: [{ value: 'CCTV5+体育赛事', mode: 'exact' }] }))
  assert.ok(!out.includes('CCTV5+体育赛事'))
  assert.ok(out.includes('CCTV1综合') && out.includes('优购物'))
})

check('接线：contains 规则一次盖住一批', () => {
  const out = names(cfg({ hiddenRules: [{ value: 'CCTV', mode: 'contains' }] }))
  assert.deepEqual(out, ['优购物'])
})

check('接线：没有规则时行为与从前完全一致（零回归）', () => {
  assert.equal(names(cfg()).length, 3)
  assert.equal(names(cfg({ hiddenRules: undefined })).length, 3)
})

check('接线：空 value 的规则不得清空播放列表（端到端守住最危险的失败模式）', () => {
  for (const bad of [[{ value: '' }], [''], [{ value: '  ', mode: 'exact' }]]) {
    assert.equal(names(cfg({ hiddenRules: bad })).length, 3, `被空规则清空了: ${JSON.stringify(bad)}`)
  }
})

check('接线：hiddenRules 被写成字符串（手改配置文件）不得拆成字符规则屏蔽一大片', () => {
  // protectAnnouncementConfig 曾经用 [...(input.hiddenRules || [])] 拷贝，
  // 展开字符串会得到 ['C','C','T','V']，单字 contains 命中一大片——实测屏蔽了 251/967 个频道。
  assert.equal(names(cfg({ hiddenRules: 'CCTV' })).length, 3)
  assert.equal(names(cfg({ hiddenRules: '购物' })).length, 3)
  assert.equal(names(cfg({ hiddenRules: 42 })).length, 3)
  assert.equal(names(cfg({ hiddenRules: { value: 'CCTV' } })).length, 3)
})

check('接线：频道 ID 变了（源换址）规则照样生效——这正是规则存在的理由', () => {
  const c = cfg({ hiddenRules: [{ value: 'CCTV5+体育赛事', mode: 'exact' }] })
  assert.ok(!names(c, 'ext-aaa').includes('CCTV5+体育赛事'))
  assert.ok(!names(c, 'ext-bbb').includes('CCTV5+体育赛事'), '换 ID 后必须仍然屏蔽')
  // 对照：hiddenChannels 绑 ID，换 ID 就失效（规则要解决的就是这个）
  const byId = cfg({ hiddenChannels: ['央视::ext-aaa'] })
  assert.ok(!names(byId, 'ext-aaa').includes('CCTV5+体育赛事'))
  assert.ok(names(byId, 'ext-bbb').includes('CCTV5+体育赛事'), '按 ID 隐藏换 ID 后失效——对照组')
})

check('接线：重命名过的频道，按原始名与按新名配的规则都生效', () => {
  const renamed = { '央视::ext-aaa': '体育台' }
  assert.ok(!names(cfg({ channelRenameMap: renamed, hiddenRules: [{ value: 'CCTV5+体育赛事', mode: 'exact' }] })).includes('体育台'))
  assert.ok(!names(cfg({ channelRenameMap: renamed, hiddenRules: [{ value: '体育台', mode: 'exact' }] })).includes('体育台'))
})

check('接线：被规则清空的分组不再占用分组名（否则改名 / 新建同名会被误锁）', () => {
  const c = cfg({ hiddenRules: [{ value: '购物', mode: 'contains' }] })
  // 「购物」组已被规则清空 → 可以把自定义分组建成同名而不报冲突
  c.customGroups = [{ name: '购物' }]
  assert.deepEqual(collectGroupConflicts(groups(), c), [])
  // 对照：没有规则时，同名自定义分组必须仍然报冲突
  const c2 = cfg({ customGroups: [{ name: '购物' }] })
  assert.equal(collectGroupConflicts(groups(), c2).length, 1)
})

console.log(`\n全部通过：${passed}/23 ✅`)
