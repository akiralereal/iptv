#!/usr/bin/env node
/**
 * 频道名称 / TVG 规整回归测试（issue #39）
 *
 * 用 issue #39 提需求者列出的真实别名清单做断言：各种写法的 CCTV 频道名，
 * 都应归一到咪咕 EPG 的规范名，从而能匹配上节目单。
 *
 * 运行： node scripts/test-channel-normalize.mjs   （或 npm test）
 *
 * 注：卫视/港台等规范名在生产环境由 playback.xml 提供（运行时读取）；
 * 测试环境无 EPG 文件，故这里只校验「静态可用」的 CCTV 系列（来自 datas.js 的 cntvNames）。
 */
import assert from 'node:assert/strict'
import { normalizeKey, normalizeTvgName, logoMatchName } from '../utils/channelNormalize.js'

let passed = 0
function check(name, fn) { fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('频道名称 / TVG 规整回归测试 (issue #39)')

// 1) normalizeKey：归一 key 是否符合预期（含 CCTV5 vs CCTV5+、CCTV4 三路区分）
check('normalizeKey 关键用例', () => {
  assert.equal(normalizeKey('CCTV1综合'), 'CCTV1')
  assert.equal(normalizeKey('CCTV-1高清'), 'CCTV1')
  assert.equal(normalizeKey('CCTV-1综合HD'), 'CCTV1')
  assert.equal(normalizeKey('CCTV5体育'), 'CCTV5')
  assert.equal(normalizeKey('CCTV5+体育赛事'), 'CCTV5+')
  assert.equal(normalizeKey('CCTV5加'), 'CCTV5+')          // 「加」当作 +
  assert.equal(normalizeKey('CCTV4中文国际'), 'CCTV4')
  assert.equal(normalizeKey('CCTV4欧洲'), 'CCTV4欧')        // 欧洲单独成 key，避免覆盖中文国际
  assert.equal(normalizeKey('CCTV4美洲'), 'CCTV4美')
  assert.equal(normalizeKey('湖南卫视HD'), normalizeKey('湖南卫视')) // 清晰度后缀不影响匹配
})

// 2) issue #39 列出的别名清单 → 规范名（咪咕 EPG 频道名）
const cases = {
  'CCTV1综合': ['CCTV1', 'CCTV1综合', 'CCTV-1综合', 'CCTV-1', 'CCTV1HD', 'CCTV1高清',
    'CCTV1综合HD', 'CCTV1综合高清', 'CCTV-1综合HD', 'CCTV-1综合高清', 'CCTV-1HD', 'CCTV-1高清'],
  'CCTV2财经': ['CCTV2', 'CCTV2财经', 'CCTV-2财经', 'CCTV-2', 'CCTV2HD', 'CCTV2高清',
    'CCTV-2财经高清', 'CCTV-2HD', 'CCTV-2高清'],
  'CCTV3综艺': ['CCTV3', 'CCTV3综艺', 'CCTV-3综艺', 'CCTV-3', 'CCTV3HD', 'CCTV3高清', 'CCTV-3综艺HD'],
  'CCTV4中文国际': ['CCTV4', 'CCTV4国际', 'CCTV4中文国际', 'CCTV-4', 'CCTV4HD', 'CCTV4高清', 'CCTV-4中文国际高清'],
  'CCTV5体育': ['CCTV5', 'CCTV-5', 'CCTV5高清', 'CCTV5体育', 'CCTV-5体育HD'],
  'CCTV5+体育赛事': ['CCTV5+', 'CCTV5+体育赛事', 'CCTV-5+', 'CCTV5加', 'CCTV5+高清'],
  'CCTV4欧洲': ['CCTV4欧洲', 'CCTV-4欧洲', 'CCTV4欧洲高清'],
  'CCTV4美洲': ['CCTV4美洲', 'CCTV-4美洲HD'],
}
for (const [canonical, aliases] of Object.entries(cases)) {
  check(`别名归一 → ${canonical}（${aliases.length} 种写法）`, () => {
    for (const alias of aliases) {
      assert.equal(normalizeTvgName(alias), canonical, `「${alias}」应归一为「${canonical}」，实际「${normalizeTvgName(alias)}」`)
    }
  })
}

// 3) 无对应规范名时返回 null，绝不误改
check('无法匹配的名字返回 null（不误改）', () => {
  assert.equal(normalizeTvgName('某体育赛事直播回看'), null)
  assert.equal(normalizeTvgName(''), null)
  assert.equal(normalizeTvgName('翡翠台'), null) // 港台台（测试环境无 EPG，预期未命中）
})

// 4) issue #40：去运营商/信源后缀，让带「（电信）」等标识的常见频道也能归一（EPG 匹配受益）
check('normalizeKey 去运营商/信源后缀', () => {
  assert.equal(normalizeKey('湖南卫视（电信）'), normalizeKey('湖南卫视'))
  assert.equal(normalizeKey('湖南卫视(联通)'), normalizeKey('湖南卫视'))
  assert.equal(normalizeKey('浙江卫视 移动'), normalizeKey('浙江卫视'))
  assert.equal(normalizeKey('东方卫视IPTV'), normalizeKey('东方卫视'))
  assert.equal(normalizeKey('CCTV1高清（电信）'), 'CCTV1')   // CCTV 仍按频道号收敛
  // 不误伤频道身份：括号里非运营商标注（资讯/国际等）不应被当成运营商剔除
  assert.notEqual(normalizeKey('凤凰资讯'), normalizeKey('凤凰中文'))
})

// 5) issue #40：台标匹配名清洗到公共库（fanmingming）短文件名约定
check('logoMatchName 清洗到公共库短名', () => {
  // CCTV：收敛到短名，保留 +、CCTV4 三路全称（fanmingming 实测 CCTV1.png/CCTV5+.png/CCTV4欧洲.png 存在）
  assert.equal(logoMatchName('CCTV1高清（电信）'), 'CCTV1')
  assert.equal(logoMatchName('CCTV-1综合'), 'CCTV1')
  assert.equal(logoMatchName('CCTV5+体育赛事'), 'CCTV5+')
  assert.equal(logoMatchName('CCTV5加'), 'CCTV5+')
  assert.equal(logoMatchName('CCTV4中文国际'), 'CCTV4')
  assert.equal(logoMatchName('CCTV4欧洲'), 'CCTV4欧洲')      // 不砍成 CCTV4欧（库里是全称）
  assert.equal(logoMatchName('CCTV4美洲HD'), 'CCTV4美洲')
  // 中文「央视N套」写法也要收敛到 CCTVN（issue #38 截图里的真实频道：央视1套高清；库里只有 CCTV1.png）
  assert.equal(logoMatchName('央视1套高清'), 'CCTV1')
  assert.equal(logoMatchName('央视5套体育'), 'CCTV5')
  assert.equal(logoMatchName('央视十三套'), 'CCTV13')
  // 非 CCTV：去清晰度/运营商标注，保留大小写与中文原样
  assert.equal(logoMatchName('湖南卫视（电信）'), '湖南卫视')
  assert.equal(logoMatchName('湖南卫视高清'), '湖南卫视')
  assert.equal(logoMatchName('Discovery高清'), 'Discovery') // 英文台名保大小写，不大写化
  assert.equal(logoMatchName('凤凰中文'), '凤凰中文')        // 干净名原样返回
  assert.equal(logoMatchName(''), '')
})

console.log(`\n全部通过：${passed} 组 ✅`)
