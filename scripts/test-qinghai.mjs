#!/usr/bin/env node
import assert from 'node:assert/strict'

import qinghai from '../extractors/qinghai/index.js'
import {
  CHANNELS,
  TOPIC_DETAIL_API,
  buildChannels,
  buildDetailUrl,
  claimsRef,
  clearCache,
  officialAssetUrl,
  parseDetail,
  parsePlayerPage,
  resolveChannel,
  signatureWindow,
} from '../extractors/qinghai/api.js'
import { QHTB_TV_PAGE, SITE_APP_SECRET } from '../extractors/qinghai/channels.js'
import { getModule, resolverFor } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }
const json = (body, status = 200) => new Response(
  typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json' } },
)

const AMDO_TOPIC = '824587377543962624'
const RADIO_TOPIC = '824587553121722368'
const MINUTE = 60 * 1000
// 2026-09-25 02:47（上海）
const NOW = Date.parse('2026-09-24T18:47:00Z')
const amdo = CHANNELS[0]

// 形状照官网直播页裁剪：换台函数里那行不带引号的赋值在前，默认频道那行在后
const page = (topicId = AMDO_TOPIC, appSecret = SITE_APP_SECRET) => `<!DOCTYPE html><html><head>
<title>ཨ་མདོ་བརྙན་འཕྲིན།_青海藏语网络广播电视台</title></head><body><script>
function initTabSwitch() { $('.lanmu h3 a').click(function(e) { var channelId = $(this).data('id');
        current_channel = channelId; }); }
var current_channel = '${topicId}', // 默认频道ID - 青海藏语广播
    current_channel_arr = 0;
  function goLive(ch_id) {
    $.ajax({
        url : 'https://mapi.qhbtv.com.cn/cloudlive-manage-mapi/api/topic/detail',
        data : {
            app_secret: '${appSecret}',
            tenant_id: '0',
            id: ch_id
        },
    });
  }
</script></body></html>`

// 形状照 api/topic/detail 实际返回裁剪；timestamp 是标称的过期时刻（unix 秒，签发时 + 7200）
const signed = (stream = 'qhzyds', expiresAt = NOW + 120 * MINUTE, encrypt = 'b8a988c36bff144e4349a70615340c47') => (
  `https://live.qhbtv.com.cn/${stream}/sd/live.m3u8?timestamp=${Math.floor(expiresAt / 1000)}&encrypt=${encrypt}`
)
const detail = (hls = signed(), extraCameras = []) => ({
  id: AMDO_TOPIC,
  custom_appid: '1077',
  title: 'ཨ་མདོ་བརྙན་འཕྲིན།',
  status: 1,
  is_continuous: 1,
  topic_camera: [
    ...extraCameras,
    {
      id: '824587377598488576',
      topic_id: AMDO_TOPIC,
      title: '主机位',
      streams: [{
        hls,
        flv: 'https://live.qhbtv.com.cn/api/cloudlive/qhzyds_sd.flv?timestamp=1790282820&encrypt=b8a988c36bff144e4349a70615340c47',
        stream_name: 'qhzyds_sd',
        stream_title: '青海藏语电视',
      }],
    },
  ],
  topic_type: { title: '电视', sign: 'tv', is_audio: 0 },
})

/**
 * 模拟官网：页面与频道接口。topics 是「专题 id → 该专题当前的 hls」，app_secret 不对回平台的错误正文。
 * 每个请求记进 log，页面记 'page'，接口记 'detail:<id>'。
 */
const site = ({ pageHtml = page(), pageStatus = 200, topics = { [AMDO_TOPIC]: signed() }, apiDown = false } = {}, log = []) => async (url, init = {}) => {
  const target = new URL(String(url))
  assert.equal(init.redirect, 'manual')
  if (target.href === QHTB_TV_PAGE) {
    log.push('page')
    return new Response(pageHtml, { status: pageStatus, headers: { 'content-type': 'text/html' } })
  }
  assert.equal(`${target.origin}${target.pathname}`, TOPIC_DETAIL_API)
  const id = target.searchParams.get('id')
  log.push(`detail:${id}`)
  if (apiDown) return json('bad gateway', 502)
  if (!target.searchParams.get('app_secret')) return json({ error_code: 10001, error_message: '签名错误1', result: [] })
  if (target.searchParams.get('app_secret') !== SITE_APP_SECRET) {
    return json({ error_code: 10002, error_message: '客户信息不存在', result: [] })
  }
  return topics[id] ? json(detail(topics[id])) : json({ error_code: 404, error_message: '直播不存在', result: [] })
}

console.log('青海模块测试')

check('模块注册为免账号的青海 relay 模块，不挂节目单', () => {
  assert.equal(getModule('qinghai'), qinghai)
  assert.equal(qinghai.name, '青海')
  assert.equal(qinghai.outputGroupName, '青海')
  assert.equal(qinghai.channelHlsMode, 'relay')
  assert.equal(qinghai.relayProxyCompatible, true)
  assert.equal(qinghai.capabilities.catchup, false)
  assert.equal(qinghai.capabilities.epg, false)
  assert.equal(qinghai.epg, undefined, '官网节目单只有整点占位')
  assert.equal(qinghai.catalogVersion, 1)
  assert.deepEqual(qinghai.configSchema, [])
  assert.equal(resolverFor('qinghai-amdo'), qinghai)
  assert.equal(resolverFor('qinghai-amdo/extra'), null)
})

await checkAsync('唯一一路安多卫视，台标用频道接口下发的官方图标', async () => {
  assert.deepEqual(CHANNELS.map(channel => [channel.ref, channel.name, channel.topicId, channel.stream]), [
    ['qinghai-amdo', '安多卫视', AMDO_TOPIC, 'qhzyds'],
  ])
  const channels = buildChannels()
  assert.deepEqual(channels, [{
    name: '安多卫视',
    deferredRef: 'qinghai-amdo',
    // 与 api/topic/detail 的 indexpic 同一地址
    logo: 'https://filestorage.qhbtv.com.cn/file/storage1-cloudlivemanage/cloudlivemanage/2025/1077/4ab9f3d8036d2c9b.png',
    groupTitle: '青海',
    opts: ['network-caching=3000'],
    catchup: 'none',
  }])
  assert.deepEqual(await qinghai.fetch(), {
    groups: [{ name: '青海', dataList: channels }],
    meta: { skipped: [], warnings: [] },
  })
  assert.equal(claimsRef('qinghai-amdo'), true)
  assert.equal(claimsRef('qinghai-qhws'), false)
  assert.equal(claimsRef(undefined), false)
})

check('从官网直播页读出默认频道与 app_secret，改版读不到时抛错', () => {
  assert.deepEqual(parsePlayerPage(page()), { topicId: AMDO_TOPIC, appSecret: SITE_APP_SECRET })
  assert.deepEqual(
    parsePlayerPage(`var current_channel = "${RADIO_TOPIC}"; x = { app_secret: "${'a'.repeat(32)}" }`),
    { topicId: RADIO_TOPIC, appSecret: 'a'.repeat(32) },
  )
  assert.throws(() => parsePlayerPage('<html>维护中</html>'), /没有找到播放器参数/)
  assert.throws(() => parsePlayerPage(page(AMDO_TOPIC, 'not-a-secret')), /没有找到播放器参数/)
  assert.throws(() => parsePlayerPage(undefined), /没有找到播放器参数/)
})

check('频道接口地址带齐专题 id、tenant_id 与 app_secret，参数格式不对不发请求', () => {
  const url = new URL(buildDetailUrl({ topicId: AMDO_TOPIC, appSecret: SITE_APP_SECRET }))
  assert.equal(`${url.origin}${url.pathname}`, 'https://mapi.qhbtv.com.cn/cloudlive-manage-mapi/api/topic/detail')
  assert.deepEqual(Object.fromEntries(url.searchParams), { id: AMDO_TOPIC, tenant_id: '0', app_secret: SITE_APP_SECRET })
  assert.throws(() => buildDetailUrl({ topicId: '1&x=2', appSecret: SITE_APP_SECRET }), /参数格式无效/)
  assert.throws(() => buildDetailUrl({ topicId: AMDO_TOPIC, appSecret: 'ABC' }), /参数格式无效/)
})

check('频道详情只收本频道流名下带齐签名的直播清单', () => {
  assert.equal(parseDetail(JSON.stringify(detail()), amdo), signed())
  // 多一个机位也按流名找本频道那条
  assert.equal(parseDetail(detail(signed(), [{ streams: [{ hls: signed('qhzygb') }] }]), amdo), signed())
  // 页面默认频道换成广播时，接口给的是广播的流
  assert.throws(() => parseDetail(detail(signed('qhzygb')), amdo), /不是安多卫视的直播流/)
  assert.throws(() => parseDetail(detail('https://evil.test/qhzyds/sd/live.m3u8?timestamp=1&encrypt=x'), amdo), /非官方媒体地址/)
  assert.throws(() => parseDetail(detail('http://live.qhbtv.com.cn/qhzyds/sd/live.m3u8'), amdo), /非官方媒体地址/)
  assert.throws(() => parseDetail(detail('https://live.qhbtv.com.cn/qhzyds/sd/live.m3u8'), amdo), /缺少有效签名/)
  assert.throws(() => parseDetail(detail(signed('qhzyds', NOW, 'zz')), amdo), /缺少有效签名/)
  assert.throws(() => parseDetail({ error_code: 10001, error_message: '签名错误1', result: [] }, amdo), /接口拒绝：签名错误1/)
  assert.throws(() => parseDetail({ ...detail(), topic_camera: [] }, amdo), /没有返回安多卫视的直播地址/)
  assert.throws(() => parseDetail('<html>', amdo), /有效 JSON/)
})

check('媒体白名单只放行媒体主机上本频道的直播清单与分片', () => {
  for (const good of [
    signed(),
    'https://live.qhbtv.com.cn/qhzyds_sd/1790273167/1790275617626.ts?timestamp=20260925024657&encrypt=c3a0016964b90942ebd52c1553ab1a9a',
  ]) assert.equal(officialAssetUrl(good), good)
  for (const bad of [
    signed('qhzygb'),
    'https://live.qhbtv.com.cn/qhzygb_sd/1790273167/1790275617626.ts?timestamp=1&encrypt=x',
    'http://live.qhbtv.com.cn/qhzyds/sd/live.m3u8',
    'https://live.qhbtv.com.cn.evil.test/qhzyds/sd/live.m3u8',
    'https://live.qhbtv.com.cn:8443/qhzyds/sd/live.m3u8',
    'https://user:pass@live.qhbtv.com.cn/qhzyds/sd/live.m3u8',
    'https://live.qhbtv.com.cn/api/cloudlive/qhzyds_sd.flv?timestamp=1&encrypt=x',
    'https://live.qhbtv.com.cn/qhzyds/sd/1790265600000,3600000.m3u8',
    'https://live.qhbtv.com.cn/qhzyds/sd/..%2f..%2flive.m3u8',
    'https://live.qhbtv.com.cn/qhzyds/sd/live.m3u8#x',
    'https://mapi.qhbtv.com.cn/qhzyds/sd/live.m3u8',
    'not a url',
  ]) assert.throws(() => officialAssetUrl(bad), /青海藏语台/)
})

check('换新时刻按签名里标称的过期时刻排，读不出或本机钟偏了就走保守窗口', () => {
  // 正常：两小时签名，半小时后换，过期前两分钟停发
  assert.deepEqual(signatureWindow(signed(), NOW), {
    refreshAt: NOW + 30 * MINUTE,
    usableUntil: NOW + 118 * MINUTE,
  })
  // 剩得不多：至少提前十分钟换，但不会快过一分钟一次
  assert.equal(signatureWindow(signed('qhzyds', NOW + 25 * MINUTE), NOW).refreshAt, NOW + 15 * MINUTE)
  assert.equal(signatureWindow(signed('qhzyds', NOW + 5 * MINUTE), NOW).refreshAt, NOW + MINUTE)
  // 本机钟快了三小时 / 慢了两天 / 参数改了：签名在服务器那边仍有效，保守地 5 分钟一换、10 分钟停发
  const fallback = { refreshAt: NOW + 5 * MINUTE, usableUntil: NOW + 10 * MINUTE }
  assert.deepEqual(signatureWindow(signed('qhzyds', NOW - 60 * MINUTE), NOW), fallback)
  assert.deepEqual(signatureWindow(signed('qhzyds', NOW + 48 * 60 * MINUTE), NOW), fallback)
  assert.deepEqual(signatureWindow('https://live.qhbtv.com.cn/qhzyds/sd/live.m3u8?encrypt=x', NOW), fallback)
})

await checkAsync('播放时取签名地址：页面一天读一次，签名半小时一换，relay 只中继清单', async () => {
  clearCache()
  const log = []
  let hls = signed()
  const topics = { get [AMDO_TOPIC]() { return hls } }
  const fetchImpl = site({ topics }, log)
  const first = await resolveChannel('qinghai-amdo', { fetchImpl, now: NOW })
  assert.equal(first.url, signed())
  assert.match(first.desc, /安多卫视当前直播地址获取成功/)
  assert.equal(first.relayHls, true, '无后缀入口也直出清单，302 出去的签名不再续期')
  assert.equal(first.upstreamUrlTransform, officialAssetUrl)
  assert.equal(first.upstreamHeaders, undefined, 'CDN 不校验来源头与 UA，不发')
  assert.deepEqual(log, ['page', `detail:${AMDO_TOPIC}`])

  // 播放器几秒一次的轮询都落在缓存上
  for (const minutes of [0.05, 5, 29]) {
    assert.equal((await resolveChannel('qinghai-amdo', { fetchImpl, now: NOW + minutes * MINUTE })).url, first.url)
  }
  assert.equal(log.length, 2)

  hls = signed('qhzyds', NOW + 150 * MINUTE, 'd6af8a3e5a7cb8c6bd3250690ad3c933')
  const renewed = await resolveChannel('qinghai-amdo', { fetchImpl, now: NOW + 30 * MINUTE })
  assert.equal(renewed.url, hls)
  assert.deepEqual(log.slice(2), [`detail:${AMDO_TOPIC}`], '换签名不重读页面')

  await resolveChannel('qinghai-amdo', { fetchImpl, now: NOW + 25 * 60 * MINUTE })
  assert.deepEqual(log.slice(3), ['page', `detail:${AMDO_TOPIC}`], '一天后重读页面')
})

await checkAsync('并发的首批播放请求共用一次页面与接口请求', async () => {
  clearCache()
  const log = []
  const fetchImpl = site({}, log)
  const results = await Promise.all([1, 2, 3].map(() => resolveChannel('qinghai-amdo', { fetchImpl, now: NOW })))
  assert.ok(results.every(result => result.url === signed()))
  assert.deepEqual(log, ['page', `detail:${AMDO_TOPIC}`])
})

await checkAsync('页面打不开或改版时用内置参数，十分钟后再读页面', async () => {
  for (const broken of [{ pageStatus: 503 }, { pageHtml: '<html>改版了</html>' }]) {
    clearCache()
    const log = []
    const fetchImpl = site(broken, log)
    const result = await resolveChannel('qinghai-amdo', { fetchImpl, now: NOW })
    assert.equal(result.url, signed())
    assert.deepEqual(log, ['page', `detail:${AMDO_TOPIC}`])
    // 签名到了该换的时候：页面冷却已过，再读一次
    await resolveChannel('qinghai-amdo', { fetchImpl, now: NOW + 30 * MINUTE })
    assert.deepEqual(log.slice(2), ['page', `detail:${AMDO_TOPIC}`])
  }

  // 页面冷却期内换签名不打页面
  clearCache()
  const log = []
  const fetchImpl = site({ pageStatus: 503, topics: { [AMDO_TOPIC]: signed('qhzyds', NOW + 12 * MINUTE) } }, log)
  await resolveChannel('qinghai-amdo', { fetchImpl, now: NOW })
  await resolveChannel('qinghai-amdo', { fetchImpl, now: NOW + 2 * MINUTE })
  assert.deepEqual(log, ['page', `detail:${AMDO_TOPIC}`, `detail:${AMDO_TOPIC}`])
})

await checkAsync('页面读到的参数取不出安多卫视时退回内置参数；读到的新参数能用就用新的', async () => {
  // 页面默认频道换成了广播
  clearCache()
  let log = []
  let result = await resolveChannel('qinghai-amdo', {
    fetchImpl: site({ pageHtml: page(RADIO_TOPIC), topics: { [AMDO_TOPIC]: signed(), [RADIO_TOPIC]: signed('qhzygb') } }, log),
    now: NOW,
  })
  assert.equal(result.url, signed())
  assert.deepEqual(log, ['page', `detail:${RADIO_TOPIC}`, `detail:${AMDO_TOPIC}`])

  // 频道换了新专题：页面给的新专题优先，内置的旧专题不再请求
  clearCache()
  log = []
  const moved = signed('qhzyds', NOW + 120 * MINUTE, 'e6f766b84933baed949fff6ea7725907')
  result = await resolveChannel('qinghai-amdo', {
    fetchImpl: site({ pageHtml: page('900000000000000001'), topics: { '900000000000000001': moved } }, log),
    now: NOW,
  })
  assert.equal(result.url, moved)
  assert.deepEqual(log, ['page', 'detail:900000000000000001'])
})

await checkAsync('接口故障时在签名到期前沿用上次成功地址并退避，到期后照实报错', async () => {
  clearCache()
  const log = []
  let apiDown = false
  const fetchImpl = async (url, init) => site({ apiDown }, log)(url, init)
  const good = await resolveChannel('qinghai-amdo', { fetchImpl, now: NOW })
  apiDown = true
  const degraded = await resolveChannel('qinghai-amdo', { fetchImpl, now: NOW + 31 * MINUTE })
  assert.equal(degraded.url, good.url)
  const calls = log.length
  await resolveChannel('qinghai-amdo', { fetchImpl, now: NOW + 31.2 * MINUTE })
  assert.equal(log.length, calls, '失败后 30 秒内不重打接口')
  const late = await resolveChannel('qinghai-amdo', { fetchImpl, now: NOW + 117 * MINUTE })
  assert.equal(late.url, good.url, '离过期还有两分钟以上仍可用')
  const expired = await resolveChannel('qinghai-amdo', { fetchImpl, now: NOW + 119 * MINUTE })
  assert.equal(expired.url, '')
  assert.match(expired.desc, /青海藏语台链接请求失败：.*HTTP 502/)
})

await checkAsync('非法引用与网络异常只返回说明，不向请求处理器抛错', async () => {
  clearCache()
  const malformed = await resolveChannel('qinghai-qhws', {
    fetchImpl: async () => { throw new Error('不应请求') },
  })
  assert.equal(malformed.url, '')
  assert.match(malformed.desc, /引用格式错误/)
  const thrown = await resolveChannel('qinghai-amdo', {
    fetchImpl: async () => { throw new Error('socket hang up') },
    now: NOW,
  })
  assert.equal(thrown.url, '')
  assert.match(thrown.desc, /青海藏语台链接请求失败：socket hang up/)
  const rejected = await resolveChannel('qinghai-amdo', {
    fetchImpl: async url => (String(url) === QHTB_TV_PAGE
      ? new Response(page(AMDO_TOPIC, 'f'.repeat(32)))
      : json({ error_code: 10002, error_message: '客户信息不存在', result: [] })),
    now: NOW,
  })
  assert.equal(rejected.url, '')
  assert.match(rejected.desc, /接口拒绝：客户信息不存在/)
})

console.log(`\n全部通过：${passed} ✅`)
