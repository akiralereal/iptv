#!/usr/bin/env node
/**
 * YouTube 解析组件（yt-dlp）的版本检查与就地升级逻辑（extractors/youtube-live/runtime.js）。
 * 不连网：PyPI 返回值用假数据，虚拟环境用临时目录模拟。
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { compareVersions, latestRelease, managedVenv, pythonSatisfies, venvPython, ytDlpCommand } from '../extractors/youtube-live/runtime.js'

// yt-dlp 报 2026.08.19，PyPI 写 2026.8.19
assert.equal(compareVersions('2026.08.19', '2026.8.19'), 0)
assert.ok(compareVersions('2026.10.21', '2026.08.19') > 0)
assert.ok(compareVersions('2026.9.1', '2026.10.21') < 0)

assert.equal(pythonSatisfies('>=3.10', '3.10.21'), true)
assert.equal(pythonSatisfies('>=3.11', '3.10.21'), false)
assert.equal(pythonSatisfies('>=3.9,!=3.10.*', '3.10.4'), false)
assert.equal(pythonSatisfies('>=3.9,!=3.10.*', '3.12.1'), true)
assert.equal(pythonSatisfies('', '3.10'), true)
assert.equal(pythonSatisfies('>=3.11', ''), true, '不知道 Python 版本时不拦')

// PyPI：按 Python 版本挑能装的最新正式版；dev 预发版、撤回的跳过
const file = (requires_python, extra = {}) => [{ requires_python, upload_time: '2026-10-21T21:54:50', yanked: false, ...extra }]
const pypi = {
  info: { version: '2026.10.26' },
  releases: {
    '2026.8.19': file('>=3.10'),
    '2026.10.21': file('>=3.10'),
    '2026.10.25': file('>=3.10', { yanked: true }),
    '2026.10.26': file('>=3.11'),
    '2026.11.4.232659.dev0': file('>=3.11'),
    '2026.9.1': [],
  },
}
const fakeFetch = async () => new Response(JSON.stringify(pypi), { status: 200 })
let latest = await latestRelease({ python: '3.10.21', fetchImpl: fakeFetch })
assert.equal(latest.version, '2026.10.21', 'Python 3.10 只能用到 2026.10.21')
assert.equal(latest.newest, '2026.10.26')
assert.equal(latest.newestRequiresPython, '>=3.11')
latest = await latestRelease({ python: '3.12.8', fetchImpl: fakeFetch })
assert.equal(latest.version, '2026.10.26')
await assert.rejects(latestRelease({ fetchImpl: async () => new Response('', { status: 503 }) }), /HTTP 503/)
await assert.rejects(latestRelease({ fetchImpl: async () => { throw new TypeError('fetch failed') } }), /连不上 PyPI/)

// 只升级本项目建的虚拟环境（有 pyvenv.cfg）；YTDLP_BIN 指定的、系统里的不碰
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'iptv-ytdlp-runtime-')))
try {
  const venv = join(dir, 'opt', 'youtube')
  mkdirSync(join(venv, 'bin'), { recursive: true })
  writeFileSync(join(venv, 'pyvenv.cfg'), 'home = /usr/bin\ninclude-system-site-packages = false\nversion = 3.12.8\n')
  writeFileSync(join(venv, 'bin', 'python'), '')
  writeFileSync(join(venv, 'bin', 'yt-dlp'), '')
  mkdirSync(join(dir, 'usr', 'local', 'bin'), { recursive: true })
  symlinkSync(join(venv, 'bin', 'yt-dlp'), join(dir, 'usr', 'local', 'bin', 'yt-dlp'))
  assert.equal(managedVenv(join(dir, 'usr', 'local', 'bin', 'yt-dlp'), { env: {} }), venv, 'Docker 的 /usr/local/bin/yt-dlp 软链接到虚拟环境')
  assert.equal(venvPython(venv), '3.12.8')
  assert.equal(managedVenv(join(venv, 'bin', 'yt-dlp'), { env: { YTDLP_BIN: '/x' } }), '', 'YTDLP_BIN 指定的不替它升级')
  const system = join(dir, 'usr', 'bin')
  mkdirSync(system, { recursive: true })
  writeFileSync(join(system, 'yt-dlp'), '')
  writeFileSync(join(system, 'python3'), '')
  assert.equal(managedVenv(join(system, 'yt-dlp'), { env: {} }), '', '系统 Python 装的 yt-dlp 不碰')
  assert.equal(managedVenv(join(dir, 'missing'), { env: {} }), '')

  // 本项目的虚拟环境用其中的 python -m yt_dlp；YTDLP_BIN 指定的、系统里的照旧直接执行
  const viaVenv = { file: join(venv, 'bin', 'python'), args: ['-m', 'yt_dlp'] }
  assert.deepEqual(ytDlpCommand(join(dir, 'usr', 'local', 'bin', 'yt-dlp'), { env: {} }), viaVenv, 'Docker 软链接')
  assert.deepEqual(ytDlpCommand(join(venv, 'bin', 'yt-dlp'), { env: {} }), viaVenv, '源码运行的 .runtime/youtube')
  assert.deepEqual(ytDlpCommand(join(system, 'yt-dlp'), { env: {} }), { file: join(system, 'yt-dlp'), args: [] })
  assert.deepEqual(ytDlpCommand('/x/yt-dlp', { env: { YTDLP_BIN: '/x/yt-dlp' } }), { file: '/x/yt-dlp', args: [] })

  // 源码运行装完后挪过项目目录：启动脚本第一行还指着旧路径，系统报「找不到」；python -m yt_dlp 照样能跑
  const run = promisify(execFile)
  writeFileSync(join(venv, 'bin', 'python'), '#!/bin/sh\n[ "$*" = "-m yt_dlp --version" ] && echo 2026.10.26\n')
  writeFileSync(join(venv, 'bin', 'yt-dlp'), '#!/old/place/iptv/.runtime/youtube/bin/python\n')
  for (const name of ['python', 'yt-dlp']) chmodSync(join(venv, 'bin', name), 0o755)
  await assert.rejects(run(join(venv, 'bin', 'yt-dlp'), ['--version']), { code: 'ENOENT' })
  const { file: python, args } = ytDlpCommand(join(venv, 'bin', 'yt-dlp'), { env: {} })
  assert.equal((await run(python, [...args, '--version'])).stdout.trim(), '2026.10.26')
} finally { rmSync(dir, { recursive: true, force: true }) }

console.log('✅ YouTube 解析组件：版本比较、按 Python 选版本、只升级本项目的虚拟环境、挪过目录照样能跑')
