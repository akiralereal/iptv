#!/usr/bin/env node
/**
 * 咪咕取流失败原因的措辞回归测试（issue #131）。
 *
 * 咪咕按「节目」做版权屏蔽时 playurl 返回 rid=COPYRIGHT_SHIELD_INVALID，提示语却只是
 * 「节目播出调整，换个内容看看吧！」——亚运会期间 CCTV5 / CCTV5+ 播到相关赛事就整条屏蔽、
 * 节目结束自动放开，用户看着像项目或账号坏了。现在对这个 rid 在原话后面补一句人话。
 *
 * desc 既进日志也是频道入口的响应正文，所以这里钉三件事：认得的 rid 补提示、
 * 认不得的 rid 一个字节都不变、没有 content 时的兜底文案不变。
 *
 * 运行： node scripts/test-migu-fail-desc.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// resolve.js 间接 import config.js，后者会读数据目录；指到临时目录避免碰真实数据
process.env.mdataDir = mkdtempSync(join(tmpdir(), 'iptv-migu-fail-desc-test-'))
const { failDesc } = await import('../extractors/migu/resolve.js')

const PID = '641886683'
let passed = 0
function test(name, fn) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

test('版权屏蔽：保留咪咕原话，后面补上原因与出路', () => {
  const desc = failDesc(PID, { code: '403', rid: 'COPYRIGHT_SHIELD_INVALID', message: '节目播出调整，换个内容看看吧！' })
  assert.ok(desc.startsWith(`${PID} 节目播出调整，换个内容看看吧！`), desc)
  assert.match(desc, /版权屏蔽/)
  assert.match(desc, /节目结束后自动恢复/)
  assert.match(desc, /其他源/)
})

test('游客被要求登录：保留咪咕原话，后面指到后台填账号的地方', () => {
  const desc = failDesc(PID, { code: '409', rid: 'TIPS_NEED_LOGIN', message: '由于版权原因，请登录后观看' })
  assert.equal(desc, `${PID} 由于版权原因，请登录后观看（游客看不了这个频道：到后台「源管理 → 咪咕视频」填上咪咕账号）`)
})

test('游客被要求登录且咪咕标着 VIP（CHC家庭影院）：补一句会员账号可看', () => {
  const desc = failDesc(PID, {
    code: '409', rid: 'TIPS_NEED_LOGIN', message: '由于版权原因，请登录后观看',
    body: { content: { tip: { code: 'VIP', msg: 'VIP' }, fee: '1' } },
  })
  assert.ok(desc.startsWith(`${PID} 由于版权原因，请登录后观看`), desc)
  assert.match(desc, /源管理 → 咪咕视频/)
  assert.match(desc, /VIP 频道，会员账号可看/)
})

test('其他 rid：原样透传，不加任何后缀', () => {
  assert.equal(failDesc(PID, { rid: 'TIPS_NEED_MEMBER', message: '该内容需开通电视会员' }), `${PID} 该内容需开通电视会员`)
})

test('接口请求失败（miguFetchFail 的 content 没有 rid）：原样透传', () => {
  assert.equal(failDesc(PID, { message: '咪咕接口请求失败', raw: undefined }), `${PID} 咪咕接口请求失败`)
})

test('没有 content（rateType <= 1）：兜底文案不变', () => {
  assert.equal(failDesc(PID, null), `${PID} 节目调整，暂不提供服务`)
  assert.equal(failDesc(PID, undefined), `${PID} 节目调整，暂不提供服务`)
})

console.log(`\n咪咕失败原因措辞：${passed} 项通过`)
