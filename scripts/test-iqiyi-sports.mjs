import test from 'node:test'
import assert from 'node:assert/strict'
import { createCatalog, CONFIG_URL, normalizeEvents, selectAuthorizedStream, validateMediaUrl } from '../extractors/iqiyi-sports/api.js'
import { parseCookies } from '../extractors/iqiyi-sports/cookies.js'
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
  const state = { clock: 1000000, captures: 0, manifests: 0, revision: 0, data: authorized(), events: [event] }
  const auth = { revision: () => state.revision, flow: Object.fromEntries(['status', 'check', 'start', 'import', 'close', 'cancel'].map(k => [k, () => ({ status: 'idle', authenticated: false })])),
    async capture() { state.captures++; if (state.failure) throw state.failure; return { data: state.data, hasLogin: state.hasLogin !== false } }, shutdown: async () => {} }
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
test('registered account module emits proxy HLS refs without signed media URLs or fake posters', async () => {
  assert.equal(getModule('iqiyi-sports'), module)
  assert.equal(resolverFor('iqiyi-sports-1200050820'), module)
  assert.equal(resolverFor('iqiyi-sports-1200050820/extra'), null)
  assert.equal(module.category, 'account')
  const result = await module.fetch({}, { catalog: { discover: async () => ({ events: [event], warnings: [] }) } })
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
test('preview is refused and reported; network errors do not masquerade as expired credentials; successful revalidation clears warning', async () => {
  const { state, runtime } = setup()
  state.data.bossRet = { code: 'A00000', previewTime: 180, data: { prv: '1' } }
  assert.equal((await runtime.resolve('iqiyi-sports-' + event.id)).url, '')
  assert.match(runtime.credentialRejected(), /试看/)
  state.failure = new Error('network timeout')
  await runtime.resolve('iqiyi-sports-' + event.id); assert.match(runtime.credentialRejected(), /试看/)
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
  assert.throws(() => validateMediaUrl('https://iqiyi.com.example.com/media.ts'))
  assert.throws(() => validateMediaUrl('http://127.0.0.1/media.ts'))
})
test('cookie import is domain restricted, preserves equals in values, and makes header session cookies locally persistent', () => {
  const cookie = parseCookies('Cookie: P00001=fixture=value; foo=bar')[0]
  assert.equal(cookie.value, 'fixture=value'); assert.ok(cookie.expires > Date.now() / 1000)
  assert.equal(parseCookies(JSON.stringify([{ name: 'P00001', value: 'fixture', domain: '.iqiyi.com', httpOnly: true }]))[0].httpOnly, true)
  assert.throws(() => parseCookies('foo=bar'), /P00001/)
  assert.throws(() => parseCookies('P00001=a\nOther=b'), /一行/)
  assert.throws(() => parseCookies(JSON.stringify([{ name: 'P00001', value: 'fixture', domain: '.evil.com' }])), /iqiyi/)
})
