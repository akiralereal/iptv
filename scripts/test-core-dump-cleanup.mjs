#!/usr/bin/env node
/**
 * 崩溃转储清理回归测试（utils/coreDumpCleanup.js）
 *
 * 不变量：
 * 1. 只删 ELF 头标明是 core 的文件，大小端都认；
 * 2. 名字像 core 但内容不是的（core.js、可执行文件、过短的文件）不碰，名字不对的 core 内容也不碰；
 * 3. 目录不碰，工作目录和数据目录相同时不重复计数；
 * 4. 镜像启动时关掉 core 生成，子进程（Chromium）一并继承。
 *
 * 运行： node scripts/test-core-dump-cleanup.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'iptv-core-dump-'))
process.env.mdataDir = DIR
process.env.mblank = 'true'

const { cleanCoreDumps, isCoreDump } = await import('../utils/coreDumpCleanup.js')

function elf({ type, bigEndian = false, size = 64 }) {
  const buf = Buffer.alloc(size)
  buf.writeUInt32BE(0x7f454c46, 0)
  buf[4] = 2
  buf[5] = bigEndian ? 2 : 1
  if (bigEndian) buf.writeUInt16BE(type, 16)
  else buf.writeUInt16LE(type, 16)
  return buf
}

try {
  const dir = join(DIR, 'work')
  mkdirSync(dir)
  writeFileSync(join(dir, 'core.7139'), elf({ type: 4, size: 1000 }))
  writeFileSync(join(dir, 'core.3094'), elf({ type: 4, bigEndian: true, size: 500 }))
  writeFileSync(join(dir, 'core'), elf({ type: 4, size: 100 }))
  writeFileSync(join(dir, 'core.chromium.42'), elf({ type: 4, size: 100 }))

  writeFileSync(join(dir, 'core.js'), 'export default 1\n')
  writeFileSync(join(dir, 'core.8'), elf({ type: 2 }))
  writeFileSync(join(dir, 'core.9'), Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  writeFileSync(join(dir, 'score.1'), elf({ type: 4 }))
  mkdirSync(join(dir, 'core.d'))

  assert.equal(isCoreDump(join(dir, 'core.7139')), true)
  assert.equal(isCoreDump(join(dir, 'core.3094')), true)
  assert.equal(isCoreDump(join(dir, 'core.8')), false)
  assert.equal(isCoreDump(join(dir, 'core.9')), false)
  assert.equal(isCoreDump(join(dir, 'missing')), false)

  assert.deepEqual(cleanCoreDumps({ dirs: [dir, dir] }), { count: 4, bytes: 1700 })
  for (const name of ['core.7139', 'core.3094', 'core', 'core.chromium.42']) assert.equal(existsSync(join(dir, name)), false, name)
  for (const name of ['core.js', 'core.8', 'core.9', 'score.1', 'core.d']) assert.equal(existsSync(join(dir, name)), true, name)

  assert.deepEqual(cleanCoreDumps({ dirs: [dir] }), { count: 0, bytes: 0 })
  assert.deepEqual(cleanCoreDumps({ dirs: [join(DIR, 'missing')] }), { count: 0, bytes: 0 })

  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf-8')
  assert.match(dockerfile, /^CMD .*ulimit -c 0; exec node app\.js/m)

  console.log('core dump cleanup tests passed')
} finally {
  rmSync(DIR, { recursive: true, force: true })
}
