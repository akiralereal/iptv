#!/usr/bin/env node

/**
 * 版本号统一更新脚本
 *
 * 用法:
 *   node bump-version.js patch          # 1.4.3 → 1.4.4
 *   node bump-version.js minor          # 1.4.3 → 1.5.0
 *   node bump-version.js major          # 1.4.3 → 2.0.0
 *   node bump-version.js 1.5.0          # 直接指定版本号
 *   node bump-version.js sync-notes     # 把 CHANGELOG.md 最新条目同步到 README 顶部「当前版本更新内容」
 *   node bump-version.js release-notes  # 把 CHANGELOG.md 最新条目打印成 GitHub Release 正文（stdout，不改文件）
 *   node bump-version.js update-base    # 把 Dockerfile 锁定的基础镜像 node:22-alpine 换成最新版（这一版用户要整包下载）
 *
 * 发版时会联网检查 yt-dlp 和基础镜像有没有新版本，只提醒不改；设 BUMP_OFFLINE=1 跳过（测试用）。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { baseChanged, baseImageInfo, pinnedBase, rewriteBase } from './scripts/base-image.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const r = (f) => resolve(__dirname, f)
const CHANGELOG_URL = 'https://github.com/akiralereal/iptv/blob/main/CHANGELOG.md'

// 读取当前版本
const pkg = JSON.parse(readFileSync(r('package.json'), 'utf-8'))
const current = pkg.version

// 计算新版本
const arg = process.argv[2]
if (!arg) {
  console.log(`当前版本: ${current}`)
  console.log('用法: node bump-version.js <patch|minor|major|x.y.z>')
  process.exit(0)
}

// sync-notes：只把 CHANGELOG.md 最新条目同步到 README 顶部「当前版本更新内容」，不改版本号
if (arg === 'sync-notes' || arg === 'sync') {
  const readmePath = r('README.md')
  const readme = readFileSync(readmePath, 'utf-8')
  const eol = readme.includes('\r\n') ? '\r\n' : '\n'
  writeFileSync(readmePath, syncTopReleaseNotes(readme, readFileSync(r('CHANGELOG.md'), 'utf-8'), eol))
  console.log('✔ 已同步 README 顶部「当前版本更新内容」')
  process.exit(0)
}

// release-notes：把 CHANGELOG.md 最新条目正文 + 升级提示打印到 stdout，供
// `gh release create vX.Y.Z --notes-file <(…)` 使用；不改任何文件。与 CHANGELOG.md 同源，避免手写第二份说明
if (arg === 'release-notes' || arg === 'notes') {
  const latest = latestChangelogEntry(readFileSync(r('CHANGELOG.md'), 'utf-8'))
  if (!latest) {
    console.error('CHANGELOG.md 里未找到更新日志条目（### vX.Y.Z (YYYY-MM-DD)）')
    process.exit(1)
  }
  if (latest.isEmpty) {
    console.error(`${latest.version} 的更新日志还是空占位，先把 CHANGELOG.md 写好再生成发布说明`)
    process.exit(1)
  }
  const tag = latest.version.replace(/^v/, '')
  process.stdout.write([
    ...latest.body,
    '',
    '---',
    '',
    ...(fullDownloadSincePreviousTag(tag) ? [
      '**这一版要重新下载完整镜像**（amd64 / arm64 约 400 MB）：镜像底层换过，各层都重建了。之后的版本恢复只下载有变化的部分（一般几十 MB）。',
      '',
    ] : []),
    `**升级**：拉取 \`akiralereal/iptv:${tag}\`（或 \`latest\`），重建容器即可；数据卷与现有订阅不受影响。完整更新历史见 [CHANGELOG.md](${CHANGELOG_URL})。`,
    '',
  ].join('\n'))
  process.exit(0)
}

// update-base：把 Dockerfile 锁定的基础镜像换成 node:22-alpine 当前最新版。只改 Dockerfile，不动版本号
if (arg === 'update-base') {
  const path = r('Dockerfile')
  const dockerfile = readFileSync(path, 'utf-8')
  let latest
  try { latest = await baseImageInfo() } catch (err) {
    console.error(`查不到 Docker Hub 上的 node:22-alpine：${err.message}`)
    process.exit(1)
  }
  if (pinnedBase(dockerfile) === latest.digest) {
    console.log(`基础镜像已是最新（Node ${latest.node} / Alpine ${latest.alpine}），不用换`)
    process.exit(0)
  }
  writeFileSync(path, rewriteBase(dockerfile, latest.digest, latest))
  console.log(`✔ Dockerfile 基础镜像换成 Node ${latest.node} / Alpine ${latest.alpine}（${latest.digest.slice(0, 19)}…）`)
  console.log('  这一版用户升级要重下整个镜像：更新日志里写明；release-notes 会自动加上提示')
  process.exit(0)
}

let newVersion
if (/^\d+\.\d+\.\d+$/.test(arg)) {
  newVersion = arg
} else {
  const [major, minor, patch] = current.split('.').map(Number)
  switch (arg) {
    case 'patch': newVersion = `${major}.${minor}.${patch + 1}`; break
    case 'minor': newVersion = `${major}.${minor + 1}.0`; break
    case 'major': newVersion = `${major + 1}.0.0`; break
    default:
      console.error(`无效参数: ${arg}`)
      console.error('用法: node bump-version.js <patch|minor|major|x.y.z|sync-notes|release-notes|update-base>')
      process.exit(1)
  }
}

const [newMajor, newMinor] = newVersion.split('.')
const now = new Date()
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

console.log(`版本更新: ${current} → ${newVersion}\n`)

// 1. package.json
const pkgPath = r('package.json')
let pkgContent = readFileSync(pkgPath, 'utf-8')
pkgContent = pkgContent.replace(
  /"version":\s*"[^"]*"/,
  `"version": "${newVersion}"`
)
writeFileSync(pkgPath, pkgContent)
console.log(`✔ package.json`)

// 2. package-lock.json
const lockPath = r('package-lock.json')
let lockContent = readFileSync(lockPath, 'utf-8')
lockContent = lockContent.replace(
  /"version":\s*"[^"]*"/,
  `"version": "${newVersion}"`
)
lockContent = lockContent.replace(
  /("":\s*\{\s*"name":\s*"iptv",\s*"version":\s*")[^"]*(")/s,
  `$1${newVersion}$2`
)
writeFileSync(lockPath, lockContent)
console.log(`✔ package-lock.json`)

// 3. web/admin.html
const htmlPath = r('web/admin.html')
let htmlContent = readFileSync(htmlPath, 'utf-8')
htmlContent = htmlContent.replace(
  /(<span id="versionText"[^>]*>)v[^<]*/,
  `$1v${newVersion}`
)
writeFileSync(htmlPath, htmlContent)
console.log(`✔ web/admin.html`)

// 4. CHANGELOG.md - 在第一个版本条目前插入新版本占位
const changelogPath = r('CHANGELOG.md')
let changelog = readFileSync(changelogPath, 'utf-8')
const changelogEol = changelog.includes('\r\n') ? '\r\n' : '\n'
const changelogEntry = `### v${newVersion} (${today})`
if (!changelog.includes(changelogEntry)) {
  changelog = changelog.replace(
    /^(?=### v\d+\.\d+\.\d+)/m,
    `${changelogEntry}${changelogEol}- ${changelogEol}${changelogEol}`
  )
  writeFileSync(changelogPath, changelog)
}
console.log(`✔ CHANGELOG.md`)

// 5. README.md - 标题版本 + 顶部「当前版本更新内容」版本头（此时条目多为空占位，正文待填；填好后再跑 sync-notes）
const readmePath = r('README.md')
let readme = readFileSync(readmePath, 'utf-8')
const readmeEol = readme.includes('\r\n') ? '\r\n' : '\n'
readme = readme.replace(
  /\*\*当前版本：v[^*]*\*\*/,
  `**当前版本：v${newVersion}**`
)
readme = syncTopReleaseNotes(readme, changelog, readmeEol)
writeFileSync(readmePath, readme)
console.log(`✔ README.md（含顶部「当前版本更新内容」）`)

// 6. .github/workflows/push_docker.yaml
const yamlPath = r('.github/workflows/push_docker.yaml')
let yaml = readFileSync(yamlPath, 'utf-8')
yaml = yaml.replace(
  /akiralereal\/iptv:\d+\.\d+\.\d+/,
  `akiralereal/iptv:${newVersion}`
)
yaml = yaml.replace(
  /akiralereal\/iptv:\d+\.\d+\n/,
  `akiralereal/iptv:${newMajor}.${newMinor}\n`
)
// 主版本滚动标签（如 :2）——此前漏更新，导致 v2.x 仍打成 :1
yaml = yaml.replace(
  /akiralereal\/iptv:\d+\n/,
  `akiralereal/iptv:${newMajor}\n`
)
writeFileSync(yamlPath, yaml)
console.log(`✔ .github/workflows/push_docker.yaml`)

console.log(`\n全部完成！接下来：`)
console.log(`  1) 编辑 CHANGELOG.md 填写更新日志（把空 \`- \` 占位补成面向用户的条目）`)
console.log(`  2) 运行 node bump-version.js sync-notes 同步到顶部「当前版本更新内容」`)

// 7. 提醒：镜像里的 yt-dlp 是发版时锁的版本，YouTube 改版后旧版本会集体解析失败。
// 只提醒不改：新版本要先在本机实测（npm run setup:youtube 后播一个直播）再写进 requirements.txt。
await checkYtDlpPin()

// 8. 提醒：基础镜像锁了版本（见 Dockerfile 开头），有新版时提示，换不换由作者决定：
// 换的那一版用户要整包下载，可以攒几个版本再换，碰上 Node 安全修复就换。
await checkBaseImage()

// ---- 工具函数 ----

async function checkBaseImage() {
  if (process.env.BUMP_OFFLINE) return
  let pinned
  try { pinned = pinnedBase(readFileSync(r('Dockerfile'), 'utf-8')) } catch { return }
  if (!pinned) {
    console.log('\n⚠️  Dockerfile 的基础镜像没锁版本：每次发版都会跟着 node:22-alpine 变，用户升级就得整包下载。执行 node bump-version.js update-base 锁上')
    return
  }
  try {
    const latest = await baseImageInfo()
    if (latest.digest === pinned) {
      console.log(`\n✔ 基础镜像 node:22-alpine 已是最新（Node ${latest.node} / Alpine ${latest.alpine}）`)
      return
    }
    const current = await baseImageInfo(pinned).catch(() => ({}))
    console.log(`\n⚠️  基础镜像 node:22-alpine 有新版本：Node ${current.node || '?'} / Alpine ${current.alpine || '?'} → Node ${latest.node} / Alpine ${latest.alpine}。`
      + '换的话这一版用户升级要重下整个镜像（约 400 MB），可以攒几个版本再换，碰上 Node 安全修复就换：node bump-version.js update-base')
  } catch {
    console.log('\n（查不到 Docker Hub，跳过基础镜像检查）')
  }
}

// 这一版和上一个发布标签的 Dockerfile 基础镜像不同 → 用户升级要整包下载。查不到 git 或没有上一版时当作没变
function fullDownloadSincePreviousTag(version) {
  try {
    const num = v => v.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0)
    const older = (a, b) => { const [x, y] = [num(a), num(b)]; const i = x.findIndex((n, k) => n !== y[k]); return i >= 0 && x[i] < y[i] }
    const tags = execFileSync('git', ['tag', '--list', 'v*', '--sort=-v:refname'], { cwd: __dirname, encoding: 'utf-8' }).split('\n').filter(Boolean)
    const previous = tags.find(t => older(t, version))
    if (!previous) return false
    const before = execFileSync('git', ['show', `${previous}:Dockerfile`], { cwd: __dirname, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
    return baseChanged(before, readFileSync(r('Dockerfile'), 'utf-8'))
  } catch {
    return false
  }
}

async function checkYtDlpPin() {
  if (process.env.BUMP_OFFLINE) return
  let pinned
  try { pinned = readFileSync(r('extractors/youtube-live/requirements.txt'), 'utf-8').match(/^yt-dlp==(\S+)/m)?.[1] } catch { return }
  if (!pinned) return
  try {
    const res = await fetch('https://pypi.org/pypi/yt-dlp/json', { signal: AbortSignal.timeout(5000) })
    const data = await res.json()
    const latest = data?.info?.version
    if (!latest) return
    const needs = data.releases?.[latest]?.[0]?.requires_python
    const num = v => v.split('.').map(n => parseInt(n, 10) || 0)
    const [a, b] = [num(latest), num(pinned)]
    const i = a.findIndex((n, k) => n !== (b[k] || 0))
    if (i >= 0 && a[i] > (b[i] || 0)) console.log(`\n⚠️  yt-dlp 有新版本 ${latest}${needs ? `（要求 Python ${needs}）` : ''}，镜像锁的是 ${pinned}：本机实测后改 extractors/youtube-live/requirements.txt 再发版；源码运行的最低 Python 也要跟着看`)
    else console.log(`\n✔ yt-dlp ${pinned} 已是 PyPI 最新正式版`)
  } catch {
    console.log('\n（查不到 PyPI，跳过 yt-dlp 版本检查）')
  }
}

// 把 CHANGELOG.md 里最新的 ### vX.Y.Z 条目镜像到 README 顶部 CURRENT_RELEASE_NOTES 标记块之间。
// 标记缺失或无更新日志条目时安全跳过。正文为空占位时只写版本头 + 待整理提示。
function syncTopReleaseNotes(readme, changelog, eol) {
  const START = '<!-- CURRENT_RELEASE_NOTES:START -->'
  const END = '<!-- CURRENT_RELEASE_NOTES:END -->'
  const sIdx = readme.indexOf(START)
  const eIdx = readme.indexOf(END)
  if (sIdx === -1 || eIdx === -1 || eIdx < sIdx) {
    console.warn('⚠ 未找到 CURRENT_RELEASE_NOTES 标记，跳过顶部同步')
    return readme
  }
  const latest = latestChangelogEntry(changelog)
  if (!latest) {
    console.warn('⚠ 未找到更新日志条目，跳过顶部同步')
    return readme
  }
  const { version, body, isEmpty } = latest

  const cleanBody = body.map(line => line
    .replace(/\p{Extended_Pictographic}\uFE0F?/gu, '')
    .replace(/\u200D/g, '')
    .replace(/^([-*]\s+)\s+/, '$1')
    .replace(/([「（])\s+/g, '$1')
    .replace(/\s+([」）])/g, '$1')
    .replace(/ {2,}/g, ' ')
  )
  const out = [`#### ${version} 更新内容`, '']
  if (isEmpty) {
    out.push('（本版更新内容整理中，完整历史见 [CHANGELOG.md](CHANGELOG.md)）')
  } else {
    out.push(...cleanBody, '', '<sub>完整更新历史见 <a href="CHANGELOG.md">CHANGELOG.md</a></sub>')
  }
  const inner = eol + out.join(eol) + eol
  return readme.slice(0, sIdx + START.length) + inner + readme.slice(eIdx)
}

// 取 CHANGELOG.md 里最新的 ### vX.Y.Z 条目：返回 { version, body（去首尾空行的正文行）, isEmpty（仍是空占位）}，找不到返回 null。
// sync-notes 与 release-notes 共用，保证顶部块与 GitHub Release 正文同源
function latestChangelogEntry(changelog) {
  const lines = changelog.split(/\r?\n/)
  const i = lines.findIndex(l => /^### v\d+\.\d+\.\d+ \(/.test(l))
  if (i === -1) return null
  const version = (lines[i].match(/^### (v\d+\.\d+\.\d+)/) || [])[1] || ''
  const body = []
  for (let j = i + 1; j < lines.length; j++) {
    if (/^#{2,3}\s/.test(lines[j])) break // 下一个 ## / ### 标题为界
    body.push(lines[j])
  }
  while (body.length && body[0].trim() === '') body.shift()
  while (body.length && body[body.length - 1].trim() === '') body.pop()
  const isEmpty = body.length === 0 || body.every(l => /^[-*]\s*$/.test(l.trim()))
  return { version, body, isEmpty }
}
