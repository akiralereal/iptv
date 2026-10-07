#!/usr/bin/env node
/**
 * 宁波模块离线测试：固定四路频道、按官网播放器的顺序取流（直播页 → 播放器配置 → CDN 参数 → 频道资料 →
 * 签名接口）、只接受本频道官方 CDN 上的清单与分片、频道资料缓存 6 小时、签名缓存到过期前 15 分钟、
 * 清单被拒时重签一次。夹具按 2026-10-06 的真实响应裁剪；CDN 加密参数换成占位串，不进仓库。
 *
 * 运行： node scripts/test-ningbo.mjs
 */
import assert from 'node:assert/strict'

import ningbo from '../extractors/ningbo/index.js'
import {
  CHANNELS, authExpiry, claimsRef, createResolver, officialMediaUrl, officialStreamUrl, parseChannelJsonp,
  parseLivePage, parseProfileScript, pickCdn, validatePlaylist,
} from '../extractors/ningbo/api.js'
import { livePage } from '../extractors/ningbo/channels.js'
import { getModule, resolverFor } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

const NOW = 1791280824000
const EXPIRES = 1791284424            // 签发后 1 小时
const channel = CHANNELS[1]           // 宁波经济生活 / NBTV2
const CHANNEL_ID = 'bb73d5de1e9047e0b7ed55d3ba3e3dce'
const PLAYER_ID = '9ebadf3777b14e0eac6cc99509ae0493'
const SCRIPT_URL = `https://web.ncmc.nbtv.cn/vms/site/nbtv/media/playerJson/liveChannel/${PLAYER_ID}.js`
const PROFILE_URL = `https://web.ncmc.nbtv.cn/vms/site/nbtv/media/playerJson/liveChannel/${PLAYER_ID}_PlayerParamProfile.json`
const JSONP_URL = `https://web.ncmc.nbtv.cn/vms/site/nbtv/liveChannel/PC/${CHANNEL_ID}.jsonp`
const SIGN_URL = 'https://em.chinamcloud.com/player/encryptUrl'
const STREAM = 'https://liveplay8.nbtv.cn/live/nbtv2_md.m3u8'
const ENCRYPT = 'PLACEHOLDER-NOT-THE-REAL-CDN-PARAMS'
const signed = (exp = EXPIRES, tag = 'a') => `${STREAM}?auth_key=${exp}-0-0-${tag.repeat(32).slice(0, 32)}`
const segment = n => `liveplay8.nbtv.cn_nbtv2_md-${n}.ts?auth_key=${EXPIRES + 11}-0-0-${'c'.repeat(32)}`
const playlist = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-MEDIA-SEQUENCE:288737\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.000,\n${segment('1791280797153')}\n#EXTINF:5.440,\n${segment('1791280809187')}\n`

const PAGE = `<!--PLAYERCODESTART--><div id="${PLAYER_ID}"></div><script type="text/javascript">var vmsPlayer_callback = function () {createLivePlayer("${CHANNEL_ID}","@WIDTH@","@HEIGHT@","new");};</script><script type="text/javascript" src="https://player.ncmc.nbtv.cn/vms/site/media/cmcPlayer/cmcMediaPlayer.js"></script><script type="text/javascript" src="${SCRIPT_URL}"></script><!--PLAYERCODEEND-->`
const SCRIPT = `eval(function(p,a,c,k,e,r){/* 打包的 jQuery，略 */}('',0,0,''.split('|'),0,{}))\nvar vmsPlayer_param = {\n\t\t player_hasAreaLimitFlag:"0",\n\t\t player_playerParamFXProfile:"https://web.ncmc.nbtv.cn/vms/site/nbtv/media/playerJson/liveChannel/${PLAYER_ID}_PlayerParamFXProfile.json",\n\t\t player_playerParamProfile:"${PROFILE_URL}",\n\t\t player_siteId:"2"\n}`
const PROFILE = { paramslist: {}, pluginslist: {}, paramsConfig: {
  cdnConfig: [{ code: 'alicdn', publishHost: 'https://liveplay8.nbtv.cn', H5PublishHost: 'https://liveplay8.nbtv.cn', invalidTime: '3600', encryptMode: 'A', getAuthUrl: SIGN_URL }],
  cdnConfigEncrypt: ENCRYPT, isCDNConfigEncrypt: 'true',
} }
const JSONP = `callback_${CHANNEL_ID}(${JSON.stringify({ imagePath: '', C_Name: 'NBTV2', C_Id: CHANNEL_ID, C_Address: `mr://j:${JSON.stringify({ playerUrl: [{ title: '高清', url: STREAM }], status: 1, catalogId: CHANNEL_ID })}` })})`

/** 按地址回真实形态的应答并计数；calls.rejectTag 指定的那份签名清单回 403。 */
function upstream({ now = () => NOW, signTags = ['a'] } = {}) {
  const calls = { page: 0, script: 0, profile: 0, jsonp: 0, sign: 0, playlist: 0, bodies: [], headers: [], rejectTag: '' }
  const fetchImpl = async (url, init = {}) => {
    if (url === livePage(channel)) { calls.page++; return new Response(PAGE) }
    if (url === SCRIPT_URL) { calls.script++; return new Response(SCRIPT) }
    if (url === PROFILE_URL) { calls.profile++; return new Response(JSON.stringify(PROFILE)) }
    if (url === JSONP_URL) { calls.jsonp++; return new Response(JSONP) }
    if (url === SIGN_URL) {
      calls.sign++
      calls.bodies.push(JSON.parse(init.body))
      calls.headers.push(init.headers)
      const tag = signTags[Math.min(calls.sign - 1, signTags.length - 1)]
      return new Response(JSON.stringify({ code: '0000', desc: '获取加密地址成功', url: signed(Math.floor(now() / 1000) + 3600, tag) }))
    }
    if (url.startsWith(STREAM)) {
      calls.playlist++
      if (calls.rejectTag && url.includes(`-0-0-${calls.rejectTag.repeat(32)}`)) return new Response('', { status: 403 })
      return new Response(playlist)
    }
    throw new Error(`意外的请求：${url}`)
  }
  return { calls, fetchImpl }
}

console.log('宁波模块测试')

check('模块注册为免账号、归入浙江的清单中继模块', () => {
  assert.equal(getModule('ningbo'), ningbo)
  assert.equal(ningbo.name, '宁波')
  assert.equal(ningbo.outputGroupName, '浙江')
  assert.equal(ningbo.channelHlsMode, 'relay', 'CDN 不看来源头，分片给播放器直连')
  assert.equal(ningbo.relayProxyCompatible, true)
  assert.equal(ningbo.capabilities.resolve, true)
  assert.equal(ningbo.capabilities.epg, false)
  assert.equal(ningbo.capabilities.catchup, false)
  assert.equal(ningbo.catalogVersion, 1)
  assert.deepEqual(ningbo.configSchema, [])
  assert.equal(resolverFor(channel.ref), ningbo)
  assert.notEqual(resolverFor('ningde-news'), ningbo, '不能认领宁德的 ref')
})

await checkAsync('四路固定频道走延迟解析，名字是官网正式名补市名', async () => {
  const { groups } = await ningbo.fetch()
  assert.equal(groups.length, 1)
  assert.equal(groups[0].name, '浙江')
  assert.deepEqual(groups[0].dataList.map(row => row.name), ['宁波新闻综合', '宁波经济生活', '宁波都市文体', '宁波影视剧'])
  assert.deepEqual(CHANNELS.map(row => row.rawName), ['NBTV1', 'NBTV2', 'NBTV3', 'NBTV4'])
  assert.ok(groups[0].dataList.every(row => row.deferredRef && !row.url && !row.logo && row.catchup === 'none'))
  assert.equal(claimsRef(channel.ref), true)
  assert.equal(claimsRef('ningbo-5'), false)
  assert.equal(livePage(channel), 'https://www.ncmc.nbtv.cn/gbds/folder8458/NBTV2/index.shtml')
})

check('官网播放器各步的解析：只认官方域名和本频道', () => {
  assert.deepEqual(parseLivePage(PAGE), { channelId: CHANNEL_ID, profileScript: SCRIPT_URL })
  assert.throws(() => parseLivePage('<html></html>'), /改版/)
  assert.equal(parseProfileScript(SCRIPT), PROFILE_URL)
  assert.throws(() => parseProfileScript(SCRIPT.replace(PROFILE_URL, 'https://evil.example/x_PlayerParamProfile.json')), /官方域名/)
  assert.equal(parseChannelJsonp(JSONP, CHANNEL_ID, channel), STREAM)
  assert.throws(() => parseChannelJsonp(JSONP, CHANNEL_ID, CHANNELS[0]), /不在该频道/)
  assert.throws(() => parseChannelJsonp(JSONP.replace('"status\\":1', '"status\\":0'), CHANNEL_ID, channel), /停播/)
  assert.throws(() => parseChannelJsonp(JSONP, 'f'.repeat(32), channel), /格式/)
  assert.deepEqual(pickCdn(PROFILE, STREAM), { index: 0, encrypt: ENCRYPT })
  const moved = structuredClone(PROFILE)
  moved.paramsConfig.cdnConfig[0].getAuthUrl = 'https://evil.example/sign'
  assert.throws(() => pickCdn(moved, STREAM), /签名接口地址已变化/)
  assert.throws(() => pickCdn(PROFILE, 'https://other.example/live/nbtv2_md.m3u8'), /没有这路流/)
})

check('只接受本频道官方 CDN 上带签名的清单与分片', () => {
  assert.equal(officialStreamUrl(signed(), channel, { signed: true }), signed())
  assert.equal(authExpiry(new URL(signed())), EXPIRES * 1000)
  assert.throws(() => officialStreamUrl(STREAM, channel, { signed: true }), /签名/)
  assert.throws(() => officialStreamUrl(signed().replace('nbtv2', 'nbtv3'), channel))
  assert.throws(() => officialStreamUrl(signed().replace('https:', 'http:'), channel))
  const seg = `https://liveplay8.nbtv.cn/live/${segment('1')}`
  assert.equal(officialMediaUrl(segment('1'), signed(), channel), seg)
  assert.throws(() => officialMediaUrl(seg.replace('nbtv2_md', 'nbtv3_md'), signed(), channel))
  assert.throws(() => officialMediaUrl(seg.replace('liveplay8.nbtv.cn/', 'evil.example/'), signed(), channel))
  assert.equal(validatePlaylist(playlist, signed(), channel), playlist)
  assert.throws(() => validatePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nx.m3u8\n', signed(), channel), /格式已变化/)
  assert.throws(() => validatePlaylist('#EXTM3U\n', signed(), channel), /没有分片/)
})

await checkAsync('按官网顺序取流；加密参数原样回传签名接口；频道资料与签名分别缓存', async () => {
  let now = NOW
  const { calls, fetchImpl } = upstream({ now: () => now })
  const resolver = createResolver({ fetchImpl, now: () => now })
  const first = await resolver.resolve(channel.ref)
  assert.equal(first.url, signed())
  assert.equal(first.relayHls, true)
  assert.equal(first.manifestText, playlist)
  assert.equal(first.manifestUrl, first.url)
  assert.equal(first.upstreamHeaders, undefined, 'CDN 不看来源头，中继不带')
  assert.equal(first.upstreamUrlTransform(`https://liveplay8.nbtv.cn/live/${segment('2')}`), `https://liveplay8.nbtv.cn/live/${segment('2')}`)
  assert.deepEqual(calls.bodies[0], { url: STREAM, playType: 'live', type: 'cdn', cdnEncrypt: ENCRYPT, cdnIndex: 0 })
  assert.equal(calls.headers[0].Referer, livePage(channel))
  assert.equal(calls.headers[0].Origin, 'https://www.ncmc.nbtv.cn')
  now += 44 * 60 * 1000
  await resolver.resolve(channel.ref)
  assert.equal(calls.sign, 1, '过期前 15 分钟内不重签')
  now += 2 * 60 * 1000
  await resolver.resolve(channel.ref)
  assert.equal(calls.sign, 2, '进入最后 15 分钟就重签')
  assert.deepEqual([calls.page, calls.script, calls.profile, calls.jsonp], [1, 1, 1, 1], '频道资料 6 小时内复用')
  assert.equal(calls.playlist, 3, '每次轮询都重取清单')
  now += 6 * 60 * 60 * 1000
  await resolver.resolve(channel.ref)
  assert.equal(calls.page, 2, '6 小时后重新走一遍官网页面')
})

await checkAsync('清单被拒时扔掉签名重签一次；并发只签一次', async () => {
  const { calls, fetchImpl } = upstream({ signTags: ['a', 'e'] })
  const resolver = createResolver({ fetchImpl, now: () => NOW })
  const results = await Promise.all([resolver.resolve(channel.ref), resolver.resolve(channel.ref)])
  assert.ok(results.every(result => result.url === signed()), results.map(r => r.desc).join('；'))
  assert.equal(calls.sign, 1)
  assert.equal(calls.page, 1)
  calls.rejectTag = 'a'
  const renewed = await resolver.resolve(channel.ref)
  assert.equal(renewed.url, signed(EXPIRES, 'e'))
  assert.equal(calls.sign, 2)
})

await checkAsync('非法引用与上游异常只返回说明，失败后短时间内不连环打上游', async () => {
  let calls = 0
  const resolver = createResolver({
    fetchImpl: async () => { calls++; return new Response('<html>502</html>', { status: 502 }) },
    now: () => NOW,
  })
  const malformed = await resolver.resolve('other')
  assert.equal(malformed.url, '')
  assert.match(malformed.desc, /引用格式错误/)
  const failed = await resolver.resolve(channel.ref)
  assert.equal(failed.url, '')
  assert.match(failed.desc, /宁波经济生活 取流失败.*HTTP 502/)
  await resolver.resolve(channel.ref)
  assert.equal(calls, 1, '冷却期内回同一个错误')
  const refused = upstream()
  const badSign = createResolver({
    fetchImpl: async (url, init) => url === SIGN_URL
      ? new Response(JSON.stringify({ code: '1001', desc: '参数错误' }))
      : refused.fetchImpl(url, init),
    now: () => NOW,
  })
  assert.match((await badSign.resolve(channel.ref)).desc, /签名接口没有给出地址/)
})

console.log(`\n全部通过：${passed} ✅`)
