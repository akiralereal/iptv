#!/usr/bin/env node
/**
 * bump-version.js 改写镜像标签的回归测试
 *
 * 不变量：发版时 push_docker.yaml 里的 :X.Y.Z / :X.Y / :X 三个标签都被改成新版本，:latest 保留，
 * 旧版本号一处不剩。bump-version.js 每种标签只改文件里第一处，工作流调整标签写法/位置后靠这里兜住。
 *
 * 在临时目录里复制相关文件后真跑一遍 bump-version.js，不动仓库本身（BUMP_OFFLINE=1，不联网查 yt-dlp / 基础镜像）。
 *
 * 另测 scripts/base-image.mjs 的纯函数：Dockerfile 基础镜像必须锁到 digest（没锁的话每次发版用户都要整包下载），
 * update-base 的改写、release-notes 判断「这一版要整包下载」的比较。
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
const FILES = ['bump-version.js', 'scripts/base-image.mjs', 'Dockerfile', 'package.json', 'package-lock.json', 'README.md', 'CHANGELOG.md', 'web/admin.html', WORKFLOW]
const { pinnedBase, rewriteBase, baseChanged } = await import('./base-image.mjs')

const tagsIn = (yaml) => [...yaml.matchAll(/akiralereal\/iptv:([\w.]+)/g)].map(m => m[1])

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('bump-version 镜像标签改写测试')

const dir = mkdtempSync(join(tmpdir(), 'iptv-bump-'))
try {
  for (const f of FILES) cpSync(join(root, f), join(dir, f))
  const bump = (v) => {
    execFileSync(process.execPath, ['bump-version.js', v], { cwd: dir, stdio: 'ignore', env: { ...process.env, BUMP_OFFLINE: '1' } })
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

  check('层缓存标签不写仓库名字面量，不会被当成版本标签改写', () => {
    const yaml = readFileSync(join(root, WORKFLOW), 'utf-8')
    assert.match(yaml, /cache-from: type=registry,ref=\$\{\{ env\.IMAGE \}\}:buildcache-\$\{\{ env\.PLATFORM_PAIR \}\}/)
    assert.match(yaml, /cache-to: type=registry,ref=\$\{\{ env\.IMAGE \}\}:buildcache-\$\{\{ env\.PLATFORM_PAIR \}\},mode=max/)
  })
} finally {
  rmSync(dir, { recursive: true, force: true })
}

const A = 'sha256:' + 'a'.repeat(64), B = 'sha256:' + 'b'.repeat(64)
check('仓库 Dockerfile 的基础镜像锁到 digest，且系统包排在 package.json 之前', () => {
  const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf-8')
  assert.match(pinnedBase(dockerfile), /^sha256:[0-9a-f]{64}$/, '没锁的话每次发版用户都要整包下载')
  const at = text => { const i = dockerfile.indexOf(text); assert.ok(i >= 0, text); return i }
  const pkg = at('COPY package*.json')
  for (const step of ['apk add --no-cache tini', 'chromium', 'apk add --no-cache tzdata', 'apk add --no-cache python3']) {
    assert.ok(at(step) < pkg, `${step} 要排在 COPY package*.json 之前，否则每次发版都跟着重建`)
  }
  assert.doesNotMatch(dockerfile, /^RUN apk add[^\n]*py3-pip/m, 'venv 的 pip 来自 ensurepip，系统 pip 用不上')
})

check('update-base 改写：换 digest、更新注释里的版本说明，其余不动', () => {
  const before = `# 基础镜像（当前 Node 22.1.0 / Alpine 3.24.1）\nFROM node:22-alpine@${A}\n\nWORKDIR /iptv\n`
  const after = rewriteBase(before, B, { node: '22.2.0', alpine: '3.24.2' })
  assert.equal(after, `# 基础镜像（当前 Node 22.2.0 / Alpine 3.24.2）\nFROM node:22-alpine@${B}\n\nWORKDIR /iptv\n`)
  assert.equal(rewriteBase('FROM node:22-alpine\n', A), `FROM node:22-alpine@${A}\n`, '没锁的也能锁上')
  assert.throws(() => rewriteBase('FROM python:3.14-alpine\n', A), /不是 node:22-alpine/)
})

check('release-notes 的整包判断：FROM 变了才算', () => {
  assert.equal(baseChanged(`FROM node:22-alpine@${A}\nRUN a\n`, `FROM node:22-alpine@${A}\nRUN b\n`), false, '只改后面的步骤不算')
  assert.equal(baseChanged(`FROM node:22-alpine@${A}\n`, `FROM node:22-alpine@${B}\n`), true)
  assert.equal(baseChanged('FROM node:22-alpine\n', `FROM node:22-alpine@${A}\n`), true, '从没锁到锁定（v4.63.0）也算')
  assert.equal(baseChanged('', `FROM node:22-alpine@${A}\n`), false, '拿不到上一版的 Dockerfile 不乱报')
})

console.log(`\n全部通过（${passed} 项）`)
