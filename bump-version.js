#!/usr/bin/env node

/**
 * 版本号统一更新脚本
 *
 * 用法:
 *   node bump-version.js patch          # 1.4.3 → 1.4.4
 *   node bump-version.js minor          # 1.4.3 → 1.5.0
 *   node bump-version.js major          # 1.4.3 → 2.0.0
 *   node bump-version.js 1.5.0          # 直接指定版本号
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const r = (f) => resolve(__dirname, f)

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

// sync-notes：只把更新日志最新条目同步到 README 顶部「当前版本更新内容」，不改版本号
if (arg === 'sync-notes' || arg === 'sync') {
  const readmePath = r('README.md')
  const readme = readFileSync(readmePath, 'utf-8')
  const eol = readme.includes('\r\n') ? '\r\n' : '\n'
  writeFileSync(readmePath, syncTopReleaseNotes(readme, eol))
  console.log('✔ 已同步 README 顶部「当前版本更新内容」')
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
      console.error('用法: node bump-version.js <patch|minor|major|x.y.z|sync-notes>')
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

// 4. README.md - 标题版本 + 插入更新日志占位
const readmePath = r('README.md')
let readme = readFileSync(readmePath, 'utf-8')
const readmeEol = readme.includes('\r\n') ? '\r\n' : '\n'
readme = readme.replace(
  /\*\*当前版本：v[^*]*\*\*/,
  `**当前版本：v${newVersion}**`
)
// 在更新日志标题后插入新版本条目（如果还没有）
const changelogEntry = `### v${newVersion} (${today})`
if (!readme.includes(changelogEntry)) {
  readme = readme.replace(
    /(## 📋 更新日志\r?\n\r?\n)/,
    `$1${changelogEntry}${readmeEol}- ${readmeEol}${readmeEol}`
  )
}
// 同步顶部「当前版本更新内容」块的版本头（此时更新日志多为空占位，正文待填；填好后再跑 sync-notes）
readme = syncTopReleaseNotes(readme, readmeEol)
writeFileSync(readmePath, readme)
console.log(`✔ README.md（含顶部「当前版本更新内容」）`)

// 5. .github/workflows/push_docker.yaml
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
console.log(`  1) 编辑 README.md 填写更新日志（把空 \`- \` 占位补成面向用户的条目）`)
console.log(`  2) 运行 node bump-version.js sync-notes 同步到顶部「当前版本更新内容」`)

// ---- 工具函数 ----

// 把「更新日志」里最新的 ### vX.Y.Z 条目镜像到 README 顶部 CURRENT_RELEASE_NOTES 标记块之间。
// 标记缺失或无更新日志条目时安全跳过。正文为空占位时只写版本头 + 待整理提示。
function syncTopReleaseNotes(readme, eol) {
  const START = '<!-- CURRENT_RELEASE_NOTES:START -->'
  const END = '<!-- CURRENT_RELEASE_NOTES:END -->'
  const sIdx = readme.indexOf(START)
  const eIdx = readme.indexOf(END)
  if (sIdx === -1 || eIdx === -1 || eIdx < sIdx) {
    console.warn('⚠ 未找到 CURRENT_RELEASE_NOTES 标记，跳过顶部同步')
    return readme
  }
  const lines = readme.split(/\r?\n/)
  const i = lines.findIndex(l => /^### v\d+\.\d+\.\d+ \(/.test(l))
  if (i === -1) {
    console.warn('⚠ 未找到更新日志条目，跳过顶部同步')
    return readme
  }
  const version = (lines[i].match(/^### (v\d+\.\d+\.\d+)/) || [])[1] || ''
  const body = []
  for (let j = i + 1; j < lines.length; j++) {
    if (/^#{2,3}\s/.test(lines[j])) break // 下一个 ## / ### 标题为界
    body.push(lines[j])
  }
  while (body.length && body[0].trim() === '') body.shift()
  while (body.length && body[body.length - 1].trim() === '') body.pop()
  const isEmpty = body.length === 0 || body.every(l => /^[-*]\s*$/.test(l.trim()))

  const out = [`#### 🆕 ${version} 更新内容`, '']
  if (isEmpty) {
    out.push('（本版更新内容整理中，完整历史见下方 [更新日志](#-更新日志)）')
  } else {
    out.push(...body, '', '<sub>完整更新历史见下方 <a href="#-更新日志">更新日志</a></sub>')
  }
  const inner = eol + out.join(eol) + eol
  return readme.slice(0, sIdx + START.length) + inner + readme.slice(eIdx)
}
