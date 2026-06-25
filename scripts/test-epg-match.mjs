#!/usr/bin/env node
/**
 * 外部 EPG 配对回归测试（issue #38）
 *
 * 核心不变量：XMLTV 的频道配对要走 <channel> 的 <display-name>，而不是只拿
 * <programme channel="ID"> 的 id 归一——否则数字/不透明 id 的源会一个都配不上。
 *
 * 运行： node scripts/test-epg-match.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { parseProgrammes, buildChannelKeyMap } from '../utils/epgParse.js'
import { normalizeKey } from '../utils/channelNormalize.js'

let passed = 0
const check = (n, fn) => { fn(); passed++; console.log('  ✅ ' + n) }

console.log('外部 EPG 配对回归测试 (issue #38)')

// 1) 数字/不透明 id + display-name（旧实现拿 id 归一 → 0 命中，正是反馈的 bug）
const xmlNumeric = `<?xml version="1.0"?>
<tv>
  <channel id="475"><display-name lang="zh">CCTV1综合</display-name></channel>
  <channel id="476"><display-name>湖南卫视</display-name></channel>
  <channel id="999"><display-name>不需要的台</display-name></channel>
  <programme channel="475" start="1"><title>新闻联播</title></programme>
  <programme channel="475" start="2"><title>焦点访谈</title></programme>
  <programme channel="476" start="1"><title>歌手</title></programme>
  <programme channel="999" start="1"><title>无关</title></programme>
</tv>`

check('数字 id + display-name：按 display-name 命中（多 programme 都收）', () => {
  const wanted = new Set([normalizeKey('CCTV1综合'), normalizeKey('湖南卫视')])
  const byKey = parseProgrammes(xmlNumeric, wanted)
  assert.equal(byKey.get(normalizeKey('CCTV1综合'))?.length, 2)
  assert.equal(byKey.get(normalizeKey('湖南卫视'))?.length, 1)
  assert.equal(byKey.has(normalizeKey('不需要的台')), false) // 不在 wanted 不收
  // 旧实现拿数字 id 归一：normalizeKey('475') 不等于任何 wanted key —— 证明旧 bug 的成因
  assert.equal(wanted.has(normalizeKey('475')), false)
})

// 2) id 即频道名（兼容老路径）：仍能命中，且外部源异写法经 #39 归一也能对上
const xmlNameId = `<tv>
  <channel id="CCTV5体育"><display-name>CCTV5体育</display-name></channel>
  <programme channel="CCTV5体育" start="1"><title>赛事</title></programme>
</tv>`
check('id 即频道名 + 外部异写法（CCTV-5）：仍命中', () => {
  const wanted = new Set([normalizeKey('CCTV-5')]) // 归一后 = CCTV5
  const byKey = parseProgrammes(xmlNameId, wanted)
  assert.equal(byKey.get(normalizeKey('CCTV-5'))?.length, 1)
})

// 3) 无 <channel> 元素、只有 programme：退回 id 自身归一兜底
const xmlNoChannel = `<tv>
  <programme channel="CCTV1" start="1"><title>x</title></programme>
</tv>`
check('无 <channel> 时退回 id 自身归一', () => {
  const wanted = new Set([normalizeKey('CCTV1综合')]) // CCTV1 与 CCTV1综合 归一同为 CCTV1
  const byKey = parseProgrammes(xmlNoChannel, wanted)
  assert.equal(byKey.get(normalizeKey('CCTV1综合'))?.length, 1)
})

// 4) 一个频道多个 <display-name> 别名都进映射
const xmlAlias = `<tv>
  <channel id="hunan"><display-name>湖南卫视HD</display-name><display-name>湖南卫视</display-name></channel>
  <programme channel="hunan" start="1"><title>x</title></programme>
</tv>`
check('多 display-name 别名都建入映射', () => {
  const map = buildChannelKeyMap(xmlAlias)
  assert.ok(map.get('hunan').has(normalizeKey('湖南卫视')))
})

console.log(`\n全部通过：${passed}/4 ✅`)
