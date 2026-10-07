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
import { CACHE_MS, PIN_MARGIN, backfillSkipped, createResolver, pinSegmentUrls, tailOf } from '../extractors/yangshipin/resolver.js'
import { FILLER_BODY, FILLER_PATH, libvlcPlaylist } from '../extractors/yangshipin/libvlc-view.js'
import { createPlaylistHistory, HISTORY_MAX_SEGMENTS } from '../extractors/yangshipin/playlist-history.js'
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
  isParkedMediaRequest,
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

// 预热页测试用：每个页面独立记账，drain 时给出 init + 三片（每片 1 秒）
function sparePage(id, events) {
  let drains = 0
  const handlers = new Set()
  const page = {
    id, closed: false, interception: false, gotos: 0,
    isClosed: () => page.closed,
    close: async () => { page.closed = true; events.push(`close ${id}`) },
    on(event, fn) { if (event === 'request') handlers.add(fn) },
    off(event, fn) { handlers.delete(fn) },
    setUserAgent: async () => {},
    evaluateOnNewDocument: async () => {},
    setRequestInterception: async value => { page.interception = value; events.push(`intercept ${id} ${value}`) },
    bringToFront: async () => { events.push(`front ${id}`) },
    goto: async () => { page.gotos++; events.push(`goto ${id}`) },
    waitForFunction: async () => {},
    evaluate: async (fn, arg) => {
      if (typeof fn === 'function' && fn.name === 'base64DrainScript') {
        drains++
        if (drains === 1) return [mseChunk('audio/mp4', fakeInit()), mseChunk('video/mp4', fakeInit()), mseChunk('audio/mp4', fakeMedia(0)), mseChunk('video/mp4', fakeMedia(0))]
        if (drains <= 3) return [mseChunk('audio/mp4', fakeMedia(drains - 1)), mseChunk('video/mp4', fakeMedia(drains - 1))]
        return []
      }
      if (arg !== undefined) { events.push(`click ${id} ${arg}`); return true }
      if (String(fn).includes('__yspHlsInstances')) return '已催官网播放器重拉清单（1/1 个实例）'
      if (String(fn).includes('buffered')) return { currentTime: 1, bufferedEnd: 3, ahead: 2, paused: false, readyState: 4 }
      return undefined
    },
    // 模拟一个请求经过页面上的拦截处理器，返回处理结果
    request(url, resourceType = 'xhr') {
      let outcome = page.interception ? 'pending' : 'free'
      const request = {
        url: () => url,
        resourceType: () => resourceType,
        abort: async () => { outcome = 'abort' },
        continue: async () => { outcome = 'continue' },
      }
      for (const handler of handlers) handler(request)
      return outcome
    },
  }
  return page
}

function spareSession(events, { launchDelayMs = 0, accountDelayMs = 0 } = {}) {
  const pages = []
  const browser = {
    connected: true,
    newPage: async options => {
      const page = sparePage(`p${pages.length + 1}`, events)
      page.background = Boolean(options?.background)
      pages.push(page)
      return page
    },
  }
  const session = {
    running: false, visible: false, browser: null, pages,
    ensureBrowser: async () => {
      if (session.running) return
      session.browser = browser
      session.running = true
      events.push('launch')
      await new Promise(resolve => setTimeout(resolve, launchDelayMs))
      events.push('base ready')
    },
    readAccount: async () => {
      await new Promise(resolve => setTimeout(resolve, accountDelayMs))
      events.push('account ok')
      return { authenticated: true, account: { nickname: '测试', vip: true } }
    },
    close: async () => { browser.connected = false; session.running = false },
  }
  return session
}

check('预热页只挡媒体分片和清单，页面脚本、接口照常放行', () => {
  assert.equal(isParkedMediaRequest('https://live-dtocnc-cdn.ysp.cctv.cn/x/index.m3u8?a=1', 'xhr'), true)
  assert.equal(isParkedMediaRequest('https://hlsliveali-cdn.ysp.cctv.cn/x/1700.m4s', 'xhr'), true)
  assert.equal(isParkedMediaRequest('https://x/seg-1.ts?k=v', 'xhr'), true)
  assert.equal(isParkedMediaRequest('https://x/whatever', 'media'), true)
  assert.equal(isParkedMediaRequest('https://player-api.yangshipin.cn/v1/player/auth', 'xhr'), false)
  assert.equal(isParkedMediaRequest('https://www.yangshipin.cn/Library/CMGPlayer.json', 'fetch'), false)
  assert.equal(isParkedMediaRequest('https://www.yangshipin.cn/static/app.mp4.js', 'script'), false)
})

await checkAsync('切台用预热页：起好一台就备下一页（挡住默认台媒体），下一台直接放开拦截点台，不再现开页面', async () => {
  const events = []
  const logs = []
  const session = spareSession(events)
  const bridge = new VipMseBridge(session, { logger: line => logs.push(line), readyMinMediaS: 3 })
  try {
    await bridge.ensure(AUTH_CHANNELS[0])
    const [p1] = session.pages
    assert.equal(p1.interception, false, '认领后拦截已关')
    assert.ok(events.indexOf(`intercept p1 false`) < events.indexOf(`front p1`), '先放开拦截')
    assert.ok(events.indexOf(`front p1`) < events.indexOf(`click p1 ${AUTH_CHANNELS[0].siteName}`), '切到前台再点台')

    // 第一台起好后备下一页：加载官网但不点台，媒体请求被挡
    assert.ok(bridge.spare, '起好一台后开始备预热页')
    assert.equal(await bridge.spare.ready, true)
    const p2 = session.pages[1]
    assert.equal(p2.gotos, 1)
    assert.equal(p2.interception, true)
    assert.equal(p2.background, true, '预热页建在后台标签，不把正在播的页挤到后台')
    assert.ok(!events.includes('front p2'))
    assert.equal(p2.request('https://cdn/x/index.m3u8'), 'abort')
    assert.equal(p2.request('https://cdn/x/12.m4s'), 'abort')
    assert.equal(p2.request('https://player-api.yangshipin.cn/v1/player/auth'), 'continue')
    assert.ok(!events.some(line => line.startsWith('click p2')), '预热页闲置时不点台')

    await bridge.ensure(AUTH_CHANNELS[1])
    assert.equal(session.pages[1], p2)
    assert.equal(p2.gotos, 1, '切台直接用预热页，不再加载官网')
    assert.equal(p2.interception, false)
    assert.equal(p2.request('https://cdn/y/index.m3u8'), 'free', '认领后处理器已摘掉')
    assert.ok(events.includes(`click p2 ${AUTH_CHANNELS[1].siteName}`))
    assert.equal(bridge.streams.get(AUTH_CHANNELS[1].id).page, p2)
    const ready = logs.filter(line => line.includes('解扰桥就绪')).at(-1)
    assert.match(ready, /浏览器与页面 \d+\.\d（预热页） · 首片/)
    assert.equal(await bridge.spare.ready, true, '又备好下一页')
    assert.equal(session.pages.length, 3)
  } finally {
    await bridge.close()
  }
  assert.ok(session.pages.every(page => page.closed), '关闭时预热页一并关掉')
})

await checkAsync('账号确认完（该续期的已续完）才开新的官网页：官网登录 SDK 续期没有跨页互斥，同时加载会把账号登出', async () => {
  const events = []
  const session = spareSession(events, { launchDelayMs: 150, accountDelayMs: 100 })
  const bridge = new VipMseBridge(session, { readyMinMediaS: 3 })
  try {
    await bridge.ensure(AUTH_CHANNELS[2])
    const at = name => events.indexOf(name)
    assert.ok(at('goto p1') > at('base ready'), `播放页要等基页加载完：${events.join(' / ')}`)
    assert.ok(at('goto p1') > at('account ok'), '也要等读账号（SDK 在这里续期）结束')
    assert.ok(at(`click p1 ${AUTH_CHANNELS[2].siteName}`) > at('goto p1'))
    await bridge.spare.ready
    assert.equal(session.pages.filter(page => page.gotos).length, 2, '只多出一个给下次切台的预热页')
  } finally {
    await bridge.close()
  }
})

await checkAsync('浏览器换过、预热页没了就丢掉，定时清理里不重开新页', async () => {
  const events = []
  const session = spareSession(events)
  const bridge = new VipMseBridge(session, { readyMinMediaS: 3 })
  try {
    await bridge.ensure(AUTH_CHANNELS[4])
    const spare = bridge.spare
    await spare.ready
    const opened = session.pages.length
    bridge.cleanup()
    assert.equal(bridge.spare, spare, '浏览器没换、页面还在就一直留着，不按时间重开')

    session.browser = { connected: true, newPage: async () => { throw new Error('不该开新页') } }
    bridge.cleanup()
    assert.equal(spare.page.closed, true)
    assert.equal(bridge.spare, null)
    assert.equal(session.pages.length, opened, '清理时不开新页')
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
    request: async () => { requests++; throw new Error('官方接口 HTTP 502') },
    select: async () => ({}),
    programmesOf: async () => { throw new Error('不该查节目单') },
  })
  await resolver.resolve('ysp-cctv10', { now: 0 })
  const before = requests
  const again = await resolver.resolve('ysp-cctv10', { now: 100 })
  assert.match(again.desc, /HTTP 502/)
  assert.ok(requests > before)
  assert.equal(resolver.cooling.size, 0)
  assert.equal(resolver.blackouts.size, 0)
})

// 版权停播：官方原话；节目单时刻按上海时间给（毫秒）
const COPYRIGHT = '应版权方要求，暂停提供直播信号，请点击观看其他精彩节目'
const at = hhmm => Date.parse(`2026-10-03T${hhmm}:00+08:00`)
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

await checkAsync('版权停播冷却到当前节目结束、最多 5 分钟：期间本地回同一句话、不刷红字、一枪不打官方（issue #158）', async () => {
  let tickets = 0
  let blocked = true
  const lookups = []
  const logs = []
  const resolver = createResolver({
    log: line => logs.push(line),
    request: async () => { tickets++; if (blocked) throw new Error(COPYRIGHT); return { urls: ['https://entry.ysp.cctv.cn/live.m3u8'] } },
    select: async () => ({ url: 'https://entry.ysp.cctv.cn/live.m3u8', text: '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:500\n#EXT-X-TARGETDURATION:5\n#EXTINF:5.000,\nhttps://a.ysp.cctv.cn/T/2024078203-500.ts\n' }),
    programmesOf: async (channel, day) => {
      lookups.push([channel.livePid, day])
      return [
        { title: '透视新科技', start: at('19:20'), stop: at('19:52') },
        { title: '自然传奇', start: at('19:52'), stop: at('20:52') },
        { title: '探索·发现', start: at('20:52'), stop: at('21:40') },
      ]
    },
  })
  const first = await resolver.resolve('ysp-cctv10', { now: at('20:45') })
  assert.equal(first.url, '')
  assert.match(first.desc, /版权方要求/)
  assert.equal(first.silent, undefined, '第一次照常打红字')
  assert.equal(tickets, 1, '版权停播换一张票也一样，不再要第二张')
  await tick()
  assert.deepEqual(lookups, [[CHANNEL_BY_REF.get('ysp-cctv10').livePid, '20261003']], '按上海日期查当天节目单')
  // 《自然传奇》20:52 才结束，但最多 5 分钟就再问一次官方
  assert.match(logs.at(-1), /CCTV10.*版权停播（当前节目《自然传奇》），20:50 前不再向官方请求/)
  for (const hhmm of ['20:46', '20:48', '20:49']) {
    const retry = await resolver.resolve('ysp-cctv10', { now: at(hhmm) + 30_000 })
    assert.equal(retry.url, '')
    assert.equal(retry.silent, true, '冷却期内的拒绝不刷红字')
    assert.match(retry.desc, /版权方要求.*20:50 前不再向官方请求/)
  }
  assert.equal(tickets, 1, '冷却期内一张票都不取')
  assert.equal(lookups.length, 1, '节目单也只查一次')
  // 5 分钟到了再问一次，还是停播：这回节目两分钟内结束，就冷却到节目结束
  await resolver.resolve('ysp-cctv10', { now: at('20:50') + 30_000 })
  assert.equal(tickets, 2)
  await tick()
  assert.match(logs.at(-1), /20:52 前不再向官方请求/)
  const other = await resolver.resolve('ysp-cctv1', { now: at('20:51') })
  assert.match(other.desc, /版权方要求/, '别的台照常向官方请求')
  assert.equal(tickets, 3)
  blocked = false
  const back = await resolver.resolve('ysp-cctv10', { now: at('20:52') })
  assert.match(back.desc, /H\.264/, '换了节目就重新向官方请求')
})

await checkAsync('版权停播查不到节目单时冷却 3 分钟；节目马上结束就冷却到节目结束', async () => {
  const cases = [
    ['节目单查不到', async () => { throw new Error('节目单 404') }, '20:48', /节目单里查不到当前节目/],
    ['节目单是空的', async () => [], '20:48', /节目单里查不到当前节目/],
    ['几个小时的长条目', async () => [{ title: '精彩节目', start: at('18:00'), stop: at('23:59') }], '20:50', /《精彩节目》/],
    ['节目马上结束', async () => [{ title: '自然传奇', start: at('19:52'), stop: at('20:46') }], '20:46', /《自然传奇》/],
  ]
  for (const [name, programmesOf, until, title] of cases) {
    const logs = []
    const resolver = createResolver({
      log: line => logs.push(line),
      request: async () => { throw new Error(COPYRIGHT) },
      select: async () => ({}),
      programmesOf,
    })
    await resolver.resolve('ysp-cctv10', { now: at('20:45') })
    await tick()
    assert.match(logs.at(-1), title, name)
    assert.match(logs.at(-1), new RegExp(`${until} 前不再向官方请求`), name)
    assert.match((await resolver.resolve('ysp-cctv10', { now: at('20:45') + 30_000 })).desc, new RegExp(`${until} 前`), name)
  }
})

// issue #158：以下几项的播放器表现来自录制回放实测，见 resolver.js STALE_AFTER_MS 的注释
const livePlaylist = seq => [
  '#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-MEDIA-SEQUENCE:${seq}`, '#EXT-X-TARGETDURATION:5',
  ...[0, 1, 2].flatMap(i => ['#EXTINF:5.000,', `https://a.ysp.cctv.cn/T/2024078203-${seq + i}.ts`]),
].join('\n') + '\n'
const firstSeq = result => Number(result.manifestText.match(/MEDIA-SEQUENCE:(\d+)/)[1])

await checkAsync('官方入口挂住时不让播放器干等：超时先回上一份清单，之后的请求立刻回，后台取到的新清单下一次直接给（issue #158）', async () => {
  let seq = 100
  let selects = 0
  let hang = null
  const logs = []
  const resolver = createResolver({
    staleAfterMs: 60,
    log: line => logs.push(line),
    request: async () => ({ urls: ['https://entry.ysp.cctv.cn/live.m3u8'] }),
    select: async () => { selects++; if (hang) await hang; return { url: 'https://entry.ysp.cctv.cn/live.m3u8', text: livePlaylist(seq++) } },
  })
  assert.equal(firstSeq(await resolver.resolve('ysp-cctv4', { now: 0 })), 100)
  let release
  hang = new Promise(resolve => { release = resolve })
  const started = Date.now()
  const stale = await resolver.resolve('ysp-cctv4', { now: 6000 })
  assert.ok(Date.now() - started >= 55, '头一次给足官方一个入口超时的时间')
  assert.ok(Date.now() - started < 1000, '不能陪着官方一直等')
  assert.equal(firstSeq(stale), 100, '回的是上一份清单')
  assert.equal(stale.url, 'https://entry.ysp.cctv.cn/live.m3u8')
  assert.match(stale.desc, /先回上一份/)
  const again = Date.now()
  assert.equal(firstSeq(await resolver.resolve('ysp-cctv4', { now: 10_000 })), 100)
  assert.ok(Date.now() - again < 30, '已经回过旧清单，后面的请求不再等')
  assert.equal(resolver.pending.size, 1, '取新清单的请求还在后台跑，且只有一个')
  hang = null
  release()
  await new Promise(resolve => setTimeout(resolve, 5))
  const before = selects
  assert.equal(firstSeq(await resolver.resolve('ysp-cctv4', { now: 14_000 })), 101, '后台取回的那份直接给')
  assert.equal(selects, before, '给还没发过的清单时不再向官方取一次')
  assert.equal(firstSeq(await resolver.resolve('ysp-cctv4', { now: 18_000 })), 102, '之后回到每次实时取')
  assert.equal(logs.length, 2)
  assert.match(logs[0], /CCTV4.*没取到新清单.*先把上一份清单回给播放器/)
  assert.match(logs[1], /CCTV4.*官方入口恢复/)
})

await checkAsync('回过旧清单之后：VLC 内核的请求略等一下、官方一恢复当场拿到新清单；其他播放器不等', async () => {
  let seq = 100
  let broken = false
  let slow = 0
  const resolver = createResolver({
    staleRecheckMs: 40,
    log: () => {},
    request: async () => ({ urls: ['https://entry.ysp.cctv.cn/live.m3u8'] }),
    select: async () => {
      if (broken) throw new Error('清单 HTTP 502')
      if (slow) await new Promise(resolve => setTimeout(resolve, slow))
      return { url: 'https://entry.ysp.cctv.cn/live.m3u8', text: livePlaylist(seq++) }
    },
  })
  const vlc = { client: { ua: LIBVLC } }
  await resolver.resolve('ysp-cctv4', { now: 0 })
  broken = true
  assert.equal(firstSeq(await resolver.resolve('ysp-cctv4', { now: 5000, ...vlc })), 100)
  // 官方恢复了，取清单要 15 毫秒：VLC 等得到，当场拿新的
  broken = false
  slow = 15
  assert.equal(firstSeq(await resolver.resolve('ysp-cctv4', { now: 10_000, ...vlc })), 101)
  broken = true
  assert.equal(firstSeq(await resolver.resolve('ysp-cctv4', { now: 15_000 })), 101)
  // 同样的恢复，其他播放器这一次立刻拿旧的，新清单留到下一次
  broken = false
  const started = Date.now()
  assert.equal(firstSeq(await resolver.resolve('ysp-cctv4', { now: 20_000 })), 101)
  assert.ok(Date.now() - started < 10, '不等')
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(firstSeq(await resolver.resolve('ysp-cctv4', { now: 24_000 })), 102)
})

await checkAsync('取新清单很快失败时同样回上一份；上一份超过 30 秒或根本没有时照旧回失败说明', async () => {
  let broken = false
  const logs = []
  const resolver = createResolver({
    log: line => logs.push(line),
    request: async () => { if (broken) throw new Error('接口 502'); return { urls: ['https://entry.ysp.cctv.cn/live.m3u8'] } },
    select: async () => { if (broken) throw new Error('清单 HTTP 502'); return { url: 'https://entry.ysp.cctv.cn/live.m3u8', text: livePlaylist(200) } },
  })
  broken = true
  const cold = await resolver.resolve('ysp-cctv4', { now: 0 })
  assert.equal(cold.url, '', '没有上一份清单可回')
  assert.match(cold.desc, /接口 502/)
  broken = false
  await resolver.resolve('ysp-cctv4', { now: 1000 })
  broken = true
  for (const now of [7000, 11_000, 31_000]) {
    assert.equal(firstSeq(await resolver.resolve('ysp-cctv4', { now })), 200)
  }
  assert.equal(logs.filter(line => /先把上一份清单回给播放器/.test(line)).length, 1, '一次断流只打一行')
  assert.match(logs[0], /接口 502/)
  const expired = await resolver.resolve('ysp-cctv4', { now: 31_001 })
  assert.equal(expired.url, '')
  assert.match(expired.desc, /链接请求失败：接口 502/)
  const other = await resolver.resolve('ysp-cctv1', { now: 7000 })
  assert.equal(other.url, '', '上一份清单按频道记，不拿别的台顶')
})

await checkAsync('403 冷却照常记、照常不打官方，只是有上一份清单时先回它', async () => {
  let blocked = false
  let upstream = 0
  const forbidden = () => Object.assign(new Error('主、备用 CDN 均不可用（a: 清单 HTTP 403）'), { allForbidden: true })
  const resolver = createResolver({
    log: () => {},
    request: async () => { upstream++; return { urls: ['https://entry.ysp.cctv.cn/live.m3u8'] } },
    select: async () => { upstream++; if (blocked) throw forbidden(); return { url: 'https://entry.ysp.cctv.cn/live.m3u8', text: livePlaylist(300) } },
  })
  await resolver.resolve('ysp-cctv4', { now: 0 })
  blocked = true
  assert.equal(firstSeq(await resolver.resolve('ysp-cctv4', { now: 6000 })), 300)
  assert.equal(resolver.cooling.has('ysp-cctv4'), true, '回了旧清单也要进冷却')
  const before = upstream
  assert.equal(firstSeq(await resolver.resolve('ysp-cctv4', { now: 10_000 })), 300)
  assert.equal(upstream, before, '冷却期内一枪都不打官方')
  const late = await resolver.resolve('ysp-cctv4', { now: 30_500 })
  assert.equal(late.url, '', '上一份清单过了 30 秒就不再顶')
  assert.match(late.desc, /冷却中/)
})

await checkAsync('顶上去的旧清单同样按播放器给视图：VLC 内核拿到的仍是带垫片的那份', async () => {
  let broken = false
  const resolver = createResolver({
    log: () => {},
    request: async () => ({ urls: ['https://entry.ysp.cctv.cn/live.m3u8'] }),
    select: async () => { if (broken) throw new Error('清单 HTTP 502'); return { url: 'https://entry.ysp.cctv.cn/live.m3u8', text: livePlaylist(400) } },
  })
  const vlc = { now: 0, client: { ua: LIBVLC }, selfBase: 'http://192.168.1.2:1905' }
  const live = await resolver.resolve('ysp-cctv4', vlc)
  broken = true
  const stale = await resolver.resolve('ysp-cctv4', { ...vlc, now: 5000 })
  assert.equal(stale.manifestText, live.manifestText)
  assert.match(stale.manifestText, /ysp-pad\.ts\n$/)
  const plain = await resolver.resolve('ysp-cctv4', { now: 9000 })
  assert.equal(plain.manifestText, livePlaylist(400), '其他播放器拿原样')
})

// 官方清单的真实形态：头里有 CDN 留存范围，每片带开始时刻（秒）
const officialPlaylist = (seq, starts, durations, { host = 'a', kept = seq - 8 } = {}) => [
  '#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-MEDIA-SEQUENCE:${seq}`, '#EXT-X-ALLOW-CACHE:NO', '#EXT-X-TARGETDURATION:5',
  '#EXT-QQHLS-PIC-WIDTH:0', `#EXT-QQHLS-SEGMENT_RANGE:${kept}-${seq + 2}`,
  ...durations.flatMap((duration, i) => [
    '#EXT-QQHLS-MACHINEID:11111', `#EXT-QQHLS-START-TIME:${starts[i]}`, `#EXT-SID:${seq + i}`,
    '#EXT-X-PROGRAM-DATE-TIME:2026-10-02T09:40:35+08:00', `#EXTINF:${duration.toFixed(3)},`,
    `https://${host}.ysp.cctv.cn/T/2029797103-${seq + i}.ts?from=player&cdn=5505`,
  ]),
].join('\n') + '\n'
const segmentsOf = text => {
  const lines = text.trim().split('\n')
  const first = Number(text.match(/MEDIA-SEQUENCE:(\d+)/)[1])
  return lines.flatMap((line, i) => line.startsWith('#') ? [] : [{ url: line, duration: Number(lines[i - 1].slice(8, -1)) }])
    .map((entry, i) => ({ ...entry, seq: first + i }))
}

check('跳片接回：缺的序号按同主机同令牌补到清单前面，时长按两头的开始时刻平摊（issue #158）', () => {
  const before = officialPlaylist(914, [1000, 1005, 1010], [5, 5, 5])
  assert.deepEqual(tailOf(before), { seq: 916, start: 1010, duration: 5 })
  // 917、918 被跳过：916 在 1015 结束，919 从 1029 开始，中间 14 秒
  const after = officialPlaylist(919, [1029, 1034, 1039], [5, 5, 5], { host: 'b' })
  const filled = backfillSkipped(after, tailOf(before))
  const list = segmentsOf(filled)
  assert.deepEqual(list.map(entry => entry.seq), [917, 918, 919, 920, 921])
  assert.equal(list[0].url, 'https://b.ysp.cctv.cn/T/2029797103-917.ts?from=player&cdn=5505')
  assert.equal(list[1].url, 'https://b.ysp.cctv.cn/T/2029797103-918.ts?from=player&cdn=5505')
  assert.deepEqual(list.map(entry => entry.duration), [7, 7, 5, 5, 5])
  assert.match(filled, /#EXT-X-TARGETDURATION:7\n/, '目标时长不能小于补进去的片')
  assert.match(filled, /SEGMENT_RANGE:911-921\n#EXTINF:7\.000,\n/, '补在第一片的标签前面，清单头不动')
  assert.equal(filled.split('\n').filter(line => line.startsWith('#EXT-X-PROGRAM-DATE-TIME')).length, 3, '官方三片的标签原样保留')
})

check('跳片接回：没缺片、缺的片已不在 CDN 留存范围、认不出标签或时长离谱时原样返回', () => {
  const tail = { seq: 916, start: 1010, duration: 5 }
  const next = officialPlaylist(917, [1015, 1020, 1025], [5, 5, 5])
  assert.equal(backfillSkipped(next, tail), next, '序号连着')
  assert.equal(backfillSkipped(officialPlaylist(915, [1005, 1010, 1015], [5, 5, 5]), tail), officialPlaylist(915, [1005, 1010, 1015], [5, 5, 5]), '有重叠')
  const skipped = officialPlaylist(919, [1029, 1034, 1039], [5, 5, 5])
  assert.equal(backfillSkipped(skipped, undefined), skipped, '没有上一份清单')
  const expired = officialPlaylist(930, [1084, 1089, 1094], [5, 5, 5], { kept: 922 })
  assert.equal(backfillSkipped(expired, tail), expired, '缺的片官方已经不留了')
  const untagged = skipped.split('\n').filter(line => !line.startsWith('#EXT-QQHLS')).join('\n')
  assert.equal(backfillSkipped(untagged, tail), untagged, '没有留存范围和开始时刻')
  assert.equal(backfillSkipped(skipped, { seq: 916, start: NaN, duration: 5 }), skipped, '上一份清单没带开始时刻')
  const absurd = officialPlaylist(919, [1100, 1105, 1110], [5, 5, 5])
  assert.equal(backfillSkipped(absurd, tail), absurd, '平摊下来每片 40 多秒，不可信')
  const renamed = skipped.replaceAll('2029797103-', '2029797103_')
  assert.equal(backfillSkipped(renamed, tail), renamed, '文件名里找不到序号')
})

await checkAsync('断流恢复后接回跳过的片，对着上一次真正发给播放器的清单算；VLC 内核的视图不接；补进去的地址之后保持不变', async () => {
  const bodies = [
    officialPlaylist(914, [1000, 1005, 1010], [5, 5, 5]),
    officialPlaylist(919, [1029, 1034, 1039], [5, 5, 5], { host: 'b' }),
    officialPlaylist(920, [1034, 1039, 1044], [5, 5, 5], { host: 'c' }),
  ]
  let broken = false
  const logs = []
  const resolver = createResolver({
    staleRecheckMs: 5,
    log: line => logs.push(line),
    request: async () => ({ urls: ['https://entry.ysp.cctv.cn/live.m3u8'] }),
    select: async () => { if (broken) throw new Error('清单 HTTP 502'); return { url: 'https://entry.ysp.cctv.cn/live.m3u8', text: bodies.shift() } },
  })
  const pause = () => new Promise(resolve => setTimeout(resolve, 5))
  await resolver.resolve('ysp-cctv4', { now: 0 })
  broken = true
  assert.equal(firstSeq(await resolver.resolve('ysp-cctv4', { now: 6000 })), 914)
  broken = false
  assert.equal(firstSeq(await resolver.resolve('ysp-cctv4', { now: 20_000 })), 914, '这一次立刻回旧的，新清单在后台取')
  await pause()
  assert.match(logs.at(-1), /新清单跳过了 2 片，已接回/)
  const recovered = await resolver.resolve('ysp-cctv4', { now: 24_000 })
  assert.deepEqual(segmentsOf(recovered.manifestText).map(entry => entry.seq), [917, 918, 919, 920, 921], '播放器手里到 916，917、918 要接回来')
  assert.deepEqual(segmentsOf(recovered.manifestText).map(entry => entry.duration), [7, 7, 5, 5, 5])
  // 官方又断了：两种播放器拿到的都是刚才那份，区别只在补没补
  broken = true
  const plain = await resolver.resolve('ysp-cctv4', { now: 25_000 })
  assert.deepEqual(segmentsOf(plain.manifestText).map(entry => entry.seq), [917, 918, 919, 920, 921])
  const vlc = await resolver.resolve('ysp-cctv4', { now: 26_000, client: { ua: LIBVLC }, selfBase: 'http://192.168.1.2:1905' })
  assert.equal(firstSeq(vlc), 919 * 2 - 2, 'VLC 视图照官方原样的三片来')
  broken = false
  assert.equal(firstSeq(await resolver.resolve('ysp-cctv4', { now: 30_000 })), 917)
  await pause()
  const next = await resolver.resolve('ysp-cctv4', { now: 35_000 })
  assert.deepEqual(segmentsOf(next.manifestText).map(entry => entry.seq), [919, 920, 921, 922], '只保留真正见过的历史，不把估算的 917、918 留进历史窗口')
  assert.match(next.manifestText, /https:\/\/b\.ysp\.cctv\.cn\/T\/2029797103-920\.ts/, '已下发过的序号地址不变')
  // 补进去的两片进过地址表：同序号再出现时沿用
  assert.equal(resolver.pins.get('ysp-cctv4').get(917), 'https://b.ysp.cctv.cn/T/2029797103-917.ts?from=player&cdn=5505')
})

check('真实分片历史逐步积累到约 30 秒，准确时长、标签和地址不变，冷启动不等待', () => {
  const history = createPlaylistHistory()
  const body = seq => officialPlaylist(seq, [seq * 5, (seq + 1) * 5, (seq + 2) * 5], [5, 5, 5])
  assert.equal(history.extend(body(100), 0), body(100))
  let result
  for (let seq = 101; seq <= 106; seq++) result = history.extend(body(seq), (seq - 100) * 5000)
  assert.deepEqual(segmentsOf(result).map(x => x.seq), [103, 104, 105, 106, 107, 108])
  assert.equal(segmentsOf(result).reduce((n, x) => n + x.duration, 0), 30)
  assert.match(result, /#EXT-X-START:TIME-OFFSET=-30\.000,PRECISE=NO/)
  assert.equal((result.match(/#EXT-X-PROGRAM-DATE-TIME:/g) || []).length, 6)
  // Repeated observations must not rewrite already-served durations or URLs.
  const changed = body(106).replace('5.000', '6.000').replaceAll('a.ysp', 'b.ysp')
  assert.equal(history.extend(changed, 31_000), result)
})

check('历史按 CDN 留存范围剪掉，目标时长不缩小，少见短片数量也有上限', () => {
  const history = createPlaylistHistory()
  const body = (seq, dur = 5, kept = seq - 8) => officialPlaylist(seq, [1000, 1005, 1010], [dur, dur, dur], { kept })
  history.extend(body(100, 8).replace('TARGETDURATION:5', 'TARGETDURATION:8'), 0)
  const short = history.extend(body(101), 5000)
  assert.match(short, /TARGETDURATION:8/)
  const pruned = history.extend(body(102, 5, 102), 10_000)
  assert.equal(firstSeq({ manifestText: pruned }), 102)
  assert.doesNotMatch(pruned, /-100\.ts|-101\.ts/)
  for (let seq = 103; seq < 130; seq++) {
    const result = history.extend(body(seq, 1, seq - 50), 10_000 + seq)
    assert.ok(segmentsOf(result).length <= HISTORY_MAX_SEGMENTS)
  }
})

check('缺口不拼接、过期/换流/序号倒退清空历史，复杂 HLS 原样下发', () => {
  const history = createPlaylistHistory()
  const body = seq => officialPlaylist(seq, [1000, 1005, 1010], [5, 5, 5])
  history.extend(body(100), 0)
  assert.equal(history.extend(body(105), 5000), body(105), '103、104 没见过，不能凭空拼接')
  assert.equal(history.extend(body(106), 36_000), body(106), '停播超过 30 秒，历史失效')
  assert.equal(history.extend(body(90), 37_000), body(90), '序号重置')
  const renamed = body(91).replaceAll('2029797103-', '9999999999-')
  assert.equal(history.extend(renamed, 38_000), renamed)
  for (const tag of ['#EXT-X-KEY:METHOD=AES-128,URI="key"', '#EXT-X-DISCONTINUITY', '#EXT-X-BYTERANGE:188@0', '#EXT-X-ENDLIST']) {
    const complex = body(92).replace('#EXTM3U', `#EXTM3U\n${tag}`)
    assert.equal(history.extend(complex, 39_000), complex)
    assert.equal(history.extend(body(93), 40_000), body(93), '复杂清单不能串进下一条流')
  }
})

// CCTV8K 那种 2 秒一片的官方清单：每取一次窗口往后滚一片
const shortPlaylist = seq => officialPlaylist(seq, [seq * 2, seq * 2 + 2, seq * 2 + 4], [2, 2, 2]).replace('TARGETDURATION:5', 'TARGETDURATION:2')

await checkAsync('短分片频道冷起先续取清单、攒到门槛再回，同时来的请求一起等；之后照常不等', async () => {
  let selects = 0
  const resolver = createResolver({
    warmupSeconds: 10, warmupMaxMs: 1000, warmupStepMs: 5, log: () => {},
    request: async () => ({ urls: ['https://a.ysp.cctv.cn/live.m3u8'] }),
    select: async () => ({ url: 'https://a.ysp.cctv.cn/live.m3u8', text: shortPlaylist(100 + selects++) }),
  })
  const [first, second] = await Promise.all([
    resolver.resolve('ysp-cctv8k', {}),
    new Promise(resolve => setTimeout(resolve, 2)).then(() => resolver.resolve('ysp-cctv8k', {})),
  ])
  assert.equal(selects, 3, '6 秒 → 8 秒 → 10 秒，续取两次')
  assert.deepEqual(segmentsOf(first.manifestText).map(x => x.seq), [100, 101, 102, 103, 104])
  assert.equal(second.manifestText, first.manifestText, '攒的过程中来的请求拿同一份，不先给薄清单')
  const vlc = await resolver.resolve('ysp-cctv8k', { client: { ua: LIBVLC }, selfBase: 'http://192.168.1.2:1905' })
  // 这个 resolver 没开共享刷新缓存，第三次照常取一次新的；已经起播过，不再续取等待
  assert.equal(selects, 4, '已经起播的频道不再等')
  assert.equal(vlc.manifestText.match(/2029797103-\d+\.ts/g).length, 6, 'VLC 视图用的也是攒好的历史')
})

await checkAsync('短分片冷起攒不够时最多等 warmupMaxMs，续取出错就先回手里的；普通频道和认不出的清单不等', async () => {
  let selects = 0
  let failing = false
  const resolver = createResolver({
    warmupSeconds: 100, warmupMaxMs: 60, warmupStepMs: 10, log: () => {},
    request: async () => ({ urls: ['https://a.ysp.cctv.cn/live.m3u8'] }),
    select: async () => {
      if (failing) throw new Error('清单 HTTP 502')
      return { url: 'https://a.ysp.cctv.cn/live.m3u8', text: shortPlaylist(200 + selects++) }
    },
  })
  const startedAt = Date.now()
  const capped = await resolver.resolve('ysp-cctv8k', {})
  assert.ok(Date.now() - startedAt < 500)
  assert.ok(selects >= 3 && selects <= 7, `等到上限就回：${selects}`)
  assert.ok(segmentsOf(capped.manifestText).length >= 3)

  selects = 0
  const erroring = createResolver({
    warmupSeconds: 100, warmupMaxMs: 1000, warmupStepMs: 5, log: () => {},
    request: async () => ({ urls: ['https://a.ysp.cctv.cn/live.m3u8'] }),
    select: async () => {
      if (selects++) throw new Error('清单 HTTP 502')
      return { url: 'https://a.ysp.cctv.cn/live.m3u8', text: shortPlaylist(300) }
    },
  })
  const early = await erroring.resolve('ysp-cctv13', {})
  assert.deepEqual(segmentsOf(early.manifestText).map(x => x.seq), [300, 301, 302], '续取出错就拿第一份先回')

  selects = 0
  const normal = createResolver({
    warmupSeconds: 100, warmupMaxMs: 1000, warmupStepMs: 5, log: () => {},
    request: async () => ({ urls: ['https://a.ysp.cctv.cn/live.m3u8'] }),
    select: async () => ({ url: 'https://a.ysp.cctv.cn/live.m3u8', text: officialPlaylist(400 + selects++, [1000, 1005, 1010], [5, 5, 5]) }),
  })
  await normal.resolve('ysp-cctv4', {})
  assert.equal(selects, 1, '每片 5 秒的频道冷起直接回')

  selects = 0
  const opaque = createResolver({
    warmupSeconds: 100, warmupMaxMs: 1000, warmupStepMs: 5, log: () => {},
    request: async () => ({ urls: ['https://a.ysp.cctv.cn/live.m3u8'] }),
    select: async () => ({ url: 'https://a.ysp.cctv.cn/live.m3u8', text: shortPlaylist(500 + selects++).replace('#EXTM3U', '#EXTM3U\n#EXT-X-DISCONTINUITY') }),
  })
  await opaque.resolve('ysp-cctv8k', {})
  assert.equal(selects, 1, '历史认不出的清单不等')
  failing = true
})

check('短分片流窗口跳过的一两片按相邻分片补回历史；片长不齐、时刻对不上、缺太多或已出 CDN 留存范围都不补', () => {
  const history = createPlaylistHistory()
  history.extend(shortPlaylist(100), 0)
  // 101、102 之后直接到 104：103 谁都没列过
  const bridged = history.extend(shortPlaylist(104), 5000)
  const list = segmentsOf(bridged)
  assert.deepEqual(list.map(x => x.seq), [100, 101, 102, 103, 104, 105, 106])
  assert.equal(list[3].duration, 2)
  assert.equal(list[3].url, list[4].url.replace('-104.ts', '-103.ts'), '沿用缺口后第一片的主机和令牌')
  assert.match(bridged, /#EXT-QQHLS-START-TIME:206\n#EXTINF:2\.000,\n\S+-103\.ts/)
  // 再缺一片也能接着补（补出来的片带开始时刻）
  assert.deepEqual(segmentsOf(history.extend(shortPlaylist(108), 10_000)).map(x => x.seq).slice(-5), [106, 107, 108, 109, 110])

  const refuse = (second, why) => {
    const h = createPlaylistHistory()
    h.extend(shortPlaylist(100), 0)
    assert.deepEqual(segmentsOf(h.extend(second, 5000)).map(x => x.seq), segmentsOf(second).map(x => x.seq), why)
  }
  refuse(shortPlaylist(107), '缺 4 片，太多')
  refuse(shortPlaylist(104).replaceAll('#EXTINF:2.000,', '#EXTINF:3.000,'), '片长和前面不一样')
  refuse(shortPlaylist(104).replace(/START-TIME:208/, 'START-TIME:211'), '开始时刻对不上')
  refuse(shortPlaylist(104).replace(/SEGMENT_RANGE:\d+/, 'SEGMENT_RANGE:104'), '缺的片 CDN 已经不留了')
  refuse(officialPlaylist(104, [208, 210, 212], [2, 2, 2]).replace('TARGETDURATION:5', 'TARGETDURATION:4'), '每片超过 3 秒的流不补')
})

await checkAsync('慢节点取回的清单比手里旧：沿用手里那份，清单不往回走、历史不清空；差太多才当序号重置', async () => {
  const bodies = [shortPlaylist(100), shortPlaylist(101), shortPlaylist(100), shortPlaylist(102), shortPlaylist(50)]
  const resolver = createResolver({
    warmupSeconds: 0, log: () => {},
    request: async () => ({ urls: ['https://a.ysp.cctv.cn/live.m3u8'] }),
    select: async () => ({ url: 'https://a.ysp.cctv.cn/live.m3u8', text: bodies.shift() }),
  })
  await resolver.resolve('ysp-cctv8k', { now: 0 })
  const ahead = await resolver.resolve('ysp-cctv8k', { now: 6000 })
  const lagging = await resolver.resolve('ysp-cctv8k', { now: 12_000 })
  assert.equal(lagging.manifestText, ahead.manifestText, '慢节点那份不下发')
  const next = await resolver.resolve('ysp-cctv8k', { now: 18_000 })
  assert.deepEqual(segmentsOf(next.manifestText).map(x => x.seq), [100, 101, 102, 103, 104], '历史没被清空')
  const reset = await resolver.resolve('ysp-cctv8k', { now: 24_000 })
  assert.deepEqual(segmentsOf(reset.manifestText).map(x => x.seq), [50, 51, 52], '落后几十片是真重置')
})

await checkAsync('活跃频道共享定时刷新，不跟着慢播放器漏片；短期重复请求不重复拉官方，停播后停止', async () => {
  let selects = 0
  const resolver = createResolver({
    refreshIntervalMs: 20, idleMs: 75, playingMinGapMs: 5, playingWindowMs: 40, log: () => {},
    request: async () => ({ urls: ['https://a.ysp.cctv.cn/live.m3u8'] }),
    select: async () => ({ url: 'https://a.ysp.cctv.cn/live.m3u8', text: officialPlaylist(100 + selects++, [1000, 1005, 1010], [5, 5, 5]) }),
  })
  try {
    await resolver.resolve('ysp-cctv4', { now: 0 })
    // 第二次请求隔得像播放器在轮询（> playingMinGapMs），共享刷新从这里启动
    await Promise.all(Array.from({ length: 5 }, () => resolver.resolve('ysp-cctv4', { now: 10 })))
    assert.equal(selects, 1, '多人并发、首份清单还新鲜，只用这一份')
    await new Promise(r => setTimeout(r, 50))
    assert.ok(selects >= 2, '播放器不轮询也在积累真实历史')
    const latest = await resolver.resolve('ysp-cctv4')
    assert.ok(segmentsOf(latest.manifestText).length > 3)
    await new Promise(r => setTimeout(r, 110))
    const stopped = selects
    await new Promise(r => setTimeout(r, 50))
    assert.equal(selects, stopped, '停播后没有上游流量')
  } finally { resolver.clear() }
})

await checkAsync('清空解析缓存会停止后台刷新，正在飞的旧请求也不再把缓存写回来', async () => {
  let release, selects = 0, hanging = false
  const resolver = createResolver({
    refreshIntervalMs: 10, idleMs: 100, playingMinGapMs: 2, playingWindowMs: 40, log: () => {},
    request: async () => ({ urls: ['https://a.ysp.cctv.cn/live.m3u8'] }),
    select: async () => {
      selects++
      if (hanging) await new Promise(r => { release = r })
      return { url: 'https://a.ysp.cctv.cn/live.m3u8', text: officialPlaylist(100, [1000, 1005, 1010], [5, 5, 5]) }
    },
  })
  try {
    await resolver.resolve('ysp-cctv4', { now: 0 })
    // 第二次请求隔得像在轮询，共享刷新从这里启动；清单还新鲜，这次不打上游
    await resolver.resolve('ysp-cctv4', { now: 5 })
    hanging = true
    await new Promise(r => setTimeout(r, 20))
    assert.equal(typeof release, 'function')
    resolver.clear(); release()
    await new Promise(r => setTimeout(r, 40))
    assert.equal(resolver.latest.size, 0)
    assert.equal(resolver.cache.size, 0)
    assert.equal(resolver.pending.size, 0)
    assert.equal(selects, 2)
  } finally { resolver.clear(); release?.() }
})

await checkAsync('只请求一次、或几毫秒内连打两次、或隔太久再来，都不算在播，不启动共享刷新', async () => {
  let selects = 0
  const resolver = createResolver({
    refreshIntervalMs: 10, idleMs: 100, playingMinGapMs: 5, playingWindowMs: 40, log: () => {},
    request: async () => ({ urls: ['https://a.ysp.cctv.cn/live.m3u8'] }),
    select: async () => ({ url: 'https://a.ysp.cctv.cn/live.m3u8', text: officialPlaylist(100 + selects++, [1000, 1005, 1010], [5, 5, 5]) }),
  })
  try {
    await resolver.resolve('ysp-cctv4', { now: 0 })
    await new Promise(r => setTimeout(r, 60))
    assert.equal(selects, 1, '扫一遍只碰一次的频道，后台没有尾巴')
    await resolver.resolve('ysp-cctv5', { now: 0 })
    await resolver.resolve('ysp-cctv5', { now: 2 })
    await new Promise(r => setTimeout(r, 60))
    assert.equal(selects, 2, '相隔几毫秒连打两次仍算扫描，不启动刷新')
    await resolver.resolve('ysp-cctv5', { now: 50 })
    assert.equal(selects, 3, '清单过了刷新周期，这次请求自己去取')
    await new Promise(r => setTimeout(r, 60))
    assert.equal(selects, 3, '隔太久再来也不算轮询')
  } finally { resolver.clear() }
})

await checkAsync('实例级取票预算：冷启动超预算的新频道本地拒绝且只打一行黄字，正在播的续播、同频道并发等待都不花票，回填后恢复', async () => {
  let requests = 0
  const logs = []
  const playlist = () => ({ url: 'https://a.ysp.cctv.cn/live.m3u8', text: officialPlaylist(100 + requests, [1000, 1005, 1010], [5, 5, 5]) })
  const resolver = createResolver({
    ticketBudget: 3, ticketBudgetWindowMs: 60_000, log: line => logs.push(line),
    request: async () => { requests++; return { urls: ['https://a.ysp.cctv.cn/live.m3u8'] } },
    select: async () => playlist(),
  })
  const client = { key: 'scan', tag: '10.0.0.9 UA:scan-test' }
  try {
    for (const ref of ['ysp-cctv1', 'ysp-cctv2', 'ysp-cctv3']) {
      assert.ok((await resolver.resolve(ref, { now: 1000, client })).url, `${ref} 在预算内正常解析`)
    }
    assert.equal(requests, 3)
    const refused = await resolver.resolve('ysp-cctv4', { now: 1500, client })
    assert.equal(refused.url, '')
    assert.equal(refused.silent, true, '拒绝按归并日志处理，不逐条刷红')
    assert.match(refused.desc, /批量探测/)
    assert.equal(requests, 3, '桶空了一枪不打上游')
    assert.equal(logs.filter(l => l.includes('批量探测') && l.includes('scan-test')).length, 1, '黄字写明是哪个客户端')
    assert.equal((await resolver.resolve('ysp-cctv5', { now: 2000, client })).url, '')
    assert.equal(logs.filter(l => l.includes('批量探测')).length, 1, '10 秒内只打一行黄字')
    const playing = await resolver.resolve('ysp-cctv1', { now: 8000, client })
    assert.ok(playing.url, '正在播的频道续播不受预算影响')
    assert.equal(requests, 3)
    const later = await resolver.resolve('ysp-cctv4', { now: 1500 + 20_000, client })
    assert.ok(later.url, '3 张/60 秒，过 20 秒攒出一张，新频道恢复')
    assert.equal(requests, 4)
  } finally { resolver.clear() }

  let slow = 0
  const shared = createResolver({
    ticketBudget: 1, ticketBudgetWindowMs: 60_000, log: () => {},
    request: async () => { slow++; await new Promise(r => setTimeout(r, 10)); return { urls: ['https://a.ysp.cctv.cn/live.m3u8'] } },
    select: async () => ({ url: 'https://a.ysp.cctv.cn/live.m3u8', text: officialPlaylist(100, [1000, 1005, 1010], [5, 5, 5]) }),
  })
  try {
    const both = await Promise.all([shared.resolve('ysp-cctv6', { now: 0 }), shared.resolve('ysp-cctv6', { now: 0 })])
    assert.ok(both.every(out => out.url), '同一个冷频道几人同时点开，等同一次取票')
    assert.equal(slow, 1)
    assert.equal((await shared.resolve('ysp-cctv7', { now: 0 })).url, '', '那一张票已经花掉')
  } finally { shared.clear() }
})

console.log(`\n全部通过：${passed} 项`)
