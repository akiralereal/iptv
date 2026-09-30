#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import yangshipin from '../extractors/yangshipin/index.js'
import {
  AUTH_CHANNELS,
  AUTH_CHANNEL_BY_REF,
  CHANNELS,
  CHANNEL_BY_REF,
  buildChannels,
} from '../extractors/yangshipin/channels.js'
import { createCKey } from '../extractors/yangshipin/ckey.js'
import { MANIFEST_TIMEOUT_MS, isOfficialMediaUrl, requestPlayUrls, selectWorkingManifest } from '../extractors/yangshipin/api.js'
import { CACHE_MS, PIN_MARGIN, createResolver, pinSegmentUrls } from '../extractors/yangshipin/resolver.js'
import { FILLER_BODY, FILLER_PATH, libvlcPlaylist } from '../extractors/yangshipin/libvlc-view.js'
import {
  LOGIN_IDENTITY_COOKIES,
  YspBrowserLogin,
  YspBrowserSession,
  browserLoginAvailability,
  parseImportedLoginState,
} from '../extractors/yangshipin/browser-auth.js'
import { claimsLocalPath, handleLocalRequest, runtime } from '../extractors/yangshipin/runtime.js'
import {
  buildFragmentPart,
  createTrackState,
  inspectInitSegment,
  inspectMediaFragment,
  parseSimpleFragment,
  VipMseBridge,
} from '../extractors/yangshipin/vip-bridge.js'
import { getModule, localRequestHandlerFor } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

function fakeInit(timescale = 90_000) {
  const body = Buffer.alloc(32)
  body.write('mdhd', 4)
  body.writeUInt8(0, 8)
  body.writeUInt32BE(timescale, 20)
  body.write('ftyp', 24)
  return body
}

function fakeMedia(sequence, { durationUnits = 90_000, bytes = 48 } = {}) {
  const body = Buffer.alloc(Math.max(48, bytes))
  body.write('mfhd', 4)
  body.writeUInt32BE(sequence, 12)
  body.write('trun', 20)
  body.writeUIntBE(0x100, 25, 3)
  body.writeUInt32BE(1, 28)
  body.writeUInt32BE(durationUnits, 32)
  body.write('moof', 40)
  return body
}

const mseChunk = (mime, body) => ({ mime, base64: body.toString('base64') })

// 与官网 MSE 实际产出同构的单片段 fMP4：moof[mfhd, traf[tfhd, tfdt v1, trun 0xf01, sdtp]] + mdat
function realisticFragment(sequence, { samples = 150, sampleUnits = 3600, baseTime = 900_000, trunVersion = 1 } = {}) {
  const box = (type, ...parts) => {
    const payload = Buffer.concat(parts)
    const header = Buffer.alloc(8)
    header.writeUInt32BE(8 + payload.length, 0)
    header.write(type, 4, 'latin1')
    return Buffer.concat([header, payload])
  }
  const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32BE(value >>> 0, 0); return b }
  const sizes = Array.from({ length: samples }, (_, i) => 20 + (i % 7))
  const data = Buffer.concat(sizes.map((size, i) => Buffer.alloc(size, i % 251)))
  const mfhd = box('mfhd', u32(0), u32(sequence))
  const tfhd = box('tfhd', u32(0), u32(1))
  const tfdtBody = Buffer.alloc(12)
  tfdtBody.writeUInt32BE(0x01000000, 0)
  tfdtBody.writeBigUInt64BE(BigInt(baseTime), 4)
  const tfdt = box('tfdt', tfdtBody)
  const entries = Buffer.concat(sizes.map((size, i) => Buffer.concat([u32(sampleUnits), u32(size), u32(i === 0 ? 0x02000000 : 0x01010000), u32(i % 3 === 0 ? 0 : 3600)])))
  const sdtp = box('sdtp', u32(0), Buffer.from(sizes.map((_, i) => (i === 0 ? 0x20 : 0x10))))
  const trunFor = offset => box('trun', u32((trunVersion << 24) | 0xf01), u32(samples), u32(offset), entries)
  const trafFor = offset => box('traf', tfhd, tfdt, trunFor(offset), sdtp)
  const moofSize = box('moof', mfhd, trafFor(0)).length
  const moof = box('moof', mfhd, trafFor(moofSize + 8))
  return { body: Buffer.concat([moof, box('mdat', data)]), sizes, data, samples, sampleUnits, baseTime }
}
const LIBVLC = 'VLC/4.0.0-dev LibVLC/4.0.0-dev'

console.log('央视频模块测试')

check('固定输出 63 个公开频道 + 10 个会员频道并统一进入央视频分组', () => {
  assert.equal(CHANNELS.length, 63)
  assert.equal(AUTH_CHANNELS.length, 10)
  assert.equal(new Set(CHANNELS.map(channel => channel.id)).size, 63)
  assert.equal(new Set(AUTH_CHANNELS.map(channel => channel.id)).size, 10)
  assert.equal(buildChannels().length, 73)
  assert.equal(yangshipin.name, '央视频')
  assert.equal(yangshipin.category, 'account')
  assert.equal(yangshipin.helper, 'yangshipin-login')
  assert.equal(yangshipin.outputGroupName, '央视频')
  // 分片一旦改回经本机转发，平台会对本机去拉分片回 403（实测 relay/302 可播、proxy 不可播）
  assert.equal(yangshipin.channelHlsMode, 'relay')
  assert.equal(getModule('yangshipin'), yangshipin)
})

check('模块只做直播：能力声明关闭回看，73 条频道逐条标 catchup none（issue #119）', () => {
  // 订阅头全局 catchup="append" 会套到所有未声明的频道上；不逐条标 none，
  // 播放器就会给央视频标出回看入口，点了却只能拿到直播。
  assert.equal(yangshipin.capabilities.catchup, false)
  const channels = buildChannels()
  assert.equal(channels.length, 73)
  assert.ok(channels.every(channel => channel.catchup === 'none'))
  // 频道表字段变化要靠 catalogVersion 递增让存量磁盘缓存在启动时重建
  assert.equal(yangshipin.catalogVersion, 4)
})

check('台标用官网电视页的频道图标，按 livePid 对应；官网没有的国学频道留空', () => {
  const channels = buildChannels()
  const byName = new Map(channels.map(channel => [channel.name, channel.logo]))
  assert.equal(byName.get('CCTV1综合'),
    'https://resources.yangshipin.cn/assets/oms/image/202306/d57905b93540bd15f0c48230dbbbff7ee0d645ff539e38866e2d15c8b9f7dfcd.png')
  assert.match(byName.get('CCTV风云足球'), /^https:\/\/resources\.yangshipin\.cn\/assets\/oms\/image\/\d{6}\/[0-9a-f]{64}\.png$/)
  assert.equal(byName.get('国学频道'), '')
  assert.equal(channels.filter(channel => channel.logo).length, 72)
  // 同一台的高清与 4K 两路官网本来就共用一张图，其余各不相同
  const logos = channels.map(channel => channel.logo).filter(Boolean)
  assert.equal(new Set(logos).size, 71)
  assert.equal(byName.get('CCTV16奥林匹克'), byName.get('CCTV16 4K'))
})

check('引用严格受频道白名单约束', () => {
  assert.equal(yangshipin.claimsRef('ysp-cctv1'), true)
  assert.equal(yangshipin.claimsRef('ysp-cctv18'), false)
  assert.equal(yangshipin.claimsRef('ysp-cctvfyzq'), false, '会员频道不能伪装成匿名引用')
  assert.equal(yangshipin.claimsRef('ysp-vip-cctvfyzq'), true)
  assert.equal(CHANNEL_BY_REF.get('ysp-cctv1').channelId, '2024078201')
  assert.equal(AUTH_CHANNEL_BY_REF.get('ysp-vip-cctvfyzq').livePid, '600099636')
})

check('会员频道本地媒体路由由模块认领，普通路径不误认', () => {
  assert.equal(yangshipin.claimsLocalPath('/ysp-vip-cctvfyzq'), true)
  assert.equal(yangshipin.claimsLocalPath('/ysp-vip/cctvfyzq/video.m3u8'), true)
  assert.equal(yangshipin.claimsLocalPath('/not-ysp-vip/cctvfyzq/video.m3u8'), false)
  assert.equal(typeof yangshipin.handleLocalRequest, 'function')
  assert.equal(typeof yangshipin.browserLoginFlow.start, 'function')
  assert.equal(localRequestHandlerFor('/ysp-vip/cctvfyzq/video.m3u8'), yangshipin)
})

check('自动登录能力会识别无桌面 Linux，macOS 桌面可用', () => {
  assert.equal(browserLoginAvailability({ platform: 'linux', env: {} }).available, false)
  assert.equal(browserLoginAvailability({ platform: 'linux', env: { DISPLAY: ':0' } }).available, true)
  assert.equal(browserLoginAvailability({ platform: 'darwin', env: {} }).available, true)
})

await checkAsync('会话浏览器不让 puppeteer 接管 SIGTERM / SIGINT：docker stop 时由 app.js 正常关闭，cookie 落盘、锁被删掉', async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'ysp-profile-'))
  let seen
  const page = {
    isClosed: () => false,
    setUserAgent: async () => {},
    evaluateOnNewDocument: async () => {},
    setRequestInterception: async () => {},
    on() {},
    url: () => 'https://www.yangshipin.cn/tv/home',
    waitForFunction: async () => {},
  }
  const session = new YspBrowserSession({
    profileDir,
    launchImpl: async opts => { seen = opts; return { connected: true, once() {}, pages: async () => [page] } },
  })
  try {
    await session.ensureBrowserNow({ visible: false })
    assert.equal(seen.launchOptions.userDataDir, profileDir)
    assert.equal(seen.launchOptions.handleSIGTERM, false)
    assert.equal(seen.launchOptions.handleSIGINT, false)
    assert.equal('handleSIGHUP' in seen.launchOptions, false)
  } finally { rmSync(profileDir, { recursive: true, force: true }) }
})

await checkAsync('官网 SDK 校验异常会清掉内存中的旧账号，不继续误报 VIP 有效', async () => {
  const session = new YspBrowserSession({ profileDir: '/tmp/ysp-test-unused' })
  session.browser = { connected: true }
  session.page = {
    isClosed: () => false,
    cookies: async () => { throw new Error('SDK unavailable') },
  }
  session.account = { nickname: '旧状态', vip: true }
  const status = await session.readAccount()
  assert.equal(status.authenticated, false)
  assert.equal(session.account, null)
})

check('导入登录态：认整段 Cookie 头与 JSON，缺会话 cookie 时在解析阶段就说明原因', () => {
  const parsed = parseImportedLoginState(' vusession=abc; ysp_strRefreshtoken=rt-1; guid=g; bad name=x; empty= ')
  assert.deepEqual(parsed.map(c => `${c.name}=${c.value}`), ['vusession=abc', 'ysp_strRefreshtoken=rt-1', 'guid=g'])
  // 直接从请求头复制时常带着 "Cookie:" 前缀
  assert.deepEqual(parseImportedLoginState('Cookie: accesstoken=a; ysp_pc=1').map(c => c.name), ['accesstoken', 'ysp_pc'])
  assert.deepEqual(parseImportedLoginState('{"cookies":{"refreshtoken":"r","ysp_uv":"u"}}').map(c => c.name), ['refreshtoken', 'ysp_uv'])
  assert.deepEqual(parseImportedLoginState('{"vusession":"v"}').map(c => c.name), ['vusession'])

  assert.throws(() => parseImportedLoginState(''), /先粘贴/)
  // 只有 js 可见的 ysp_* 令牌 = 书签工具那种来源，官网必拒：解析阶段就点明缺 HttpOnly 会话 cookie
  assert.throws(() => parseImportedLoginState('ysp_strRefreshtoken=rt; yspopenid=o; endtime=1'), /HttpOnly 会话 cookie/)
  assert.throws(() => parseImportedLoginState('ysp_pc=1; ysp_uv=2'), /会话 cookie/)
  assert.throws(() => parseImportedLoginState('junk without equals'), /没有 cookie/)
  assert.throws(() => parseImportedLoginState('{"cookies":[]}'), /没有 cookie 列表/)
  assert.throws(() => parseImportedLoginState('x'.repeat(70 * 1024)), /过长/)
  assert.deepEqual(LOGIN_IDENTITY_COOKIES, ['vusession', 'accesstoken', 'refreshtoken'])
})

await checkAsync('导入登录态会先清旧 cookie、按 .yangshipin.cn 域种入、重载首页再由 SDK 校验，并回调账号结果', async () => {
  const calls = []
  const seen = []
  const session = new YspBrowserSession({ profileDir: '/tmp/ysp-test-unused', onAccount: status => seen.push(status) })
  let cookiesNow = [{ name: 'vusession', value: 'old', domain: '.yangshipin.cn', path: '/' }, { name: 'ysp_uv', value: 'u', domain: 'www.yangshipin.cn', path: '/' }]
  const page = {
    isClosed: () => false,
    on() {}, off() {},
    url: () => 'https://www.yangshipin.cn/tv/home',
    cookies: async () => cookiesNow,
    deleteCookie: async (...items) => { calls.push(['delete', items.map(i => i.name)]); cookiesNow = [] },
    setCookie: async (...items) => { calls.push(['set', items]); cookiesNow = items.map(i => ({ name: i.name, value: i.value, domain: i.domain, path: i.path })) },
    goto: async url => { calls.push(['goto', url]) },
    waitForFunction: async () => { calls.push(['sdk-ready']) },
    evaluate: async () => ({ nickname: '导入账号', type: 'wechat', vip: true }),
  }
  session.ensureBrowserNow = async ({ visible }) => { calls.push(['browser', visible]); session.browser = { connected: true }; session.page = page; return page }

  const status = await session.importLoginCookies([{ name: 'ysp_strRefreshtoken', value: 'rt' }, { name: 'vusession', value: 'vs' }])
  const flagged = calls.find(c => c[0] === 'set')[1].map(c => [c.name, c.httpOnly])
  assert.deepEqual(flagged, [['ysp_strRefreshtoken', false], ['vusession', true]])
  assert.equal(status.authenticated, true)
  assert.equal(status.account.nickname, '导入账号')
  assert.deepEqual(calls[0], ['browser', false])
  assert.deepEqual(calls[1], ['delete', ['vusession', 'ysp_uv']])
  assert.equal(calls[2][0], 'set')
  assert.deepEqual(calls[2][1].map(c => [c.name, c.value, c.domain, c.path]), [['ysp_strRefreshtoken', 'rt', '.yangshipin.cn', '/'], ['vusession', 'vs', '.yangshipin.cn', '/']])
  assert.ok(calls[2][1].every(c => c.expires > Date.now() / 1000 + 47 * 3600))
  assert.deepEqual(calls[3], ['goto', 'https://www.yangshipin.cn/tv/home'])
  assert.deepEqual(calls[4], ['sdk-ready'])
  assert.deepEqual(seen, [{ authenticated: true, account: { nickname: '导入账号', type: 'wechat', vip: true } }])

  // 官网没认出来：明确回调「未登录」，供 runtime 撤掉保活标记
  page.evaluate = async fn => (String(fn).includes('isSigned') ? false : null)
  const denied = await session.importLoginCookies([{ name: 'vusession', value: 'stale' }])
  assert.equal(denied.authenticated, false)
  assert.deepEqual(seen.at(-1), { authenticated: false, account: null })
  assert.deepEqual(denied.diagnostic.imported, ['vusession'])
  assert.deepEqual(denied.diagnostic.remaining, ['vusession'])
  assert.equal(denied.diagnostic.signed, false)
  assert.deepEqual(denied.diagnostic.api, [])
})

check('libVLC 视图：单片段 fMP4 能在任意样本处拆开，样本、时间戳与字节原样保留', () => {
  for (const trunVersion of [0, 1]) {
    const frag = realisticFragment(9, { trunVersion })
    const parsed = parseSimpleFragment(frag.body)
    assert.ok(parsed, '官网同构的片段要能解析')
    assert.equal(parsed.count, frag.samples)
    assert.equal(parsed.baseTime, frag.baseTime)
    const head = buildFragmentPart(frag.body, parsed, 0, 125, 1)
    const tail = buildFragmentPart(frag.body, parsed, 125, frag.samples, 2)
    const h = parseSimpleFragment(head)
    const t = parseSimpleFragment(tail)
    assert.ok(h && t, '拆出来的两段仍是合法 fMP4')
    assert.equal(h.count + t.count, frag.samples)
    assert.equal(h.baseTime, frag.baseTime)
    assert.equal(t.baseTime, frag.baseTime + 125 * frag.sampleUnits, '尾巴的 tfdt 接在主体后面')
    const dataOf = (buf, p) => buf.subarray(p.dataStart, p.dataStart + p.sizes.reduce((a, b) => a + b, 0))
    assert.ok(Buffer.concat([dataOf(head, h), dataOf(tail, t)]).equals(frag.data), '样本字节拼回去与原片一致')
    assert.equal(h.trunVersion, trunVersion)
    assert.deepEqual(inspectMediaFragment(tail, 90_000), { sequence: 2, duration: (frag.samples - 125) * frag.sampleUnits / 90_000 })
  }
  assert.equal(parseSimpleFragment(fakeMedia(3)), null, '结构不规整的片段不拆')
})

await checkAsync('libVLC 客户端拿到「主体 + 半秒尾巴」清单：1 秒刷新、时长按 6 成声明、冷起垫两个占位；其他客户端清单不变', async () => {
  const channel = AUTH_CHANNELS[5]
  const bridge = new VipMseBridge({})
  const state = {
    channel, page: { isClosed: () => false, close: async () => {} }, streamId: 3, touched: Date.now(), draining: null, ready: null,
    audio: createTrackState(), video: createTrackState(),
  }
  bridge.streams.set(channel.id, state)
  bridge.drain = async () => {}
  try {
    // 每片 150 个样本 × 3600 / 90000 = 6 秒
    const fragments = [realisticFragment(40, { baseTime: 0 }), realisticFragment(41, { baseTime: 540_000 })]
    for (const kind of ['video', 'audio']) {
      bridge.ingestChunks(state, [mseChunk(`${kind}/mp4`, fakeInit()), ...fragments.map(f => mseChunk(`${kind}/mp4`, f.body))])
    }
    const normal = await bridge.playlist(channel, 'video', '/pass', { userAgent: 'AppleCoreMedia/1.0.0' })
    assert.match(normal, /#EXT-X-TARGETDURATION:6\n/)
    assert.equal((normal.match(/#EXTINF/g) || []).length, 2)
    assert.match(normal, /\/40\.m4s\?v=3-0/)
    assert.doesNotMatch(normal, /\/v\d+\.m4s/)

    const vlc = await bridge.playlist(channel, 'video', '/pass', { userAgent: LIBVLC })
    assert.match(vlc, /#EXT-X-TARGETDURATION:1\n/)
    assert.match(vlc, /#EXT-X-MEDIA-SEQUENCE:0\n/)
    assert.doesNotMatch(vlc, /INDEPENDENT-SEGMENTS|EXT-X-START/, '尾巴不从关键帧开始；EXT-X-START 它对直播不认')
    // 实际 5.48 + 0.52 秒，按 6 成声明；最早一片前垫两个 0.1 秒的占位项
    assert.deepEqual([...vlc.matchAll(/#EXTINF:([\d.]+)/g)].map(m => Number(m[1])), [0.1, 0.1, 3.288, 0.312, 3.288, 0.312])
    assert.deepEqual([...vlc.matchAll(/\/(v[a-z]*\d+)\.m4s/g)].map(m => m[1]), ['vpad0', 'vpad1', 'v2', 'v3', 'v4', 'v5'])
    assert.match(vlc, /\/pass\/ysp-vip\/[a-z0-9]+\/video\/v3\.m4s\?v=3-0/)
    assert.equal(bridge.asset(channel, 'video', 'vpad0'), null, '占位项没有内容，请求就 404')

    const tail = bridge.asset(channel, 'video', 'v3')
    const parsedTail = parseSimpleFragment(tail)
    assert.equal(parsedTail.count, 13)
    assert.equal(parsedTail.baseTime, 137 * 3600)
    assert.ok(bridge.asset(channel, 'video', 'v3').equals(tail), '每次现拼，内容一致')
    assert.equal(bridge.asset(channel, 'video', 'v9'), null)
    assert.ok(bridge.asset(channel, 'video', '41').equals(fragments[1].body), '普通视图照旧给原片')

    // 最早一片滑出窗口后占位项随之消失，序号照常连续
    state.video.segments.delete(Math.min(...state.video.segments.keys()))
    const slid = await bridge.playlist(channel, 'video', '', { userAgent: LIBVLC })
    assert.match(slid, /#EXT-X-MEDIA-SEQUENCE:4\n/)
    assert.doesNotMatch(slid, /vpad/)
  } finally {
    await bridge.close()
  }
})

check('官网桥接 fMP4 能解析时标、序号和精确时长', () => {
  const init = fakeInit()
  assert.deepEqual(inspectInitSegment(init), { timescale: 90_000 })

  const media = fakeMedia(17, { durationUnits: 450_000 })
  assert.deepEqual(inspectMediaFragment(media, 90_000), { sequence: 17, duration: 5 })
})

await checkAsync('官网续票重发 init / 序号归零会切换 epoch，不混用旧片段', async () => {
  const channel = AUTH_CHANNELS[0]
  const page = { isClosed: () => false, evaluate: async () => [], close: async () => {} }
  const bridge = new VipMseBridge({}, { maxSegmentBytes: 1024, maxTrackBytes: 4096 })
  const state = {
    channel, page, streamId: 7, touched: Date.now(), draining: null, ready: null,
    audio: createTrackState(), video: createTrackState(),
  }
  bridge.streams.set(channel.id, state)
  try {
    bridge.ingestChunks(state, [
      mseChunk('video/mp4', fakeInit()),
      mseChunk('video/mp4', fakeMedia(100)),
      mseChunk('video/mp4', fakeMedia(101)),
    ])
    assert.deepEqual([...state.video.segments.keys()], [100, 101])

    bridge.ingestChunks(state, [
      mseChunk('video/mp4', fakeInit()),
      mseChunk('video/mp4', fakeMedia(1)),
    ])
    assert.equal(state.video.epoch, 1)
    assert.deepEqual([...state.video.segments.keys()], [102], '对外序号须单调递增，不能跟官网一起归零')
    assert.equal(state.video.segments.get(102).sourceSequence, 1)
    const playlist = await bridge.playlist(channel, 'video', '/pass')
    assert.match(playlist, /#EXT-X-START:TIME-OFFSET=-25,PRECISE=NO\n/, '让播放器从直播边缘往回 25 秒起播')
    assert.match(playlist, /#EXT-X-DISCONTINUITY/)
    assert.match(playlist, /init\.mp4\?v=7-1/)
    assert.match(playlist, /102\.m4s\?v=7-1/)
    assert.doesNotMatch(playlist, /100\.m4s/)
  } finally {
    await bridge.close()
  }
})

await checkAsync('会员桥限制异常单片与每轨总字节，避免高码率页面耗尽内存', async () => {
  const channel = AUTH_CHANNELS[1]
  const bridge = new VipMseBridge({}, { maxSegmentBytes: 100, maxTrackBytes: 160 })
  const state = {
    channel, streamId: 8, audio: createTrackState(), video: createTrackState(),
  }
  try {
    bridge.ingestChunks(state, [mseChunk('video/mp4', fakeInit())])
    for (const sequence of [1, 2, 3]) {
      bridge.ingestChunks(state, [mseChunk('video/mp4', fakeMedia(sequence, { bytes: 80 }))])
    }
    assert.deepEqual([...state.video.segments.keys()], [2, 3])
    assert.equal(state.video.segmentBytes, 160)
    bridge.ingestChunks(state, [mseChunk('video/mp4', fakeMedia(4, { bytes: 120 }))])
    assert.deepEqual([...state.video.segments.keys()], [2, 3], '超出单片上限的块必须丢弃')
  } finally {
    await bridge.close()
  }
})

await checkAsync('登录切换会先等待在飞桥接任务收口，再关闭页面', async () => {
  let finishTask
  let closed = false
  const pending = new Promise(resolve => { finishTask = resolve })
  const page = { close: async () => { closed = true } }
  const bridge = new VipMseBridge({}, { quiesceTimeoutMs: 500 })
  bridge.pages.add(page)
  bridge.trackTask(pending)
  const suspending = bridge.suspend()
  await Promise.resolve()
  assert.equal(closed, false)
  finishTask()
  await suspending
  assert.equal(closed, true)
  await bridge.close()
})

function fakeBridgeBrowser(page) {
  return {
    running: true,
    visible: false,
    browser: { newPage: async () => page },
    ensureBrowser: async () => {},
    readAccount: async () => ({ authenticated: true, account: { nickname: '测试', vip: true } }),
    close: async () => {},
  }
}

// feed(): 每次 drain 从页面取回的一批 MSE 块
function fakeBridgePage(feed) {
  return {
    isClosed: () => false,
    close: async () => {},
    on() {},
    setUserAgent: async () => {},
    evaluateOnNewDocument: async () => {},
    goto: async () => {},
    waitForFunction: async () => {},
    evaluate: async (fn, arg) => {
      if (typeof fn === 'function' && fn.name === 'base64DrainScript') return feed()
      if (arg !== undefined) return true   // 点台
      if (String(fn).includes('__yspHlsInstances')) return '已催官网播放器重拉清单（1/1 个实例）'
      if (String(fn).includes('buffered')) return { currentTime: 11, bufferedEnd: 17, ahead: 6, paused: false, readyState: 4 }
      return undefined   // 清空缓冲无返回
    },
  }
}

await checkAsync('解扰桥先攒齐音视频各三片再就绪，并打一行带各阶段耗时的日志', async () => {
  const channel = AUTH_CHANNELS[0]
  const logs = []
  let drains = 0
  const page = fakeBridgePage(() => {
    drains++
    if (drains === 1) {
      return [
        mseChunk('audio/mp4', fakeInit()), mseChunk('video/mp4', fakeInit()),
        mseChunk('audio/mp4', fakeMedia(0)), mseChunk('video/mp4', fakeMedia(0)),
      ]
    }
    if (drains <= 3) return [mseChunk('audio/mp4', fakeMedia(drains - 1)), mseChunk('video/mp4', fakeMedia(drains - 1))]
    return []
  })
  // 伪分片每片 1 秒，门槛按 3 秒算，等价于真实的「三片凑够 20 秒」
  const bridge = new VipMseBridge(fakeBridgeBrowser(page), { logger: line => logs.push(line), readyMinMediaS: 3 })
  try {
    const state = await bridge.ensure(channel)
    assert.equal(state.audio.segments.size, 3)
    assert.equal(state.video.segments.size, 3)
    const ready = logs.find(line => line.includes('解扰桥就绪'))
    assert.ok(ready, logs.join('\n'))
    assert.match(ready, /共 \d+\.\d 秒（排队 \d+\.\d · 浏览器与页面 \d+\.\d · 首片 \d+\.\d · 补片 \d+\.\d）/)
    assert.match(ready, /音 3 片 \/ 视 3 片共 3\.0 秒，分片约 1\.0 秒/)
    assert.match(ready, /已催官网播放器重拉清单（1\/1 个实例）；官网播放器 位置 11s \/ 缓冲至 17s（超前 6s）/)
    assert.ok(state.kickTimer, '就绪后开始定时催官网播放器重拉清单')
    assert.doesNotMatch(ready, /未补满/)
    const playlist = await bridge.playlist(channel, 'video')
    assert.equal((playlist.match(/#EXTINF/g) || []).length, 3, '首份清单就带三片')
  } finally {
    await bridge.close()
  }
})

await checkAsync('三片但媒体时长不够 20 秒时继续等，凑够才就绪', async () => {
  const channel = AUTH_CHANNELS[3]
  const logs = []
  let drains = 0
  // 每片 1 秒：前 3 次各来一片（3 秒，不够），之后每次一片，凑到 5 秒才算够
  const page = fakeBridgePage(() => {
    drains++
    if (drains === 1) return [mseChunk('audio/mp4', fakeInit()), mseChunk('video/mp4', fakeInit()), mseChunk('audio/mp4', fakeMedia(0)), mseChunk('video/mp4', fakeMedia(0))]
    if (drains <= 5) return [mseChunk('audio/mp4', fakeMedia(drains - 1)), mseChunk('video/mp4', fakeMedia(drains - 1))]
    return []
  })
  const bridge = new VipMseBridge(fakeBridgeBrowser(page), { logger: line => logs.push(line), readyMinMediaS: 5, readyMediaWaitMs: 5_000 })
  try {
    const state = await bridge.ensure(channel)
    assert.equal(state.video.segments.size, 5, '三片到手后还得等到累计 5 秒')
    assert.match(logs.find(line => line.includes('解扰桥就绪')), /视 5 片共 5\.0 秒/)
  } finally {
    await bridge.close()
  }
})

await checkAsync('三片到手后凑时长最多等 readyMediaWaitMs，超时就先交清单', async () => {
  const channel = AUTH_CHANNELS[4]
  const logs = []
  let drains = 0
  const page = fakeBridgePage(() => {
    drains++
    if (drains === 1) return [mseChunk('audio/mp4', fakeInit()), mseChunk('video/mp4', fakeInit()), mseChunk('audio/mp4', fakeMedia(0)), mseChunk('video/mp4', fakeMedia(0))]
    if (drains <= 3) return [mseChunk('audio/mp4', fakeMedia(drains - 1)), mseChunk('video/mp4', fakeMedia(drains - 1))]
    return []
  })
  const bridge = new VipMseBridge(fakeBridgeBrowser(page), { logger: line => logs.push(line), readyMinMediaS: 20, readyMediaWaitMs: 700 })
  const startedAt = Date.now()
  try {
    const state = await bridge.ensure(channel)
    assert.equal(state.video.segments.size, 3)
    assert.ok(Date.now() - startedAt < 3_000, '不能等到 10 秒的总上限才放行')
    assert.match(logs.find(line => line.includes('解扰桥就绪')), /视 3 片共 3\.0 秒，分片约 1\.0 秒/)
    assert.doesNotMatch(logs.find(line => line.includes('解扰桥就绪')), /未凑够/, '按等待上限放行不算「未凑够」')
  } finally {
    await bridge.close()
  }
})

await checkAsync('首片之后补不满三片，超过补片窗口就先交清单，日志注明未凑够', async () => {
  const channel = AUTH_CHANNELS[1]
  const logs = []
  let drains = 0
  const page = fakeBridgePage(() => (++drains === 1
    ? [
        mseChunk('audio/mp4', fakeInit()), mseChunk('video/mp4', fakeInit()),
        mseChunk('audio/mp4', fakeMedia(5)), mseChunk('video/mp4', fakeMedia(5)),
      ]
    : []))
  const bridge = new VipMseBridge(fakeBridgeBrowser(page), { logger: line => logs.push(line), readyTopUpMs: 800 })
  const startedAt = Date.now()
  try {
    const state = await bridge.ensure(channel)
    assert.ok(Date.now() - startedAt >= 800, '首片后要等满补片窗口')
    assert.equal(state.video.segments.size, 1)
    assert.match(logs.find(line => line.includes('解扰桥就绪')), /音 1 片 \/ 视 1 片共 1\.0 秒（未凑够，先交清单）/)
  } finally {
    await bridge.close()
  }
})

await checkAsync('会员页与后台浏览器都改为 3 分钟无人请求才释放', async () => {
  const channel = AUTH_CHANNELS[2]
  let closedPages = 0
  let browserClosed = false
  const session = { running: true, visible: false, close: async () => { browserClosed = true } }
  const bridge = new VipMseBridge(session)
  const tick = () => new Promise(resolve => setImmediate(resolve))
  try {
    assert.equal(bridge.streamIdleTtlMs, 180_000)
    assert.equal(bridge.browserIdleTtlMs, 180_000)
    const page = { isClosed: () => false, close: async () => { closedPages++ } }
    bridge.streams.set(channel.id, {
      channel, page, touched: Date.now() - 120_000, audio: createTrackState(), video: createTrackState(),
    })
    bridge.lastActivity = Date.now() - 120_000
    bridge.cleanup()
    await tick()
    assert.equal(closedPages, 0, '两分钟没人请求还不能释放')
    assert.equal(browserClosed, false)
    bridge.streams.get(channel.id).touched = Date.now() - 200_000
    bridge.cleanup()
    await tick()
    assert.equal(closedPages, 1)
    assert.equal(browserClosed, false, '页面刚释放、最近仍有活动时浏览器先留着')
    bridge.lastActivity = Date.now() - 200_000
    bridge.cleanup()
    await tick()
    assert.equal(browserClosed, true)
  } finally {
    await bridge.close()
  }
})

await checkAsync('会员 master 保留用户鉴权前缀，HEAD 不启动浏览器且不虚报过期片段', async () => {
  const master = await handleLocalRequest({
    path: '/ysp-vip-cctvsjdl', method: 'GET', accessPrefix: '/u/test_token_123',
  })
  assert.equal(master.status, 200)
  assert.match(master.body, /\/u\/test_token_123\/ysp-vip\/cctvsjdl\/audio\.m3u8/)
  assert.match(master.body, /CODECS="avc1\.640029,mp4a\.40\.2"/)
  const head = await handleLocalRequest({ path: '/ysp-vip/cctvsjdl/video/7.m4s', method: 'HEAD' })
  assert.equal(head.status, 404)
  assert.equal(runtime.browserSession.running, false)
})

await checkAsync('会员 fMP4 片段支持 Range，过期片段明确 404', async () => {
  const channel = AUTH_CHANNELS[0]
  const body = Buffer.from('0123456789')
  runtime.vipBridge.streams.set(channel.id, {
    channel,
    page: { isClosed: () => false, close: async () => {} },
    touched: Date.now(),
    audio: { init: body, timescale: 1, segments: new Map(), lastChunkAt: Date.now() },
    video: { init: body, timescale: 1, segments: new Map([[7, { sequence: 7, duration: 1, body }]]), lastChunkAt: Date.now() },
  })
  try {
    const ranged = await handleLocalRequest({
      path: `/ysp-vip/${channel.id}/video/7.m4s`, method: 'GET', headers: { range: 'bytes=2-5' },
    })
    assert.equal(ranged.status, 206)
    assert.equal(ranged.body.toString(), '2345')
    assert.equal(ranged.headers['Content-Range'], 'bytes 2-5/10')
    const head = await handleLocalRequest({
      path: `/ysp-vip/${channel.id}/video/7.m4s`, method: 'HEAD', headers: { range: 'bytes=2-5' },
    })
    assert.equal(head.status, 206)
    assert.equal(head.body, '')
    assert.equal(head.headers['Content-Length'], 4)
    assert.equal(head.headers['Content-Range'], 'bytes 2-5/10')
    const missing = await handleLocalRequest({ path: `/ysp-vip/${channel.id}/video/8.m4s`, method: 'GET' })
    assert.equal(missing.status, 404)
  } finally {
    runtime.vipBridge.streams.delete(channel.id)
  }
})

await checkAsync('自动登录状态机只启动一轮并在识别后恢复后台会话', async () => {
  const calls = []
  const account = { nickname: '测试账号', vip: true }
  let reads = 0
  const browserSession = {
    visible: false,
    async readAccount() {
      reads++
      return reads === 1
        ? { running: true, visible: false, authenticated: false, account: null }
        : { running: true, visible: reads === 2, authenticated: true, account }
    },
    async openLogin() { this.visible = true; calls.push('open'); return { authenticated: false, account: null } },
    async close() { this.visible = false; calls.push('close') },
  }
  const login = new YspBrowserLogin(browserSession, {
    beforeOpen: async () => calls.push('suspend'),
    restore: async () => calls.push('restore'),
    pollMs: 0,
    timeoutMs: 100,
    sleepImpl: async () => {},
  })
  const first = login.start()
  const duplicate = login.start()
  assert.equal(first.status, 'opening')
  assert.equal(duplicate.status, 'opening')
  await login.task
  assert.deepEqual(calls, ['suspend', 'open', 'close', 'restore'])
  assert.equal(login.status().status, 'success')
  assert.equal(login.status().account.nickname, '测试账号')
  assert.ok(Number.isFinite(login.status().lastVerifiedAt))
})

check('清晰度档逐频道固定，默认 fhd，剧场频道只认 shd', () => {
  assert.equal(CHANNEL_BY_REF.get('ysp-cctv1').defn, 'fhd')
  assert.equal(CHANNEL_BY_REF.get('ysp-cctvdyjc').defn, 'shd')
  assert.equal(CHANNELS.filter(channel => channel.defn === 'shd').length, 3)
  assert.ok(CHANNELS.every(channel => ['fhd', 'shd'].includes(channel.defn)))
})

check('客户端票据具有固定版本前缀，且同一输入仍含随机会话材料', () => {
  const a = createCKey('2024078201', { now: 1_700_000_000_000 })
  const b = createCKey('2024078201', { now: 1_700_000_000_000 })
  assert.match(a.cKey, /^--01[A-Za-z0-9_-]+$/)
  assert.equal(a.timestamp, 1_700_000_000)
  assert.equal(a.guid.length, 32)
  assert.notEqual(a.cKey, b.cKey)
})

check('只接受央视频/CCTV 官方 HTTPS 媒体域名', () => {
  assert.equal(isOfficialMediaUrl('https://hlslive-tx-cdn.ysp.cctv.cn/a.m3u8'), true)
  assert.equal(isOfficialMediaUrl('http://hlslive-tx-cdn.ysp.cctv.cn/a.m3u8'), false)
  assert.equal(isOfficialMediaUrl('https://ysp.cctv.cn.evil.example/a.m3u8'), false)
  assert.equal(isOfficialMediaUrl('https://evil.example/a.m3u8'), false)
})

await checkAsync('频道自带的清晰度档进入请求，且只接受官方域名的播放地址', async () => {
  const seen = []
  const fetchImpl = async url => {
    seen.push(new URL(url).searchParams.get('defn'))
    return new Response(JSON.stringify({
      iretcode: 0,
      playurl: 'https://hlslive-tx-cdn.ysp.cctv.cn/a.m3u8',
      backurl_list: ['https://evil.example/a.m3u8'],
    }), { status: 200 })
  }
  const { urls } = await requestPlayUrls(CHANNEL_BY_REF.get('ysp-cctvdyjc'), { fetchImpl })
  assert.deepEqual(seen, ['shd'])
  assert.deepEqual(urls, ['https://hlslive-tx-cdn.ysp.cctv.cn/a.m3u8'], '备用地址里的非官方域名必须被丢弃')
  await requestPlayUrls(CHANNEL_BY_REF.get('ysp-cctv1'), { fetchImpl })
  assert.deepEqual(seen, ['shd', 'fhd'])
})

await checkAsync('主 CDN 清单失败后切换备用 CDN，拍平成媒体清单，且全程不试拉分片', async () => {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push(String(url))
    if (String(url).includes('bad.ysp')) return new Response('denied', { status: 403 })
    if (String(url).endsWith('/master.m3u8')) return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia.m3u8\n', { status: 200 })
    if (String(url).endsWith('/media.m3u8')) return new Response('#EXTM3U\n#EXTINF:6,\npart.ts\n', { status: 200 })
    if (String(url).endsWith('/part.ts')) return new Response(Buffer.from([0x47, 0x40, 0x00, 0x10]), { status: 206 })
    return new Response('', { status: 404 })
  }
  const result = await selectWorkingManifest([
    'https://bad.ysp.cctv.cn/live.m3u8',
    'https://good.ysp.cctv.cn/master.m3u8',
  ], { fetchImpl })
  assert.equal(result.url, 'https://good.ysp.cctv.cn/media.m3u8')
  assert.equal(result.sourceUrl, 'https://good.ysp.cctv.cn/master.m3u8', '保留可重新调度的官方入口')
  assert.match(result.text, /part\.ts/)
  // 官方 CDN 对短间隔重复请求回 403：换票时补这一枪分片会在 CDN 正常时把主备全判死。
  assert.equal(calls.some(url => url.endsWith('/part.ts')), false, '选 CDN 阶段不得试拉分片')
})

await checkAsync('入口挂住不回应时 3 秒就换备用入口，不让播放器干等', async () => {
  assert.equal(MANIFEST_TIMEOUT_MS, 3000)
  const fetchImpl = (url, { signal } = {}) => String(url).includes('hang.ysp')
    ? new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
    : Promise.resolve(new Response('#EXTM3U\n#EXTINF:5,\npart.ts\n', { status: 200 }))
  const started = Date.now()
  const result = await selectWorkingManifest(['https://hang.ysp.cctv.cn/live.m3u8', 'https://good.ysp.cctv.cn/live.m3u8'], { fetchImpl, timeoutMs: 50 })
  assert.equal(result.sourceUrl, 'https://good.ysp.cctv.cn/live.m3u8')
  assert.ok(Date.now() - started < 1000)
  await selectWorkingManifest(['https://hang.ysp.cctv.cn/live.m3u8'], { fetchImpl, timeoutMs: 50 }).then(
    () => { throw new Error('全部挂住不应成功') },
    error => { assert.match(error.message, /超时/); assert.equal(error.allForbidden, false, '超时不算限流') },
  )
})

await checkAsync('清单能取回但没有分片条目的 CDN 视为不可用', () => selectWorkingManifest(
  ['https://empty.ysp.cctv.cn/live.m3u8'],
  { fetchImpl: async () => new Response('#EXTM3U\n#EXT-X-ENDLIST\n', { status: 200 }) },
).then(
  () => { throw new Error('空清单不应通过') },
  error => assert.match(error.message, /主、备用 CDN 均不可用/),
))

await checkAsync('同频道并发解析只取一次票，TTL 到期后自动换票', async () => {
  let requests = 0
  const resolver = createResolver({
    request: async () => { requests++; return { urls: ['https://good.ysp.cctv.cn/live.m3u8'] } },
    select: async () => ({ text: '#EXTM3U\n#EXTINF:6,\na.ts\n', url: 'https://good.ysp.cctv.cn/live.m3u8' }),
  })
  const [a, b] = await Promise.all([
    resolver.resolve('ysp-cctv1', { now: 0 }),
    resolver.resolve('ysp-cctv1', { now: 0 }),
  ])
  assert.equal(requests, 1)
  assert.equal(a.url, b.url)
  assert.match(a.desc, /H\.264/)
  await resolver.resolve('ysp-cctv1', { now: CACHE_MS })
  assert.equal(requests, 2)
})

await checkAsync('每次解析返回新清单，正文不随 5 分钟取票缓存复用，代理层无需重复请求', async () => {
  // 直播清单每 3 秒滚动一次，缓存正文会让播放器在整个 TTL 内反复拿到同一批分片而卡死。
  let requests = 0
  let selects = 0
  const resolver = createResolver({
    request: async () => { requests++; return { urls: ['https://good.ysp.cctv.cn/live.m3u8'] } },
    select: async () => ({ text: `#EXTM3U\n#EXTINF:6,\npart-${++selects}.ts\n`, url: 'https://good.ysp.cctv.cn/live.m3u8' }),
  })
  const result = await resolver.resolve('ysp-cctv1', { now: 0 })
  assert.equal(result.url, 'https://good.ysp.cctv.cn/live.m3u8')
  assert.match(result.manifestText, /part-1\.ts/)
  assert.equal(result.manifestUrl, result.url)
  assert.equal(result.upstreamHeaders?.Referer, 'https://live.cctv.cn/')
  const next = await resolver.resolve('ysp-cctv1', { now: 6000 })
  assert.match(next.manifestText, /part-2\.ts/, '轮询必须拿到滚动后的分片')
  assert.equal(requests, 1, '清单实时刷新不能导致每次都重新取票')
  assert.equal(selects, 2)
  const cached = [...resolver.cache.values()]
  assert.ok(cached.every(entry => !('manifest' in entry) && !('text' in entry) && !('manifestText' in entry)), '缓存条目里不得留存清单正文')
})

await checkAsync('缓存主线失效时可换备用入口，不复用重定向后的临时媒体地址', async () => {
  const urls = ['https://main.ysp.cctv.cn/live.m3u8', 'https://backup.ysp.cctv.cn/live.m3u8']
  let requests = 0
  let selects = 0
  const resolver = createResolver({
    request: async () => { requests++; return { urls } },
    select: async candidates => {
      selects++
      assert.equal(candidates.includes('https://temporary.ysp.cctv.cn/media.m3u8'), false)
      assert.equal(candidates.length, 2)
      if (selects === 3) assert.equal(candidates[0], urls[1], '上次成功的备用入口优先')
      return {
        url: 'https://temporary.ysp.cctv.cn/media.m3u8',
        sourceUrl: urls[selects === 1 ? 0 : 1],
        text: `#EXTM3U\n#EXTINF:6,\npart-${selects}.ts\n`,
      }
    },
  })
  await resolver.resolve('ysp-cctv2', { now: 0 })
  const recovered = await resolver.resolve('ysp-cctv2', { now: 6000 })
  assert.match(recovered.manifestText, /part-2/)
  await resolver.resolve('ysp-cctv2', { now: 12000 })
  assert.equal(requests, 1, '备用可用时不必重新取票')
})

await checkAsync('缓存主备全部 403 时提前换票，同频道并发恢复只换一次', async () => {
  let requests = 0
  let oldCalls = 0
  const resolver = createResolver({
    request: async () => ({ urls: [`https://good.ysp.cctv.cn/ticket-${++requests}.m3u8`] }),
    select: async urls => {
      if (urls[0].includes('ticket-1') && ++oldCalls > 1) throw new Error('清单 HTTP 403')
      return { url: urls[0], text: '#EXTM3U\n#EXTINF:6,\npart.ts\n' }
    },
  })
  await resolver.resolve('ysp-cctv2', { now: 0 })
  const results = await Promise.all([
    resolver.resolve('ysp-cctv2', { now: 6000 }),
    resolver.resolve('ysp-cctv2', { now: 6000 }),
  ])
  assert.equal(requests, 2)
  assert.ok(results.every(result => result.url.endsWith('/ticket-2.m3u8')))
})

await checkAsync('CCTV1 切换 CCTV2 时两台缓存独立，切回也读取最新清单', async () => {
  const requests = []
  let selects = 0
  const resolver = createResolver({
    request: async channel => { requests.push(channel.id); return { urls: [`https://good.ysp.cctv.cn/${channel.id}.m3u8`] } },
    select: async urls => ({ url: urls[0], text: `#EXTM3U\n#EXTINF:6,\npart-${++selects}.ts\n` }),
  })
  for (const [i, ref] of ['ysp-cctv1', 'ysp-cctv2', 'ysp-cctv1'].entries()) {
    const result = await resolver.resolve(ref, { now: i * 6000 })
    assert.ok(result.url.endsWith(`/${ref.slice(4)}.m3u8`))
    assert.match(result.manifestText, new RegExp(`part-${i + 1}\\.ts`))
  }
  assert.deepEqual(requests, ['cctv1', 'cctv2'])
})

await checkAsync('同一序号换了主机或令牌仍下发第一次的地址，新序号才用新地址（issue #142 / #143）', async () => {
  // hls.js 与 AVPlayer 都逐片比对新旧清单，同一序号地址变了就不再接纳新清单，十几秒后卡住
  const playlist = (seq, host, token) => [
    '#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-MEDIA-SEQUENCE:${seq}`, '#EXT-X-TARGETDURATION:5',
    ...[0, 1, 2].flatMap(i => ['#EXTINF:5.000,', `https://${host}.ysp.cctv.cn/${token}/2024078203-${seq + i}.ts`]),
  ].join('\n') + '\n'
  const bodies = {
    'ysp-cctv1': [playlist(100, 'hlslive-tx-3-cdn', 'T1'), playlist(101, 'bktlivecloud-cdn', 'T1'), playlist(102, 'live-dtocnc-cdn', 'T2')],
    'ysp-cctv2': [playlist(101, 'hlslive-tx-5-cdn', 'T9')],
  }
  let ref = 'ysp-cctv1'
  const resolver = createResolver({
    request: async () => ({ urls: ['https://entry.ysp.cctv.cn/live.m3u8'] }),
    select: async () => ({ url: 'https://entry.ysp.cctv.cn/live.m3u8', text: bodies[ref].shift() }),
  })
  const segments = result => result.manifestText.split('\n').filter(line => line && !line.startsWith('#'))
  const a = segments(await resolver.resolve(ref, { now: 0 }))
  const b = segments(await resolver.resolve(ref, { now: 5000 }))
  const c = segments(await resolver.resolve(ref, { now: 10000 }))
  assert.deepEqual(b.slice(0, 2), a.slice(1), '换主机后已下发过的序号地址不变')
  assert.equal(b[2], 'https://bktlivecloud-cdn.ysp.cctv.cn/T1/2024078203-103.ts')
  assert.deepEqual(c.slice(0, 2), b.slice(1), '换票（令牌变了）后同样沿用')
  assert.equal(c[2], 'https://live-dtocnc-cdn.ysp.cctv.cn/T2/2024078203-104.ts')
  ref = 'ysp-cctv2'
  const other = segments(await resolver.resolve(ref, { now: 15000 }))
  assert.equal(other[0], 'https://hlslive-tx-5-cdn.ysp.cctv.cn/T9/2024078203-101.ts', '各频道分开记，不串台')
  resolver.clear()
  assert.equal(resolver.pins.size, 0)
})

check('分片地址固定：相对地址补全、文件名变了用新地址、窗口外记录剪掉', () => {
  const base = 'https://a.ysp.cctv.cn/tok/live.m3u8'
  const one = (seq, uri) => `#EXTM3U\r\n#EXT-X-MEDIA-SEQUENCE:${seq}\r\n#EXTINF:5,\r\n${uri}\r\n`
  assert.equal(pinSegmentUrls(one(7, 'seg-7.ts'), base, new Map()),
    '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:7\n#EXTINF:5,\nhttps://a.ysp.cctv.cn/tok/seg-7.ts\n')
  const pins = new Map()
  pinSegmentUrls(one(5, 'https://a.ysp.cctv.cn/t/s1-5.ts'), base, pins)
  assert.match(pinSegmentUrls(one(5, 'https://b.ysp.cctv.cn/t/s1-5.ts'), base, pins), /\/\/a\.ysp\.cctv\.cn\/t\/s1-5\.ts/)
  assert.match(pinSegmentUrls(one(5, 'https://b.ysp.cctv.cn/t/s2-5.ts'), base, pins), /\/\/b\.ysp\.cctv\.cn\/t\/s2-5\.ts/, '换了一路流以新地址为准')
  pinSegmentUrls(one(5 + PIN_MARGIN + 10, 'https://b.ysp.cctv.cn/t/s2-45.ts'), base, pins)
  assert.deepEqual([...pins.keys()], [5 + PIN_MARGIN + 10], '窗口远去后旧序号剪掉')
  pinSegmentUrls(one(1, 'https://b.ysp.cctv.cn/t/s3-1.ts'), base, pins)
  assert.deepEqual([...pins.keys()], [1], '序号重置后不留高位旧记录')
})

check('libVLC 视图：整片后面跟垫片、最后一项是垫片、刷新间隔最多 5 秒、声明时长总和不变', () => {
  const upstream = (seq, td, durations) => [
    '#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-MEDIA-SEQUENCE:${seq}`, `#EXT-X-TARGETDURATION:${td}`,
    ...durations.flatMap((duration, i) => [
      '#EXT-QQHLS-MACHINEID:11111', `#EXT-X-PROGRAM-DATE-TIME:2026-09-27T15:28:0${i}+08:00`,
      `#EXTINF:${duration.toFixed(3)},`, `https://a.ysp.cctv.cn/T/2024078203-${seq + i}.ts`,
    ]),
  ].join('\n') + '\n'
  const pad = 'http://192.168.1.2:1905/ysp-pad.ts'
  const entries = text => {
    const lines = text.trim().split('\n')
    const first = Number(text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)[1])
    return lines.flatMap((line, i) => line.startsWith('#') ? [] : [{ url: line, duration: Number(lines[i - 1].slice(8, -1)) }])
      .map((entry, i) => ({ ...entry, index: first + i }))
  }
  const text = libvlcPlaylist(upstream(100, 9, [8.88, 4.2, 5]), pad)
  assert.match(text, /^#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-MEDIA-SEQUENCE:198\n#EXT-X-TARGETDURATION:5\n/)
  assert.equal(/PROGRAM-DATE-TIME|QQHLS/.test(text), false, '上游的附加标签不带过去')
  const list = entries(text)
  assert.deepEqual(list.map(entry => entry.url === pad ? 'pad' : entry.url.match(/-(\d+)\.ts/)[1]),
    ['pad', 'pad', '100', 'pad', '101', 'pad', '102', 'pad'])
  assert.deepEqual(list.filter(entry => entry.url !== pad).map(entry => entry.index), [200, 202, 204], '第 n 片固定排在 2n')
  // TS 上声明时长不准会让 libVLC 在分片边界重新对时间线，所以整片 + 垫片必须正好等于上游时长
  const real = list.slice(2)
  assert.equal(Number(real.reduce((sum, entry) => sum + entry.duration, 0).toFixed(3)), 18.08)
  assert.deepEqual(real.filter(entry => entry.url !== pad).map(entry => entry.duration), [8.87, 4.19, 4.99])

  // 窗口往前滚一片：已经下发过的片序号不变，新片接在后面
  const next = entries(libvlcPlaylist(upstream(101, 5, [4.2, 5, 5]), pad))
  assert.deepEqual(next.filter(entry => entry.url !== pad).map(entry => entry.index), [202, 204, 206])
  assert.equal(next.at(-1).url, pad)
  assert.equal(next.at(-1).index, 207)
  assert.match(libvlcPlaylist(upstream(101, 5, [4.2, 5, 5]), pad), /#EXT-X-TARGETDURATION:5\n/)
  assert.match(libvlcPlaylist(upstream(101, 4, [4, 4, 4]), pad), /#EXT-X-TARGETDURATION:4\n/, '上游更短时不改')
})

check('libVLC 视图：改写不了的清单回 null，调用方下发原样', () => {
  const pad = 'http://h/ysp-pad.ts'
  const base = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:7\n#EXT-X-TARGETDURATION:5\n'
  assert.equal(libvlcPlaylist(`${base}#EXTINF:5,\nhttps://a.ysp.cctv.cn/T/s-7.ts\n`, ''), null, '没有垫片地址')
  assert.equal(libvlcPlaylist(base, pad), null, '没有分片')
  assert.equal(libvlcPlaylist(`${base}#EXTINF:5,\nhttps://a.ysp.cctv.cn/T/s-7.m4s\n`, pad), null, '不是 TS')
  assert.equal(libvlcPlaylist(`${base}#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:5,\nhttps://a.ysp.cctv.cn/T/s-7.ts\n`, pad), null, '加密')
  assert.equal(libvlcPlaylist(`${base}#EXTINF:5,\nhttps://a.ysp.cctv.cn/T/s-7.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:5,\nhttps://a.ysp.cctv.cn/T/s-8.ts\n`, pad), null, '有断点')
  assert.equal(libvlcPlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia.m3u8\n', pad), null, '主清单')
  assert.equal(libvlcPlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5,\nhttps://a.ysp.cctv.cn/T/s-7.ts\n', pad), null, '没有序号')
  assert.match(libvlcPlaylist(`${base}#EXTINF:5,\r\nhttps://a.ysp.cctv.cn/T/s-7.ts?x=1\r\n`, pad), /s-7\.ts\?x=1\n#EXTINF:0\.010,\nhttp:\/\/h\/ysp-pad\.ts\n$/, '行尾 \\r 归一、带参数的地址照认')
})

await checkAsync('libVLC 视图只给 VLC 内核且外壳给了本机地址时才换，其他情况下发原样', async () => {
  const text = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:100\n#EXT-X-TARGETDURATION:8\n#EXTINF:7.440,\nhttps://a.ysp.cctv.cn/T/2024078203-100.ts\n'
  const resolver = createResolver({
    request: async () => ({ urls: ['https://a.ysp.cctv.cn/T/live.m3u8'] }),
    select: async () => ({ url: 'https://a.ysp.cctv.cn/T/live.m3u8', text }),
  })
  const vlc = { ua: 'VLC/4.0.0-dev LibVLC/4.0.0-dev' }
  const viewed = await resolver.resolve('ysp-cctv1', { now: 0, client: vlc, selfBase: 'http://192.168.1.2:1905/pass' })
  assert.match(viewed.manifestText, /#EXTINF:7\.430,\nhttps:\/\/a\.ysp\.cctv\.cn\/T\/2024078203-100\.ts\n#EXTINF:0\.010,\nhttp:\/\/192\.168\.1\.2:1905\/pass\/ysp-pad\.ts\n$/)
  for (const ctx of [
    { client: vlc },
    { client: { ua: 'AppleCoreMedia/1.0.0.23A344 (Apple TV; U; CPU OS 27_0 like Mac OS X; zh_cn)' }, selfBase: 'http://h' },
    { client: { ua: 'Lavf/61.7.100' }, selfBase: 'http://h' },
    { selfBase: 'http://h' },
    {},
  ]) {
    const plain = await resolver.resolve('ysp-cctv1', { now: 5000, ...ctx })
    assert.equal(plain.manifestText, text)
  }
})

await checkAsync('垫片是 200 个 TS 空包，本机路由认领并直接返回', async () => {
  assert.equal(FILLER_BODY.length, 188 * 200)
  for (let at = 0; at < FILLER_BODY.length; at += 188) {
    assert.equal(FILLER_BODY.readUInt32BE(at), 0x471fff10, '同步字节 + PID 0x1FFF + 只有负载')
  }
  assert.equal(claimsLocalPath(FILLER_PATH), true)
  assert.equal(claimsLocalPath('/ysp-pad.tsx'), false)
  const got = await handleLocalRequest({ path: FILLER_PATH, method: 'GET' })
  assert.equal(got.status, 200)
  assert.equal(got.headers['Content-Type'], 'video/mp2t')
  assert.equal(got.headers['Content-Length'], FILLER_BODY.length)
  assert.equal(got.body, FILLER_BODY)
  const head = await handleLocalRequest({ path: FILLER_PATH, method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.body, '')
})

await checkAsync('解析失败也绝不抛异常，只回空 url 与原因', async () => {
  // 模块契约：app.js 的 handler 没有顶层 try，抛出等于请求永不 end、客户端挂死。
  const boom = createResolver({ request: async () => { throw new Error('接口 502') }, select: async () => ({}) })
  const failed = await boom.resolve('ysp-cctv1', { now: 0 })
  assert.equal(failed.url, '')
  assert.match(failed.desc, /接口 502/)
  const unknown = await boom.resolve('ysp-not-a-channel', { now: 0 })
  assert.equal(unknown.url, '')
  const noCtx = await boom.resolve('ysp-cctv1')
  assert.equal(noCtx.url, '')
})

await checkAsync('主备全部 403 才标记限流，混有超时或其他状态码不算', async () => {
  const pick = statuses => selectWorkingManifest(
    statuses.map((_, i) => `https://n${i}.ysp.cctv.cn/live.m3u8`),
    { fetchImpl: async url => new Response('denied', { status: statuses[Number(new URL(url).hostname[1])] }) },
  ).then(() => { throw new Error('不应成功') }, error => error)
  assert.equal((await pick([403, 403])).allForbidden, true)
  assert.equal((await pick([403, 404])).allForbidden, false)
  assert.equal((await pick([502])).allForbidden, false)
})

await checkAsync('换票后仍全部 403 时同频道冷却 30 秒，期间不打官方，到期再试', async () => {
  let requests = 0
  let selects = 0
  let blocked = true
  const forbidden = () => Object.assign(new Error('主、备用 CDN 均不可用（a: 清单 HTTP 403）'), { allForbidden: true })
  const resolver = createResolver({
    request: async channel => { requests++; return { urls: [`https://good.ysp.cctv.cn/${channel.id}.m3u8`] } },
    select: async urls => {
      selects++
      if (blocked) throw forbidden()
      return { url: urls[0], text: '#EXTM3U\n#EXTINF:6,\npart.ts\n' }
    },
  })
  const first = await resolver.resolve('ysp-cctv1', { now: 0 })
  assert.equal(first.url, '')
  assert.match(first.desc, /30 秒内暂停向官方请求/)
  const upstream = [requests, selects]
  // 播放器毫秒级连环重试：冷却期内一枪都不能打到官方
  for (const now of [100, 500, 2000, 29_999]) {
    const retry = await resolver.resolve('ysp-cctv1', { now })
    assert.equal(retry.url, '')
    assert.match(retry.desc, /冷却中/)
  }
  assert.deepEqual([requests, selects], upstream, '冷却期内不得换票或拉清单')
  // 冷却按频道记，别的台照常实打
  await resolver.resolve('ysp-cctv2', { now: 1000 })
  assert.ok(requests > upstream[0])
  blocked = false
  const recovered = await resolver.resolve('ysp-cctv1', { now: 30_000 })
  assert.match(recovered.desc, /H\.264/, '冷却到期后应重新向官方请求')
})

await checkAsync('超时、接口报错等非 403 失败不冷却，下一次请求照常实打', async () => {
  let requests = 0
  const resolver = createResolver({
    request: async () => { requests++; throw new Error('应版权方要求，暂停提供直播信号') },
    select: async () => ({}),
  })
  await resolver.resolve('ysp-cctv10', { now: 0 })
  const before = requests
  const again = await resolver.resolve('ysp-cctv10', { now: 100 })
  assert.match(again.desc, /版权方要求/)
  assert.ok(requests > before)
  assert.equal(resolver.cooling.size, 0)
})

console.log(`\n全部通过：${passed} 项`)
