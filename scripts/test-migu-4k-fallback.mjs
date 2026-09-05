#!/usr/bin/env node
/**
 * 咪咕 4K 取流降级链回归测试（issue #117）。
 *
 * 4K（rateType 9）请求带 `ott=true`，走的是咪咕「大屏 / 电视终端」策略，按大屏（四屏）
 * 权益判定。足球通这类不含电视端的「三屏」会员在这条路上会被判 TIPS_NEED_MEMBER，
 * 原实现随即降到蓝光，1080P 成了他们的天花板，日志还打「该账号没有会员」。而手机策略
 * （不带 ott）本身就列有 rateType 9「臻享 超高清」。修法：被大屏策略拒绝后先原样按手机
 * 策略再要一次 4K，仍被拒才降级；含大屏权益的账号第一次就成功、路径不变。
 *
 * 这里把 fetchUrl 换成按「(rateType, 是否带 ott)」查表的假请求函数，钉住请求顺序、
 * 最终档位与日志措辞。真实接口上的对比见 issue #117 里的实测。
 *
 * 运行： node scripts/test-migu-4k-fallback.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// androidURL.js 间接 import config.js，后者会读数据目录；指到临时目录避免碰真实数据
process.env.mdataDir = mkdtempSync(join(tmpdir(), 'iptv-migu-4k-test-'))
const { getAndroidURL, printStreamInfo } = await import('../extractors/migu/androidURL.js')

const PID = '967231356'
const OPTS = { enableHDR: false, enableH265: false }

const ok = (rt) => ({
  rid: 'SUCCESS', message: 'SUCCESS',
  body: {
    urlInfo: { url: `http://gslbmgsplive.miguvideo.com/x.m3u8?pid=${PID}&puData=0123456789abcdef0123456789abcdef`, rateType: String(rt) },
    content: { contId: PID },
    auth: { logined: true, authResult: 'SUCCESS' },
  },
})
// offered：咪咕拒绝时在 urlInfo.rateType 里给出的「它愿意给的档位」
const needMember = (offered, message = '该内容需开通电视会员') => ({
  rid: 'TIPS_NEED_MEMBER', message,
  body: { urlInfo: offered == null ? {} : { rateType: String(offered) }, auth: { logined: true, authResult: 'FAIL' } },
})

function fakeFetch(table) {
  const calls = []
  const fn = async (url) => {
    const q = new URL(url).searchParams
    const key = `${q.get('rateType')}${q.get('ott') === 'true' ? '+ott' : ''}`
    calls.push(key)
    const resp = table[key]
    assert.ok(resp, `没有为请求 ${key} 准备回应，实际请求顺序：${calls.join(' → ')}`)
    return typeof resp === 'function' ? resp() : resp
  }
  return { fn, calls }
}

// 截获日志，检查措辞
const logs = []
const origLog = console.log
console.log = (...a) => { logs.push(a.join(' ')) }

let passed = 0
async function check(name, fn) {
  logs.length = 0
  await fn()
  passed++
  origLog(`  ✅ ${name}`)
}

try {
  await check('三屏会员：4K 被大屏策略拒绝后按手机策略再要一次，拿到 4K', async () => {
    const { fn, calls } = fakeFetch({ '9+ott': needMember(9), '9': ok(9) })
    const res = await getAndroidURL('u', 't', PID, 9, { ...OPTS, fetchUrl: fn })
    assert.deepEqual(calls, ['9+ott', '9'])
    assert.equal(res.rateType, 9)
    assert.ok(res.url.includes('&ddCalcu='), '成功时要拿到加了 ddCalcu 的地址')
    assert.ok(logs.some(l => l.includes('咪咕：该内容需开通电视会员')), '日志要带咪咕原话')
    assert.ok(!logs.some(l => l.includes('没有会员')), '不再说「该账号没有会员」')
  })

  await check('账号不含 4K：两次 4K 都被拒，按咪咕愿意给的档位降到蓝光', async () => {
    const { fn, calls } = fakeFetch({ '9+ott': needMember(9), '9': needMember(4), '4': ok(4) })
    const res = await getAndroidURL('u', 't', PID, 9, { ...OPTS, fetchUrl: fn })
    assert.deepEqual(calls, ['9+ott', '9', '4'])
    assert.equal(res.rateType, 4)
    assert.ok(logs.some(l => l.includes('已降到 蓝光 1080P')), '日志要说清实际降到的档位')
  })

  await check('蓝光也被拒：兜底到高清，且只再请求一次', async () => {
    const { fn, calls } = fakeFetch({ '9+ott': needMember(9), '9': needMember(9), '4': needMember(3), '3': ok(3) })
    const res = await getAndroidURL('u', 't', PID, 9, { ...OPTS, fetchUrl: fn })
    assert.deepEqual(calls, ['9+ott', '9', '4', '3'])
    assert.equal(res.rateType, 3)
  })

  await check('含大屏权益的账号：第一次带 ott 就成功，路径不变', async () => {
    const { fn, calls } = fakeFetch({ '9+ott': ok(9) })
    const res = await getAndroidURL('u', 't', PID, 9, { ...OPTS, fetchUrl: fn })
    assert.deepEqual(calls, ['9+ott'])
    assert.equal(res.rateType, 9)
  })

  await check('非 4K 档位从不带 ott：蓝光被拒直接降到高清', async () => {
    const { fn, calls } = fakeFetch({ '4': needMember(3), '3': ok(3) })
    const res = await getAndroidURL('u', 't', PID, 4, { ...OPTS, fetchUrl: fn })
    assert.deepEqual(calls, ['4', '3'])
    assert.equal(res.rateType, 3)
  })

  await check('拒绝回应缺 urlInfo / message：仍能降级到高清，不抛错', async () => {
    const { fn, calls } = fakeFetch({ '9+ott': { rid: 'TIPS_NEED_MEMBER', message: 'x' }, '9': { rid: 'TIPS_NEED_MEMBER' }, '3': ok(3) })
    const res = await getAndroidURL('u', 't', PID, 9, { ...OPTS, fetchUrl: fn })
    assert.deepEqual(calls, ['9+ott', '9', '3'])
    assert.equal(res.rateType, 3)
  })

  await check('重试途中网络失败：返回统一的失败结果，不抛错', async () => {
    const { fn, calls } = fakeFetch({ '9+ott': needMember(9), '9': () => undefined })
    const res = await getAndroidURL('u', 't', PID, 9, { ...OPTS, fetchUrl: fn })
    assert.deepEqual(calls, ['9+ott', '9'])
    assert.equal(res.url, '')
    assert.ok(res.content?.message, '失败结果要带可展示的 message')
  })
  // ---- 取流摘要日志（替代原来的「登录认证成功」+ 红字「认证失败 视频内容不完整」）----
  const RED = '\x1B[31m', GREEN = '\x1B[32m', YELLOW = '\x1B[33m'
  const stream = ({ url = 'http://x/y.m3u8', logined = true, authResult = 'SUCCESS', rateType = '9', rateDesc = '臻享 超高清', trySeeDuration = '0' } = {}) => ({
    url, content: { body: { urlInfo: { rateType, rateDesc, trySeeDuration }, auth: { logined, authResult, resultDesc: '产品:未订购且不享受权益免费' } } },
  })

  await check('取流摘要：会员完整播放一行绿字，只写档位', async () => {
    printStreamInfo(stream())
    assert.equal(logs.length, 1)
    assert.ok(logs[0].startsWith(GREEN) && logs[0].includes('咪咕取流：臻享 超高清'), logs[0])
  })

  await check('取流摘要：账号没订购该内容但流已下发，不再打红字', async () => {
    printStreamInfo(stream({ authResult: 'FAIL' }))
    assert.equal(logs.length, 1)
    assert.ok(!logs.some(l => l.includes(RED)), '不该有红字')
    assert.ok(!logs.some(l => l.includes('认证失败')), '不再打「认证失败 视频内容不完整」')
  })

  await check('取流摘要：只给试看时黄字并写明秒数', async () => {
    printStreamInfo(stream({ authResult: 'FAIL', trySeeDuration: '360' }))
    assert.equal(logs.length, 1)
    assert.ok(logs[0].startsWith(YELLOW) && logs[0].includes('仅试看 360 秒'), logs[0])
  })

  await check('取流摘要：游客标「游客」，缓存命中标「缓存」', async () => {
    printStreamInfo(stream({ logined: false, rateType: '3', rateDesc: '高清 720P' }))
    printStreamInfo(stream(), { cached: true })
    assert.ok(logs[0].includes('咪咕取流：游客 · 高清 720P'), logs[0])
    assert.ok(logs[1].includes('咪咕取流（缓存）：臻享 超高清'), logs[1])
  })

  await check('取流摘要：拿不到地址或 content 为空时什么都不打、不抛错', async () => {
    printStreamInfo(stream({ url: '' }))
    printStreamInfo({ url: 'http://x', content: null })
    printStreamInfo(null)
    assert.equal(logs.length, 0)
  })
} finally {
  console.log = origLog
}

console.log(`\n${passed} 项通过`)
