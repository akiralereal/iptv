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
      console.error('用法: node bump-version.js <patch|minor|major|x.y.z>')
      process.exit(1)
  }
}

const [newMajor, newMinor] = newVersion.split('.')
const today = new Date().toISOString().slice(0, 10)

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

// 2. web/admin.html
const htmlPath = r('web/admin.html')
let htmlContent = readFileSync(htmlPath, 'utf-8')
htmlContent = htmlContent.replace(
  /(<span id="versionText"[^>]*>)v[^<]*/,
  `$1v${newVersion}`
)
writeFileSync(htmlPath, htmlContent)
console.log(`✔ web/admin.html`)

// 3. README.md - 标题版本 + 插入更新日志占位
const readmePath = r('README.md')
let readme = readFileSync(readmePath, 'utf-8')
readme = readme.replace(
  /\*\*当前版本：v[^*]*\*\*/,
  `**当前版本：v${newVersion}**`
)
// 在更新日志标题后插入新版本条目（如果还没有）
const changelogEntry = `### v${newVersion} (${today})`
if (!readme.includes(changelogEntry)) {
  readme = readme.replace(
    /(## 📋 更新日志\n\n)/,
    `$1${changelogEntry}\n- \n\n`
  )
}
writeFileSync(readmePath, readme)
console.log(`✔ README.md`)

// 4. .github/workflows/push_docker.yaml
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
writeFileSync(yamlPath, yaml)
console.log(`✔ .github/workflows/push_docker.yaml`)

console.log(`\n全部完成！记得编辑 README.md 填写更新日志内容。`)
