#!/usr/bin/env node
/**
 * 广告 issue 判定（scripts/issue-spam.mjs）回归测试
 *
 * 不变量：#188、#208、#209 这类 IPTV 软文判为广告，换了推广域名也照样判出来；
 * 正常的中文 issue、海外用户的英文 issue、贴频道清单的 issue 都不误判。
 * 样本是照着原帖结构缩写的，不整段照搬广告原文。
 *
 * 运行： node scripts/test-issue-spam.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectSpam } from './issue-spam.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const isSpam = (title, body) => {
  const r = detectSpam(title, body)
  assert.ok(r.spam, `应判为广告，得分 ${r.score}：${r.reasons.join('；')}`)
}
const isNotSpam = (title, body) => {
  const r = detectSpam(title, body)
  assert.ok(!r.spam, `不应判为广告，得分 ${r.score}：${r.reasons.join('；')}`)
}

// 结尾那一行关键词：#208、#209 都有几百个，这里取 40 个
const STUFFING = Array.from({ length: 10 }, (_, i) =>
  `IPTV Germany ${i}, best IPTV Berlin, German TV streaming, IPTV for Smart TV`).join(', ')

const REVIEW = (site) => `${site}

After years of dealing with unreliable IPTV services, I've finally found one that delivers — ${site}.

· 📡 15,000+ channels – covering Germany, Europe, the UK, the US and Canada
· 🛡️ Buffer-free streaming
· 💎 Affordable pricing – flexible plans for 1, 3, or 5+ devices

⭐️ TiviMate: select "Xtream Codes Login" and enter the credentials from your welcome email.

🚀 Super responsive support – available via email and WhatsApp

Highly recommended! ⭐️
`

const GUIDE = `Are you looking for the best [IPTV Germany](liveiptvservice.com) options in 2026?

## How to Choose the Best IPTV Germany Service

Check the provider's channel list, device compatibility and whether a legitimate free trial is available.

${STUFFING}`

console.log('广告 issue 判定测试')

check('#209 式「亲身体验」软文：判为广告', () => {
  isSpam('Best IPTV Service in Germany 🇩🇪 – My Honest Experience with liveiptvservice.com', `${REVIEW('liveiptvservice.com')}\n${STUFFING}`)
})

check('#188 式软文（没有关键词堆砌）：判为广告', () => {
  isSpam('Best IPTV Service in Germany 🇩🇪 – My Experience with liveiptvservice.com', REVIEW('liveiptvservice.com'))
})

check('#208 式「选购指南」软文：判为广告', () => {
  isSpam('# Best IPTV Germany 2026: A Complete Guide to IPTV Services', GUIDE)
})

check('换了推广域名、不在黑名单里：仍判为广告', () => {
  isSpam('Best IPTV Provider 2026 – My Experience', REVIEW('some-new-iptv.shop'))
  isSpam('IPTV Guide 2026', GUIDE.replace('liveiptvservice.com', 'some-new-iptv.shop'))
})

check('只有推广域名一项：判为广告', () => {
  isSpam('求助', '有人用过 liveiptvservice.com 吗？')
})

check('正常的中文 issue：0 分', () => {
  const r = detectSpam('v4.46.0 订阅源不能自动更新', '升级到 v4.46.0 后，外部订阅源过了刷新间隔也不更新，手动点刷新可以。Docker 部署，x86。')
  assert.equal(r.score, 0, r.reasons.join('；'))
})

check('海外用户的英文 issue：不误判', () => {
  isNotSpam('Subscription source not updating after v4.46.0',
    'After upgrading to v4.46.0 the external subscription is no longer refreshed automatically. Manual refresh works. Running in Docker on x86.')
  // 英文、又碰上两处话术（Xtream Codes、WhatsApp）也只到 2 分
  isNotSpam('Feature request: Xtream Codes API output and WhatsApp alerts',
    'Could the server expose channels through the Xtream Codes API so players like TiviMate can log in? A WhatsApp notification channel for alerts would also help.')
})

check('贴一长串频道清单：不算关键词堆砌', () => {
  const cctv = Array.from({ length: 40 }, (_, i) => `CCTV${i + 1}`).join(',')
  assert.equal(detectSpam('央视频道缺失', `以下频道都没有：\n${cctv}`).score, 0)
})

check('中文 issue 里贴一长串英文台名：只算堆砌一项，不到阈值', () => {
  const names = Array.from({ length: 10 }, () => 'Phoenix Chinese, Phoenix InfoNews, TVB Jade, Now News').join(', ')
  isNotSpam('香港频道建议', `希望增加以下频道：\n${names}`)
})

check('正文为空（null）不报错', () => {
  assert.equal(detectSpam('建议', null).score, 0)
})

check('工作流引用的判定脚本路径与实际一致', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/issue_spam.yaml'), 'utf-8')
  assert.ok(workflow.includes('sparse-checkout: scripts/issue-spam.mjs'))
  assert.ok(workflow.includes("import('${{ github.workspace }}/scripts/issue-spam.mjs')"))
})

console.log(`\n全部通过（${passed} 项）`)
