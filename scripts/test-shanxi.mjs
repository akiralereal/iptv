#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import shanxi from '../extractors/shanxi/index.js'
import {
  CHANNELS,
  PROVINCE_INFO_PATH,
  buildChannels,
  buildCitySecretUrl,
  claimsRef,
  clearCache,
  officialAssetUrl,
  parseCityResponse,
  parseProvinceInfo,
  provinceDailyKey,
  provinceInfoUrl,
  provinceStreamUrl,
  resolveChannel,
} from '../extractors/shanxi/api.js'
import { getModule, resolverFor } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }
const response = (body, status = 200) => new Response(
  typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json' } },
)

// 形状照官网 info.json 实际返回裁剪
const info = (rates = { q8RVWgs: [1000], lce1mC4: [800], Md571Kv: [500, 800] }) => ({
  channels: Object.entries(rates).map(([code, list]) => ({
    n: code, i: code, t: '1', d: 7,
    r: list.map(n => ({ t: '', n })),
    l: 'https://livehhhttps.sxrtv.com',
    s: 'https://livehhhttps.sxrtv.com',
  })),
  play: { dl: 1, ds: 1, tk: '', dh: 0 },
})
const secret = 'a'.repeat(64)
const citySigned = (stream = 'sxtymlive', hwTime = '6ab5437e') => ({
  code: 200,
  data: { address: `https://citymlive.sxrtv.com/live/${stream}.m3u8?hwSecret=${secret}&hwTime=${hwTime}` },
})
// 2026-09-24 22:00（上海）
const SEP24 = Date.parse('2026-09-24T14:00:00Z')
const satellite = CHANNELS.find(channel => channel.ref === 'shanxi-satellite')
const taiyuan = CHANNELS.find(channel => channel.ref === 'shanxi-taiyuan-1')

console.log('山西广电模块测试')

check('模块注册为免账号的山西 relay 模块', () => {
  assert.equal(getModule('shanxi'), shanxi)
  assert.equal(shanxi.name, '山西')
  assert.equal(shanxi.outputGroupName, '山西')
  assert.equal(shanxi.channelHlsMode, 'relay')
  assert.equal(shanxi.relayProxyCompatible, true)
  assert.equal(shanxi.capabilities.catchup, false)
  assert.equal(shanxi.catalogVersion, 1)
  assert.deepEqual(shanxi.configSchema, [])
  assert.equal(resolverFor('shanxi-satellite'), shanxi)
  assert.equal(resolverFor('shanxi-satellite/extra'), null)
})

await checkAsync('省级六套与地市十套并入唯一的山西分组', async () => {
  assert.deepEqual(CHANNELS.map(channel => [channel.kind, channel.name]), [
    ['province', '山西卫视'], ['province', '黄河电视台'], ['province', '山西经济与科技'],
    ['province', '山西影视'], ['province', '山西社会与法治'], ['province', '山西文体生活'],
    ['city', '太原-1'], ['city', '朔州-1'], ['city', '忻州综合'], ['city', '阳泉新闻综合'], ['city', '吕梁-1'],
    ['city', '晋中综合'], ['city', '长治-1'], ['city', '晋城新闻综合'], ['city', '临汾-1'], ['city', '运城-1'],
  ])
  assert.equal(new Set(CHANNELS.map(channel => channel.ref)).size, CHANNELS.length)
  const channels = buildChannels()
  assert.ok(channels.every(channel => channel.groupTitle === '山西' && channel.catchup === 'none'))
  // 公共台标库收了的留空按台名匹配，库里没有的用官网台标
  const withLogo = channels.filter(channel => channel.logo).map(channel => channel.name)
  assert.equal(withLogo.length, 10)
  assert.ok(!withLogo.includes('山西卫视') && !withLogo.includes('晋中综合') && withLogo.includes('黄河电视台'))
  assert.ok(channels.every(channel => !channel.logo || channel.logo.startsWith('https://imagehhsitehttps.sxrtv.com/images/')))
  assert.deepEqual(await shanxi.fetch(), {
    groups: [{ name: '山西', dataList: channels }],
    meta: { skipped: [], warnings: [] },
  })
  assert.equal(claimsRef('shanxi-yuncheng-1'), true)
  assert.equal(claimsRef('shanxi-datong-1'), false)
})

check('省级当日路径键与官网播放器一致，按上海时区零点切换', () => {
  // 以下键均对官网 CDN 实测：当天 200，前一天、后一天 400
  assert.deepEqual(
    ['q8RVWgs', 'lce1mC4', '4j01KWX', 'Md571Kv', 'p4y5do9', 'agmpyEk'].map(code => provinceDailyKey(code, SEP24)),
    ['31sq3R0', '21tl3e0', 'u51e300', 'd5iM350', 'idp3y00', 'toa3m0y'],
  )
  assert.equal(provinceDailyKey('q8RVWgs', Date.parse('2026-09-23T14:00:00Z')), 'n1shugV')
  // 上海零点前后一毫秒；与运行机器的时区无关
  assert.equal(provinceDailyKey('q8RVWgs', Date.parse('2026-09-24T15:59:59.999Z')), '31sq3R0')
  assert.equal(provinceDailyKey('q8RVWgs', Date.parse('2026-09-24T16:00:00Z')), 'm5sh8sV')
  assert.throws(() => provinceDailyKey('../x', SEP24), /频道代码格式无效/)
})

check('info.json 带官网 MD5 参数，每套频道取最高码率、只认省级媒体主机', () => {
  const url = new URL(provinceInfoUrl(1_790_260_300_000))
  assert.equal(url.pathname, PROVINCE_INFO_PATH)
  assert.equal(url.searchParams.get('t'), (1_790_260_300_000).toString(16))
  assert.equal(url.searchParams.get('token'),
    createHash('md5').update(`1790260300000${PROVINCE_INFO_PATH}Dream`).digest('hex'))

  const parsed = parseProvinceInfo(JSON.stringify(info()))
  assert.equal(parsed.dynamicPath, true)
  assert.deepEqual(parsed.channels.get('Md571Kv'), { rate: 800, origin: 'https://livehhhttps.sxrtv.com' })
  assert.equal(provinceStreamUrl(satellite, parsed, SEP24),
    'https://livehhhttps.sxrtv.com/lsdream/q8RVWgs/1000/31sq3R0.m3u8')

  const foreign = info({ q8RVWgs: [1000] })
  foreign.channels[0].l = 'https://livehhhttps.sxrtv.com.evil.test'
  assert.throws(() => parseProvinceInfo(foreign), /没有有效频道/)
  assert.throws(() => parseProvinceInfo({ play: {} }), /配置格式异常/)
  assert.throws(() => provinceStreamUrl(satellite, parseProvinceInfo(info({ lce1mC4: [800] })), SEP24), /没有山西卫视/)
})

check('地市签名接口只收地市媒体主机上带齐签名的清单', () => {
  assert.equal(parseCityResponse(citySigned(), taiyuan),
    `https://citymlive.sxrtv.com/live/sxtymlive.m3u8?hwSecret=${secret}&hwTime=6ab5437e`)
  assert.throws(() => parseCityResponse({ code: 200, data: { address: 'https://evil.test/live/x.m3u8' } }, taiyuan), /非官方媒体地址/)
  assert.throws(() => parseCityResponse({ code: 200, data: { address: 'https://citymlive.sxrtv.com/live/x.m3u8' } }, taiyuan), /有效签名/)
  assert.throws(() => parseCityResponse({ code: 500, msg: 'err' }, taiyuan), /没有返回播放地址/)
  assert.throws(() => parseCityResponse('<html>', taiyuan), /有效 JSON/)
  assert.equal(buildCitySecretUrl(taiyuan), 'https://dyhhplus.sxrtv.com/tapi/custom/huawei_live_secret.jsp?itemId=11')
})

check('媒体白名单分别限定两家主机的目录', () => {
  for (const good of [
    'https://livehhhttps.sxrtv.com/lsdream/q8RVWgs/1000/31sq3R0.m3u8',
    'https://livehhhttps.sxrtv.com/lsdream/q8RVWgs/1000/1790179200000/84944843D8.ts',
    'https://citymlive.sxrtv.com/live/sxtymlive.m3u8?hwSecret=x&hwTime=1',
    'https://citymlive.sxrtv.com/live/sxtymlive_1790264183481_1885803018_35711.ts?ps=8&app=live&hwSecret=x',
  ]) assert.equal(officialAssetUrl(good), good)
  for (const bad of [
    'http://livehhhttps.sxrtv.com/lsdream/q8RVWgs/1000/31sq3R0.m3u8',
    'https://livehhhttps.sxrtv.com.evil.test/lsdream/q8RVWgs/1000/31sq3R0.m3u8',
    'https://livehhhttps.sxrtv.com/lsdream/336E7E6818120C00FA7E8129A9999A10/info.json',
    'https://livehhhttps.sxrtv.com/lsdream/q8RVWgs/1000/..%2f..%2fx.m3u8',
    'https://citymlive.sxrtv.com/private/x.m3u8',
    'https://citymlive.sxrtv.com/live/x.mp4',
    'https://user:pass@citymlive.sxrtv.com/live/x.m3u8',
    'https://citymlive.sxrtv.com:8443/live/x.m3u8',
    'https://dyhhplus.sxrtv.com/live/x.m3u8',
    'not a url',
  ]) assert.throws(() => officialAssetUrl(bad), /山西广电/)
})

const SEP24_KEY = 'https://livehhhttps.sxrtv.com/lsdream/q8RVWgs/1000/31sq3R0.m3u8'
const SEP25_KEY = 'https://livehhhttps.sxrtv.com/lsdream/q8RVWgs/1000/m5sh8sV.m3u8'
const INFO_RE = /^https:\/\/livehhhttps\.sxrtv\.com\/lsdream\/336E7E6818120C00FA7E8129A9999A10\/info\.json\?t=/
// 模拟官网 CDN：只有 live 指定的那个键回清单，其余 400
const upstream = (live, log = []) => async url => {
  const target = String(url)
  log.push(target)
  if (INFO_RE.test(target)) return response(info())
  return target === live
    ? new Response('#EXTM3U\n#EXTINF:8,\n1790265600000/00000855D8.ts\n', { status: 200 })
    : new Response('#EXTM3U\n', { status: 400 })
}

await checkAsync('省级按当前时间重算路径：配置五分钟复用，远离零点不取清单', async () => {
  clearCache()
  const log = []
  const fetchImpl = upstream(SEP24_KEY, log)
  // 23:50 与次日 00:10（上海）
  const before = await resolveChannel(satellite.ref, { fetchImpl, now: Date.parse('2026-09-24T15:50:00Z') })
  assert.equal(before.url, SEP24_KEY)
  assert.equal(before.manifestText, undefined, '平时只给地址，清单由代理层去取')
  assert.equal(before.relayHls, true)
  assert.equal(before.upstreamHeaders, undefined, '两家 CDN 都不校验来源头，不发')
  assert.equal(before.upstreamUrlTransform, officialAssetUrl)
  const after = await resolveChannel(satellite.ref, { fetchImpl, now: Date.parse('2026-09-24T16:10:00Z') })
  assert.equal(after.url, SEP25_KEY)
  assert.equal(log.filter(url => !INFO_RE.test(url)).length, 0, '零点窗口外不多打一次清单')
  const reused = await resolveChannel(satellite.ref, { fetchImpl, now: Date.parse('2026-09-24T16:14:00Z') })
  assert.equal(reused.url, SEP25_KEY)
  assert.equal(log.length, 2, '配置五分钟内复用')
})

await checkAsync('零点前后本机钟与官网换键不同步时，改用相邻那天仍可用的键', async () => {
  // 实测：本机 00:00:01.6 按新键取是 400，官网两三秒后才换过来
  clearCache()
  const ahead = await resolveChannel(satellite.ref, { fetchImpl: upstream(SEP24_KEY), now: Date.parse('2026-09-24T16:00:01Z') })
  assert.equal(ahead.url, SEP24_KEY)
  assert.equal(ahead.manifestUrl, SEP24_KEY)
  assert.match(ahead.manifestText, /^#EXTM3U/)

  // 反过来本机钟慢：23:59:59 官网已经换了
  clearCache()
  const behind = await resolveChannel(satellite.ref, { fetchImpl: upstream(SEP25_KEY), now: Date.parse('2026-09-24T15:59:59Z') })
  assert.equal(behind.url, SEP25_KEY)
  assert.match(behind.manifestText, /^#EXTM3U/)

  // 两个键都不通：照本机时间给地址，由代理层按老路子取与回退
  clearCache()
  const neither = await resolveChannel(satellite.ref, { fetchImpl: upstream('none'), now: Date.parse('2026-09-24T16:00:01Z') })
  assert.equal(neither.url, SEP25_KEY)
  assert.equal(neither.manifestText, undefined)
})

await checkAsync('地市 30 秒内复用签名，到期重换', async () => {
  clearCache()
  let hwTime = '6ab5437e'
  let requests = 0
  const fetchImpl = async (url, init) => {
    requests++
    assert.equal(String(url), buildCitySecretUrl(taiyuan))
    assert.equal(init.redirect, 'manual')
    return response(citySigned('sxtymlive', hwTime))
  }
  const first = await resolveChannel(taiyuan.ref, { fetchImpl, now: 1000 })
  const reused = await resolveChannel(taiyuan.ref, { fetchImpl, now: 20_000 })
  assert.equal(requests, 1, '挡住播放器 2 秒一次的清单轮询')
  assert.equal(reused.url, first.url)
  hwTime = '6ab543a0'
  const renewed = await resolveChannel(taiyuan.ref, { fetchImpl, now: 40_000 })
  assert.equal(requests, 2)
  assert.match(renewed.url, /hwTime=6ab543a0$/)
})

await checkAsync('接口抖动沿用上次成功地址并退避，硬过期后照实报错', async () => {
  clearCache()
  let ok = true
  const fetchImpl = async () => (ok ? response(citySigned()) : response('boom', 502))
  const good = await resolveChannel(taiyuan.ref, { fetchImpl, now: 1000 })
  ok = false
  const degraded = await resolveChannel(taiyuan.ref, { fetchImpl, now: 60_000 })
  assert.equal(degraded.url, good.url, '五分钟硬期限内沿用最近一次成功地址')
  const expired = await resolveChannel(taiyuan.ref, { fetchImpl, now: 10 * 60_000 })
  assert.equal(expired.url, '')
  assert.match(expired.desc, /请求失败.*HTTP 502/)
})

await checkAsync('非法引用只返回说明，不向请求处理器抛错', async () => {
  clearCache()
  const malformed = await resolveChannel('shanxi-datong-1', {
    fetchImpl: async () => { throw new Error('不应请求') },
  })
  assert.equal(malformed.url, '')
  assert.match(malformed.desc, /引用格式错误/)
  const thrown = await resolveChannel(satellite.ref, {
    fetchImpl: async () => { throw new Error('socket hang up') },
  })
  assert.equal(thrown.url, '')
  assert.match(thrown.desc, /山西广电链接请求失败：socket hang up/)
})

console.log(`\n全部通过：${passed} ✅`)
