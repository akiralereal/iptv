#!/usr/bin/env node
import assert from 'node:assert/strict'

import yunnan from '../extractors/yunnan/index.js'
import {
  CHANNELS,
  YNTV_ORIGIN,
  YNTV_PAGE,
  buildCatalogUrl,
  buildChannels,
  claimsRef,
  clearCache,
  officialAssetUrl,
  parseCatalogResponse,
  parseProgrammeResponse,
  resolveChannel,
  upstreamHeadersFor,
} from '../extractors/yunnan/api.js'
import { getModule, resolverFor } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }
const response = (body, status = 200) => new Response(
  typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json' } },
)

const secret = '0123456789abcdef0123456789abcdef'
const programme = (webName = 'yunnanweishi', start = 1789263360, duration = 3660) => ({
  url: `/live/${webName}/chunks_dvr_range-${start}-${duration}.m3u8`,
  string: secret,
  time: 1789266542,
  jmd: [],
})
const catalog = (room = '临沧综合', stream = 'https://hwapi.yntv.cn/6tt654/1i495z.m3u8') => ({
  code: 0,
  data: { results: [{ roomName: room, liveStatus: 'live', lives: [{ isShow: true, cameraPositionStatus: 'live', stream }] }] },
})

console.log('云南广电模块测试')

check('模块注册为免账号的云南全代理模块', () => {
  assert.equal(getModule('yunnan'), yunnan)
  assert.equal(yunnan.name, '云南')
  assert.equal(yunnan.outputGroupName, '云南')
  assert.equal(yunnan.channelHlsMode, 'proxy')
  assert.equal(yunnan.capabilities.catchup, false)
  assert.equal(yunnan.catalogVersion, 2)
  assert.deepEqual(yunnan.configSchema, [])
  assert.equal(resolverFor('yunnan-satellite'), yunnan)
  assert.equal(resolverFor('yunnan-satellite/extra'), null)
})

await checkAsync('省级四套与地方三套并入唯一的云南分组', async () => {
  assert.deepEqual(CHANNELS.map(channel => [channel.kind, channel.name]), [
    ['yntv', '云南卫视'], ['yntv', '云南都市'], ['yntv', '云南康旅'], ['yntv', '澜湄国际'],
    ['qicai', '临沧综合'], ['qicai', '怒江综合'], ['qicai', '昭通综合'],
  ])
  const channels = buildChannels()
  assert.ok(channels.every(channel => channel.groupTitle === '云南' && channel.catchup === 'none'))
  // 都用七彩云端的官方频道卡、各不相同；澜湄国际官方没有可用台标，留空
  const withLogo = channels.filter(channel => channel.logo)
  assert.deepEqual(channels.filter(channel => !channel.logo).map(channel => channel.name), ['澜湄国际'])
  assert.ok(withLogo.every(channel => /^https:\/\/cdnproduce\.yntv\.cn\/ysxw\/HDZB_FABU\/[0-9A-F]{32}\/[0-9A-F]{32}\.png$/.test(channel.logo)))
  assert.equal(new Set(withLogo.map(channel => channel.logo)).size, withLogo.length)
  assert.deepEqual(await yunnan.fetch(), {
    groups: [{ name: '云南', dataList: channels }],
    meta: { skipped: [], warnings: [] },
  })
  assert.equal(claimsRef('yunnan-zhaotong'), true)
  assert.equal(claimsRef('yunnan-kunming'), false)
})

check('省级接口返回的必须是本频道当前节目的窗口，签名齐备', () => {
  assert.equal(
    parseProgrammeResponse(programme(), CHANNELS[0]),
    `https://tvlive.yntv.cn/live/yunnanweishi/chunks_dvr_range-1789263360-3660.m3u8?wsSecret=${secret}&wsTime=1789266542`,
  )
  // 一个频道的签名不能被引去另一个频道的目录
  assert.throws(() => parseProgrammeResponse(programme('yunnandushi'), CHANNELS[0]), /当前节目直播路径/)
  assert.throws(() => parseProgrammeResponse({ ...programme(), url: '/live/yunnanweishi/playlist.m3u8' }, CHANNELS[0]), /当前节目直播路径/)
  assert.throws(() => parseProgrammeResponse({ ...programme(), string: 'nope' }, CHANNELS[0]), /有效播放签名/)
  assert.throws(() => parseProgrammeResponse({ ...programme(), time: 'later' }, CHANNELS[0]), /有效签名时间/)
})

check('地方目录按房间名取当前在线机位，停播不糊弄', () => {
  const lincang = CHANNELS[4]
  assert.equal(parseCatalogResponse(catalog(), lincang), 'https://hwapi.yntv.cn/6tt654/1i495z.m3u8')
  assert.throws(() => parseCatalogResponse(catalog('昆明综合'), lincang), /当前没有在线机位/)
  assert.throws(() => parseCatalogResponse({ code: 1, message: '目录异常' }, lincang), /目录异常/)
  assert.throws(() => parseCatalogResponse(catalog('临沧综合', 'https://evil.test/x.m3u8'), lincang), /非官方媒体地址/)
  assert.match(buildCatalogUrl(), /labelName=%E5%9C%B0%E6%96%B9%E5%8F%B0/)
})

check('媒体白名单分别限定两家主机的目录', () => {
  assert.match(officialAssetUrl('https://tvlive.yntv.cn/live/yunnanweishi/dvr_v_p528_1.ts'), /\.ts$/)
  assert.match(officialAssetUrl('https://hwapi.yntv.cn/6tt654/1i495z-1789266780000.ts'), /\.ts$/)
  for (const bad of [
    'http://tvlive.yntv.cn/live/yunnanweishi/x.m3u8',
    'https://tvlive.yntv.cn.evil.test/live/yunnanweishi/x.m3u8',
    'https://tvlive.yntv.cn/private/x.m3u8',
    'https://tvlive.yntv.cn/live/yunnanweishi/x.mp4',
    'https://tvlive.yntv.cn/live/yunnanweishi/..%2f..%2fx.m3u8',
    'https://user:pass@tvlive.yntv.cn/live/yunnanweishi/x.m3u8',
    'https://tvlive.yntv.cn:444/live/yunnanweishi/x.m3u8',
    'https://cdnproduce.yntv.cn/live/x.m3u8',
    'not a url',
  ]) assert.throws(() => officialAssetUrl(bad), /云南广电/)
})

check('回源请求头按目标主机分发，不把云视网来源头漏给七彩云端', () => {
  assert.deepEqual(upstreamHeadersFor('https://tvlive.yntv.cn/live/yunnanweishi/x.m3u8'), {
    Referer: YNTV_PAGE,
    Origin: YNTV_ORIGIN,
  })
  assert.deepEqual(upstreamHeadersFor('https://hwapi.yntv.cn/6tt654/1i495z.m3u8'), {})
  assert.throws(() => upstreamHeadersFor('https://evil.test/x.m3u8'), /非官方媒体地址/)
})

await checkAsync('播放时换取当前地址，30 秒内复用、节目切换后重取', async () => {
  clearCache()
  const channel = CHANNELS[0]
  let start = 1789263360
  let requests = 0
  const fetchImpl = async url => {
    requests++
    assert.match(String(url), /getRq\?name=yunnanweishi$/)
    return response(programme('yunnanweishi', start, 3660))
  }
  const first = await resolveChannel(channel.ref, { fetchImpl, now: 1000 })
  const reused = await resolveChannel(channel.ref, { fetchImpl, now: 20_000 })
  assert.equal(requests, 1, '30 秒内不再打接口，挡住播放器的连环轮询')
  assert.equal(reused.url, first.url)
  start = 1789267020
  const rolled = await resolveChannel(channel.ref, { fetchImpl, now: 40_000 })
  assert.equal(requests, 2)
  assert.match(rolled.url, /chunks_dvr_range-1789267020-3660/, '节目换档后拿到新窗口')
  assert.equal(typeof rolled.upstreamHeaders, 'function')
  assert.equal(rolled.upstreamUrlTransform('https://tvlive.yntv.cn/live/yunnanweishi/dvr_v_p528_1.ts'),
    'https://tvlive.yntv.cn/live/yunnanweishi/dvr_v_p528_1.ts')
})

await checkAsync('接口抖动沿用上次成功地址并退避，硬过期后照实报错', async () => {
  clearCache()
  const channel = CHANNELS[0]
  let ok = true
  const fetchImpl = async () => (ok ? response(programme()) : response('boom', 500))
  const good = await resolveChannel(channel.ref, { fetchImpl, now: 1000 })
  assert.match(good.url, /chunks_dvr_range/)
  ok = false
  const degraded = await resolveChannel(channel.ref, { fetchImpl, now: 60_000 })
  assert.equal(degraded.url, good.url, '五分钟硬期限内沿用最近一次成功地址')
  const expired = await resolveChannel(channel.ref, { fetchImpl, now: 10 * 60_000 })
  assert.equal(expired.url, '')
  assert.match(expired.desc, /请求失败.*HTTP 500/)
})

await checkAsync('非法引用只返回说明，不向请求处理器抛错', async () => {
  clearCache()
  const malformed = await resolveChannel('yunnan-kunming', {
    fetchImpl: async () => { throw new Error('不应请求') },
  })
  assert.equal(malformed.url, '')
  assert.match(malformed.desc, /引用格式错误/)
})

console.log(`\n全部通过：${passed} ✅`)
