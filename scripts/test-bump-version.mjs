#!/usr/bin/env node
/**
 * bump-version.js 改写镜像标签的回归测试
 *
 * 不变量：发版时 push_docker.yaml 里的 :X.Y.Z / :X.Y / :X 三个标签都被改成新版本，:latest 保留，
 * 旧版本号一处不剩。bump-version.js 每种标签只改文件里第一处，工作流调整标签写法/位置后靠这里兜住。
 *
 * 在临时目录里复制相关文件后真跑一遍 bump-version.js，不动仓库本身。
 *
 * 运行： node scripts/test-bump-version.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKFLOW = '.github/workflows/push_docker.yaml'
const FILES = ['bump-version.js', 'package.json', 'package-lock.json', 'README.md', 'web/admin.html', WORKFLOW]

const tagsIn = (yaml) => [...yaml.matchAll(/akiralereal\/iptv:([\w.]+)/g)].map(m => m[1])

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('bump-version 镜像标签改写测试')

const dir = mkdtempSync(join(tmpdir(), 'iptv-bump-'))
try {
  for (const f of FILES) cpSync(join(root, f), join(dir, f))
  const bump = (v) => {
    execFileSync(process.execPath, ['bump-version.js', v], { cwd: dir, stdio: 'ignore' })
    return readFileSync(join(dir, WORKFLOW), 'utf-8')
  }

  check('当前工作流恰好四个标签：latest + X.Y.Z + X.Y + X', () => {
    const tags = tagsIn(readFileSync(join(root, WORKFLOW), 'utf-8'))
    assert.equal(tags.length, 4, `标签：${tags.join(', ')}`)
    assert.ok(tags.includes('latest'))
    assert.ok(tags.some(t => /^\d+\.\d+\.\d+$/.test(t)))
    assert.ok(tags.some(t => /^\d+\.\d+$/.test(t)))
    assert.ok(tags.some(t => /^\d+$/.test(t)))
  })

  check('大版本升级：三个版本标签全部跟上', () => {
    assert.deepEqual(tagsIn(bump('97.8.9')).sort(), ['97', '97.8', '97.8.9', 'latest'])
  })

  check('再升一次小版本：仍然全部跟上、无旧版本残留', () => {
    assert.deepEqual(tagsIn(bump('97.9.0')).sort(), ['97', '97.9', '97.9.0', 'latest'])
  })
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n全部通过（${passed} 项）`)
