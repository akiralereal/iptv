#!/usr/bin/env node
/**
 * 起一个只开指定抓取模块的本地实例：其他模块、咪咕、内置源、订阅源全关，用来单独看一个模块的抓取结果。
 * 数据放系统临时目录、每次启动清空，不碰正式配置。Ctrl-C 退出。
 *
 *   node scripts/run-only-module.mjs                    # 默认 jrkan-events，端口 19071
 *   node scripts/run-only-module.mjs --only hangzhou --port 19072
 *
 * 模块的请求从这台机器发出：要换网络就先换好再启动。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const opt = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback }
const only = opt('--only', 'jrkan-events')
const port = opt('--port', '19071')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const dataDir = join(tmpdir(), `iptv-only-${only}-${port}`)
rmSync(dataDir, { recursive: true, force: true })
mkdirSync(dataDir, { recursive: true })
const env = {
  ...process.env, mdataDir: dataDir, mport: port, mblank: 'true',
  // 默认读本地 built-in-sources.json；要测远程配置时外面设 mbuiltInSourcesUrl
  mbuiltInSourcesUrl: process.env.mbuiltInSourcesUrl ?? '',
  menableEpgAggregation: 'false', menableLogoCache: 'false',
}
Object.assign(process.env, env)  // 注册表里的模块加载时会读 config.js，要先指到临时目录

const { hasModule, listModules } = await import('../extractors/registry.js')
if (!hasModule(only)) {
  console.error(`没有模块 ${only}`)
  process.exit(1)
}
const modules = Object.fromEntries(listModules()
  .filter(module => typeof module.enabledGetter !== 'function')
  .map(module => [module.id, { enabled: module.id === only, config: {} }]))
writeFileSync(join(dataDir, 'extractors.json'), JSON.stringify({ modules, masterSwitchRetired: true }, null, 2))

console.log(`只开 ${only}，数据目录 ${dataDir}`)
console.log(`播放列表 http://127.0.0.1:${port}/interface.m3u`)
console.log(`后台     http://127.0.0.1:${port}/admin\n`)
const child = spawn(process.execPath, ['app.js'], { cwd: root, env, stdio: 'inherit' })
process.on('SIGINT', () => {})
process.on('SIGTERM', () => child.kill('SIGTERM'))
child.on('exit', code => process.exit(code ?? 0))
