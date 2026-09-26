#!/usr/bin/env node
import assert from 'node:assert/strict'

import yangshipin from '../extractors/yangshipin/index.js'
import {
  AUTH_CHANNELS,
  AUTH_CHANNEL_BY_REF,
  CHANNELS,
  CHANNEL_BY_REF,
  buildChannels,
} from '../extractors/yangshipin/channels.js'
import { createCKey } from '../extractors/yangshipin/ckey.js'
import { isOfficialMediaUrl, requestPlayUrls, selectWorkingManifest } from '../extractors/yangshipin/api.js'
import { CACHE_MS, createResolver } from '../extractors/yangshipin/resolver.js'
import {
  LOGIN_IDENTITY_COOKIES,
  YspBrowserLogin,
  YspBrowserSession,
  browserLoginAvailability,
  parseImportedLoginState,
} from '../extractors/yangshipin/browser-auth.js'
import { handleLocalRequest, runtime } from '../extractors/yangshipin/runtime.js'
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
