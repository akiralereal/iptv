#!/usr/bin/env node
/**
 * 后台「检查更新」的回归测试（utils/updateCheck.js）
 *
 * 不变量：只有远端版本更高才提示更新；镜像返回比当前更旧的版本时视为缓存过期，换下一个镜像。
 * 起因：v4.79.0 发版后，gcore.jsdelivr.net 还在返回 4.78.0，旧判断（`!==`）把它显示成「发现新版本 v4.78.0」。
 *
 * 不联网：fetch 用假的，每个镜像按地址返回预设的版本或错误。
 *
 * 运行： node scripts/test-update-check.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { checkForUpdate, compareVersions } from '../utils/updateCheck.js'

let passed = 0
const check = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('检查更新：版本比较与过期镜像')

const RAW = 'https://raw.githubusercontent.com/akiralereal/iptv/main/package.json'
const MIRRORS = ['raw', 'proxy', 'gcore', 'cdn'].map(name => (url) => `${name}|${url}`)

/** answers: 镜像名 → 版本字符串 | Error | { status } | 对象（原样当作 package.json） */
function fakeFetch(answers) {
  const asked = []
  const impl = async (url) => {
    const name = url.split('|')[0]
    asked.push(name)
    const a = answers[name]
    if (a === undefined || a instanceof Error) throw a || new Error('ECONNREFUSED')
    if (a.status) return { ok: false, status: a.status, json: async () => ({}) }
    const body = typeof a === 'string' ? { version: a } : a
    return { ok: true, status: 200, json: async () => body }
  }
  return { impl, asked }
}

const run = (current, answers, extra = {}) => {
  const f = fakeFetch(answers)
  const stale = []
  return checkForUpdate(current, {
    rawUrl: RAW, mirrors: MIRRORS, fetchImpl: f.impl,
    onStaleMirror: (url, v) => stale.push(`${url.split('|')[0]}=${v}`),
    ...extra,
  }).then(r => ({ ...r, asked: f.asked, stale }))
}

await check('compareVersions 按数字逐段比，忽略前缀 v', () => {
  assert.ok(compareVersions('4.79.0', '4.78.0') > 0)
  assert.ok(compareVersions('4.78.0', '4.79.0') < 0)
  assert.ok(compareVersions('4.10.0', '4.9.9') > 0)
  assert.equal(compareVersions('v4.79.0', '4.79.0'), 0)
  assert.equal(compareVersions('4.79', '4.79.0'), 0)
})

await check('远端相同：已是最新，不再问后面的镜像', async () => {
  const r = await run('4.79.0', { raw: '4.79.0' })
  assert.equal(r.hasUpdate, false)
  assert.equal(r.latestVersion, '4.79.0')
  assert.deepEqual(r.asked, ['raw'])
})

await check('远端更高：有更新', async () => {
  const r = await run('4.78.0', { raw: '4.79.0' })
  assert.equal(r.hasUpdate, true)
  assert.equal(r.latestVersion, '4.79.0')
})

await check('报告的场景：直连失败、gcore 缓存旧版本 → 跳过它，cdn 给出当前版本，不提示更新', async () => {
  const r = await run('4.79.0', { proxy: { status: 502 }, gcore: '4.78.0', cdn: '4.79.0' })
  assert.equal(r.hasUpdate, false)
  assert.equal(r.latestVersion, '4.79.0')
  assert.deepEqual(r.asked, ['raw', 'proxy', 'gcore', 'cdn'])
  assert.deepEqual(r.stale, ['gcore=4.78.0'])
})

await check('过期镜像后面有更新的版本：照样提示', async () => {
  const r = await run('4.79.0', { gcore: '4.78.0', cdn: '4.80.0' })
  assert.equal(r.hasUpdate, true)
  assert.equal(r.latestVersion, '4.80.0')
})

await check('能回答的镜像都是旧版本：按已是最新处理，latestVersion 填当前版本', async () => {
  const r = await run('4.79.0', { gcore: '4.78.0' })
  assert.equal(r.hasUpdate, false)
  assert.equal(r.latestVersion, '4.79.0')
})

await check('package.json 里没有 version：当作该镜像失败，继续问下一个', async () => {
  const r = await run('4.79.0', { raw: { name: 'iptv' }, proxy: '4.79.1' })
  assert.equal(r.hasUpdate, true)
  assert.equal(r.latestVersion, '4.79.1')
})

await check('全部镜像失败：抛出最后一个错误（前端显示「检查失败」）', async () => {
  const errors = []
  await assert.rejects(
    run('4.79.0', { cdn: new Error('最后一个') }, { onMirrorError: (url, e) => errors.push(e.message) }),
    /最后一个/
  )
  assert.equal(errors.length, 4)
})

console.log(`\n全部 ${passed} 项通过`)
