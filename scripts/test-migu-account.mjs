#!/usr/bin/env node
/**
 * 咪咕账号 Token 失效的发现（extractors/migu/account.js）。
 *
 * 咪咕对失效的 Token 不报错，照样给流、只是按游客给（auth.logined=false，最高 540P，2026-10-06
 * 用乱填账号实测）。这里钉住：配了账号却回未登录 = 失效并进后台提醒；地址里带的别人账号不报；
 * 网络失败只说检查没做完、不冤枉 Token；重新登录成功就清掉。
 *
 * 运行： node scripts/test-migu-account.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// account.js → androidURL.js 间接 import config.js，后者会读数据目录；指到临时目录避免碰真实数据
process.env.mdataDir = mkdtempSync(join(tmpdir(), 'iptv-migu-account-test-'))
const { checkAccount, credentialRejected, noteAuth, resetAccountState, TOKEN_REJECTED_NOTICE } = await import('../extractors/migu/account.js')
const { getAndroidURL, sendsAccount } = await import('../extractors/migu/androidURL.js')
const { resolve, clearCache } = await import('../extractors/migu/resolve.js')
// 模块经注册表取：直接 import migu/index.js 会撞上注册表的循环依赖
const { getModule } = await import('../extractors/registry.js')
const migu = getModule('migu')

const PID = '641886683'
const config = { userId: '1234567890', token: 'private-test-token' }
const reply = logined => ({ code: 200, message: 'SUCCESS', body: { urlInfo: { url: 'http://x/y.m3u8', rateType: '2' }, auth: { logined } } })
// 只给 checkAccount 用的取流桩：记下是否带了账号请求头
function playurl(body) {
  const calls = []
  const fetchUrl = async (url, opts) => { calls.push(opts.headers); return body }
  return { calls, fetchUrl }
}

let passed = 0
async function test(name, fn) {
  resetAccountState()
  await fn()
  passed++
  console.log(`  ✓ ${name}`)
}

await test('刷新检查：带账号要 720p，回未登录即判失效，回已登录即通过', async () => {
  const rejected = playurl(reply(false))
  assert.deepEqual(await checkAccount(config, PID, { fetchUrl: rejected.fetchUrl }), { rejected: TOKEN_REJECTED_NOTICE })
  assert.equal(rejected.calls[0].UserId, config.userId)
  assert.equal(rejected.calls[0].UserToken, config.token)
  assert.equal(credentialRejected(config), TOKEN_REJECTED_NOTICE)
  assert.match(TOKEN_REJECTED_NOTICE, /540p/)

  assert.deepEqual(await checkAccount(config, PID, { fetchUrl: playurl(reply(true)).fetchUrl }), {})
  assert.equal(credentialRejected(config), '')
})

await test('没配账号不检查；网络失败、回应没有登录状态只说检查没做完', async () => {
  assert.deepEqual(await checkAccount({}, PID, { fetchUrl: () => assert.fail('没配账号不该请求') }), {})
  assert.deepEqual(await checkAccount({ userId: 'x' }, PID, { fetchUrl: () => assert.fail('缺 Token 不该请求') }), {})
  const down = await checkAccount(config, PID, { fetchUrl: async () => undefined })
  assert.match(down.warning, /咪咕账号检查没有完成/)
  const odd = await checkAccount(config, PID, { fetchUrl: async () => ({ code: 200, body: {} }) })
  assert.match(odd.warning, /没有返回登录状态/)
  assert.equal(credentialRejected(config), '')
})

await test('播放时：只有后台配置的账号回未登录才报，地址里带的别人账号不报', async () => {
  noteAuth('999', 'someone-else', config, reply(false))
  assert.equal(credentialRejected(config), '')
  noteAuth(config.userId, config.token, config, reply(false))
  assert.equal(credentialRejected(config), TOKEN_REJECTED_NOTICE)
  // 换了 Token 不再算被拒；同一账号重新登录成功就清掉
  assert.equal(credentialRejected({ ...config, token: 'fresh-token' }), '')
  noteAuth(config.userId, config.token, config, reply(true))
  assert.equal(credentialRejected(config), '')
  // 回应里没有 logined（取流失败）不动结论
  noteAuth(config.userId, config.token, config, reply(false))
  noteAuth(config.userId, config.token, config, { message: '网络超时' })
  assert.equal(credentialRejected(config), TOKEN_REJECTED_NOTICE)
})

await test('标清按游客要：不带账号请求头，播放时的未登录不拿来判 Token 失效', async () => {
  // resolve.js 只在 sendsAccount 为真时把回应交给 noteAuth；这里钉住它与真实请求头一致
  for (const rateType of [2, '2', 3, 4, 9]) {
    const headers = []
    await getAndroidURL(config.userId, config.token, PID, rateType, {
      enableHDR: false, enableH265: false,
      fetchUrl: async (url, opts) => { headers.push(opts.headers); return undefined },
    })
    assert.equal(headers.length > 0, true)
    assert.equal(sendsAccount(config.userId, config.token, rateType), headers[0].UserId === config.userId, `rateType ${rateType}`)
  }
  assert.equal(sendsAccount(config.userId, config.token, 2), false, '标清不带账号')
  assert.equal(sendsAccount(config.userId, config.token, 3), true)
  assert.equal(sendsAccount('', '', 3), false)

  // 走真实的播放解析：咪咕对不带账号的请求回未登录
  const playback = async rateType => {
    clearCache()
    const sent = []
    const fetchUrl = async (url, opts) => { sent.push(opts.headers.UserId); return reply(!!opts.headers.UserId) }
    await resolve(PID, { account: config, config: { ...config, rateType, enableClientDispatch: true }, fetchUrl })
    return sent
  }
  assert.deepEqual(await playback(2), [undefined])
  assert.equal(credentialRejected(config), '', '标清播放不冤枉 Token')
  // 对照：带账号去要、咪咕回未登录，才算失效
  const reject = async () => { clearCache(); await resolve(PID, { account: config, config: { ...config, rateType: 3, enableClientDispatch: true }, fetchUrl: async () => reply(false) }) }
  await reject()
  assert.equal(credentialRejected(config), TOKEN_REJECTED_NOTICE)
  clearCache()
})

await test('模块把播放时的结论交给后台（credentialRejected 钩子）', async () => {
  assert.equal(typeof migu.credentialRejected, 'function')
  noteAuth(config.userId, config.token, config, reply(false))
  assert.equal(migu.credentialRejected(config), TOKEN_REJECTED_NOTICE)
})

console.log(`\n全部通过：${passed} ✓`)
