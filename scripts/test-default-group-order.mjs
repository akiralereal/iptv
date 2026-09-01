#!/usr/bin/env node
import assert from 'node:assert/strict'
import { applyConfig, DEFAULT_GROUP_ORDER, sortGroupsByDefault } from '../utils/playlistConfig.js'

const makeGroups = names => names.map((name, index) => ({
  name,
  channels: [{ id: `c${index}`, name: `频道${index}` }],
}))

const baseConfig = () => ({
  channelGroupMap: {}, channelRenameMap: {}, channelOrder: {}, hiddenChannels: [],
  customGroups: [], groupOrder: [], deletedGroups: [], groupRenameMap: {}, groupSortMode: {},
})

let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log(`  ✅ ${name}`)
}

console.log('默认分组顺序测试')

check('内容类按固定顺序置顶，不受来源顺序影响', () => {
  const shuffled = [
    '斗鱼', '卫视', '体育-明天', '国际', '公告', '体育', 'B站', '央视频', '央视',
    '少儿', '文旅', '体育-昨天', '亚太', '娱乐时尚', '虎牙', '影视', '教育', '体育-今天',
  ]
  assert.deepEqual(sortGroupsByDefault(makeGroups(shuffled)).map(group => group.name), DEFAULT_GROUP_ORDER)
  assert.equal(DEFAULT_GROUP_ORDER.indexOf('央视频'), DEFAULT_GROUP_ORDER.indexOf('央视') + 1)
  assert.equal(DEFAULT_GROUP_ORDER.indexOf('国际'), DEFAULT_GROUP_ORDER.indexOf('亚太') + 1)
  assert.equal(DEFAULT_GROUP_ORDER.includes('新闻'), false)
})

check('地方台连续放在内容类之后，并保持原相对顺序', () => {
  const names = ['广东', '自定义', '体育', '地方', '福建地市台', '辽宁', '文旅', '宁夏电视台']
  assert.deepEqual(
    sortGroupsByDefault(makeGroups(names)).map(group => group.name),
    ['体育', '文旅', '广东', '地方', '福建地市台', '辽宁', '宁夏电视台', '自定义'],
  )
})

check('景观分组统一放在最后，并保持原相对顺序', () => {
  const names = ['上海景观', '广东', '青岛景观', '其他', '南京景观', '央视']
  assert.deepEqual(
    sortGroupsByDefault(makeGroups(names)).map(group => group.name),
    ['央视', '广东', '其他', '上海景观', '青岛景观', '南京景观'],
  )
})

check('用户手动 groupOrder 仍优先于默认顺序', () => {
  const result = applyConfig(makeGroups(['体育', '央视', '广东', '上海景观']), {
    ...baseConfig(),
    groupOrder: ['上海景观', '广东', '央视', '体育'],
  })
  assert.deepEqual(result.map(group => group.name), ['上海景观', '广东', '央视', '体育'])
})

check('无论旧配置还是显式排序，系统公告始终固定置顶', () => {
  const groups = makeGroups(['体育', '公告', '央视'])
  const legacy = applyConfig(groups, { ...baseConfig(), groupOrder: ['央视', '体育'] })
  assert.deepEqual(legacy.map(group => group.name), ['公告', '央视', '体育'])

  const explicit = applyConfig(groups, { ...baseConfig(), groupOrder: ['央视', '体育', '公告'] })
  assert.deepEqual(explicit.map(group => group.name), ['公告', '央视', '体育'])
})

check('旧 groupOrder 里的纪实位置自动由文旅继承', () => {
  const result = applyConfig(makeGroups(['体育', '文旅', '广东']), {
    ...baseConfig(),
    groupOrder: ['广东', '纪实', '体育'],
  })
  assert.deepEqual(result.map(group => group.name), ['广东', '文旅', '体育'])
})

check('旧配置未记录央视频时自动紧跟央视，显式拖拽后尊重用户位置', () => {
  const groups = makeGroups(['央视频', '卫视', '央视', '体育'])
  const legacy = applyConfig(groups, {
    ...baseConfig(),
    groupOrder: ['体育', '央视', '卫视'],
  })
  assert.deepEqual(legacy.map(group => group.name), ['体育', '央视', '央视频', '卫视'])

  const explicit = applyConfig(groups, {
    ...baseConfig(),
    groupOrder: ['央视频', '体育', '央视', '卫视'],
  })
  assert.deepEqual(explicit.map(group => group.name), ['央视频', '体育', '央视', '卫视'])
})

console.log(`\n全部通过：${passed}/${passed} ✅`)
