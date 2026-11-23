#!/usr/bin/env node
/**
 * 完整更新间隔校验（utils/updateInterval.js，issue #246）。
 *
 * 以前 0、0.5、负数、非数字或超过 596 小时的间隔原样交给 setInterval，Node 会退成 1 毫秒，
 * 完整更新每毫秒并发跑一次，日志被「准备更新文件」刷屏。
 *
 * 不变量：
 *  1) 填错（非数字、小于 1）按默认 8 小时并给出提示；超过 168 按 168 并提示；正常值不提示。
 *  2) 解析出的小时数换成毫秒后，setInterval 不会退成 1 毫秒。
 *  3) 保存接口（mergeSystemConfig）存进去的一定是 1～168 的整数字符串。
 *
 * 运行： node scripts/test-update-interval.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_UPDATE_INTERVAL_HOURS, MAX_UPDATE_INTERVAL_HOURS, resolveUpdateIntervalHours,
} from '../utils/updateInterval.js'

const DATA_DIR = mkdtempSync(join(tmpdir(), 'iptv-update-interval-'))
process.env.mdataDir = DATA_DIR

let passed = 0
const check = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('完整更新间隔校验')

try {
  await check('正常值原样用、不提示', () => {
    for (const [raw, hours] of [['8', 8], [8, 8], ['1', 1], ['168', 168], [' 12 ', 12], ['24', 24]]) {
      assert.deepEqual(resolveUpdateIntervalHours(raw), { hours, warning: null }, JSON.stringify(raw))
    }
  })

  await check('小数向下取整', () => {
    assert.deepEqual(resolveUpdateIntervalHours('1.5'), { hours: 1, warning: null })
    assert.deepEqual(resolveUpdateIntervalHours('8.9'), { hours: 8, warning: null })
  })

  await check('0、小于 1、负数、非数字、空值按默认 8 小时并提示', () => {
    for (const raw of ['0', 0, '0.5', '-1', '-8', 'abc', '8abc', '', undefined, null, 'NaN', 'Infinity']) {
      const { hours, warning } = resolveUpdateIntervalHours(raw)
      assert.equal(hours, DEFAULT_UPDATE_INTERVAL_HOURS, JSON.stringify(raw))
      assert.ok(warning && warning.includes('无效'), JSON.stringify(raw))
    }
  })

  await check('超过 168 按 168 并提示', () => {
    for (const raw of ['169', '600', '9999', 1e9]) {
      const { hours, warning } = resolveUpdateIntervalHours(raw)
      assert.equal(hours, MAX_UPDATE_INTERVAL_HOURS, JSON.stringify(raw))
      assert.ok(warning && warning.includes('超过上限'), JSON.stringify(raw))
    }
  })

  await check('任何输入换成毫秒后都不会让 setInterval 退成 1 毫秒', async () => {
    const inputs = ['0', '0.5', '-1', 'abc', '600', '9999', '8', '1', '168']
    let fired = 0
    const timers = inputs.map(raw => setInterval(() => { fired++ }, resolveUpdateIntervalHours(raw).hours * 60 * 60 * 1000))
    await new Promise(resolve => setTimeout(resolve, 100))
    timers.forEach(clearInterval)
    assert.equal(fired, 0)
  })

  await check('保存接口只存 1～168 的整数字符串', async () => {
    const { mergeSystemConfig } = await import('../utils/systemConfigAPI.js')
    const cases = [['8', '8'], ['12', '12'], ['', '8'], ['0', '8'], ['0.5', '8'], ['-3', '8'], ['abc', '8'], ['600', '168'], ['2.5', '2']]
    for (const [input, stored] of cases) {
      assert.equal(mergeSystemConfig({}, { programInfoUpdateInterval: input }).programInfoUpdateInterval, stored, JSON.stringify(input))
    }
    // 没提交这一项（如网络代理标签单独保存）时不动已存值
    assert.equal(mergeSystemConfig({ programInfoUpdateInterval: '12' }, { proxy: '' }).programInfoUpdateInterval, '12')
  })
} finally {
  rmSync(DATA_DIR, { recursive: true, force: true })
}

console.log(`\n${passed} 项通过`)
