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

const ok = (rt, extra = {}, urlInfoExtra = {}) => ({
  rid: 'SUCCESS', message: 'SUCCESS',
  body: {
    urlInfo: { url: `http://gslbmgsplive.miguvideo.com/x.m3u8?pid=${PID}&puData=0123456789abcdef0123456789abcdef`, rateType: String(rt), rateDesc: RATE_DESC[rt], ...urlInfoExtra },
    content: { contId: PID },
    auth: { logined: true, authResult: 'SUCCESS' },
    ...extra,
  },
})
const RATE_DESC = { 3: '高清 720P', 4: '蓝光 1080P', 7: '原画 HDR', 8: '超清4K (投屏专享)', 9: '臻享 超高清' }
// 09-06 游客探 4K 场次时看到的档位表形状：手机表到 9「臻享 超高清」，大屏表另有 8「超清4K (投屏专享)」
const tier = (rt, usageCode, extra = {}) => ({ rateType: String(rt), rateDesc: RATE_DESC[rt], usageCode: String(usageCode), ottEnable: '1', needAuth: rt >= 3, currentTerminalCanSwitch: '1', ...extra })
const TABLES = {
  mediaFiles: [tier(3, 54), tier(4, 55), tier(7, 902), tier(9, 221406)],
  ottMediaFiles: [tier(4, 55), tier(8, 221416)],
}
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

  await check('含电视端权益：大屏档位表列着「投屏专享」→ 再按它带 ott 要一次，拿到 rateType 8', async () => {
    const { fn, calls } = fakeFetch({ '9+ott': ok(9, TABLES), '8+ott': ok(8) })
    const res = await getAndroidURL('u', 't', PID, 9, { ...OPTS, fetchUrl: fn })
    assert.deepEqual(calls, ['9+ott', '8+ott'])
    assert.equal(res.rateType, 8)
    assert.ok(res.url.includes('&ddCalcu='))
    assert.ok(logs.some(l => l.includes('大屏档位表：蓝光 1080P(4/55 需权益) / 超清4K (投屏专享)(8/221416 需权益)')), '要把咪咕列的档位表连 usageCode 打出来')
    assert.ok(logs.some(l => l.includes('按 rateType 8 带大屏策略再要一次')), '要说明多要的这一次是什么')
  })

  await check('大屏策略只给到原画（解说流）：档位表有投屏专享照样再要', async () => {
    const { fn, calls } = fakeFetch({ '9+ott': ok(7, TABLES), '8+ott': ok(8) })
    const res = await getAndroidURL('u', 't', PID, 9, { ...OPTS, fetchUrl: fn })
    assert.deepEqual(calls, ['9+ott', '8+ott'])
    assert.equal(res.rateType, 8)
  })

  await check('投屏专享被拒 / 没给地址：沿用第一次拿到的档位，不降级', async () => {
    const { fn, calls } = fakeFetch({ '9+ott': ok(9, TABLES), '8+ott': needMember(9, '开通钻石会员即可免费畅看哦~') })
    const res = await getAndroidURL('u', 't', PID, 9, { ...OPTS, fetchUrl: fn })
    assert.deepEqual(calls, ['9+ott', '8+ott'])
    assert.equal(res.rateType, 9)
    assert.ok(logs.some(l => l.includes('没拿到（咪咕：开通钻石会员即可免费畅看哦~），沿用 臻享 超高清')))

    const second = fakeFetch({ '9+ott': ok(9, TABLES), '8+ott': () => undefined })
    const res2 = await getAndroidURL('u', 't', PID, 9, { ...OPTS, fetchUrl: second.fn })
    assert.equal(res2.rateType, 9, '网络失败也沿用')
  })

  await check('★ 投屏档被静默降档（SUCCESS 但给的是蓝光 / 原画）：不能顶掉已拿到的 4K', async () => {
    for (const lower of [4, 7]) {
      const { fn, calls } = fakeFetch({ '9+ott': ok(9, TABLES), '8+ott': ok(lower) })
      const res = await getAndroidURL('u', 't', PID, 9, { ...OPTS, fetchUrl: fn })
      assert.deepEqual(calls, ['9+ott', '8+ott'])
      assert.equal(res.rateType, 9, `咪咕回 ${lower} 时要沿用 9`)
      assert.ok(logs.some(l => l.includes(`没拿到（咪咕实际给的是 ${RATE_DESC[lower]}），沿用 臻享 超高清`)), '日志要说清咪咕实际给了哪档')
    }
  })

  await check('★ 投屏档只给试看：视为没拿到，沿用完整的 4K', async () => {
    const { fn } = fakeFetch({ '9+ott': ok(9, TABLES), '8+ott': ok(8, {}, { trySeeDuration: '300' }) })
    const res = await getAndroidURL('u', 't', PID, 9, { ...OPTS, fetchUrl: fn })
    assert.equal(res.rateType, 9)
    assert.ok(logs.some(l => l.includes('（只给试看 300 秒），沿用 臻享 超高清')))
  })

  await check('投屏档 SUCCESS 但没地址：沿用第一次的结果', async () => {
    const noUrl = ok(8); noUrl.body.urlInfo.url = ''
    const { fn } = fakeFetch({ '9+ott': ok(9, TABLES), '8+ott': noUrl })
    const res = await getAndroidURL('u', 't', PID, 9, { ...OPTS, fetchUrl: fn })
    assert.equal(res.rateType, 9)
  })

  await check('档位表里低档也标了「投屏」：只认 4K 的投屏档，取表末尾那项', async () => {
    const weird = { ottMediaFiles: [
      { rateType: '4', rateDesc: '蓝光 1080P (投屏)', usageCode: '55' },
      { rateType: '8', rateDesc: '超清4K (投屏专享)', usageCode: '221416' },
    ] }
    const { fn, calls } = fakeFetch({ '9+ott': ok(9, weird), '8+ott': ok(8) })
    const res = await getAndroidURL('u', 't', PID, 9, { ...OPTS, fetchUrl: fn })
    assert.deepEqual(calls, ['9+ott', '8+ott'])
    assert.equal(res.rateType, 8)
    const onlyLow = { ottMediaFiles: [{ rateType: '4', rateDesc: '蓝光 1080P (投屏)', usageCode: '55' }] }
    const b = fakeFetch({ '9+ott': ok(9, onlyLow) })
    assert.equal((await getAndroidURL('u', 't', PID, 9, { ...OPTS, fetchUrl: b.fn })).rateType, 9)
    assert.deepEqual(b.calls, ['9+ott'], '只有低档投屏时不多请求')
  })

  await check('大屏表在 ottMediaFiles 缺失时也看 mediaFiles', async () => {
    const inMobile = { ottMediaFiles: null, mediaFiles: [tier(4, 55), tier(9, 221406), tier(8, 221416, { currentTerminalCanSwitch: '0' })] }
    const { fn, calls } = fakeFetch({ '9+ott': ok(9, inMobile), '8+ott': ok(8) })
    const res = await getAndroidURL('u', 't', PID, 9, { ...OPTS, fetchUrl: fn })
    assert.deepEqual(calls, ['9+ott', '8+ott'])
    assert.equal(res.rateType, 8)
    assert.ok(logs.some(l => l.includes('超清4K (投屏专享)(8/221416 需权益 本端不可切)')), '「本端不可切」标记要打出来')
  })

  await check('普通频道（大屏表为空）：档位表不刷黄字，只进 debug', async () => {
    const { fn } = fakeFetch({ '9+ott': ok(4, { mediaFiles: [tier(3, 54), tier(4, 55)], ottMediaFiles: null }) })
    await getAndroidURL('u', 't', PID, 9, { ...OPTS, fetchUrl: fn })
    assert.ok(!logs.some(l => l.includes('\x1B[33m') && l.includes('档位表')), '普通频道不该有黄字档位表')
  })

  await check('第一次 SUCCESS 却没地址：不进大屏分支，按原样返回空地址', async () => {
    const noUrl = ok(9, TABLES); noUrl.body.urlInfo.url = ''
    const { fn, calls } = fakeFetch({ '9+ott': noUrl })
    const res = await getAndroidURL('u', 't', PID, 9, { ...OPTS, fetchUrl: fn })
    assert.deepEqual(calls, ['9+ott'])
    assert.equal(res.url, '')
    assert.ok(!logs.some(l => l.includes('按大屏策略取到')))
  })

  await check('档位表里没有投屏档（普通频道 / 已经拿到 8）：不多请求', async () => {
    const noCast = { mediaFiles: [tier(3, 54), tier(4, 55)], ottMediaFiles: null }
    const a = fakeFetch({ '9+ott': ok(4, noCast) })
    assert.equal((await getAndroidURL('u', 't', PID, 9, { ...OPTS, fetchUrl: a.fn })).rateType, 4)
    assert.deepEqual(a.calls, ['9+ott'])
    const b = fakeFetch({ '9+ott': ok(8, TABLES) })
    assert.equal((await getAndroidURL('u', 't', PID, 9, { ...OPTS, fetchUrl: b.fn })).rateType, 8)
    assert.deepEqual(b.calls, ['9+ott'], '已经是投屏档就不再要')
  })

  await check('三屏会员走手机策略拿到的 4K：不看档位表、不多请求（那条路上本来就没大屏档）', async () => {
    const { fn, calls } = fakeFetch({ '9+ott': needMember(9), '9': ok(9, TABLES) })
    const res = await getAndroidURL('u', 't', PID, 9, { ...OPTS, fetchUrl: fn })
    assert.deepEqual(calls, ['9+ott', '9'])
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
