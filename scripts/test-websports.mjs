#!/usr/bin/env node
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'iptv-websports-test-'))
process.env.mdataDir = dataDir
process.env.mbuiltInSourcesUrl = ''
process.env.mblank = 'true'
after(() => rmSync(dataDir, { recursive: true, force: true }))
const { createProvider, expiryOf, isLiveManifest, isPublicUrl, linePaths, normalizeSiteConfig, parseMatches, parseSite, wrappedPlayerUrl } = await import('../extractors/websports/api.js')
const { default: builtInSourceManager } = await import('../utils/builtInSources.js')
const { default: extractor } = await import('../extractors/websports/index.js')
const { getModule, resolverFor } = await import('../extractors/registry.js')

// 按 2026-10-31 首页、index.js、入口页、线路页裁剪；域名、签名均为离线测试值
const b64 = text => Buffer.from(text).toString('base64')
const homeHtml = `<script>window.PLAY_HOSTS = {
  line1: atob("${b64('http://blocked.example.com')}"), line2: atob("${b64('http://open.example.com/')}"),
};
function getPlayUrl(line, id) { var host = window.PLAY_HOSTS[line]; return host + "/play/steam" + id + ".html"; }</script>
<script src="//cdn.example.com/index.js?t_5" type="text/javascript"></script>`
const row = (id, time, league, home, away) => `document.write('<ul class="item play d-touch active " data-lid="1,1,1" data-stype="zqlq">');
document.write('  <li class="lab_events" style="background-color:#F57070"><span class="name">${league}</span></li>');
document.write('  <li class="lab_time">${time}</li>');
document.write('  <li class="lab_team_home"><strong class="name">${home}</strong><em class="bf" title="2"></em></li>');
document.write('  <li class="lab_team_away"><strong class="name">${away}</strong><em class="bf" title="2"></em></li>');
document.write('    <a class="item ok_kqt type1" href="javascript:void(0)" onclick="openRandomUrl1()"><strong>直播①</strong></a>');
document.write('    <a class="item ok type1 me" href="' + getPlayUrl("line1", "${id}") + '" data-play=""><strong>直播①</strong></a>');
document.write('    <a class="item ok type1 me" href="' + getPlayUrl("line2", "${id}") + '" data-play=""><strong>直播②</strong></a>');
document.write('</ul>');
`
const listScript = row('825411', '10-31 22:00', '意甲', '博洛尼亚', '蒙扎') + row('825412', '11-01 03:00', 'NBA', 'A,队', 'B"队') + row('825411', '10-31 22:00', '意甲', '重复', '重复')
const entryHtml = `<iframe src="/play/sm.html?id=100&id2="></iframe>
<a data-play="/play/sm.html?id=928&amp;id2="></a>
<a data-play="/play/dead/?id=1&id2="></a>
<a data-play="/play/wen/?id=abc&id2="></a>
<!--<a data-play="/play/commented/?id=2&id2="></a>-->
<a data-play="=&id2="></a><a data-play=""></a>`
const linePage = param => `<script>window.playerConfig = { playerUrlBase64: "${b64('https://player.example.com/paps.html?id=')}" };
var encodedStr = "${param}";</script>`
const liveManifest = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:5.4,\na.ts?auth_key=1\n'
const stream = 'https://cdn.example.com/rrty/hd-1_gqzm.m3u8?auth_key=1793458862-0-0-abc'

function mockSite(state = {}) {
  const calls = state.calls = []
  return async (raw, options) => {
    const url = new URL(raw)
    calls.push(url.href)
    if (url.hostname === 'www.jrkan.com') return state.homeDown ? new Response('', { status: 502 }) : new Response(homeHtml)
    if (url.hostname === 'cdn.example.com' && url.pathname === '/index.js') return new Response(listScript)
    if (url.hostname === 'blocked.example.com') return new Response('blocked', { status: 403 })
    if (url.hostname === 'open.example.com') {
      if (state.allBlocked) return new Response('blocked', { status: 403 })
      if (url.pathname.startsWith('/play/steam')) {
        assert.equal(options.headers.Referer, 'https://www.jrkan.com/')
        return new Response(entryHtml)
      }
      assert.equal(options.headers.Referer, 'http://open.example.com/play/steam825411.html', '线路页要带入口页 Referer')
      if (url.pathname === '/play/dead/') return new Response(linePage('dead'))
      if (url.pathname === '/play/wen/') return new Response(linePage('live+/='))
      return new Response('no', { status: 403 })
    }
    if (raw === stream) return new Response(state.streamEnded ? '#EXTM3U\n#EXT-X-ENDLIST\n' : liveManifest)
    if (url.hostname === 'dead.example.com') return new Response('nf', { status: 404 })
    return new Response('nf', { status: 404 })
  }
}
const decodeMock = async (url, options) => {
  decodeMock.seen.push({ url, referer: options.referer })
  return { links: url.endsWith('dead') ? ['https://dead.example.com/x.m3u8'] : [stream] }
}
decodeMock.seen = []

test('首页解析出播放域名、路径规则和列表脚本，结构变了返回空', () => {
  assert.deepEqual(parseSite(homeHtml, 'https://www.jrkan.com/'), {
    hosts: ['http://blocked.example.com', 'http://open.example.com'], prefix: '/play/steam', suffix: '.html',
    home: 'https://www.jrkan.com/', listUrl: 'https://cdn.example.com/index.js?t_5',
  })
  assert.equal(parseSite('<html></html>', 'https://www.jrkan.com/'), null)
})

test('比赛表按场去重，名字里的引号和逗号不进 EXTINF', () => {
  const matches = parseMatches(listScript)
  assert.equal(matches.length, 2)
  assert.deepEqual(matches[0], { id: '825411', time: '10-31 22:00', league: '意甲', home: '博洛尼亚', away: '蒙扎' })
  assert.equal(matches[1].home, 'A，队')
  assert.equal(matches[1].away, "B'队")
})

test('线路 1080p 的 pao 优先，其余按站点顺序，sm.html 放最后，注释掉的和空线路不算', () => {
  assert.deepEqual(linePaths(entryHtml), ['/play/dead/?id=1&id2=', '/play/wen/?id=abc&id2=', '/play/sm.html?id=928&id2='])
  assert.deepEqual(linePaths(`${entryHtml}<a data-play="/play/pao/?id=9&id2="></a>`),
    ['/play/pao/?id=9&id2=', '/play/dead/?id=1&id2=', '/play/wen/?id=abc&id2=', '/play/sm.html?id=928&id2='])
})

test('线路页还原播放器地址，前缀不像播放器就不用', () => {
  assert.equal(wrappedPlayerUrl(linePage('a+/=')), 'https://player.example.com/paps.html?id=a+/=')
  assert.equal(wrappedPlayerUrl(`playerUrlBase64: "${b64('javascript:alert(1)//?id=')}" encodedStr = "a"`), '')
  assert.equal(wrappedPlayerUrl('<html></html>'), '')
})

test('第三方页面算出来的地址只放行公网域名', () => {
  assert.equal(isPublicUrl(stream), true)
  for (const raw of ['http://127.0.0.1/a.m3u8', 'http://localhost/a.m3u8', 'http://192.168.1.2/a.m3u8', 'http://[::1]/a.m3u8', 'http://nas.local/a.m3u8', 'file:///etc/passwd', 'ftp://a.example.com/x', 'https://u:p@a.example.com/x', 'nonsense']) {
    assert.equal(isPublicUrl(raw), false, raw)
  }
})

test('域名池逐项校验：拼错和内网地址只丢那一条，整个字段不可用才退回默认值', () => {
  const defaults = normalizeSiteConfig(null)
  assert.ok(defaults.homeUrls.length && defaults.playHosts.length && defaults.listUrl)
  const pool = normalizeSiteConfig({
    homeUrls: ['https://New.example.com', 'https://new.example.com/', 'http://127.0.0.1/', 'https://a.example.com/path', 'nonsense', 42],
    playHosts: 'not-an-array',
    listUrl: 'http://192.168.1.2/index.js',
  })
  assert.deepEqual(pool.homeUrls, ['https://new.example.com/'])
  assert.deepEqual(pool.playHosts, defaults.playHosts)
  assert.equal(pool.listUrl, defaults.listUrl)
  const many = Array.from({ length: 40 }, (_, i) => `https://s${i}.example.com/`)
  assert.equal(normalizeSiteConfig({ homeUrls: many }).homeUrls.length, 16)
})

test('仓库里的域名池每一条都能通过校验（push 前拦住手误）', () => {
  const { websports } = JSON.parse(readFileSync('built-in-sources.json', 'utf-8'))
  const pool = normalizeSiteConfig(websports)
  assert.deepEqual(pool.homeUrls, websports.homeUrls)
  assert.deepEqual(pool.playHosts, websports.playHosts)
  assert.equal(pool.listUrl, websports.listUrl)
})

test('按域名池找首页：死域名跳过，打开过的下轮排最前，改了配置下一轮生效', async () => {
  const calls = []
  let config = { homeUrls: ['https://dead.example.com/', 'https://live.example.com/'] }
  const fetchImpl = async raw => {
    const url = new URL(raw)
    calls.push(url.hostname)
    if (url.pathname === '/index.js') return new Response(listScript)
    return ['live.example.com', 'moved.example.com'].includes(url.hostname) ? new Response(homeHtml) : new Response('', { status: 502 })
  }
  const provider = createProvider({ fetchImpl, decode: decodeMock, siteConfig: async () => config })
  await provider.discover()
  assert.deepEqual(calls, ['dead.example.com', 'live.example.com', 'cdn.example.com'])
  calls.length = 0
  await provider.discover()
  assert.deepEqual(calls, ['live.example.com', 'cdn.example.com'], '上次打开过的先试，不再等死域名超时')
  calls.length = 0
  config = { homeUrls: ['https://gone.example.com/', 'https://moved.example.com/'] }
  await provider.discover()
  assert.deepEqual(calls, ['gone.example.com', 'moved.example.com', 'cdn.example.com'], '旧域名移出配置后不再访问')
})

test('首页全挂时用配置里的播放域名和列表地址，读配置失败退回默认值', async () => {
  const calls = []
  const fetchImpl = async raw => {
    calls.push(raw)
    const url = new URL(raw)
    if (raw === 'https://list.example.com/matches.js') return new Response(listScript)
    if (url.pathname === '/index.js') return new Response(listScript)
    if (url.hostname === 'new-play.example.com') return new Response(entryHtml)
    return new Response('', { status: 502 })
  }
  const decode = async url => ({ links: url.endsWith('dead') ? [] : [stream] })
  const config = { homeUrls: ['https://dead.example.com/'], playHosts: ['http://new-play.example.com'], listUrl: 'https://list.example.com/matches.js' }
  const provider = createProvider({ fetchImpl, decode, siteConfig: async () => config })
  assert.equal((await provider.discover()).length, 2)
  assert.ok(calls.includes(config.listUrl))
  await provider.resolve('825411').catch(() => {})
  assert.ok(calls.includes('http://new-play.example.com/play/steam825411.html'))

  const broken = createProvider({ fetchImpl, decode, siteConfig: async () => { throw new Error('boom') } })
  assert.equal((await broken.discover()).length, 2, '读配置出错不影响刷新')
})

test('模块自己触发远程拉取，内置源关闭也读得到，间隔内不重复拉', async () => {
  const realRefresh = builtInSourceManager.refreshRemoteConfig
  const realSources = builtInSourceManager.sources
  let pulls = 0
  builtInSourceManager.refreshRemoteConfig = async function () {
    pulls++
    this.sources = { enabled: true, sources: [], websports: { homeUrls: ['https://pushed.example.com/'] } }
  }
  builtInSourceManager.remoteCheckedAt = 0
  try {
    assert.deepEqual((await builtInSourceManager.moduleSiteConfig('websports', 60000)).homeUrls, ['https://pushed.example.com/'])
    await builtInSourceManager.moduleSiteConfig('websports', 60000)
    assert.equal(pulls, 1)
    await builtInSourceManager.moduleSiteConfig('websports', 0)
    assert.equal(pulls, 2)
    assert.equal(await builtInSourceManager.moduleSiteConfig('noSuchSection', 60000), null)
  } finally {
    builtInSourceManager.refreshRemoteConfig = realRefresh
    builtInSourceManager.sources = realSources
    builtInSourceManager.remoteCheckedAt = 0
  }
})

test('已结束的清单不算在播；签名到期时间取 auth_key 或 expire', () => {
  assert.equal(isLiveManifest(liveManifest), true)
  assert.equal(isLiveManifest('#EXTM3U\n#EXTINF:5,\na.ts\n#EXT-X-ENDLIST\n'), false)
  assert.equal(isLiveManifest('<html>'), false)
  assert.equal(expiryOf('https://a.example.com/a.m3u8?auth_key=1793458862-0-0-abc', 0), (1793458862 - 120) * 1000)
  assert.equal(expiryOf('https://a.example.com/a.m3u8?expire=1793470503&sign=x', 0), (1793470503 - 120) * 1000)
  assert.equal(expiryOf('https://a.example.com/a.m3u8', 1000), 1000 + 60 * 60 * 1000)
})

test('入口被拒换下一个域名，线路不通换下一条，同一场不重复解析', async () => {
  const state = {}
  let clock = 1_000_000
  decodeMock.seen = []
  const provider = createProvider({ fetchImpl: mockSite(state), now: () => clock, decode: decodeMock })
  await provider.discover()
  const first = await provider.resolve('825411')
  assert.equal(first.url, stream)
  assert.equal(first.line, '/play/wen/?id=abc&id2=')
  assert.ok(state.calls.includes('http://blocked.example.com/play/steam825411.html'))
  assert.deepEqual(decodeMock.seen.map(x => x.url), ['https://player.example.com/paps.html?id=dead', 'https://player.example.com/paps.html?id=live+/='])
  assert.equal(decodeMock.seen[1].referer, 'http://open.example.com/play/wen/?id=abc&id2=')

  assert.equal(first.text, liveManifest)
  assert.equal(first.manifestUrl, stream)

  const before = state.calls.length
  clock += 61 * 1000
  const again = await provider.resolve('825411')
  assert.equal(again.text, liveManifest)
  assert.deepEqual(state.calls.slice(before), [stream], '之后每次刷新只取清单，不重走链路')
})

test('清单断了当场换线路，断过的地址先避开', async () => {
  const backup = 'https://backup.example.com/live/1.m3u8?expire=1793470503&sign=x'
  const state = {}
  const site = mockSite(state)
  const fetchImpl = async (raw, options) => {
    if (raw === stream && state.flaky) return new Response('nf', { status: 404 })
    if (raw === backup) return new Response(liveManifest)
    return site(raw, options)
  }
  const decode = async url => ({ links: url.endsWith('dead') ? [stream] : [stream, backup] })
  const provider = createProvider({ fetchImpl, decode })
  await provider.discover()
  assert.equal((await provider.resolve('825411')).url, stream)
  state.flaky = true
  assert.equal((await provider.resolve('825411')).url, backup)
  state.flaky = false
  assert.equal((await provider.resolve('825411')).url, backup, '换过去之后不跳回刚断的线路')
})

test('流结束后重新解析，解不出时报清楚并短暂记住失败', async () => {
  const state = {}
  let clock = 1_000_000
  const provider = createProvider({ fetchImpl: mockSite(state), now: () => clock, decode: decodeMock })
  await provider.discover()
  await provider.resolve('825411')
  state.streamEnded = true
  clock += 61 * 1000
  await assert.rejects(provider.resolve('825411'), /暂无可用线路/)
  const before = state.calls.length
  await assert.rejects(provider.resolve('825411'), /暂无可用线路/)
  assert.equal(state.calls.length, before, '失败冷却内不打上游')
})

test('入口全部 403 时说明要换网络，首页打不开时用兜底结构', async () => {
  const blocked = createProvider({ fetchImpl: mockSite({ allBlocked: true }), decode: decodeMock })
  await blocked.discover()
  await assert.rejects(blocked.resolve('825411'), /大陆或香港/)

  const fetchImpl = async raw => new URL(raw).pathname === '/index.js' ? new Response(listScript) : new Response('', { status: 502 })
  assert.equal((await createProvider({ fetchImpl }).discover()).length, 2)
})

test('模块登记：默认关闭、频道走清单中继，resolve 出错不抛异常', async () => {
  assert.equal(getModule('websports'), extractor)
  assert.equal(extractor.defaultEnabled, false)
  assert.equal(resolverFor('websports-825411')?.id, 'websports')
  assert.equal(resolverFor('websports-abc'), null)
  const { groups } = await extractor.fetch({}, { fetchImpl: mockSite(), decode: decodeMock })
  assert.equal(groups[0].name, '赛事直播')
  assert.deepEqual(groups[0].dataList[0], {
    name: '10-31 22:00 意甲 博洛尼亚 vs 蒙扎', deferredRef: 'websports-825411', relayHls: true,
    catchup: 'none', logo: '', opts: ['network-caching=3000'],
  })
  assert.deepEqual(await extractor.resolve('nope'), { url: '', desc: '未知的赛事引用' })
  const played = await extractor.resolve('websports-825411', { fetchImpl: mockSite(), decode: decodeMock })
  assert.deepEqual([played.url, played.manifestText, played.manifestUrl], [stream, liveManifest, stream])
  const failed = await extractor.resolve('websports-825411', { fetchImpl: mockSite({ allBlocked: true }), decode: decodeMock })
  assert.equal(failed.url, '')
  assert.match(failed.desc, /大陆或香港/)
})
