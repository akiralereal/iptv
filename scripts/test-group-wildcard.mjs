#!/usr/bin/env node
/**
 * 分组通配隐藏回归测试（issue #2 的能力，issue #123 起由界面生成）
 *
 * deletedGroups 里以 `*` 结尾的条目按前缀匹配：`体育-*` 盖住 体育-昨天 / 今天 / 明天，
 * 也盖住以后新出现的同前缀分组——赛事回放这类每天重建的分组只能这么处理，逐个隐藏
 * 明天就白隐藏了。这个能力一直只有手改配置文件才用得上，后台「隐藏分组」现在会在
 * 检测到同前缀兄弟分组时主动提议生成它，所以语义必须钉死。
 *
 * 边界重点：`体育-*` 不能顺手把 `体育` 也带走——前缀里的分隔符是有意义的，
 * 用户点的是「体育-昨天」，把主分组「体育」一起隐藏掉是灾难性的误伤。
 *
 * 运行： node scripts/test-group-wildcard.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { applyConfig, isGroupDeleted } from '../utils/playlistConfig.js'
import { ANNOUNCEMENT, SYSTEM_CHANNELS } from '../utils/announcement.js'

for (const k of ['log', 'info', 'warn']) {
  const orig = console[k]
  console[k] = (...a) => { if (a.some(x => typeof x === 'string' && /应用播放列表配置|配置应用完成/.test(x))) return; orig.apply(console, a) }
}

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }

const groups = () => ([
  { name: '体育', channels: [{ id: 'a1', name: '广东体育' }] },
  { name: '体育-昨天', channels: [{ id: 'b1', name: '回放1' }] },
  { name: '体育-今天', channels: [{ id: 'c1', name: '直播1' }] },
  { name: '体育-明天', channels: [{ id: 'd1', name: '预告1' }] },
  { name: '体育频道', channels: [{ id: 'e1', name: '五星体育' }] },
  { name: '央视', channels: [{ id: 'f1', name: 'CCTV1综合' }] },
])
const cfg = (deletedGroups = []) => ({
  channelGroupMap: {}, channelRenameMap: {}, channelOrder: {}, hiddenChannels: [],
  customGroups: [], groupOrder: [], deletedGroups, groupRenameMap: {}, groupSortMode: {}, hiddenRules: []
})
const visibleGroups = c => applyConfig(groups(), c).map(g => g.name).filter(n => n !== ANNOUNCEMENT.group)

console.log('分组通配隐藏回归测试 (issue #2 / #123)')

check('`体育-*` 盖住三个带前缀的分组', () => {
  const out = visibleGroups(cfg(['体育-*']))
  assert.ok(!out.includes('体育-昨天') && !out.includes('体育-今天') && !out.includes('体育-明天'))
})

check('`体育-*` 不得带走主分组「体育」——分隔符是有意义的（最关键的边界）', () => {
  const out = visibleGroups(cfg(['体育-*']))
  assert.ok(out.includes('体育'), '主分组「体育」被误伤了')
})

check('`体育-*` 不得带走「体育频道」（前缀不含分隔符就不该命中）', () => {
  assert.ok(visibleGroups(cfg(['体育-*'])).includes('体育频道'))
})

check('无关分组不受影响', () => {
  assert.ok(visibleGroups(cfg(['体育-*'])).includes('央视'))
})

check('精确条目照旧生效，且只命中自己', () => {
  const out = visibleGroups(cfg(['体育-昨天']))
  assert.ok(!out.includes('体育-昨天'))
  assert.ok(out.includes('体育-今天') && out.includes('体育') )
})

check('以后新出现的同前缀分组自动被盖住（规则的全部意义）', () => {
  // 模拟明天刷新后多出来的分组
  const tomorrow = [...groups(), { name: '体育-后天', channels: [{ id: 'g1', name: '预告2' }] }]
  const out = applyConfig(tomorrow, cfg(['体育-*'])).map(g => g.name)
  assert.ok(!out.includes('体育-后天'))
})

check('isGroupDeleted 的前缀语义（供后台与服务端共用的判定）', () => {
  assert.equal(isGroupDeleted('体育-昨天', ['体育-*']), true)
  assert.equal(isGroupDeleted('体育', ['体育-*']), false)
  assert.equal(isGroupDeleted('体育频道', ['体育-*']), false)
  assert.equal(isGroupDeleted('体育-昨天', ['体育-昨天']), true)
  assert.equal(isGroupDeleted('体育-昨天', []), false)
})

check('通配符不得吃掉系统公告分组（protectAnnouncementConfig 只过滤精确名，兜底在 applyConfig 的豁免）', () => {
  // 公告频道按 tvgId 认，构造真实形态而不是随便捏一条，否则测的是个假东西
  const withSystem = [
    ...groups(),
    { name: ANNOUNCEMENT.group, channels: SYSTEM_CHANNELS.map(s => ({ id: s.tvgId, name: s.name, url: `\${replace}${s.videoPath}` })) },
  ]
  const prefix = ANNOUNCEMENT.group.slice(0, 1) + '*'   // 「公*」
  const out = applyConfig(withSystem, cfg([prefix])).find(g => g.name === ANNOUNCEMENT.group)
  assert.ok(out, `公告分组被 ${prefix} 整组隐藏了`)
  assert.equal(out.channels.length, SYSTEM_CHANNELS.length, '公告分组的系统频道被通配隐藏吃掉了')
})

check('被移动走的频道不受原分组通配隐藏影响（单频道归类优先级最高）', () => {
  const c = cfg(['体育-*'])
  c.customGroups = [{ name: '我的收藏' }]
  c.channelGroupMap = { '体育-昨天::b1': '我的收藏' }
  const out = applyConfig(groups(), c)
  assert.ok(out.find(g => g.name === '我的收藏')?.channels.some(ch => ch.name === '回放1'))
})

console.log(`\n全部通过：${passed}/9 ✅`)
