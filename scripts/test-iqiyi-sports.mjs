import test from 'node:test'
import assert from 'node:assert/strict'
import { createCatalog, CONFIG_URL, normalizeEvents, normalizeVods, eventName, entitlementOptions, accessLabel, selectVodStream, selectAuthorizedStream, validateMediaUrl } from '../extractors/iqiyi-sports/api.js'
import { parseCookies } from '../extractors/iqiyi-sports/cookies.js'
import { createBrowserAuth } from '../extractors/iqiyi-sports/auth.js'
import { createRuntime } from '../extractors/iqiyi-sports/runtime.js'
import module from '../extractors/iqiyi-sports/index.js'
import { getModule, resolverFor } from '../extractors/registry.js'

// Trimmed from official 2026-10-14 catalog and member playback responses; no real cookies/tickets.
const event = { id: '1200050820', qipuId: '1477288679609723', title: '2026武网·女单第2轮：施晗vs费尔南德斯',
  officialPage: 'https://sports.iqiyi.com/resource/pcw/live/eo2bwc2ejb', free: false }
const row = { matchBaseInfo: { matchId: event.id, qipuid: event.qipuId, title: event.title, status: '1', isFree: '0' }, jumpInfo: { iqiyiPC: event.officialPage } }
const catalogBody = rows => ({ resCode: '200', retData: [{ list: rows }] })
const stream = (bid, bitrate, codeFormat = 2) => ({ bid, bitrate, codeFormat, screenSize: '1920:1080', formatType: 'TS', url: `https://hlslive.video.iqiyi.com/${bid}.m3u8` })
const authorized = () => ({ id: event.qipuId, boss: 2, bossRet: { code: 'A00000', data: { prv: '0' } }, program: { liveDrmInfo: { drm: false } }, streams: [stream(600, '4000'), stream(610, '5500'), stream(610, '5500', 3)] })
const hls = sequence => `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nhttps://spqcloudcdncnc.inter.71edge.com/sample-${sequence}.ts\n`
function setup() {
  const state = { clock: 1000000, captures: 0, manifests: 0, accountChecks: 0, revision: 0, data: authorized(), events: [event] }
  const auth = { revision: () => state.revision, flow: Object.fromEntries(['status', 'check', 'start', 'import', 'close', 'cancel'].map(k => [k, () => ({ status: 'idle', authenticated: false })])),
    async capture() { state.captures++; if (state.failure) throw state.failure; return { data: state.data, hasLogin: state.hasLogin !== false } },
    // state.account: undefined = still valid, 'expired' = official P00100, 'unknown' = account API not answered.
    async checkAccount() {
      state.accountChecks++; await state.accountGate
      if (state.account === 'expired') throw Object.assign(new Error('官方未确认账号登录有效，请重新登录'), { credential: true })
      if (state.account === 'unknown') throw new Error('官方账号状态核验未完成，请稍后重试')
    }, shutdown: async () => {} }
  const runtime = createRuntime({ auth, now: () => state.clock, catalog: { discover: async () => ({ events: state.events, warnings: [] }) },
    fetchImpl: async () => { state.manifests++; if (state.http403) { state.http403 = false; return new Response('', { status: 403 }) }; return new Response(state.encrypted ? '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="license"\n' : hls(state.manifests)) } })
  return { state, runtime }
}
test('discover uses current official menus, deduplicates live events, and excludes ended/foreign/religious entries', async () => {
  const future = { ...row, matchBaseInfo: { ...row.matchBaseInfo, matchId: '2', status: '0' } }
  const ended = { ...row, matchBaseInfo: { ...row.matchBaseInfo, matchId: '3', status: '2' } }
  const foreign = { ...row, jumpInfo: { iqiyiPC: 'https://example.com/live/' } }
  const religious = { ...row, matchBaseInfo: { ...row.matchBaseInfo, matchId: '4', title: '宗教直播' } }
  assert.deepEqual(normalizeEvents(catalogBody([row, row, future, ended, foreign, religious])).map(e => e.id), [event.id])
  const calls = []
  const catalog = createCatalog({ fetchImpl: async url => { calls.push(url); return new Response(JSON.stringify(url === CONFIG_URL
    ? { retData: { menuConfigList: [{ url: 'https://sports.iqiyi.com/resource/json/pc/channel/menu_123.json' }] } }
    : url.includes('/matchinfo_new/') ? { resCode: '200', retData: { matchBaseInfo: row.matchBaseInfo } } : catalogBody([row]))) } })
  const result = await catalog.discover(); await catalog.discover()
  assert.equal(result.events[0].id, event.id)
  assert.equal(calls.length, 3)
  assert.ok(calls[1].includes('menu_123.json'))
})
test('topic-only nested live entries are followed, deduplicated and checked against official event details', async () => {
  const menu = 'https://sports.iqiyi.com/resource/json/pc/channel/menu_123.json'
  const topic = 'https://sports.iqiyi.com/resource/json/pc/specialProgram_new/new/special_p_880460552_0.json'
  const page = 'https://sports.iqiyi.com/resource/pc/index_pc.html#/specialProgramNew/880460552'
  const stale = { ...row, matchBaseInfo: { ...row.matchBaseInfo, matchId: '1200050811', qipuid: '8201042815042123' } }
  const bodies = {
    [CONFIG_URL]: { retData: { menuConfigList: [{ url: menu }, { url: page }] } },
    [menu]: catalogBody([{ commonBaseInfo: { type: 'special_program' }, jumpInfo: { iqiyiPC: page } }]),
    [topic]: { resCode: '200', retData: { leftModules: [{ list: [{ resContentJA: [row, row, stale] }] }],
      rightModules: [{ link: page }], foreign: 'https://evil.com/resource/pc/index_pc.html#/specialProgramNew/123' } },
  }
  const calls = []
  const catalog = createCatalog({ fetchImpl: async url => {
    calls.push(url)
    const body = bodies[url] || { resCode: '200', retData: { matchBaseInfo: url.includes(stale.matchBaseInfo.qipuid)
      ? { ...stale.matchBaseInfo, status: '2' } : row.matchBaseInfo } }
    return new Response(JSON.stringify(body))
  } })
  const result = await catalog.discover()
  assert.deepEqual(result.events.map(e => e.id), [event.id])
  assert.equal(result.coverage.candidates, 2); assert.equal(result.coverage.complete, true)
  assert.equal(calls.filter(u => u === topic).length, 1)
  assert.equal(calls.some(u => u.includes('evil.com')), false)
})
test('failed and legacy topics report incomplete coverage; temporary detail failure preserves previous known event', async () => {
  let clock = 0, failTopic = false, failDetail = false, wrongIdentity = false
  const menu = 'https://sports.iqiyi.com/resource/json/pc/channel/menu_123.json'
  const catalog = createCatalog({ now: () => clock, fetchImpl: async url => {
    if (url === CONFIG_URL) return Response.json({ retData: { menuConfigList: [{ url: menu }] } })
    if (url.includes('/matchinfo_new/')) {
      if (failDetail) return new Response('', { status: 503 })
      return Response.json({ resCode: '200', retData: { matchBaseInfo: { ...row.matchBaseInfo, matchId: wrongIdentity ? '999' : event.id } } })
    }
    if (url.includes('/specialProgram_new/special_p_')) return new Response('', { status: 403 })
    if (url !== menu && failTopic) return new Response('', { status: 403 })
    return Response.json(catalogBody([row, { links: [
      'https://sports.iqiyi.com/resource/pc/index_pc.html#/specialProgramNew/123',
      'https://sports.iqiyi.com/sport/index_pc.html#/specialProgram/456' ] }]))
  } })
  assert.equal((await catalog.discover()).events.length, 1)
  clock += 60001; failTopic = true; failDetail = true
  const result = await catalog.discover()
  assert.equal(result.events.length, 1); assert.equal(result.coverage.complete, false)
  assert.ok(result.warnings.some(w => w.includes('HTTP 403')))
  assert.ok(result.warnings.some(w => w.includes('/specialProgram_new/special_p_456_0.json')))
  assert.ok(result.warnings.some(w => w.includes('状态未确认')))
  catalog.clear(); failDetail = false; wrongIdentity = true
  assert.equal((await catalog.discover()).events.length, 0)
})
test('readable legacy topics are included and total directory failure rejects instead of publishing an empty catalog', async () => {
  let clock = 0, offline = false
  const url = 'https://sports.iqiyi.com/sport/index_pc.html#/specialProgram/456'
  const catalog = createCatalog({ now: () => clock, fetchImpl: async source => {
    if (source === CONFIG_URL) return Response.json({ retData: { menuConfigList: [{ url }] } })
    if (offline) return new Response('', { status: 503 })
    if (source.includes('/matchinfo_new/')) return Response.json({ resCode: '200', retData: { matchBaseInfo: row.matchBaseInfo } })
    assert.equal(source, 'https://sports.iqiyi.com/resource/json/pc/specialProgram_new/special_p_456_0.json')
    return Response.json({ resCode: '200', retData: { leftModules: [{ list: [{ resContentJA: [row] }] }] } })
  } })
  const result = await catalog.discover()
  assert.deepEqual(result.events.map(e => e.id), [event.id])
  assert.equal(result.coverage.legacyTopics, 1); assert.equal(result.coverage.complete, true)
  clock += 60001; offline = true
  await assert.rejects(catalog.discover(), /全部读取失败/)
  offline = false
  assert.equal((await catalog.discover()).events.length, 1)
})
test('registered network live module emits proxy HLS refs without signed media URLs or fake posters', async () => {
  assert.equal(getModule('iqiyi-sports'), module)
  assert.equal(resolverFor('iqiyi-sports-1200050820'), module)
  assert.equal(resolverFor('iqiyi-sports-1200050820/extra'), null)
  assert.equal(module.category, 'live')
  const result = await module.fetch({}, { filterPlayable: async items => ({ items, warnings: [], skipped: [] }), catalog: { discover: async () => ({ events: [event], warnings: [] }) } })
  const channel = result.groups[0].dataList[0]
  assert.equal(channel.proxyHls, true); assert.equal(channel.catchup, 'none'); assert.equal(channel.logo, '')
  assert.equal(channel.deferredRef, 'iqiyi-sports-1200050820'); assert.equal(channel.url, undefined)
})
test('highest compatible stream is H264 1080p50, manifests stay fresh, and tickets renew after four minutes', async () => {
  const { state, runtime } = setup()
  const first = await runtime.resolve('iqiyi-sports-' + event.id), second = await runtime.resolve('iqiyi-sports-' + event.id)
  assert.ok(first.url.endsWith('/610.m3u8')); assert.match(first.desc, /50帧/)
  assert.notEqual(first.manifestText, second.manifestText); assert.equal(state.captures, 1)
  assert.deepEqual(first.upstreamHeaders('https://spqcloudcdncnc.inter.71edge.com/sample.ts').Referer, event.officialPage)
  assert.throws(() => first.upstreamHeaders('https://example.com/media.ts'))
  state.clock += 240001; await runtime.resolve('iqiyi-sports-' + event.id); assert.equal(state.captures, 2)
  state.http403 = true; await runtime.resolve('iqiyi-sports-' + event.id); assert.equal(state.captures, 3)
  state.events = []; assert.equal((await runtime.resolve('iqiyi-sports-' + event.id)).url, '')
})
test('authorization is rechecked in the background before the four-minute hard expiry', async () => {
  const { state, runtime } = setup()
  await runtime.resolve('iqiyi-sports-' + event.id); assert.equal(state.captures, 1)
  state.clock += 150001
  const served = await runtime.resolve('iqiyi-sports-' + event.id)
  assert.ok(served.url); assert.equal(state.captures, 2)
  await new Promise(r => setImmediate(r))
  // Renewed ticket now serves; no foreground capture at the old four-minute mark.
  state.clock += 100000; await runtime.resolve('iqiyi-sports-' + event.id); assert.equal(state.captures, 2)
  // Background recheck that lands on preview revokes the ticket; the account API confirms the expired login and raises the alert.
  state.clock += 60000; state.data = { ...authorized(), bossRet: { code: 'A00000', previewTime: 180, data: { prv: '1' } } }; state.account = 'expired'
  await runtime.resolve('iqiyi-sports-' + event.id); await new Promise(r => setImmediate(r))
  assert.match(runtime.credentialRejected(), /重新登录/)
  assert.equal((await runtime.resolve('iqiyi-sports-' + event.id)).url, '')
})
test('playback reads a stale catalog without waiting and refreshes it in the background', async () => {
  let clock = 0, release, scans = 0, gate = Promise.resolve()
  const catalog = createCatalog({ now: () => clock, fetchImpl: async url => {
    if (url === CONFIG_URL) { scans++; await gate; return Response.json({ retData: { menuConfigList: [{ url: 'https://sports.iqiyi.com/resource/json/pc/channel/menu_1.json' }] } }) }
    if (url.includes('/matchinfo_new/')) return Response.json({ resCode: '200', retData: { matchBaseInfo: row.matchBaseInfo } })
    return Response.json(catalogBody([row]))
  } })
  await catalog.discover(); assert.equal(scans, 1)
  clock += 120000; gate = new Promise(r => { release = r })
  const stale = await catalog.discover({ allowStale: true })
  assert.equal(stale.events[0].id, event.id); assert.equal(scans, 2)
  release(); await catalog.discover(); assert.equal(scans, 2)
  clock += 700000; gate = Promise.resolve()
  await catalog.discover({ allowStale: true }); assert.equal(scans, 3)
})
test('preview on an expired login is refused and reported; network errors do not masquerade as expired credentials; successful revalidation clears warning', async () => {
  const { state, runtime } = setup()
  state.data.bossRet = { code: 'A00000', previewTime: 180, data: { prv: '1' } }; state.account = 'expired'
  assert.equal((await runtime.resolve('iqiyi-sports-' + event.id)).url, '')
  await new Promise(r => setImmediate(r))
  assert.match(runtime.credentialRejected(), /重新登录/)
  state.failure = new Error('network timeout')
  await runtime.resolve('iqiyi-sports-' + event.id); assert.match(runtime.credentialRejected(), /重新登录/)
  delete state.failure; state.data = authorized(); state.revision++
  assert.ok((await runtime.resolve('iqiyi-sports-' + event.id)).url); assert.equal(runtime.credentialRejected(), '')
  state.revision++; state.data.program.liveDrmInfo.drm = true
  assert.match((await runtime.resolve('iqiyi-sports-' + event.id)).desc, /DRM/)
  state.data = authorized(); state.encrypted = true
  assert.match((await runtime.resolve('iqiyi-sports-' + event.id)).desc, /加密/)
})
test('free complete authorization works without a cookie, and foreign media URLs are refused', () => {
  const data = authorized(); data.boss = 0; delete data.bossRet
  assert.equal(selectAuthorizedStream(data, false).member, false)
  const paid = authorized(); delete paid.bossRet
  assert.throws(() => selectAuthorizedStream(paid, false), /完整播放授权/)
  assert.throws(() => validateMediaUrl('https://iqiyi.com.example.com/media.ts'))
  assert.throws(() => validateMediaUrl('http://127.0.0.1/media.ts'))
})
test('cookie import is domain restricted, preserves equals in values, and makes header session cookies locally persistent', () => {
  const cookie = parseCookies('Cookie: P00001=fixture=value; foo=bar')[0]
  assert.equal(cookie.value, 'fixture=value'); assert.ok(cookie.expires > Date.now() / 1000 + 29 * 86400)
  assert.equal(parseCookies(JSON.stringify([{ name: 'P00001', value: 'fixture', domain: '.iqiyi.com', httpOnly: true }]))[0].httpOnly, true)
  assert.throws(() => parseCookies('foo=bar'), /P00001/)
  assert.throws(() => parseCookies('P00001=a\nOther=b'), /一行/)
  assert.throws(() => parseCookies(JSON.stringify([{ name: 'P00001', value: 'fixture', domain: '.evil.com' }])), /iqiyi/)
})

// Official 2026-10-17 sports cards: separate jumpInfoLived / jumpInfoHighlight.
const replayJump = { iqiyiPC: 'https://sports.iqiyi.com/resource/pcw/play/16ufymbi2ew', qipuid: '4223102379481300' }
const highlightJump = { iqiyiPC: 'https://sports.iqiyi.com/resource/pcw/play/qstb9ce7xc', qipuid: '2778401687812300' }
const endedCard = { commonBaseInfo: { type: 'lived' }, matchBaseInfo: { title: '朗斯vs葡萄牙体育', status: '2', matchRoomStartTime: '2026-10-14 00:40' },
  jumpInfoLived: replayJump, jumpInfoHighlight: highlightJump }
const clipCard = { commonBaseInfo: { type: 'V', qipuid: highlightJump.qipuid, customerMakerName: '集锦', payInfo: { isFree: '1' } },
  specialBaseInfo: { title: '【集锦】朗斯0-2葡萄牙体育', publishTime: '2026-10-14 03:20:00' }, jumpInfo: highlightJump }
function vodCapture(event, overrides = {}) {
  return { code: 'A00000', hasLogin: false, data: { tvid: event.qipuId, program: { video: [{
    code: 2, ff: 'ts', bid: 500, drmType: 1, duration: 4, isPreview: 0,
    m3u8: hls(1) + '#EXT-X-ENDLIST\n', ...overrides,
  }] } } }
}
test('VOD cards use explicit replay/highlight markers, deduplicate video IDs, retain dates and exclude news/foreign pages', async () => {
  const news = { ...clipCard, commonBaseInfo: { ...clipCard.commonBaseInfo, customerMakerName: '' }, specialBaseInfo: { title: '赛事新闻', publishTime: '2026-10-17' } }
  const foreign = { ...clipCard, jumpInfo: { ...highlightJump, iqiyiPC: 'https://example.com/play/123' } }
  const result = normalizeVods(catalogBody([endedCard, clipCard, news, foreign, endedCard]))
  assert.equal(result.length, 2)
  assert.deepEqual(new Set(result.map(e => e.kind)), new Set(['replay', 'highlight']))
  const replay = result.find(e => e.kind === 'replay')
  assert.equal(replay.qipuId, replayJump.qipuid)
  assert.equal(replay.id, 'vod-' + replayJump.qipuid)
  assert.equal(eventName(replay), '[回放] 10月14日 朗斯vs葡萄牙体育')
  assert.match(eventName(event), /^\[直播\]/)
  const moduleResult = await module.fetch({}, { filterPlayable: async items => ({ items, warnings: [], skipped: [] }), catalog: { discover: async () => ({ events: [event], vods: result, warnings: [] }) } })
  assert.equal(moduleResult.groups.length, 1); assert.equal(moduleResult.groups[0].name, '爱奇艺体育')
  assert.equal(moduleResult.groups[0].dataList.length, 3)
  assert.equal(moduleResult.groups[0].dataList[1].deferredRef, 'iqiyi-sports-vod-' + replayJump.qipuid)
  assert.equal(resolverFor('iqiyi-sports-vod-' + replayJump.qipuid), module)
  assert.equal(resolverFor('iqiyi-sports-vod-123/evil'), null)
})
test('VOD resolver returns a finite seekable HLS from the official player and renews its ticket on expiry', async () => {
  const vod = normalizeVods(catalogBody([endedCard]))[0]
  let clock = 0, captures = 0
  const auth = { revision: () => 0, flow: { status: () => ({}) }, capture: async () => { captures++; return vodCapture(vod) }, shutdown: async () => {} }
  const runtime = createRuntime({ catalog: { discover: async () => ({ events: [], vods: [vod] }) }, auth, now: () => clock,
    fetchImpl: async () => { throw new Error('inline VOD must not fetch an invented manifest URL') } })
  const result = await runtime.resolve('iqiyi-sports-' + vod.id)
  assert.match(result.manifestText, /#EXT-X-ENDLIST/)
  assert.match(result.manifestText, /#EXT-X-PLAYLIST-TYPE:VOD/)
  assert.doesNotMatch(result.desc, /50帧/)
  await runtime.resolve('iqiyi-sports-' + vod.id); assert.equal(captures, 1)
  clock += 240001; await runtime.resolve('iqiyi-sports-' + vod.id); assert.equal(captures, 2)
})
test('VOD rejects mismatched IDs, partial previews, DRM and foreign segments without treating server errors as expired credentials', () => {
  const vod = normalizeVods(catalogBody([endedCard]))[0]
  assert.equal(selectVodStream(vodCapture(vod), vod).duration, 4)
  assert.throws(() => selectVodStream(vodCapture({ ...vod, qipuId: '123' }), vod), /不一致/)
  assert.throws(() => selectVodStream(vodCapture(vod, { isPreview: 1 }), vod), e => e.credential === true)
  assert.throws(() => selectVodStream(vodCapture(vod, { duration: 180 }), vod), /未获得完整观看权益/)
  assert.throws(() => selectVodStream(vodCapture(vod, { drmType: 2 }), vod), /DRM/)
  assert.throws(() => selectVodStream(vodCapture(vod, { m3u8: '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="license"\n#EXT-X-ENDLIST' }), vod), /加密/)
  assert.throws(() => selectVodStream(vodCapture(vod, { m3u8: hls(1).replace('spqcloudcdncnc.inter.71edge.com', 'evil.com') + '#EXT-X-ENDLIST' }), vod), /CDN/)
  assert.throws(() => selectVodStream({ code: 'SERVER_ERROR' }, vod), e => !e.credential)
})
test('catalog merges and sorts VOD from ordinary menus and nested topics, leaving live detail verification separate', async () => {
  const menu = 'https://sports.iqiyi.com/resource/json/pc/channel/menu_123.json'
  const catalog = createCatalog({ fetchImpl: async url => Response.json(url === CONFIG_URL
    ? { retData: { menuConfigList: [{ url: menu }] } } : catalogBody([clipCard, endedCard])) })
  const result = await catalog.discover()
  assert.equal(result.events.length, 0); assert.equal(result.vods.length, 2)
  assert.ok(result.vods[0].publishedAt >= result.vods[1].publishedAt)
})

test('browser capture keeps live/free response shape and captures only the requested VOD dash response', async () => {
  let listener, mode, calls = 0
  const page = { on: (_event, fn) => { listener = fn }, cookies: async () => [], close: async () => {},
    goto: async () => {
      calls++
      const data = mode.kind ? vodCapture(mode) : { data: { streams: authorized().streams, boss: 0 } }
      const url = mode.kind ? `https://cache.video.iqiyi.com/dash?tvid=${mode.qipuId}` : 'https://live.video.iqiyi.com/live?lp=fixture'
      await listener({ url: () => url, text: async () => JSON.stringify(data) })
    } }
  const browser = { connected: true, on: () => {}, defaultBrowserContext: () => ({ newPage: async () => page }) }
  const auth = createBrowserAuth({ profile: '/tmp/iptv-iqiyi-auth-fixture', launchImpl: async () => browser, closeImpl: async () => {} })
  mode = { ...event, free: true }
  const live = await auth.capture(mode)
  assert.equal(live.data.boss, 0); assert.ok(live.data.streams.length)
  mode = normalizeVods(catalogBody([endedCard]))[0]
  const vod = await auth.capture(mode)
  assert.equal(vod.code, 'A00000'); assert.equal(String(vod.data.tvid), mode.qipuId)
  assert.equal(calls, 2)
  await auth.shutdown()
})

test('VOD login validation checks official account status instead of accepting an arbitrary cookie on public replays', async () => {
  const vod = normalizeVods(catalogBody([endedCard]))[0]
  let listener, valid = false, preview = false
  const page = { on: (_event, fn) => { listener = fn }, close: async () => {}, cookies: async () => [{ name: 'P00001', value: 'fixture' }],
    evaluate: async () => ({ ok: true, code: valid ? 'A00000' : 'P00100', hasUser: valid }),
    goto: async url => {
      if (url.includes('/resource/pc/index_pc.html')) return
      await listener({ url: () => `https://cache.video.iqiyi.com/dash?tvid=${vod.qipuId}`, text: async () => JSON.stringify(vodCapture(vod, preview ? { duration: 5650 } : {})) })
    } }
  const browser = { connected: true, on: () => {}, defaultBrowserContext: () => ({ newPage: async () => page }) }
  const auth = createBrowserAuth({ getEvent: async () => vod, profile: '/tmp/iptv-iqiyi-auth-fixture', launchImpl: async () => browser, closeImpl: async () => {} })
  assert.equal((await auth.flow.check()).authenticated, false)
  valid = true
  assert.equal((await auth.flow.check()).authenticated, true)
  preview = true
  const restricted = await auth.flow.check()
  assert.equal(restricted.authenticated, true); assert.equal(restricted.entitled, false)
  assert.match(restricted.message, /账号登录有效/)
  await auth.shutdown()
})

test('browser status API preserves content entitlement separately from login and strips unapproved fields', async () => {
  const { getBrowserLoginStatusAPI } = await import('../utils/extractorsAPI.js')
  const original = module.browserLoginFlow.status
  module.browserLoginFlow.status = async () => ({ authenticated: true, entitled: false, status: 'authenticated', message: '账号有效，当前回放需额外权益', secret: 'fixture' })
  try {
    const result = await getBrowserLoginStatusAPI('iqiyi-sports')
    assert.equal(result.success, true); assert.equal(result.data.authenticated, true)
    assert.equal(result.data.entitled, false); assert.equal(result.data.secret, undefined)
  } finally { module.browserLoginFlow.status = original }
})

test('eligibility hides previews and network-unknown entries, caches checks and rechecks after account changes', async () => {
  const { createEligibility } = await import('../extractors/iqiyi-sports/eligibility.js')
  let clock = 0, calls = 0, changed = false
  const items = ['allowed', 'preview', 'timeout'].map(id => ({ id, kind: 'replay' }))
  const filter = createEligibility({ now: () => clock, delay: async () => {}, probe: async item => {
    calls++
    return { status: item.id === 'timeout' ? 'unknown' : item.id === 'allowed' && !changed ? 'allowed' : 'denied', reason: '仅获试看' }
  } })
  let result = await filter.filter(items, { waitMs: 100 })
  assert.deepEqual(result.items.map(i => i.id), ['allowed'])
  assert.equal(result.skipped.length, 1); assert.equal(result.unknown, 1)
  await filter.filter(items, { waitMs: 100 }); assert.equal(calls, 3)
  clock += 60001
  await filter.filter(items, { waitMs: 100 }); assert.equal(calls, 4, '网络检查失败只短期缓存，不永久当作无权')
  changed = true; filter.reset()
  result = await filter.filter(items, { waitMs: 100 })
  assert.equal(result.items.length, 0); assert.equal(result.skipped.length, 2)
  await filter.shutdown()
})
test('eligibility ignores in-flight results from the previous account and does not duplicate active probes', async () => {
  const { createEligibility } = await import('../extractors/iqiyi-sports/eligibility.js')
  let finishOld, calls = 0
  const gate = new Promise(resolve => { finishOld = resolve })
  const filter = createEligibility({ delay: async () => {}, probe: async () => ++calls === 1 ? gate : { status: 'denied', reason: '新账号无权' } })
  const items = [{ id: 'vod-123', kind: 'replay' }]
  await filter.filter(items, { waitMs: 0 })
  await filter.filter(items, { waitMs: 0 }); assert.equal(calls, 1)
  filter.reset()
  await filter.filter(items, { waitMs: 0 })
  finishOld({ status: 'allowed' })
  await new Promise(resolve => setImmediate(resolve))
  const result = await filter.filter(items, { waitMs: 100 })
  assert.equal(result.items.length, 0); assert.equal(result.skipped.length, 1)
  assert.equal(calls, 2)
  await filter.shutdown()
})
test('a transient failed recheck never republishes an expired positive result', async () => {
  const { createEligibility } = await import('../extractors/iqiyi-sports/eligibility.js')
  let clock = 0, fail = false
  const filter = createEligibility({ now: () => clock, probe: async () => { if (fail) throw new Error('timeout'); return { status: 'allowed' } } })
  const item = { id: 'live-1' }
  assert.equal((await filter.filter([item], { waitMs: 100 })).items.length, 1)
  clock += 120001; fail = true
  const result = await filter.filter([item], { waitMs: 100 })
  assert.equal(result.items.length, 0); assert.equal(result.unknown, 1)
  await filter.shutdown()
})
test('the production module outputs only streams verified as complete, including free-labelled content', async () => {
  const vods = normalizeVods(catalogBody([endedCard]))
  const good = vods[0], bad = vods[1]
  const auth = { revision: () => 0, flow: { status: () => ({}) }, shutdown: async () => {}, capture: async item => vodCapture(item, item.id === bad.id ? { duration: 180 } : {}) }
  const catalog = { discover: async () => ({ events: [], vods, warnings: [] }) }
  const runtime = createRuntime({ catalog, auth, eligibilityWaitMs: 1000 })
  const result = await module.fetch({}, { catalog, filterPlayable: runtime.filterPlayable })
  assert.deepEqual(result.groups[0].dataList.map(c => c.deferredRef), ['iqiyi-sports-' + good.id])
  assert.equal(result.meta.skipped.length, 1, '免费标签也不能让不完整片段漏过过滤')
  await runtime.shutdown()
  const missing = await module.fetch({}, { catalog: { discover: async () => { throw new Error('offline') } } })
  assert.equal(missing.groups[0].dataList.length, 0)
  assert.match(missing.meta.warnings[0], /未核验/)
})

test('clearing an unused eligibility cache never starts production scans or publishes callbacks', async () => {
  const { createEligibility } = await import('../extractors/iqiyi-sports/eligibility.js')
  let updates = 0
  const filter = createEligibility({ probe: async () => { throw new Error('not requested') }, onUpdate: () => { updates++ } })
  filter.reset()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(updates, 0)
  await filter.shutdown()
})

test('playback and background renewal refusals immediately remove a formerly allowed entry', async () => {
  const { state, runtime } = setup()
  await runtime.resolve('iqiyi-sports-' + event.id)
  assert.equal((await runtime.filterPlayable([event])).items.length, 1)
  state.data.bossRet = { code: 'A00000', previewTime: 180, data: { prv: '1' } }
  state.clock += 150001
  await runtime.resolve('iqiyi-sports-' + event.id)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await runtime.filterPlayable([event])).items.length, 0)
  await runtime.shutdown()
})

test('visible login is exclusive and subsequent checks and captures reopen the profile headlessly', async () => {
  const launches = [], browsers = []
  let closed = 0
  const makePage = () => {
    let listener
    return { on: (_name, fn) => { listener = fn }, isClosed: () => false,
      setViewport: async () => {}, bringToFront: async () => {}, close: async () => {},
      cookies: async () => [{ name: 'P00001', value: 'fixture' }],
      goto: async () => { if (listener) await listener({ url: () => 'https://live.video.iqiyi.com/live', text: async () => JSON.stringify({ data: authorized() }) }) },
    }
  }
  let candidate = event
  const auth = createBrowserAuth({ getEvent: async () => candidate, profile: '/tmp/iptv-iqiyi-auth-fixture',
    launchImpl: async options => {
      launches.push(options.headless)
      const context = { newPage: async () => makePage() }
      const browser = { connected: true, on: () => {}, newPage: async () => makePage(), defaultBrowserContext: () => context }
      browsers.push(browser)
      return browser
    }, closeImpl: async browser => { browser.connected = false; closed++ },
  })
  await auth.flow.start()
  assert.equal(auth.flow.status().visible, true)
  await assert.rejects(auth.capture(event), /完成或关闭登录窗口/)
  const checked = await auth.flow.check()
  assert.equal(checked.visible, false)
  assert.deepEqual(launches, [false, true], 'check must switch from visible to headless')
  await Promise.all([auth.capture(event), auth.capture(event)])
  assert.equal(launches.length, 2, 'batch probes reuse only the headless session')
  await auth.flow.start()
  await auth.flow.cancel()
  assert.equal(auth.flow.status().visible, false)
  assert.equal(auth.flow.status().running, false)
  await auth.capture(event)
  assert.equal(launches.at(-1), true)
  await auth.flow.start()
  candidate = null
  const noEvent = await auth.flow.check()
  assert.equal(noEvent.visible, false)
  assert.notEqual(noEvent.status, 'waiting', 'empty catalogs must not leave a visible login session or pause scans forever')
  assert.ok(closed >= 3)
  await auth.shutdown()
})

test('official payment options remain nonexclusive and never prove anonymous access or purchase history', () => {
  const rights = { isFree: '1', isPublicRight: '1', isSingleRight: '1', isSpecificRight: '1' }
  const options = entitlementOptions(rights)
  assert.deepEqual(options, ['会员', '单场付费', '专项权益'])
  assert.equal(accessLabel({ free: true }), '权益已授权', 'catalog free alone is insufficient')
  assert.equal(accessLabel({ entitlementOptions: options }), '会员 / 单场付费 / 专项权益')
  assert.equal(accessLabel({ entitlementOptions: options }, true), '免费免登录')
  const normalized = normalizeEvents(catalogBody([{ ...row, commonBaseInfo: { payInfo: rights } }]))[0]
  assert.deepEqual(normalized.entitlementOptions, options)
  const vod = normalizeVods(catalogBody([{ ...clipCard, commonBaseInfo: { ...clipCard.commonBaseInfo, payInfo: rights } }]))[0]
  assert.deepEqual(vod.entitlementOptions, options)
  assert.match(eventName({ ...vod, accessLabel: '免费免登录' }), /^\[集锦\] \[免费免登录\]/)
})

test('free labels require a complete anonymous probe, failed probes preserve paid classification and previews stay hidden', async () => {
  const base = normalizeVods(catalogBody([endedCard]))[0]
  const items = ['free', 'paid', 'preview'].map((key, i) => ({ ...base, id: `vod-${i + 1}`, qipuId: String(i + 1), title: key, free: true,
    entitlementOptions: key === 'paid' ? ['单场付费', '专项权益'] : [] }))
  let anonymousCalls = 0, ownerCalls = 0
  const auth = { revision: () => 0, flow: { status: () => ({}) }, shutdown: async () => {},
    captureAnonymous: async item => { anonymousCalls++; return vodCapture(item, item.title === 'free' ? {} : { isPreview: 1 }) },
    capture: async item => { ownerCalls++; return { ...vodCapture(item, item.title === 'preview' ? { isPreview: 1 } : {}), hasLogin: true } },
  }
  const runtime = createRuntime({ auth, catalog: { discover: async () => ({ events: [], vods: items }) } })
  const result = await runtime.filterPlayable(items)
  assert.deepEqual(result.items.map(i => i.accessLabel), ['免费免登录', '单场付费 / 专项权益'])
  assert.equal(result.skipped.length, 1)
  assert.equal(anonymousCalls, 3); assert.equal(ownerCalls, 2)
  await runtime.shutdown()
})

test('anonymous capture uses and closes an isolated browser context without the persisted account', async () => {
  let isolated = 0, contextClosed = 0
  const makePage = () => {
    let listener
    return { on: (_event, fn) => { listener = fn }, close: async () => {}, cookies: async () => [],
      goto: async () => listener({ url: () => 'https://live.video.iqiyi.com/live', text: async () => JSON.stringify({ data: { boss: 0, streams: authorized().streams } }) }) }
  }
  const browser = { connected: true, on: () => {},
    defaultBrowserContext: () => { throw new Error('anonymous probe must not read owner context') },
    createBrowserContext: async () => { isolated++; return { newPage: async () => makePage(), close: async () => { contextClosed++ } } },
  }
  const auth = createBrowserAuth({ profile: '/tmp/iptv-iqiyi-auth-fixture', launchImpl: async () => browser, closeImpl: async () => {} })
  const result = await auth.captureAnonymous({ ...event, free: true })
  assert.equal(result.hasLogin, false)
  assert.equal(selectAuthorizedStream(result.data, result.hasLogin).member, false)
  assert.equal(isolated, 1); assert.equal(contextClosed, 1)
  await auth.shutdown()
})

test('playback keeps the probed viewing label after the short live record expired', async () => {
  const { createEligibility } = await import('../extractors/iqiyi-sports/eligibility.js')
  let clock = 0
  const filter = createEligibility({ now: () => clock, delay: async () => {}, probe: async () => ({ status: 'allowed', accessLabel: '免费免登录' }) })
  const item = { id: 'live-free' }
  assert.equal((await filter.filter([item], { waitMs: 100 })).items[0].accessLabel, '免费免登录')
  clock += 180000
  filter.record(item, 'allowed')
  assert.equal((await filter.filter([item], { waitMs: 100 })).items[0].accessLabel, '免费免登录', '观看中的免费赛事不能改名为「权益已授权」')
  filter.record(item, 'unknown', '官方节目清单超时'); filter.record(item, 'allowed')
  assert.equal((await filter.filter([item], { waitMs: 100 })).items[0].accessLabel, '免费免登录', '一次普通失败后恢复播放也保留标签')
  filter.reset(); filter.record(item, 'allowed')
  assert.equal((await filter.filter([item], { waitMs: 100 })).items[0].accessLabel, '权益已授权', '换账号后不沿用旧账号的核验标签')
  await filter.shutdown()
})

test('an expired positive result stays listed only while its recheck runs, then follows the new verdict', async () => {
  const { createEligibility } = await import('../extractors/iqiyi-sports/eligibility.js')
  let clock = 0, gate, verdict = 'allowed'
  const probe = async () => {
    if (gate) await gate.promise
    return verdict === 'allowed' ? { status: 'allowed', accessLabel: '会员' } : { status: 'denied', reason: '缺少权益' }
  }
  const hold = () => { let resolve; const promise = new Promise(r => { resolve = r }); gate = { promise, resolve } }
  const filter = createEligibility({ now: () => clock, delay: async () => {}, probe })
  const item = { id: 'live-1' }
  assert.equal((await filter.filter([item], { waitMs: 100 })).items.length, 1)
  clock += 300000; hold(); verdict = 'denied'
  let result = await filter.filter([item], { waitMs: 10 })
  assert.deepEqual(result.items.map(i => i.accessLabel), ['会员'], '五分钟刷新时官网页面慢，不能把在播直播从列表拿掉')
  assert.equal(result.unknown, 0); assert.equal(result.warnings.length, 0)
  gate.resolve(); gate = undefined
  result = await filter.filter([item], { waitMs: 100 })
  assert.equal(result.items.length, 0, '复核被拒后照常隐藏'); assert.equal(result.skipped.length, 1)
  await filter.shutdown()

  verdict = 'allowed'
  const stuck = createEligibility({ now: () => clock, delay: async () => {}, probe })
  assert.equal((await stuck.filter([item], { waitMs: 100 })).items.length, 1)
  clock += 120000 + 10 * 60 * 1000 + 1; hold()
  result = await stuck.filter([item], { waitMs: 10 })
  assert.equal(result.items.length, 0, '复核卡住超过宽限期不再沿用旧结论'); assert.equal(result.unknown, 1)
  gate.resolve(); gate = undefined
  await stuck.shutdown()
})

test('a valid account without rights to the chosen paid live room is not reported as an expired login', async () => {
  let listener, valid = true, accountChecks = 0
  const preview = { ...authorized(), bossRet: { code: 'A00000', previewTime: 180, data: { prv: '1' } } }
  const page = { on: (_event, fn) => { listener = fn }, close: async () => {}, cookies: async () => [{ name: 'P00001', value: 'fixture' }],
    evaluate: async () => { accountChecks++; return { ok: true, code: valid ? 'A00000' : 'P00100', hasUser: valid } },
    goto: async url => {
      if (url.includes('/resource/pc/index_pc.html')) return
      await listener({ url: () => 'https://live.video.iqiyi.com/live', text: async () => JSON.stringify({ data: preview }) })
    } }
  const browser = { connected: true, on: () => {}, defaultBrowserContext: () => ({ newPage: async () => page }),
    createBrowserContext: async () => ({ newPage: async () => page, setCookie: async () => {}, close: async () => {} }) }
  const auth = createBrowserAuth({ getEvent: async () => event, profile: '/tmp/iptv-iqiyi-auth-fixture', launchImpl: async () => browser, closeImpl: async () => {} })
  const restricted = await auth.flow.check()
  assert.equal(restricted.status, 'authenticated'); assert.equal(restricted.authenticated, true)
  assert.equal(restricted.entitled, false); assert.match(restricted.message, /账号登录有效/)
  assert.equal(accountChecks, 1)
  valid = false
  const expired = await auth.flow.check()
  assert.equal(expired.status, 'error'); assert.equal(expired.authenticated, false)
  assert.match(expired.message, /重新登录/)
  await assert.rejects(auth.flow.import('P00001=expired; QC005=fixture'), /未通过官方登录校验/)
  await auth.shutdown()
})

// A still-valid account without this room's rights gets the same preview as an expired login.
const previewRet = () => ({ code: 'A00000', previewTime: 180, data: { prv: '1' } })
const settle = () => new Promise(resolve => setImmediate(resolve))
const promptly = (promise, label) => {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 1000) })]).finally(() => clearTimeout(timer))
}
const ref = 'iqiyi-sports-' + event.id
test('a playback preview on a still-valid account hides the entry without a login alert; the account check never holds the manifest poll and runs at most every ten minutes', async () => {
  const { state, runtime } = setup()
  let release
  state.accountGate = new Promise(resolve => { release = resolve })
  state.data.bossRet = previewRet()
  const refused = await promptly(runtime.resolve(ref), '清单请求不能等账号页面加载')
  assert.equal(refused.url, ''); assert.match(refused.desc, /试看/)
  assert.equal(state.accountChecks, 1); assert.equal(runtime.credentialRejected(), '')
  release(); await settle()
  assert.equal(runtime.credentialRejected(), '', '账号有效、只是这场没有权益，不报登录失效')
  assert.equal((await runtime.filterPlayable([event])).items.length, 0, '照常隐藏')
  for (let i = 0; i < 3; i++) await runtime.resolve(ref)
  assert.equal(state.accountChecks, 1, '播放器反复重试不反复开账号页')
  state.clock += 10 * 60 * 1000
  await runtime.resolve(ref); await settle()
  assert.equal(state.accountChecks, 2); assert.equal(runtime.credentialRejected(), '')
  await runtime.shutdown()
})
test('the login alert waits for the official account API to confirm an expired login; inconclusive checks and a previous account raise nothing', async () => {
  const { state, runtime } = setup()
  state.failure = new Error('network timeout'); await runtime.resolve(ref); delete state.failure
  state.data.program.liveDrmInfo.drm = true; await runtime.resolve(ref); state.data = authorized()
  assert.equal(state.accountChecks, 0, '网络和 DRM 错误不问账号接口')
  state.data.bossRet = previewRet(); state.account = 'unknown'
  await runtime.resolve(ref); await settle()
  assert.equal(state.accountChecks, 1); assert.equal(runtime.credentialRejected(), '', '账号接口没答上来不算登录失效')
  state.clock += 10 * 60 * 1000; state.account = 'expired'
  await runtime.resolve(ref); await settle()
  assert.match(runtime.credentialRejected(), /重新登录/)
  state.failure = new Error('network timeout')
  await runtime.resolve(ref); assert.match(runtime.credentialRejected(), /重新登录/, '之后的网络错误不清掉已确认的提醒')
  delete state.failure
  let release
  state.accountGate = new Promise(resolve => { release = resolve })
  state.revision++
  await runtime.resolve(ref)
  assert.equal(runtime.credentialRejected(), ''); assert.equal(state.accountChecks, 3, '换账号后不沿用十分钟间隔')
  state.revision++; release(); await settle()
  assert.equal(runtime.credentialRejected(), '', '旧账号的核验结果作废')
  await runtime.shutdown()
})
test('a background renewal that lands on a preview revokes the ticket and alerts only for a confirmed expired login', async () => {
  const { state, runtime } = setup()
  await runtime.resolve(ref)
  state.clock += 150001; state.data = { ...authorized(), bossRet: previewRet() }
  assert.ok((await runtime.resolve(ref)).url, '复核在后台跑，当前清单照常返回')
  await settle()
  assert.equal(state.accountChecks, 1); assert.equal(runtime.credentialRejected(), '')
  assert.equal((await runtime.resolve(ref)).url, '', '复核被拒后撤票')
  state.data = authorized(); state.account = 'expired'; state.clock += 10 * 60 * 1000
  assert.ok((await runtime.resolve(ref)).url); assert.equal(state.accountChecks, 1)
  state.clock += 150001; state.data = { ...authorized(), bossRet: previewRet() }
  await runtime.resolve(ref); await settle()
  assert.equal(state.accountChecks, 2); assert.match(runtime.credentialRejected(), /重新登录/)
  await runtime.shutdown()
})
test('the account helper reads the saved profile, treats only official P00100 as expired and stays out of the login window', async () => {
  let code = 'A00000', evaluations = 0
  const page = { on: () => {}, close: async () => {}, goto: async () => {}, isClosed: () => false, setViewport: async () => {}, bringToFront: async () => {},
    evaluate: async () => { evaluations++; return code === 'down' ? { ok: false, code: '', hasUser: false } : { ok: true, code, hasUser: code === 'A00000' } } }
  const browser = { connected: true, on: () => {}, newPage: async () => page, defaultBrowserContext: () => ({ newPage: async () => page }) }
  const auth = createBrowserAuth({ getEvent: async () => event, profile: '/tmp/iptv-iqiyi-auth-fixture', launchImpl: async () => browser, closeImpl: async () => {} })
  await auth.checkAccount()
  code = 'P00100'; await assert.rejects(auth.checkAccount(), e => e.credential === true && /重新登录/.test(e.message))
  code = 'down'; await assert.rejects(auth.checkAccount(), e => !e.credential)
  await auth.flow.start()
  await assert.rejects(auth.checkAccount(), /登录操作/)
  assert.equal(evaluations, 3)
  await auth.shutdown()
})
