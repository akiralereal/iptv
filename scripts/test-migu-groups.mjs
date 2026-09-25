#!/usr/bin/env node
/**
 * 咪咕跨分组去重测试。
 *
 * 咪咕按自己的分类给同一个频道打多个标签：CCTV1 同时在 央视/影视/新闻/纪实，
 * 四份完全一样（同名、同 tvg-id、同地址），只有 group-title 不同。实测代价：
 * 645 个条目对应 593 个真实频道，47 个频道跨分组重复；播放器按名聚合成「源1/源2」
 * 后 CCTV1 显示成有 4 个源而它们指向同一个地址；「我的频道」的配置键带原始分组名，
 * 隐藏一次只隐藏一份。
 *
 * 规则：同一个 pID 只留在**最先出现**的分组里，CCTV5 / CCTV5+
 * 例外地同时保留在体育和央视；同时咪咕「地方」不直接输出，
 * 只把明确保留的独有频道并入对应地区（目前只剩财富天下并入江苏）。
 *
 * 这是条纯数据整形规则，改错了**不会报错** —— 频道只是悄悄跑到别的分组、
 * 或者又开始到处重复。所以把它钉在这里。
 *
 * 运行： node scripts/test-migu-groups.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
// 经 registry 入口导入：直接 import 模块文件会撞上既有的循环依赖
//（migu → systemConfigAPI → updateData → extractorManager → registry → migu）的 TDZ。
import '../extractors/registry.js'
const { dedupeAcrossGroups, redistributeMiguLocalChannels } = await import('../extractors/migu/index.js')

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }

const g = (name, ...pids) => ({ name, dataList: pids.map(p => ({ pID: String(p), name: 'ch' + p })) })
const shape = (groups) => groups.map(x => [x.name, x.dataList.map(c => c.pID)])

console.log('咪咕跨分组去重测试')

check('★ 普通频道的同一 pID 只留在最先出现的分组里', () => {
  const out = dedupeAcrossGroups([
    g('体育', 5),
    g('央视', 1, 5, 13),
    g('新闻', 1, 13),
  ])
  assert.deepEqual(shape(out), [['体育', ['5']], ['央视', ['1', '13']]],
    '普通频道仍按先出现的分组归属')
})

check('CCTV5 / CCTV5+ 同时保留在体育和央视，但不泄漏到其它组', () => {
  const c5 = { pID: '641886683', name: 'CCTV5体育' }
  const c5plus = { pID: '641886773', name: 'CCTV5+体育赛事' }
  const out = dedupeAcrossGroups([
    { name: '体育', dataList: [c5, c5plus, { ...c5 }] },
    { name: '央视', dataList: [{ ...c5 }, { ...c5plus }] },
    { name: '新闻', dataList: [{ ...c5 }, { ...c5plus }] },
  ])
  assert.deepEqual(shape(out), [
    ['体育', ['641886683', '641886773']],
    ['央视', ['641886683', '641886773']],
  ])
})

check('顺序原样保留，不做任何重排', () => {
  const out = dedupeAcrossGroups([g('体育', 1), g('央视', 2), g('卫视', 3), g('地方', 4)])
  assert.deepEqual(out.map(x => x.name), ['体育', '央视', '卫视', '地方'],
    '顺序由 fetchList 从咪咕拿到，这里不许重排（两处各自定义顺序必然走偏）')
})

check('去空的分组不出现在结果里（免得播放列表挂空分组）', () => {
  const out = dedupeAcrossGroups([g('体育', 1), g('新闻', 1)])
  assert.deepEqual(out.map(x => x.name), ['体育'])
})

check('同名不同 pID 都保留（只按 pID 去重，不按名字）', () => {
  const a = { name: '体育', dataList: [{ pID: '1', name: '梨园频道' }] }
  const b = { name: '综艺', dataList: [{ pID: '2', name: '梨园频道' }] }
  const out = dedupeAcrossGroups([a, b])
  assert.deepEqual(shape(out), [['体育', ['1']], ['综艺', ['2']]],
    '同名但不同频道（不同 pID）必须都留着')
})

check('不修改传入的对象（渲染/缓存可能还拿着原引用）', () => {
  const input = [g('体育', 1), g('央视', 1)]
  const before = JSON.stringify(input)
  dedupeAcrossGroups(input)
  assert.equal(JSON.stringify(input), before, 'dedupeAcrossGroups 不该原地改调用方的数组')
})

check('空输入 / 空分组不炸', () => {
  assert.deepEqual(dedupeAcrossGroups([]), [])
  assert.deepEqual(dedupeAcrossGroups([{ name: '体育', dataList: [] }]), [])
})

check('咪咕地方组只保留指定独有频道，并归入江苏；陕西四路已由官方模块覆盖', () => {
  const local = {
    name: '地方',
    dataList: [
      { pID: '1', name: '上海新闻综合' },          // 上海官方模块已有：丢弃
      { pID: '2', name: '上视东方影视' },          // 播放不了：剔除
      { pID: '3', name: '南京新闻综合频道' },      // 南京官方模块已有：丢弃
      { pID: '4', name: '盐城新闻综合' },          // 江苏地市频道：丢弃
      { pID: '5', name: '陕西银龄频道' },          // 陕西官方模块已有：丢弃
      { pID: '6', name: '陕西都市青春频道' },      // 陕西官方模块已有：丢弃
      { pID: '7', name: '陕西秦腔频道' },          // 陕西官方模块已有：丢弃
      { pID: '8', name: '陕西新闻资讯频道' },      // 陕西官方模块已有：丢弃
      { pID: '9', name: '财富天下' },              // 江苏：保留
      { pID: '10', name: '广东珠江频道' },         // 广东官方模块已有：丢弃
    ],
  }
  const out = redistributeMiguLocalChannels([g('体育', 100), local, g('影视', 200)])
  assert.deepEqual(out.map(group => group.name), ['体育', '江苏', '影视'])
  assert.deepEqual(shape(out), [
    ['体育', ['100']],
    ['江苏', ['9']],
    ['影视', ['200']],
  ])
  assert.equal(out.some(group => group.name === '地方'), false)
})

check('咪咕新闻频道全部剔除，去掉空的新闻分组', () => {
  const news = {
    name: '新闻',
    dataList: [
      { pID: '1', name: '中国天气' },
      { pID: '2', name: '公共新闻频道' },
      { pID: '3', name: '淮安新闻综合' },
      { pID: '4', name: '宿迁新闻综合' },
      { pID: '5', name: '徐州新闻综合' },
      { pID: '6', name: '盐城新闻综合' },
      { pID: '7', name: '江阴新闻综合' },
      { pID: '8', name: '南通新闻综合' },
      { pID: '9', name: '宜兴新闻综合' },
      { pID: '10', name: '溧水新闻综合' },
      { pID: '11', name: '镇江新闻综合' },
      { pID: '12', name: '海南广播电视总台新闻频道' },
      { pID: '13', name: '陕西新闻资讯频道' },       // 陕西官方模块已有；只撤并入名单时会在新闻组冒出来
    ],
  }
  assert.deepEqual(redistributeMiguLocalChannels([news]), [])
})

check('上视东方影视无论出现在哪个分类都剔除（播放不了）', () => {
  const input = [
    { name: '影视', dataList: [{ pID: '1', name: '上视东方影视' }, { pID: '2', name: '南方影视' }] },
    { name: '地方', dataList: [{ pID: '1', name: '上视东方影视' }] },
  ]
  assert.deepEqual(shape(redistributeMiguLocalChannels(input)), [['影视', ['2']]])
})

check('咪咕熊猫分组整组移除（iPanda 官方模块已覆盖）', () => {
  const input = [
    g('央视', 1),
    { name: '熊猫', dataList: [
      { pID: '2', name: '熊猫频道01高清' },
      { pID: '3', name: '熊猫频道1' },
    ] },
    g('少儿', 4),
  ]
  assert.deepEqual(shape(redistributeMiguLocalChannels(input)), [
    ['央视', ['1']],
    ['少儿', ['4']],
  ])
})

check('咪咕综艺分组整组移除', () => {
  const input = [
    g('体育', 1),
    { name: '综艺', dataList: [
      { pID: '2', name: '最强综艺趴' },
      { pID: '3', name: '江苏综艺频道' },
    ] },
    g('少儿', 4),
  ]
  assert.deepEqual(shape(redistributeMiguLocalChannels(input)), [
    ['体育', ['1']],
    ['少儿', ['4']],
  ])
})

check('文旅精简会剔除专题轮播和已有地方官方源的副本', () => {
  const documentary = {
    name: '纪实',
    dataList: [
      { pID: '1', name: '新动力量创一流' },
      { pID: '2', name: '中华特产' },
      { pID: '3', name: '环球旅游' },
      { pID: '4', name: '梨园频道' },
      { pID: '5', name: '海南广播电视总台社会与法频道' },
      { pID: '6', name: '海南广播电视总台文旅频道' },
    ],
  }
  assert.deepEqual(shape(redistributeMiguLocalChannels([documentary])), [
    ['纪实', ['2', '3']],
  ])
})

check('重分组会合并已有地区组，且不修改输入', () => {
  const input = [
    { name: '江苏', dataList: [{ pID: '1', name: '旧频道' }] },
    { name: '地方', dataList: [{ pID: '2', name: '财富天下' }] },
  ]
  const before = JSON.stringify(input)
  const out = redistributeMiguLocalChannels(input)
  assert.deepEqual(shape(out), [['江苏', ['1', '2']]])
  assert.equal(JSON.stringify(input), before)
})

console.log(`全部通过：${passed} ✅`)
