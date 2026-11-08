import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'iptv-xumo-test-'))
process.env.mdataDir = dir; process.env.mblank = 'true'; process.env.mbuiltInSourcesUrl = ''
after(() => rmSync(dir, { recursive: true, force: true }))
const { Provider, INTERVALS, claimsRef, parseCatalog, cleanEntry } = await import('../extractors/xumo/api.js')
const { Store, seed } = await import('../extractors/xumo/store.js')
const { exclusionReason } = await import('../extractors/xumo/policy.js')
const { highestPlaylist, variantsIn } = await import('../extractors/xumo/hls.js')
const { createTransport, API_HOSTS, MEDIA_HOSTS, safeUrl } = await import('../extractors/xumo/transport.js')
const { default: module, buildGroups } = await import('../extractors/xumo/index.js')
const { resolverFor, proxyModules } = await import('../extractors/registry.js')
const { ExtractorManager } = await import('../utils/extractorManager.js')
const { inlineResolvedManifest } = await import('../utils/appUtils.js')
const { toProxyManifest, lookup } = await import('../utils/hlsProxy.js')
const channel = (id = 99951134, name = 'UFC') => ({ id, name, slug: 'channel-' + id, description: 'Live entertainment', genreId: 67, genre: 'Sports', entry: `https://dbrb49pjoymg4.cloudfront.net/${id}/master.m3u8` })
const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="en.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Spanish",LANGUAGE="es",URI="es.m3u8"\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",URI="subs.m3u8"\n#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",NAME="English",INSTREAM-ID="CC1"\n#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=1280x720,FRAME-RATE=60\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,FRAME-RATE=30,AUDIO="audio",SUBTITLES="subs",CLOSED-CAPTIONS="cc"\nhigh.m3u8\n'
function setup(extra = {}) {
  const folder = mkdtempSync(join(dir, 'case-')), items = [channel(), channel(99991158, 'CBS News'), channel(99991282, 'Local Now'), channel(99951135, 'Sports')]
  const state = { items, calls: [], bad: new Set(), decoded: 0, now: Date.parse('2026-11-08T12:00Z'), ...extra }
  const initial = { schema: 1, generation: 1, catalogCount: items.length, publishedAt: new Date(state.now).toISOString(), channels: Object.fromEntries(items.map(c => [c.id, c])) }
  const store = new Store({ path: join(folder, 'state.json'), initial })
  store.publish(initial)
  const fetchImpl = async (raw, options = {}) => {
    const url = new URL(raw); state.calls.push({ url: url.href, method: options.method, headers: options.headers })
    if (state.offline) throw new Error('network unavailable')
    if (url.hostname === 'play.xumo.com') {
      if (state.catalogDown) return new Response('down', { status: 503 })
      return new Response(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ runtimeConfig: { XUMO_API_URL: 'valencia-app-mds.xumo.com' }, props: { pageProps: { page: { genres: [{ id: 67, name: 'Sports' }], channels: state.items.map(c => ({ ...c, genre: 67 })) } } } })}</script>`)
    }
    if (url.hostname === 'valencia-app-mds.xumo.com') {
      const id = Number(/channel\/(\d+)/.exec(url.pathname)?.[1]), c = state.items.find(c => c.id === id)
      if (state.drm) return Response.json({ ssaiStreamUrls: [{ url: c.entry, drm: true, mimeType: 'application/x-mpegURL' }], ssaiStreamUrl: c.entry })
      return Response.json({ ssaiStreamUrls: [{ url: c.entry, mimeType: 'application/x-mpegURL' }] })
    }
    if (state.bad.has(Number(url.pathname.split('/')[1]))) return new Response('down', { status: 503 })
    if (url.pathname.endsWith('master.m3u8')) return new Response(master)
    if (url.pathname.endsWith('.m3u8')) return new Response(`#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:${state.calls.length}\n#EXTINF:1,\n${state.calls.length}.ts\n`)
    return new Response(new Uint8Array([0x47, 1, 2]), { status: options.headers?.Range ? 206 : 200 })
  }
  const provider = new Provider({ store, fetchImpl, now: () => state.now, isEnabled: () => !state.disabled,
    decode: async () => { state.decoded++; if (state.decodeFails) throw new Error('bad sample') } })
  return { provider, store, state, fetchImpl }
}
test('海外模块默认关闭、代理覆盖完整、全部频道使用稳定本机入口', () => {
  assert.equal(module.defaultEnabled, false); assert.equal(module.category, 'overseas')
  assert.ok(proxyModules().includes(module)); assert.equal(module.channelHlsMode, 'proxy'); assert.equal(module.playbackRequiresEnabled, true)
  assert.equal(resolverFor('xumo-99951134'), module)
  for (const host of [...API_HOSTS, ...MEDIA_HOSTS]) assert.ok(module.proxyHosts.includes(host))
  for (const suffix of ['/x', '?x=1', '\n']) assert.equal(claimsRef('xumo-99951134' + suffix), false)
  const manager = new ExtractorManager(); assert.equal(manager.isModuleEnabled(module), false)
  manager.loaded = true; manager.config.masterSwitchRetired = true
  manager.config.modules.xumo = { enabled: true }
  manager.cache.modules.xumo = { groups: buildGroups(Object.values(seed.channels)), health: {} }
  const all = manager.getValidChannels().flatMap(g => g.dataList)
  assert.equal(all.length, 422); assert.ok(all.every(c => c.proxyHls && c.sourceId === 'xt:xumo' && c.catchup === 'none'))
  manager.config.modules.xumo.enabled = false; assert.equal(manager.getValidChannels().length, 0)
})
test('最高分辨率优先，同档帧率/码率优先；对应多音轨、WebVTT、CC 均经本机代理', async () => {
  const { provider } = setup()
  const result = await provider.resolve('xumo-99951134')
  assert.equal(variantsIn(result.manifestText).length, 1); assert.match(result.manifestText, /1920x1080/)
  const text = toProxyManifest(inlineResolvedManifest(result), 'xumo-99951134', undefined, undefined, result.upstreamUrlTransform)
  assert.match(text, /LANGUAGE="es"/); assert.match(text, /TYPE=SUBTITLES/); assert.match(text, /INSTREAM-ID="CC1"/); assert.doesNotMatch(text, /https?:\/\//)
  for (const key of text.matchAll(/(s[0-9a-f]{16})\./g)) assert.equal(lookup(key[1]).pid, 'xumo-99951134')
  const multi = master + '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,FRAME-RATE=60\nfast.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,FRAME-RATE=60\nbest.m3u8\n'
  assert.equal(variantsIn(highestPlaylist(multi, 'https://dbrb49pjoymg4.cloudfront.net/a/').text)[0].uri, 'https://dbrb49pjoymg4.cloudfront.net/a/best.m3u8')
})
test('每次新播放取会话，合并并发；不把临时清单写入磁盘', async () => {
  const { provider, store, state } = setup(); const before = readFileSync(store.path, 'utf8')
  await Promise.all([provider.resolve('xumo-99951134'), provider.resolve('xumo-99951134')])
  assert.equal(state.calls.length, 1)
  state.now += 6000; await provider.resolve('xumo-99951134'); assert.equal(state.calls.length, 2)
  assert.equal(readFileSync(store.path, 'utf8'), before)
})
test('每天更新、每六小时检查，调度持久化；读取未到期清单不请求上游', async () => {
  const { provider, store, state, fetchImpl } = setup()
  assert.equal(await provider.run('update'), true)
  assert.equal(provider.runtime.jobs.update.nextRunAt, state.now + INTERVALS.update)
  assert.equal(provider.runtime.jobs.check.nextRunAt, state.now + INTERVALS.check)
  const restarted = new Provider({ store, fetchImpl, now: () => state.now })
  const n = state.calls.length; restarted.poll(); assert.equal(state.calls.length, n)
  state.now += INTERVALS.check + 1; restarted.poll(); await restarted.inFlight
  assert.equal(restarted.runtime.jobs.check.lastSuccessAt, state.now)
})
test('目录失联、异常缩减、整批取流失败均保留快照字节，重启仍可用', async () => {
  for (const change of [{ catalogDown: true }, { offline: true }, { bad: new Set([99951134, 99991158, 99991282, 99951135]) }]) {
    const { provider, store, state } = setup(change), before = readFileSync(store.path, 'utf8')
    assert.equal(await provider.run('update'), false); assert.equal(readFileSync(store.path, 'utf8'), before)
    assert.equal(Object.keys(new Provider({ store }).channels()).length, 4)
    assert.equal(provider.runtime.jobs.update.nextRunAt, state.now + 1800000)
  }
  const { provider, store, state } = setup(), before = readFileSync(store.path, 'utf8')
  state.items = state.items.slice(0, 1); assert.equal(await provider.run('update'), false); assert.equal(readFileSync(store.path, 'utf8'), before)
})
test('单台失败保留；新频道先解码与推进验证，失败不加入', async () => {
  const { provider, state } = setup(); state.bad.add(99951134)
  state.items.push(channel(99951999, 'New Sports'))
  assert.equal(await provider.run('update'), true); assert.equal(state.decoded, 2)
  assert.equal(provider.runtime.channelHealth['99951134'].status, 'retained')
  assert.ok(provider.channels()['99951999'])
  state.items.push(channel(99951998, 'Other Sports')); state.decodeFails = true
  assert.equal(await provider.run('update'), true); assert.equal(provider.channels()['99951998'], undefined)
})
test('宗教频道从发现和播放双重排除；已缓存频道改为宗教内容立即阻止播放', async () => {
  for (const c of [channel(99951481, 'Renamed'), channel(99951999, 'Gospel TV'), { ...channel(), genreId: 768 }]) assert.ok(exclusionReason(c))
  assert.equal(exclusionReason(channel(99951999, 'Gabriel Iglesias')), '')
  assert.equal(exclusionReason({ ...channel(99991333, 'Dove Channel'), genreId: 768 }), '')
  assert.equal(Object.values(seed.channels).filter(exclusionReason).length, 0)
  const { provider, state } = setup(); state.items[0].description = 'Christian ministry'
  assert.equal(await provider.run('update'), true); assert.equal(provider.channels()['99951134'], undefined)
  await assert.rejects(provider.resolve('xumo-99951134'), /排除/)
})
test('下架需两次有效目录并相隔一天；重新出现后重新计时', async () => {
  const { provider, state } = setup(); const removed = state.items.shift()
  assert.equal(await provider.run('update'), true); assert.ok(provider.channels()[removed.id])
  state.now += INTERVALS.update + 1
  state.items.unshift(removed); await provider.run('update')
  state.items.shift(); await provider.run('update'); assert.ok(provider.channels()[removed.id])
  state.now += INTERVALS.update + 1; await provider.run('update'); assert.equal(provider.channels()[removed.id], undefined)
})
test('关闭后无新请求、无发布；后台分批任务检查主项目传入的实时开关', async () => {
  const { provider, state, store } = setup(), before = readFileSync(store.path, 'utf8')
  const baseCheck = provider.check.bind(provider)
  provider.check = async (...args) => { state.disabled = true; return baseCheck(...args) }
  await provider.run('update'); assert.equal(readFileSync(store.path, 'utf8'), before)
  const n = state.calls.length; provider.poll(); await assert.rejects(provider.resolve('xumo-99951134'), /关闭/); assert.equal(state.calls.length, n)
  const managerSource = readFileSync(new URL('../utils/extractorManager.js', import.meta.url), 'utf8')
  assert.match(managerSource, /isEnabled: \(\) => this\.isModuleEnabled\(module\)/)
})
test('快照损坏恢复备份，空快照与临时会话不能覆盖有效清单', async () => {
  const { provider, store } = setup(); await provider.run('update')
  writeFileSync(store.path, '{broken'); assert.equal(Object.keys(store.load().channels).length, 4)
  assert.throws(() => store.publish({ schema: 1, channels: {} }), /为空/)
  const value = structuredClone(seed); Object.values(value.channels)[0].entry = 'https://dbrb49pjoymg4.cloudfront.net/manifest/hash/prod/194a140c-0cf5-443e-b747-08bf621d75a8/0.m3u8'
  assert.throws(() => store.publish(value), /临时会话/)
})
test('官方接口 DRM 拒绝，SIMULCAST 之外不收；接口变更与任意 URL 拒绝', async () => {
  const { provider } = setup({ drm: true }); await assert.rejects(provider.entries(channel()), /DRM/)
  assert.throws(() => parseCatalog('changed'), /结构/)
  for (const url of ['https://127.0.0.1/a', 'http://dai.google.com/a', 'https://dai.google.com.evil.test/a']) assert.throws(() => safeUrl(url), /官方链路/)
  assert.equal(cleanEntry('https://dai.google.com/a?platform=[PLATFORM]&device=[IFA]&keep=1'), 'https://dai.google.com/a?platform=web&keep=1')
})
test('代理逐跳验证；子清单、字幕、Range、HEAD 共用出站且不退回客户端直连', async () => {
  const { fetchImpl, state } = setup(), io = createTransport({ fetchImpl })
  assert.equal((await io.media(channel().entry)).status, 200)
  assert.equal((await io.media('https://dai.google.com/a.vtt')).status, 200)
  assert.equal((await io.media('https://dai.google.com/a.ts', { headers: { Range: 'bytes=0-2' } })).status, 206)
  await io.media('https://dai.google.com/a.ts', { method: 'HEAD' }); assert.equal(state.calls.at(-1).method, 'HEAD')
  const redirect = createTransport({ fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://evil.test/a.m3u8' } }) })
  await assert.rejects(redirect.media(channel().entry), /官方链路/)
  const malformed = createTransport({ fetchImpl: async () => new Response('#EXTM3U\n#EXTINF:6,\nhttps://evil.test/video.ts\n') })
  await assert.rejects(malformed.media(channel().entry), /官方链路/)
})
test('变量、AES key、初始化段与媒体相对地址保留；DRM 与结束清单拒绝', () => {
  const source = '#EXTM3U\n#EXT-X-DEFINE:QUERYPARAM="token"\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:3\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\npart.m4s?token={$token}\n'
  const text = highestPlaylist(source, 'https://dai.google.com/live/playlist.m3u8?token=abc', safeUrl).text
  assert.match(text, /URI="https:\/\/dai.google.com\/live\/key"/); assert.match(text, /part.m4s\?token=abc/)
  assert.match(text, /#EXT-X-DEFINE:NAME="token",VALUE="abc"/)
  for (const bad of ['#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES\n', '#EXTM3U\n#EXTINF:6,\na.ts\n#EXT-X-ENDLIST', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=12\n']) assert.throws(() => highestPlaylist(bad, 'https://dai.google.com/'))
})
