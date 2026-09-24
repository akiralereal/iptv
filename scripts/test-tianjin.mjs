#!/usr/bin/env node
/**
 * 天津广电（津云 WiseTV）模块离线测试：加解密往返、2 字节循环移位、媒体白名单、
 * 签名缓存与兜底、resolve 绝不抛异常。签发接口与 CDN 全部用注入的假 fetch 模拟，
 * getWise4PK 的公钥由本地现生成的 RSA 密钥对充当。
 *
 * 运行： node scripts/test-tianjin.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import {
  constants,
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
} from 'node:crypto'

import tianjin from '../extractors/tianjin/index.js'
import {
  BUNDLE_ID,
  CHANNELS,
  FORCE_RESIGN_GAP_MS,
  MEDIA_UA,
  PUBLIC_KEY_API,
  PUBLIC_KEY_TTL_MS,
  SIGN_API,
  SESSION_IDLE_MS,
  SIGN_POLICY,
  buildChannels,
  claimsRef,
  createResolver,
  createSessionKey,
  decryptWiseUrl,
  encryptWiseRequest,
  officialMediaUrl,
  rotateHex,
  upstreamHeadersFor,
  validateConfig,
} from '../extractors/tianjin/api.js'
import { DEVICE_ID, wiseConfig, wiseHeaders } from '../extractors/tianjin/auth.js'
import { getModule, resolverFor } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 })
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' })
// 用模块内置默认值当「服务端」的密钥；测试里不出现任何具体取值
const BUILT_IN = wiseConfig({})
const SATELLITE = CHANNELS.find(channel => channel.ref === 'tianjin-satellite')
const SPORTS = CHANNELS.find(channel => channel.ref === 'tianjin-sports')

const tripleDes = (value, key, decrypt = false) => {
  const cipher = decrypt ? createDecipheriv('des-ede3', key, null) : createCipheriv('des-ede3', key, null)
  return Buffer.concat([cipher.update(value), cipher.final()])
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'text/html; charset=utf-8' } })
const hls = (text, status = 200) => new Response(text, { status, headers: { 'content-type': 'application/vnd.apple.mpegurl' } })

/** 服务端视角：解开 wise4ParaBody 拿到会话键与频道 ID。 */
function openRequest(body, cipherKey = BUILT_IN.cipherKey) {
  const hex = rotateHex(new URLSearchParams(body).get('wise4ParaBody'), false)
  const rsaBase64 = tripleDes(Buffer.from(hex, 'hex'), Buffer.from(cipherKey), true).toString('utf8')
  const plaintext = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(rsaBase64, 'base64')).toString('utf8')
  const [bundle, sessionKey, channelId] = plaintext.split('|')
  return { bundle, sessionKey, channelId }
}

/** 服务端视角：按 App 协议把直播地址加密回去。 */
function sealUrl(url, sessionKey, cipherKey = BUILT_IN.cipherKey) {
  const session = Buffer.from(sessionKey)
  const innerHex = tripleDes(Buffer.from(url), Buffer.concat([session, session, session])).toString('hex')
  return rotateHex(tripleDes(Buffer.from(innerHex), Buffer.from(cipherKey)).toString('hex'), true)
}

const LIVE2_ENTRY = n => `http://live2.wisetv.com.cn/TJIPTV/TJWSHD2/playlist.m3u8?wsSecret=${'a'.repeat(32)}&wsTime=6ab5719${n}&GUID=${'b'.repeat(32)}`
const VARIANT = n => `http://live2.wisetv.com.cn/TJIPTV/TJWSHD2/playlist.m3u8?wsSecret=${'a'.repeat(32)}&wsTime=6ab5719${n}&GUID=${'b'.repeat(32)}&wsHlsSession=${'c'.repeat(32)}`
// 形状照 live2 实际返回裁剪：master 只有一路绝对地址的子清单，媒体清单里分片带会话参数
const MASTER = n => `#EXTM3U\n#EXT-X-STREAM-INF:PROGRAM-ID=1, BANDWIDTH=2048000\n${VARIANT(n)}\n`
const MEDIA = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-ALLOW-CACHE:NO\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:1790250610\n\n'
  + '#EXTINF:1.984,\n1790250610.ts?wsApp=HLS&wsHlsSession=cccc\n#EXTINF:1.984,\n1790250611.ts?wsApp=HLS&wsHlsSession=cccc\n'

/** 假上游：记录每类请求次数；各环节的行为可按测试替换。 */
function fakeUpstream(overrides = {}) {
  const calls = { pk: 0, sign: 0, entry: 0, variant: 0, other: 0, signHeaders: [], mediaHeaders: [], channels: [] }
  let serial = 0
  const handlers = {
    pk: async () => json({ code: 200, message: 'OK', data: PUBLIC_PEM }),
    sign: async (options) => {
      const request = openRequest(options.body)
      calls.channels.push(request.channelId)
      assert.equal(request.bundle, BUNDLE_ID)
      serial++
      return json({ code: 200, message: 'OK', data: { url: sealUrl(LIVE2_ENTRY(serial % 10), request.sessionKey) } })
    },
    entry: async url => hls(MASTER(new URL(url).searchParams.get('wsTime').slice(-1))),
    variant: async () => hls(MEDIA),
    ...overrides,
  }
  const fetchImpl = async (url, options = {}) => {
    const href = String(url)
    if (href === PUBLIC_KEY_API) { calls.pk++; return handlers.pk(options) }
    if (href === SIGN_API) { calls.sign++; calls.signHeaders.push(options.headers); return handlers.sign(options) }
    calls.mediaHeaders.push(options.headers)
    if (href.includes('wsHlsSession=')) { calls.variant++; return handlers.variant(href, options) }
    if (href.includes('live2.wisetv.com.cn')) { calls.entry++; return handlers.entry(href, options) }
    calls.other++
    throw new Error(`意外请求 ${href}`)
  }
  return { calls, fetchImpl, handlers }
}

console.log('天津广电（津云）模块测试')

check('模块注册为免账号、全代理、无回看的天津模块', () => {
  assert.equal(getModule('tianjin'), tianjin)
  assert.equal(tianjin.name, '天津')
  assert.equal(tianjin.outputGroupName, '天津')
  assert.equal(tianjin.channelHlsMode, 'proxy')
  assert.equal(tianjin.capabilities.resolve, true)
  assert.equal(tianjin.capabilities.catchup, false)
  assert.equal(tianjin.capabilities.epg, true)
  assert.equal(tianjin.catalogVersion, 1)
  assert.deepEqual(tianjin.configSchema, [])
  assert.equal(resolverFor('tianjin-satellite'), tianjin)
  assert.equal(resolverFor('tianjin-satellite/extra'), null)
})

await checkAsync('七路频道并入唯一的天津分组，每路都带津云官方频道台标', async () => {
  assert.deepEqual(CHANNELS.map(channel => channel.name),
    ['天津卫视', '天津新闻', '天津文艺', '天津影视', '天津都市', '天津体育', '天津教育'])
  assert.equal(new Set(CHANNELS.map(channel => channel.ref)).size, CHANNELS.length)
  assert.equal(new Set(CHANNELS.map(channel => channel.channelId)).size, CHANNELS.length)
  assert.ok(CHANNELS.every(channel => /^\d{32}$/.test(channel.channelId)))
  assert.ok(!CHANNELS.some(channel => /购物/.test(channel.name)))
  const channels = buildChannels()
  assert.ok(channels.every(channel => channel.groupTitle === '天津' && channel.catchup === 'none'))
  // 默认没有台标库兜底：七路都给 WiseTV 图片服务器上的完整地址，且各不相同
  assert.ok(channels.every(channel => /^https:\/\/s1\.wisetv\.com\.cn\/pic\/[\w/]+\.(?:jpg|png)$/.test(channel.logo)))
  assert.equal(new Set(channels.map(channel => channel.logo)).size, channels.length)
  assert.deepEqual(await tianjin.fetch(), { groups: [{ name: '天津', dataList: channels }], meta: { skipped: [], warnings: [] } })
  assert.equal(claimsRef('tianjin-education'), true)
  assert.equal(claimsRef('tianjin-shopping'), false)
})

check('内置应用参数完整、三项互不相同，环境变量可以覆盖', () => {
  assert.ok(BUILT_IN.ak && BUILT_IN.sk)
  assert.equal(Buffer.byteLength(BUILT_IN.cipherKey), 24)
  assert.equal(new Set([BUILT_IN.ak, BUILT_IN.sk, BUILT_IN.cipherKey]).size, 3)
  assert.equal(validateConfig(BUILT_IN), BUILT_IN)
  const override = wiseConfig({ TIANJIN_WISE_AK: 'ak-x', TIANJIN_WISE_SK: 'sk-x', TIANJIN_WISE_3DES_KEY: '0123456789abcdef01234567' })
  assert.deepEqual(override, { ak: 'ak-x', sk: 'sk-x', cipherKey: '0123456789abcdef01234567' })
  // 最常见的误填：把 SK 当成 3DES 密钥
  assert.throws(() => validateConfig({ ...override, cipherKey: 'sk-x'.padEnd(24, '0'), sk: 'sk-x'.padEnd(24, '0') }), /不能与 AK \/ SK 相同/)
  assert.throws(() => validateConfig({ ...override, cipherKey: 'short' }), /24 字节/)
  assert.throws(() => validateConfig({ ...override, ak: '' }), /缺少 AK/)
  const headers = wiseHeaders(BUILT_IN)
  assert.match(DEVICE_ID, /^[0-9a-f]{16}$/)
  assert.equal(headers['x-deviceid'], DEVICE_ID)
  assert.equal(headers.imei, DEVICE_ID)
  assert.equal(headers['x-platform'], 'Android')
  assert.equal(headers.ak, BUILT_IN.ak)
})

check('3DES 外层的 2 字节循环移位：发出去左移 4 个字符，收回来右移', () => {
  assert.equal(rotateHex('0123456789abcdef', true), '456789abcdef0123')
  assert.equal(rotateHex('456789abcdef0123', false), '0123456789abcdef')
  assert.equal(rotateHex(rotateHex('deadbeefcafebabe', true), false), 'deadbeefcafebabe')
  // 会话键逐字节取低 4 位
  assert.equal(createSessionKey(size => Buffer.from([0x10, 0x2f, 0xa3, 0x04, 0xff, 0x00, 0x7e, 0x5b].slice(0, size))), '0f34f0eb')
})

check('请求加密与 App 同构：服务端解得开包名、会话键和频道 ID', () => {
  const body = encryptWiseRequest(SATELLITE.channelId, PUBLIC_PEM, BUILT_IN.cipherKey, '89abcdef')
  assert.match(body, /^[0-9a-f]+$/)
  assert.deepEqual(openRequest(new URLSearchParams({ wise4ParaBody: body }).toString()),
    { bundle: 'cn.com.enorth.jinyun', sessionKey: '89abcdef', channelId: SATELLITE.channelId })
  assert.throws(() => encryptWiseRequest('../1', PUBLIC_PEM, BUILT_IN.cipherKey, '89abcdef'), /频道 ID/)
  assert.throws(() => encryptWiseRequest(SATELLITE.channelId, PUBLIC_PEM, BUILT_IN.cipherKey, 'XYZ'), /会话键/)
})

check('两层 3DES 地址解密往返；密钥不对或密文畸形时报错而不是吐乱码', () => {
  const url = 'http://live-tx.wisetv.com.cn/TJIPTV/TJWSHD2.m3u8?txSecret=00&txTime=6ab57141&GUID=11'
  const sealed = sealUrl(url, '89abcdef')
  assert.equal(decryptWiseUrl(sealed, BUILT_IN.cipherKey, '89abcdef'), url)
  // 漏掉移位（9 月那次误判的原因）就解不开
  assert.throws(() => decryptWiseUrl(rotateHex(sealed, false), BUILT_IN.cipherKey, '89abcdef'), /解密失败/)
  assert.throws(() => decryptWiseUrl(sealed, '0123456789abcdef01234567', '89abcdef'), /解密失败/)
  assert.throws(() => decryptWiseUrl('xyz', BUILT_IN.cipherKey, '89abcdef'), /无效的加密地址/)
})

check('媒体白名单只放行 wisetv.com.cn 的 live* 直播主机上的清单与分片', () => {
  for (const good of [
    'http://live-tx.wisetv.com.cn/TJIPTV/TJWSHD2.m3u8?txSecret=x&txTime=6ab57141',
    'http://live-tx.wisetv.com.cn/TJIPTV/TJWSHD2-1790039373.ts?txSecret=x&GUID=ts',
    'http://live2.wisetv.com.cn/TJIPTV/TJWYHD2/playlist.m3u8?wsSecret=x&wsHlsSession=y',
    'http://live2.wisetv.com.cn/TJIPTV/TJWYHD2/1790250609.ts?wsApp=HLS&wsHlsSession=y',
    'http://live-bd.wisetv.com.cn/TJIPTV/TJYSHD2-1790039446.ts?secret=x',
    'https://live-bd.wisetv.com.cn/TJIPTV/TJYSHD2.m3u8',
  ]) assert.equal(officialMediaUrl(good), good)
  for (const bad of [
    'http://live2.wisetv.com.cn.evil.test/TJIPTV/x.m3u8',
    'http://evil-live2.wisetv.com.cn/TJIPTV/x.m3u8',
    'http://jyapi2.wisetv.com.cn/TJIPTV/x.m3u8',
    'http://s1.wisetv.com.cn/pic/x.ts',
    'http://live2.wisetv.com.cn:8080/TJIPTV/x.m3u8',
    'http://user:pass@live2.wisetv.com.cn/TJIPTV/x.m3u8',
    'http://live2.wisetv.com.cn/TJIPTV/..%2f..%2fx.m3u8',
    'http://live2.wisetv.com.cn/TJIPTV/x.mp4',
    'ftp://live2.wisetv.com.cn/TJIPTV/x.m3u8',
    'not a url',
  ]) assert.throws(() => officialMediaUrl(bad), /津云/)
  assert.deepEqual(upstreamHeadersFor('http://live2.wisetv.com.cn/TJIPTV/TJWYHD2/1.ts'), { 'User-Agent': MEDIA_UA })
  // 重定向到别处时代理层每一跳都会先过这里
  assert.throws(() => upstreamHeadersFor('http://evil.test/TJIPTV/1.ts'), /非官方/)
})

await checkAsync('完整链路：公钥 → 签发 → 解密 → master → 媒体清单，都以同一个 UA 回源', async () => {
  const upstream = fakeUpstream()
  const clock = 1_790_000_000_000
  const resolver = createResolver({ fetchImpl: upstream.fetchImpl, env: {}, now: () => clock })
  const result = await resolver.resolve('tianjin-satellite')
  assert.equal(result.url, LIVE2_ENTRY(1))
  assert.equal(result.manifestUrl, VARIANT(1))
  assert.equal(result.manifestText, MEDIA)
  assert.equal(result.upstreamHeaders, upstreamHeadersFor)
  assert.equal(result.upstreamUrlTransform, officialMediaUrl)
  assert.equal(result.relayHls, undefined)
  assert.match(result.desc, /天津卫视/)
  assert.deepEqual(upstream.calls.channels, [SATELLITE.channelId])
  assert.deepEqual([upstream.calls.pk, upstream.calls.sign, upstream.calls.entry, upstream.calls.variant], [1, 1, 1, 1])
  // 接口请求带内置 ak/sk 与设备头；清单两跳都是 MEDIA_UA、不带 Referer
  assert.equal(upstream.calls.signHeaders[0].ak, BUILT_IN.ak)
  assert.equal(upstream.calls.signHeaders[0].sk, BUILT_IN.sk)
  assert.equal(upstream.calls.signHeaders[0]['x-deviceid'], DEVICE_ID)
  for (const headers of upstream.calls.mediaHeaders) assert.deepEqual(headers, { 'User-Agent': MEDIA_UA })
})

await checkAsync('入口签名按频道缓存：有效期内不再签发，公钥一小时复用，并发只签一次', async () => {
  const upstream = fakeUpstream()
  let clock = 1_790_000_000_000
  const resolver = createResolver({ fetchImpl: upstream.fetchImpl, env: {}, now: () => clock, sessionIdleMs: 0 })
  const results = await Promise.all(Array.from({ length: 5 }, () => resolver.resolve('tianjin-satellite')))
  assert.ok(results.every(result => result.url === LIVE2_ENTRY(1)))
  assert.equal(upstream.calls.sign, 1)
  assert.equal(upstream.calls.pk, 1)
  // 关掉会话复用时每次都从入口取清单，只是不签发
  assert.equal(upstream.calls.entry, 5)

  clock += SIGN_POLICY.refreshMs - 1
  assert.equal((await resolver.resolve('tianjin-satellite')).url, LIVE2_ENTRY(1))
  assert.equal(upstream.calls.sign, 1)

  clock += 2
  assert.equal((await resolver.resolve('tianjin-satellite')).url, LIVE2_ENTRY(2))
  assert.equal(upstream.calls.sign, 2)
  assert.equal(upstream.calls.pk, 1)

  await resolver.resolve('tianjin-sports')
  assert.equal(upstream.calls.sign, 3)
  assert.equal(upstream.calls.channels.at(-1), SPORTS.channelId)

  clock += PUBLIC_KEY_TTL_MS
  await resolver.resolve('tianjin-sports')
  assert.equal(upstream.calls.pk, 2)
})

await checkAsync('播放中直接轮询媒体清单：不回入口、不重签，跨过签名有效期也不换 CDN；会话断了或停播一分钟后从入口重来', async () => {
  let variantFailsOnce = false
  const upstream = fakeUpstream()
  const originalVariant = upstream.handlers.variant
  upstream.handlers.variant = async (url, options) => {
    if (variantFailsOnce) { variantFailsOnce = false; return hls('Forbidden', 403) }
    return originalVariant(url, options)
  }
  let clock = 1_790_000_000_000
  const resolver = createResolver({ fetchImpl: upstream.fetchImpl, env: {}, now: () => clock })
  const first = await resolver.resolve('tianjin-satellite')
  assert.deepEqual([upstream.calls.sign, upstream.calls.entry, upstream.calls.variant], [1, 1, 1])

  // 播放器 3 秒一轮询，连播 20 分钟：远超入口 10 分钟的签名有效期，仍然只轮询媒体清单
  for (let elapsed = 0; elapsed < 20 * 60 * 1000; elapsed += 3000) {
    clock += 3000
    const result = await resolver.resolve('tianjin-satellite')
    assert.equal(result.manifestUrl, first.manifestUrl)
    assert.equal(result.manifestText, MEDIA)
  }
  assert.deepEqual([upstream.calls.sign, upstream.calls.entry, upstream.calls.variant], [1, 1, 401])

  // 媒体清单被拒：丢掉会话，入口签名早过期了，重签后从新入口建会话
  variantFailsOnce = true
  clock += 3000
  const renewed = await resolver.resolve('tianjin-satellite')
  assert.equal(renewed.url, LIVE2_ENTRY(2))
  assert.equal(renewed.manifestUrl, VARIANT(2))
  assert.deepEqual([upstream.calls.sign, upstream.calls.entry], [2, 2])

  // 停播超过一分钟：不再信旧会话，从入口重来；入口签名还新鲜，不用重签
  clock += SESSION_IDLE_MS
  assert.equal((await resolver.resolve('tianjin-satellite')).url, LIVE2_ENTRY(2))
  assert.deepEqual([upstream.calls.sign, upstream.calls.entry], [2, 3])
})

await checkAsync('换签失败时在硬期限内沿用旧地址并退避，过了硬期限照实报错且不抛异常', async () => {
  let signFails = false
  const upstream = fakeUpstream()
  const originalSign = upstream.handlers.sign
  upstream.handlers.sign = async options => (signFails ? json({ code: 500, message: 'response code is 500' }) : originalSign(options))
  let clock = 1_790_000_000_000
  const resolver = createResolver({ fetchImpl: upstream.fetchImpl, env: {}, now: () => clock, sessionIdleMs: 0 })
  assert.equal((await resolver.resolve('tianjin-satellite')).url, LIVE2_ENTRY(1))

  signFails = true
  clock += SIGN_POLICY.refreshMs + 1
  assert.equal((await resolver.resolve('tianjin-satellite')).url, LIVE2_ENTRY(1))
  assert.equal(upstream.calls.sign, 2)
  // 退避期内不再打签发接口
  clock += SIGN_POLICY.retryMs - 1
  assert.equal((await resolver.resolve('tianjin-satellite')).url, LIVE2_ENTRY(1))
  assert.equal(upstream.calls.sign, 2)
  // 签发失败会丢掉公钥缓存，下次重新取
  const pkBefore = upstream.calls.pk
  clock += 2
  await resolver.resolve('tianjin-satellite')
  assert.equal(upstream.calls.sign, 3)
  assert.equal(upstream.calls.pk, pkBefore + 1)

  clock = 1_790_000_000_000 + SIGN_POLICY.hardTtlMs + 1
  const expired = await resolver.resolve('tianjin-satellite')
  assert.equal(expired.url, '')
  assert.match(expired.desc, /天津广电链接请求失败：津云签发接口失败：response code is 500/)
})

await checkAsync('旧签名取不到清单时丢掉重签一次；强制重签限频，CDN 整体拒绝时不连环打接口', async () => {
  let entryStatus = 200
  const upstream = fakeUpstream()
  const originalEntry = upstream.handlers.entry
  upstream.handlers.entry = async (url, options) => {
    // 只有第一条签名被 CDN 拒（模拟提前失效）
    if (entryStatus === 403 && url === LIVE2_ENTRY(1)) return hls('Forbidden', 403)
    if (entryStatus === 'all') return hls('Forbidden', 403)
    return originalEntry(url, options)
  }
  let clock = 1_790_000_000_000
  const resolver = createResolver({ fetchImpl: upstream.fetchImpl, env: {}, now: () => clock, sessionIdleMs: 0 })
  await resolver.resolve('tianjin-satellite')
  entryStatus = 403
  clock += 1000
  const renewed = await resolver.resolve('tianjin-satellite')
  assert.equal(renewed.url, LIVE2_ENTRY(2))
  assert.equal(upstream.calls.sign, 2)

  entryStatus = 'all'
  clock += FORCE_RESIGN_GAP_MS
  const refused = await resolver.resolve('tianjin-satellite')
  assert.equal(refused.url, '')
  assert.match(refused.desc, /HTTP 403/)
  assert.equal(upstream.calls.sign, 3)
  // 限频窗口内：只取清单、不再重签
  for (let i = 0; i < 5; i++) {
    clock += 100
    assert.equal((await resolver.resolve('tianjin-satellite')).url, '')
  }
  assert.equal(upstream.calls.sign, 3)
})

await checkAsync('签发接口一直失败且没有旧地址：冷却期内直接回错误，不连环打接口', async () => {
  const upstream = fakeUpstream({ sign: async () => json({ code: 400, message: 'bad app id' }) })
  let clock = 1_790_000_000_000
  const resolver = createResolver({ fetchImpl: upstream.fetchImpl, env: {}, now: () => clock, sessionIdleMs: 0 })
  for (let i = 0; i < 5; i++) {
    const result = await resolver.resolve('tianjin-satellite')
    assert.equal(result.url, '')
    assert.match(result.desc, /bad app id/)
    clock += 200
  }
  assert.equal(upstream.calls.sign, 1)
  clock += 5000
  await resolver.resolve('tianjin-satellite')
  assert.equal(upstream.calls.sign, 2)
})

await checkAsync('resolve 绝不抛异常：网络异常、非 JSON、白名单外地址、清单不是 HLS、参数错误都回原因', async () => {
  const cases = [
    [{ pk: async () => { throw new Error('ECONNRESET') } }, /ECONNRESET/],
    [{ pk: async () => new Response('<html>502</html>', { status: 502 }) }, /不是 JSON（HTTP 502）/],
    [{ pk: async () => json({ code: 200, data: 'not a key' }) }, /没有返回公钥/],
    [{ sign: async () => json({ code: 200, data: {} }) }, /没有返回直播地址/],
    [{ sign: async options => json({ code: 200, data: { url: sealUrl('http://evil.test/TJIPTV/x.m3u8', openRequest(options.body).sessionKey) } }) }, /非官方媒体地址/],
    [{ entry: async () => hls('<html>login</html>') }, /不是 HLS/],
    [{ variant: async () => hls('#EXTM3U\n#EXT-X-ENDLIST\n') }, /没有分片/],
    [{ entry: async () => new Response(null, { status: 302, headers: { location: 'http://evil.test/x.m3u8' } }) }, /非官方媒体地址/],
  ]
  for (const [overrides, reason] of cases) {
    const upstream = fakeUpstream(overrides)
    const resolver = createResolver({ fetchImpl: upstream.fetchImpl, env: {}, now: () => 1_790_000_000_000 })
    const result = await resolver.resolve('tianjin-satellite')
    assert.equal(result.url, '', String(reason))
    assert.match(result.desc, reason)
  }
  const resolver = createResolver({ fetchImpl: () => { throw new Error('不应联网') }, env: {} })
  assert.deepEqual(await resolver.resolve('tianjin-unknown'), { url: '', desc: '天津频道引用格式错误' })
  const misconfigured = createResolver({
    fetchImpl: () => { throw new Error('不应联网') },
    env: { TIANJIN_WISE_SK: 'same-value-24-bytes-long', TIANJIN_WISE_3DES_KEY: 'same-value-24-bytes-long' },
  })
  assert.match((await misconfigured.resolve('tianjin-satellite')).desc, /不能与 AK \/ SK 相同/)
})

await checkAsync('clearResolveCache 丢掉签名与公钥，下次重新签发', async () => {
  const upstream = fakeUpstream()
  const resolver = createResolver({ fetchImpl: upstream.fetchImpl, env: {}, now: () => 1_790_000_000_000 })
  await resolver.resolve('tianjin-satellite')
  resolver.clear()
  await resolver.resolve('tianjin-satellite')
  assert.equal(upstream.calls.sign, 2)
  assert.equal(upstream.calls.pk, 2)
})

console.log(`\n全部通过：${passed} ✅`)
