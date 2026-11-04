#!/usr/bin/env node
/**
 * 辽宁模块（北斗融媒省台 + 沈阳台）离线测试：频道白名单、live/replay 判定、鉴权签名与解码、
 * 短签名、并发共享鉴权与失败退避。夹具 scripts/fixtures/liaoning-oauth.json：
 * province / shenyang 是 2026-11-04 实网 getOauth 响应裁剪（refer 为官方原始密文，pullKey 换成
 * 同一公钥加密的假值，不把真实拉流密钥写进仓库）；before/afterRotation 是同法造的轮换样本。
 * 运行：node scripts/test-liaoning.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import liaoning from '../extractors/liaoning/index.js'
import { createOauthSign, decodeOauth } from '../extractors/liaoning/auth.js'
import {
  buildChannelGroups,
  normalizePrograms,
  playableStreamOf,
  signStreamUrl,
  clearCache,
  resolveChannel,
} from '../extractors/liaoning/api.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { clearCache(); await fn(); passed++; console.log(`  ✅ ${name}`) }
const authFixtures = JSON.parse(readFileSync(new URL('./fixtures/liaoning-oauth.json', import.meta.url), 'utf8'))
const pullKey = 'TestPullKey00001'

console.log('辽宁模块测试')

check('默认开启（大陆都能播），关掉再开前给出网络提示；固定抓省台与沈阳台，不暴露配置', () => {
  assert.notEqual(liaoning.defaultEnabled, false)
  assert.match(liaoning.enableNotice, /辽宁本地网络/)
  assert.match(liaoning.enableNotice, /请自行辨别/)
  assert.deepEqual(liaoning.configSchema, [])
  assert.equal(liaoning.outputGroupName, '辽宁')
})

check('只解析 type=22 的正式白名单频道，且频道要属于所抓的租户', () => {
  const payload = { data: [
    { type: 22, config: JSON.stringify({ programs: [
      { id: 'c077b260424404846285cba1e1759280', title: '辽宁卫视', cover: 'http://img/logo.jpg' },
      { id: 'ffffffffffffffffffffffffffffffff', title: '专题直播' },
      { id: 'd447fcc472f14c7f14872d4e26b12d8f', title: '沈阳台的编号出现在省台页面' },
    ] }) },
    { type: 11, config: JSON.stringify({ programs: [{ id: '10d3de0d03c62e85a1a281bbde8b6952' }] }) },
  ] }
  assert.deepEqual(normalizePrograms(payload, 'liaoning'), [{
    id: 'c077b260424404846285cba1e1759280', tenantId: 'liaoning', name: '辽宁卫视', logo: 'https://img/logo.jpg',
  }])
})

check('只接受 live 类型及对应租户 CDN 地址', () => {
  const good = { code: 200, data: { playableType: 'live', playableUrl: JSON.stringify({ m3u8: 'https://bdrmtvzb.lnyun.com.cn/bdrm/lntv.m3u8' }) } }
  // 实测样子：回看时 playableUrl 直接是带时间窗参数的地址，不是 JSON
  const replay = { code: 200, data: { playableType: 'replay', programName: '直通市县区', playableUrl: 'https://bdrmtvzb.lnyun.com.cn/bdrm/lntv.m3u8?aliyunols=on&lhs_start_human_s_8=20261104071500' } }
  const badHost = { code: 200, data: { playableType: 'live', playableUrl: JSON.stringify({ m3u8: 'https://evil.example/live.m3u8' }) } }
  assert.equal(playableStreamOf(good, 'liaoning').url, 'https://bdrmtvzb.lnyun.com.cn/bdrm/lntv.m3u8')
  assert.deepEqual(playableStreamOf(replay, 'liaoning'), { url: '', type: 'replay', programName: '直通市县区' })
  assert.equal(playableStreamOf(badHost, 'liaoning').url, '')
  assert.equal(playableStreamOf(good, 'shenyang').url, '', '省台 CDN 不能当沈阳台的地址')
})

check('短签名格式、过期时间和摘要稳定', () => {
  const signed = new URL(signStreamUrl('https://bdrmtvzb.lnyun.com.cn/bdrm/lntv.m3u8', 'liaoning', pullKey, 1_700_000_000_000))
  assert.equal(signed.searchParams.get('auth_key'), '1700001800-0-0-3da8d8b2478c080d6db9bebc4aa24258')
  assert.throws(() => signStreamUrl('https://evil.example/live.m3u8', 'liaoning', pullKey, 1_700_000_000_000), /不是该北斗融媒租户/)
})

check('省台与沈阳台合并进辽宁，引用只带频道编号，固定走全代理', () => {
  const groups = buildChannelGroups([
    { id: 'c077b260424404846285cba1e1759280', tenantId: 'liaoning', name: '辽宁卫视', url: 'x', logo: '' },
    { id: 'd447fcc472f14c7f14872d4e26b12d8f', tenantId: 'shenyang', name: '沈阳新闻综合', url: 'y', logo: '' },
  ])
  assert.deepEqual(groups.map(group => group.name), ['辽宁'])
  assert.deepEqual(groups[0].dataList.map(channel => [channel.name, channel.deferredRef]), [
    ['辽宁卫视', 'liaoning-c077b260424404846285cba1e1759280'],
    ['沈阳新闻综合', 'liaoning-d447fcc472f14c7f14872d4e26b12d8f'],
  ])
  assert.ok(groups.every(group => group.dataList.every(channel => channel.proxyHls === true)))
})

check('模块只认领白名单频道；旧 beidou 引用和路径注入都不接', () => {
  assert.equal(liaoning.claimsRef('liaoning-c077b260424404846285cba1e1759280'), true)
  assert.equal(liaoning.claimsRef('liaoning-acb1a5713531ac7feb7836b1b4db442c'), true)
  assert.equal(liaoning.claimsRef('liaoning-ffffffffffffffffffffffffffffffff'), false)
  assert.equal(liaoning.claimsRef('beidou-liaoning-c077b260424404846285cba1e1759280'), false)
  assert.equal(liaoning.claimsRef('liaoning-../../secret'), false)
})

check('鉴权签名与 Android 原生 liveSign 的实测结果一致', () => {
  const randomValues = [4, 1, 4, 6, 9]
  const sign = createOauthSign('918510749a0f319ec12ff695b1c95230', 1_788_441_716_000, () => randomValues.shift())
  assert.equal(sign, 'NDE0NjkxNzg4NDQxNzE2B5CC4623C1FB781E8B5F187535DFF25E')
})

check('解码 11-04 官方 version=6 响应：省台、沈阳台各自的 CDN 与 Referer', () => {
  assert.deepEqual(decodeOauth(authFixtures.province, 'bdrmtvzb.lnyun.com.cn'), {
    pullKey, referer: 'http://ckjd.bdy.lnyun.com.cn', remainingSeconds: 35357,
  })
  const shenyang = decodeOauth(authFixtures.shenyang, 'sygbdsttvzb.lnyun.com.cn')
  assert.equal(shenyang.pullKey, pullKey)
  assert.equal(shenyang.referer, 'http://ygnm.bdy.lnyun.com.cn')
  assert.throws(() => decodeOauth(authFixtures.province, 'sygbdsttvzb.lnyun.com.cn'), /CDN 不匹配/)
})

check('解码异常响应：密文损坏、长度不对、已过期都拒绝', () => {
  const data = authFixtures.afterRotation.data
  for (const refer of ['', Buffer.alloc(128).toString('base64'), Buffer.alloc(256).toString('base64')]) {
    assert.throws(() => decodeOauth({ code: 200, data: { ...data, refer } }, 'bdrmtvzb.lnyun.com.cn'), /密文格式|解码失败/)
  }
  assert.throws(() => decodeOauth({ code: 200, data: { ...data, referTimeOut: '0' } }, 'bdrmtvzb.lnyun.com.cn'), /已过期/)
  assert.throws(() => decodeOauth({ code: 400, data: null }, 'bdrmtvzb.lnyun.com.cn'), /CDN 不匹配/)
})

const channelId = '918510749a0f319ec12ff695b1c95230'
const anotherId = '078ce87dcf5384d51e4655cb962fda18'
const ref = `liaoning-${channelId}`
const t0 = 1_700_000_000_000

function mockApi() {
  const state = { oauthCalls: 0, payload: authFixtures.beforeRotation, fail: false, waf: false }
  state.fetchImpl = async (raw, options) => {
    const url = new URL(raw)
    if (state.waf) return { ok: false, status: 405, json: async () => assert.fail('WAF 页面不是 JSON') }
    let payload
    if (url.pathname.endsWith('/tab/page')) {
      payload = { code: 200, data: [{ type: 22, config: { programs: [{ id: channelId }, { id: anotherId }] } }] }
    } else if (url.pathname.endsWith('/getPlayableUrl')) {
      payload = { code: 200, data: { playableType: 'live', playableUrl: JSON.stringify({ m3u8: 'https://bdrmtvzb.lnyun.com.cn/bdrm/yspd.m3u8' }) } }
    } else if (url.pathname.endsWith('/getOauth')) {
      state.oauthCalls++
      assert.equal(options.method, 'POST')
      assert.equal(options.headers.Referer, 'https://bdrm.bdy.lnyun.com.cn')
      assert.equal(url.searchParams.get('version'), '6')
      assert.ok([channelId, anotherId].includes(url.searchParams.get('domainId')))
      assert.ok(url.searchParams.get('sign'))
      if (state.fail) throw new Error('模拟鉴权服务不可用')
      payload = state.payload
    } else assert.fail(`未知接口 ${url}`)
    return { ok: true, status: 200, json: async () => payload }
  }
  return state
}

await checkAsync('同一租户并发播放只取一次鉴权，提前刷新轮换 Referer', async () => {
  const api = mockApi()
  const ctx = { fetchImpl: api.fetchImpl, now: t0 }
  const results = await Promise.all([resolveChannel(ref, ctx), resolveChannel(`liaoning-${anotherId}`, ctx)])
  assert.equal(api.oauthCalls, 1)
  for (const result of results) {
    assert.ok(result.url)
    assert.equal(result.upstreamHeaders.Referer, 'http://aaaa.bdy.lnyun.com.cn')
    const signed = new URL(result.url)
    const expires = 1700001800
    const digest = createHash('md5').update(`/bdrm/yspd.m3u8-${expires}-0-0-${pullKey}`).digest('hex')
    assert.equal(signed.searchParams.get('auth_key'), `${expires}-0-0-${digest}`)
  }
  await resolveChannel(ref, { ...ctx, now: t0 + 89999 })
  assert.equal(api.oauthCalls, 1)
  api.payload = authFixtures.afterRotation
  const renewed = await resolveChannel(ref, { ...ctx, now: t0 + 90000 })
  assert.equal(api.oauthCalls, 2)
  assert.equal(renewed.upstreamHeaders.Referer, 'http://bbbb.bdy.lnyun.com.cn')
})

await checkAsync('鉴权刷新失败不会发出过期播放地址，短暂退避后能恢复', async () => {
  const api = mockApi()
  const ctx = { fetchImpl: api.fetchImpl, now: t0 }
  await resolveChannel(ref, ctx)
  api.fail = true
  const failed = await resolveChannel(ref, { ...ctx, now: t0 + 90000 })
  assert.equal(failed.url, '')
  assert.match(failed.desc, /模拟鉴权服务不可用/)
  assert.equal(api.oauthCalls, 2)
  const retry = await resolveChannel(ref, { ...ctx, now: t0 + 91000 })
  assert.equal(retry.url, '')
  assert.equal(api.oauthCalls, 2)
  api.fail = false
  api.payload = authFixtures.afterRotation
  const recovered = await resolveChannel(ref, { ...ctx, now: t0 + 95000 })
  assert.ok(recovered.url)
  assert.equal(recovered.upstreamHeaders.Referer, 'http://bbbb.bdy.lnyun.com.cn')
  assert.equal(api.oauthCalls, 3)
})

await checkAsync('即使官方剩余有效期很长，也至多缓存十分钟；清缓存会重取', async () => {
  const api = mockApi()
  api.payload = { code: 200, data: { ...authFixtures.beforeRotation.data, referTimeOut: '86400' } }
  const ctx = { fetchImpl: api.fetchImpl, now: t0 }
  await resolveChannel(ref, ctx)
  await resolveChannel(ref, { ...ctx, now: t0 + 600000 })
  assert.equal(api.oauthCalls, 2)
  clearCache()
  await resolveChannel(ref, { ...ctx, now: t0 + 600001 })
  assert.equal(api.oauthCalls, 3)
})

await checkAsync('官方按网络拦截（WAF 405）时报错写明是网络被拒，也不再去取鉴权', async () => {
  const api = mockApi()
  api.waf = true
  await assert.rejects(liaoning.fetch({}, { fetchImpl: api.fetchImpl, now: t0 }), /HTTP 405（官方拒绝了这台服务器所在的网络）/)
  const failed = await resolveChannel(ref, { fetchImpl: api.fetchImpl, now: t0 })
  assert.equal(failed.url, '')
  assert.match(failed.desc, /HTTP 405（官方拒绝了这台服务器所在的网络）/)
  assert.equal(api.oauthCalls, 0)
})

await checkAsync('fetch：当前只给回看的频道记进 skipped，其余照常列出', async () => {
  const api = mockApi()
  const base = api.fetchImpl
  api.fetchImpl = async (raw, options) => {
    const url = new URL(raw)
    if (url.pathname.endsWith('/getPlayableUrl') && url.searchParams.get('domainId') === anotherId) {
      return { ok: true, status: 200, json: async () => ({ code: 200, data: { playableType: 'replay', programName: '大城小事', playableUrl: 'https://bdrmtvzb.lnyun.com.cn/bdrm/x.m3u8' } }) }
    }
    if (url.pathname.endsWith('/tab/page') && url.hostname.startsWith('sygbdst')) {
      return { ok: true, status: 200, json: async () => ({ code: 200, data: [] }) }
    }
    return base(raw, options)
  }
  const { groups, meta } = await liaoning.fetch({}, { fetchImpl: api.fetchImpl, now: t0 })
  assert.deepEqual(groups.flatMap(group => group.dataList.map(channel => channel.name)), ['辽宁影视剧'])
  assert.deepEqual(meta.skipped, [{ name: '辽宁生活', reason: '官方当前仅提供回看（大城小事）' }])
  assert.equal(meta.warnings.length, 1, '沈阳台页面没频道只记警告，不拖掉省台')
  assert.match(meta.warnings[0], /沈阳台/)
})

clearCache()
console.log(`\n${passed} 项测试全部通过`)
