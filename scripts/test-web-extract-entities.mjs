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
import { restoreLegacyEntities, describePendingRequests } from '../utils/webSourceExtractor.js'

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

// ---- 导航超时诊断：挂着的请求按域名汇总 ----
check('挂着的请求按域名汇总：数量、类型、最久等待、是否收到过响应', () => {
  const now = 100000
  const pending = new Map([
    ['https://cloud.example.hk/a.js', { start: now - 28000, type: 'script', responded: false }],
    ['https://cloud.example.hk/b.js', { start: now - 29500, type: 'script', responded: false }],
    ['https://cloud.example.hk/player.html', { start: now - 5000, type: 'document', responded: false }],
    ['https://cdn.example.cn/x.css', { start: now - 3000, type: 'stylesheet', responded: true }],
  ])
  assert.equal(
    describePendingRequests(pending, now),
    'cloud.example.hk×3(script/document,无响应,30s) cdn.example.cn×1(stylesheet,3s)'
  )
})

check('挂着的请求汇总：最多列 maxHosts 个域名（按数量降序）、空集合返回空串、坏 URL 不抛', () => {
  const now = 1000
  const many = new Map([...Array(8)].map((_, i) => [`https://h${i}.com/${i}`, { start: now - 1000, type: 'xhr' }]))
  many.set('https://h0.com/again', { start: now - 500, type: 'xhr' })
  const out = describePendingRequests(many, now, 3)
  assert.equal(out.split(' ').length, 3)
  assert.ok(out.startsWith('h0.com×2('), '数量最多的域名排最前')
  assert.equal(describePendingRequests(new Map(), now), '')
  assert.equal(describePendingRequests(new Map([['not a url', { start: now - 2000 }]]), now), 'not a url×1(?,无响应,2s)')
})

console.log(`\n全部通过：${passed}/7 ✅`)
