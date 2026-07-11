#!/usr/bin/env node
/**
 * 网页提取地址「旧式实体误解码还原」回归测试（issue #84）
 *
 * 背景：「网页提取」模式用 puppeteer 读 document.body.innerText 找 m3u8 地址。innerText
 * 是 HTML 解析后的文本，网页源码里裸写的 "&timestamp="、"&notin=" 等会被浏览器按「不带
 * 分号也解码」的旧式命名实体规则解成 "×tamp="、"¬in="，地址随后被保存 → 一直播不了。
 * restoreLegacyEntities 把 U+00A0–U+00FF 的字符按码点还原回 "&实体名"。
 *
 * 不变量：
 *  - 被误解码的 Latin-1 字符（×=&times、¬=&not、®=&reg…）还原回原参数；
 *  - 不含这些字符的干净地址原样返回（&amp; 经 innerText 已是干净的 &，不受影响）。
 *
 * 运行： node scripts/test-web-extract-entities.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { restoreLegacyEntities } from '../utils/webSourceExtractor.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('网页提取地址「旧式实体误解码还原」回归测试 (issue #84)')

check('还原 &timestamp（×tamp → &timestamp）——issue #84 原始场景', () => {
  assert.equal(
    restoreLegacyEntities('http://h/x.m3u8?pid=2028597139×tamp=20260710&Key=1'),
    'http://h/x.m3u8?pid=2028597139&timestamp=20260710&Key=1'
  )
})

check('还原 &notin（¬in → &notin）', () => {
  assert.equal(restoreLegacyEntities('http://h/x.m3u8?a=¬in=y'), 'http://h/x.m3u8?a=&notin=y')
})

check('多个实体混合全部还原', () => {
  // 原意：?pid=1&timestamp=2&reg=cn&para=3&sect=4&copy=5&micro=6&middot=7&notin=8
  const mangled = 'http://h/x.m3u8?pid=1×tamp=2®=cn¶=3§=4©=5µ=6·=7¬in=8'
  assert.equal(
    restoreLegacyEntities(mangled),
    'http://h/x.m3u8?pid=1&timestamp=2&reg=cn&para=3&sect=4&copy=5&micro=6&middot=7&notin=8'
  )
})

check('干净地址原样返回（无 Latin-1 字符）', () => {
  const clean = 'http://h/x.m3u8?a=1&b=2&timestamp=3&sign=abc'
  assert.equal(restoreLegacyEntities(clean), clean)
})

check('&amp; 来源的 & 已是干净的，不受影响', () => {
  // 页面里 &amp;timestamp 经 innerText 已得到干净的 &timestamp（不含 Latin-1 字符），还原是 no-op
  assert.equal(restoreLegacyEntities('http://h/x.m3u8?x=1&timestamp=2'), 'http://h/x.m3u8?x=1&timestamp=2')
})

console.log(`\n全部通过：${passed}/5 ✅`)
