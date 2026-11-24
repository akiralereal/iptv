#!/usr/bin/env node
/**
 * 已下线功能残留数据清理回归测试（utils/retiredData.js）
 *
 * 不变量：
 * 1. 数据目录里的 hongguo-vod/（含子目录和文件）整个删掉；
 * 2. 数据目录里别的文件和目录不碰；
 * 3. 目录不存在时什么都不做、不报错，再跑一次也一样；
 * 4. hongguo-vod 是符号链接时只删链接，不删它指向的目录。
 *
 * 运行： node scripts/test-retired-data.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'iptv-retired-data-'))
process.env.mdataDir = DIR
process.env.mblank = 'true'

const { removeRetiredData } = await import('../utils/retiredData.js')

try {
  const hongguo = join(DIR, 'hongguo-vod')
  mkdirSync(join(hongguo, '.runtime', 'media', 'session-abc'), { recursive: true })
  writeFileSync(join(hongguo, '.runtime', 'app-session.json'), '{}')
  writeFileSync(join(hongguo, '.runtime', 'media', 'session-abc', 'part-00001.m4s'), 'x')
  writeFileSync(join(DIR, 'system-config.json'), '{}')
  mkdirSync(join(DIR, 'logos'))
  writeFileSync(join(DIR, 'logos', 'CCTV1.png'), 'x')

  assert.deepEqual(removeRetiredData(), ['hongguo-vod'])
  assert.equal(existsSync(hongguo), false)
  assert.equal(existsSync(join(DIR, 'system-config.json')), true)
  assert.equal(existsSync(join(DIR, 'logos', 'CCTV1.png')), true)

  assert.deepEqual(removeRetiredData(), [])

  const outside = mkdtempSync(join(tmpdir(), 'iptv-retired-target-'))
  try {
    writeFileSync(join(outside, 'keep.txt'), 'x')
    symlinkSync(outside, hongguo)
    assert.deepEqual(removeRetiredData(), ['hongguo-vod'])
    assert.equal(existsSync(hongguo), false)
    assert.equal(existsSync(join(outside, 'keep.txt')), true)
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }

  console.log('✓ test-retired-data 通过')
} finally {
  rmSync(DIR, { recursive: true, force: true })
}
