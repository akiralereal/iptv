#!/usr/bin/env node
/**
 * 公共台标库索引回归测试（issue #124）
 *
 * 不变量：
 * 1. 库里有的频道要能命中——包括换了写法的（CCTV怀旧剧场 / 国学频道 / 分组里的裸名 / 英文台名）；
 * 2. 库里没有的必须返回空串（订阅写空 tvg-logo，播放器出占位图），
 *    绝不能再拼一个必定 404 的地址——那是 issue #124 里用户看到的裂图；
 * 3. 景观 / 慢直播这类「频道名不是台名」的伪频道天然查不到，自动留空；
 * 4. 归一后一对多的库名（广东移动 / 广东4K超高清 都会被压成「广东」）一律不参与宽松匹配，
 *    宁可留空也不能贴错台标；
 * 5. 没有索引时返回 null，让调用方退回按名盲拼的老行为（首次启动没网也不能比以前差）。
 *
 * 运行： node scripts/test-logo-library.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { resolveLibraryLogo, setLogoIndexForTest, hasLogoIndex } from '../utils/logoLibrary.js'

let passed = 0
function check(name, fn) { fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('公共台标库索引回归测试 (issue #124)')

// 取自真实台标库（taksssss/tv 的 icon）的一小撮文件名
const LIBRARY = [
  'CCTV1', 'CCTV5+', 'CCTV4欧洲', '湖南卫视', '吉林都市', '贵州公共', '湖北经视',
  '怀旧剧场', '第一剧场', '风云音乐', '国学', '少儿',
  '内蒙古新闻综合', '内蒙古经济生活', '内蒙古蒙语卫视', '内蒙古农牧',
  '广东移动', '广东4K超高清', 'SKYNEWS', 'NHKWORLD', '纬来体育', '翡翠', '公视', '卫视台', '国',
]

check('无索引时返回 null（调用方退回盲拼）', () => {
  setLogoIndexForTest(null)
  assert.equal(hasLogoIndex(), false)
  assert.equal(resolveLibraryLogo('湖南卫视', '卫视'), null)
})

setLogoIndexForTest(LIBRARY)
assert.equal(hasLogoIndex(), true)

check('原名精确命中', () => {
  assert.equal(resolveLibraryLogo('湖南卫视', '卫视'), '湖南卫视')
  assert.equal(resolveLibraryLogo('吉林都市', '吉林'), '吉林都市')
  assert.equal(resolveLibraryLogo('纬来体育', '体育'), '纬来体育')
})

check('清晰度/运营商写法命中（复用 logoMatchName，issue #40）', () => {
  assert.equal(resolveLibraryLogo('CCTV-1综合高清', '央视'), 'CCTV1')
  assert.equal(resolveLibraryLogo('湖南卫视（电信）', '卫视'), '湖南卫视')
  assert.equal(resolveLibraryLogo('CCTV5+体育赛事', '央视'), 'CCTV5+')
})

check('央视付费频道脱 CCTV 前缀命中（#114 里说会留空的那批）', () => {
  assert.equal(resolveLibraryLogo('CCTV怀旧剧场', '央视频'), '怀旧剧场')
  assert.equal(resolveLibraryLogo('CCTV第一剧场', '央视频'), '第一剧场')
  assert.equal(resolveLibraryLogo('CCTV风云音乐', '央视频'), '风云音乐')
})

check('去「频道 / 台」尾巴命中（精选列表里的港台频道靠这条）', () => {
  assert.equal(resolveLibraryLogo('国学频道', '央视频'), '国学')
  assert.equal(resolveLibraryLogo('少儿频道', '少儿'), '少儿')
  assert.equal(resolveLibraryLogo('翡翠台', '香港'), '翡翠')
  assert.equal(resolveLibraryLogo('公视高清', '台湾'), '公视')      // 清晰度后缀先被 logoMatchName 去掉
  assert.equal(resolveLibraryLogo('卫视台', '卫视'), '卫视台')      // 库里有原名就用原名，不脱后缀
  assert.equal(resolveLibraryLogo('国台', '其它'), '')             // 脱完只剩一个字就不脱，免得撞上无关的单字台标
})

check('分组里的裸名补省名命中', () => {
  assert.equal(resolveLibraryLogo('新闻综合', '内蒙古'), '内蒙古新闻综合')
  assert.equal(resolveLibraryLogo('经济生活', '内蒙古'), '内蒙古经济生活')
  assert.equal(resolveLibraryLogo('农牧频道', '内蒙古'), '内蒙古农牧')
  assert.equal(resolveLibraryLogo('内蒙古蒙古语卫视', '内蒙古'), '内蒙古蒙语卫视')
})

check('英文台名大小写/空格不敏感命中', () => {
  assert.equal(resolveLibraryLogo('Sky News', '国际'), 'SKYNEWS')
  assert.equal(resolveLibraryLogo('NHK World', '日本'), 'NHKWORLD')
})

check('库里没有 → 空串（不再拼 404 地址）', () => {
  assert.equal(resolveLibraryLogo('白城新闻综合', '吉林'), '')
  assert.equal(resolveLibraryLogo('FIFA+', '体育'), '')
  assert.equal(resolveLibraryLogo('', '吉林'), '')
})

check('景观/慢直播伪频道留空', () => {
  assert.equal(resolveLibraryLogo('长江大桥', '南京景观'), '')
  assert.equal(resolveLibraryLogo('慢直播｜北京云蒙山', '北京景观'), '')
  assert.equal(resolveLibraryLogo('长春市·新民广场', '吉林风景'), '')
})

check('归一撞车的库名不参与宽松匹配（不贴错台标）', () => {
  // 「广东移动」「广东4K超高清」经 logoMatchName 都变成「广东」，这个 key 必须被丢弃；
  // 于是库里没有的「广东联通」只能留空，而不是随机贴上其中一张。
  assert.equal(resolveLibraryLogo('广东联通', '广东'), '')
  // 但两者各自的原名仍然精确命中
  assert.equal(resolveLibraryLogo('广东移动', '广东'), '广东移动')
  assert.equal(resolveLibraryLogo('广东4K超高清', '广东'), '广东4K超高清')
})

console.log(`\n全部通过：${passed} 组 ✅`)
