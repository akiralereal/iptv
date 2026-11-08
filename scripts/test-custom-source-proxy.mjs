#!/usr/bin/env node
/**
 * 自定义源「经网络代理转发」（订阅 / 直连卡片上的 useProxy，utils/customSourceProxy.js）。
 *
 * 本机起源站和 HTTP CONNECT 代理，频道地址用不存在的域名（cdn.example）——请求能到源站就说明确实走了代理。
 *
 * 不变量：
 *  - 只有用户自己加的订阅源、直连源认这个开关；抓取模式、内置「精选频道」订阅勾了也不算；
 *  - 只改写公网 http(s) 频道；局域网地址、rtp/udp、FLV 照旧原样输出；
 *  - 引用按「源 + 台名 + 剥掉签名参数的地址」算：订阅换签名引用不变，播放时取最新地址；
 *  - 改写后的频道身份仍按原地址算（identity-url），用户的隐藏 / 改名 / 排序不丢；
 *  - 播放：有代理 → 经代理取清单、交全代理链路，请求头（UA / Referer）由服务器带上，回看参数接回原地址；
 *    没有代理 → 302 回原地址；不是 HLS → 302 回原地址，且不把整条直播流读进内存；经代理失败 → 502，不悄悄直连；
 *  - 拉订阅列表也经代理；失效检测按播放时的路子经代理探。
 *
 * 运行： node scripts/test-custom-source-proxy.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DATA_DIR = mkdtempSync(join(tmpdir(), 'iptv-custom-proxy-'))
process.env.mdataDir = DATA_DIR
delete process.env.HTTPS_PROXY
delete process.env.https_proxy

const { reloadConfig } = await import('../config.js')
const cp = await import('../utils/customSourceProxy.js')
const { ExternalSourceManager, BUILT_IN_SUBSCRIPTIONS, fetchAndParseM3u } = await import('../utils/externalSources.js')
const { startProbe, getProbeStatus } = await import('../utils/sourceProbe.js')
const { registerRefResolver, resolverFor } = await import('../extractors/registry.js')
const { channel } = await import('../utils/appUtils.js')
const { buildChannelId, parseInterfaceTxt } = await import('../utils/playlistConfig.js')

let passed = 0
const check = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

// ---- 源站：按路径回清单 / 分片 / 裸流 / 403，记下每次请求带的头 ----
const seen = []
const rawStreams = new Set()
const PLAYLIST = [
  '#EXTM3U',
  '#EXTINF:-1 group-title="海外",代理台',
  '#EXTVLCOPT:http-referrer=http://ref.example/',
  '#EXTVLCOPT:http-user-agent=Own/1.0',
  'http://cdn.example/live/master.m3u8?id=1&token=T1',
  '#EXTINF:-1 group-title="海外",回看台',
  'http://cdn.example/live/media.m3u8',
  '#EXTINF:-1 group-title="海外",裸流台',
  'http://cdn.example/live/raw',
  '#EXTINF:-1 group-title="海外",拒绝台',
  'http://cdn.example/denied',
  '#EXTINF:-1 group-title="海外",FLV台',
  'http://cdn.example/live/a.flv',
  '#EXTINF:-1 group-title="本地",局域网台',
  'http://192.168.1.2:4022/udp/239.0.0.1:5000',
  '#EXTINF:-1 group-title="本地",组播台',
  'rtp://239.0.0.1:5000',
].join('\n')
const origin = http.createServer((req, res) => {
  seen.push({ host: req.headers.host, url: req.url, ua: req.headers['user-agent'], referer: req.headers.referer })
  const path = req.url.split('?')[0]
  if (path === '/sub.m3u') { res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' }); res.end(PLAYLIST); return }
  if (path === '/live/master.m3u8') {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
    res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000\nmedia.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlow.m3u8\n')
    return
  }
  if (path === '/live/media.m3u8') {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
    res.end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:6,\nseg1.ts\n')
    return
  }
  if (path === '/live/seg1.ts') { res.writeHead(200, { 'Content-Type': 'video/mp2t' }); res.end(Buffer.alloc(188, 0x47)); return }
  if (path === '/live/raw') {
    // 一条不停的 TS 裸流：解析时读到开头就该停，不能等它读完
    res.writeHead(200, { 'Content-Type': 'video/mp2t' })
    const timer = setInterval(() => res.write(Buffer.alloc(188 * 50, 0x47)), 5)
    rawStreams.add(timer)
    res.on('close', () => { clearInterval(timer); rawStreams.delete(timer) })
    return
  }
  if (path === '/denied') { res.writeHead(403); res.end('forbidden'); return }
  res.writeHead(404); res.end()
})
origin.listen(0, '127.0.0.1'); await once(origin, 'listening')

const connects = []
const proxy = http.createServer((req, res) => { res.writeHead(405).end() })
proxy.on('connect', (req, socket, head) => {
  connects.push(req.url)
  const upstream = net.connect(origin.address().port, '127.0.0.1', () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    upstream.write(head)
    upstream.pipe(socket).pipe(upstream)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
})
proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening')
writeFileSync(join(DATA_DIR, 'system-config.json'), JSON.stringify({ proxy: `http://127.0.0.1:${proxy.address().port}` }))
reloadConfig()

console.log('自定义源「经网络代理转发」测试')

try {
  await check('哪些地址改由服务器转发：公网 http(s)；局域网、非 HTTP、FLV 不改', () => {
    for (const url of ['http://cdn.example/a.m3u8', 'https://a.b.example/live?id=1', 'http://198.18.0.5/a.m3u8', 'http://[2001:db8::1]/a.m3u8']) {
      assert.equal(cp.proxiableUrl(url), true, url)
    }
    for (const url of ['http://192.168.1.2:4022/udp/x', 'http://10.0.0.1/a.m3u8', 'http://127.0.0.1/a.m3u8', 'http://[fd00::1]/a.m3u8',
      'http://nas.lan/a.m3u8', 'http://box.local/a.m3u8', 'http://router/a.m3u8', 'http://localhost:8080/a.m3u8',
      'rtp://239.0.0.1:5000', 'udp://@239.0.0.1:5000', 'rtmp://cdn.example/live/a', 'http://cdn.example/live/a.flv', 'not a url', '']) {
      assert.equal(cp.proxiableUrl(url), false, url)
    }
  })

  await check('引用：换签名不变，换源 / 换台 / 换路径就变；格式能被认领', () => {
    const a = cp.proxyRefFor('src1', '代理台', 'http://cdn.example/live/master.m3u8?id=1&token=T1')
    assert.match(a, /^cp-[0-9a-f]{16}$/)
    assert.equal(cp.claimsRef(a), true)
    assert.equal(cp.proxyRefFor('src1', '代理台', 'http://cdn.example/live/master.m3u8?id=1&token=T2'), a)
    assert.notEqual(cp.proxyRefFor('src2', '代理台', 'http://cdn.example/live/master.m3u8?id=1&token=T1'), a)
    assert.notEqual(cp.proxyRefFor('src1', '别的台', 'http://cdn.example/live/master.m3u8?id=1&token=T1'), a)
    assert.notEqual(cp.proxyRefFor('src1', '代理台', 'http://cdn.example/live/master.m3u8?id=2&token=T1'), a)
    for (const bad of ['cp-xyz', 'cp-0123456789abcdef0', '12345', 'overseas-dw', '']) assert.equal(cp.claimsRef(bad), false, bad)
  })

  await check('请求头：#EXTVLCOPT 换成回源请求头，函数形态（User-Agent 才会原样发出）', () => {
    const headers = cp.upstreamHeadersOf(['http-user-agent=Own/1.0', 'http-referrer=http://ref.example/', 'network-caching=1000'])
    assert.equal(typeof headers, 'function')
    assert.deepEqual(headers('http://x/'), { 'User-Agent': 'Own/1.0', Referer: 'http://ref.example/' })
    assert.equal(cp.upstreamHeadersOf(['network-caching=1000']), undefined)
    assert.equal(cp.upstreamHeadersOf(undefined), undefined)
  })

  // ---- 管理器：订阅经代理拉、频道带引用 ----
  const LISTS = 'http://lists.example/sub.m3u'
  const builtIn = BUILT_IN_SUBSCRIPTIONS[0]
  writeFileSync(join(DATA_DIR, 'external-sources.json'), JSON.stringify({
    enabled: true, includeInPlaylists: true, updateOnStartup: true,
    seededBuiltInUrls: BUILT_IN_SUBSCRIPTIONS.map(s => s.subscriptionUrl),
    seededDefaultSubscriptions: ['https://raw.githubusercontent.com/akiralereal/iptv/main/from-the-web/from-the-web.m3u'],
    retiredBuiltInsV1: true,
    sources: [
      { id: 'sub00001', name: '海外订阅', mode: 'subscription', enabled: true, useProxy: true, subscriptionUrl: LISTS },
      { id: 'sub00002', name: '没勾的订阅', mode: 'subscription', enabled: true, subscriptionUrl: LISTS,
        parsedChannels: [{ name: '直连台', group: '海外', logo: '', url: 'http://cdn.example/live/media.m3u8' }] },
      { id: 'dir00001', name: '直连台A', group: '海外', mode: 'direct', enabled: true, useProxy: true, m3u8Url: 'http://cdn.example/live/media.m3u8?sign=a' },
      { id: 'fet00001', name: '抓取台', group: '海外', mode: 'fetch', enabled: true, useProxy: true, webUrl: 'http://page.example/', m3u8Url: 'http://cdn.example/live/fetch.m3u8' },
      { ...builtIn, id: 'bi000001', useProxy: true, parsedChannels: [{ name: '精选台', group: '海外', logo: '', url: 'http://cdn.example/live/featured.m3u8' }] },
    ],
  }))
  const mgr = new ExternalSourceManager()
  const channelsByName = () => Object.fromEntries(mgr.getValidChannels().flatMap(g => g.dataList).map(c => [c.name, c]))

  await check('拉订阅：勾了开关就经网络代理拉列表', async () => {
    const r = await mgr.updateSubscriptionSource(0)
    assert.equal(r.success, true, r.message)
    assert.ok(connects.includes('lists.example:80'), `代理没收到拉列表的 CONNECT：${connects}`)
    assert.equal(mgr.sources.sources[0].parsedChannels.length, 7)
  })

  await check('频道引用：公网 http(s) 才带；没勾的源、抓取模式、内置精选频道都不带', () => {
    const ch = channelsByName()
    for (const name of ['代理台', '回看台', '裸流台', '拒绝台', '直连台A']) assert.ok(cp.claimsRef(ch[name].proxyRef), name)
    for (const name of ['FLV台', '局域网台', '组播台', '直连台', '抓取台']) assert.equal(ch[name].proxyRef, undefined, name)
    // 内置精选频道：开关不生效（它没有卡片，内置的出站不让用户改）
    if (ch['精选台']) assert.equal(ch['精选台'].proxyRef, undefined)
    // 原地址照旧留在 url 上：去重、身份、失效检测都还按它
    assert.equal(ch['代理台'].url, 'http://cdn.example/live/master.m3u8?id=1&token=T1')
    assert.deepEqual(mgr.proxiedChannels().map(c => c.name).sort(), ['代理台', '回看台', '拒绝台', '直连台A', '裸流台'].sort())
    assert.equal(mgr.proxiedChannels().find(c => c.name === '代理台').sourceName, '海外订阅')
  })

  await check('频道身份：本机入口带 identity-url 时，与改写前的原地址算出同一个频道 ID', () => {
    const c = channelsByName()['代理台']
    writeFileSync(join(DATA_DIR, 'interface.txt'), [
      '#EXTM3U',
      `#EXTINF:-1 tvg-id="代理台" tvg-name="代理台" tvg-logo="" identity-url="${encodeURIComponent(c.url)}" group-title="海外",代理台`,
      `\${replace}/proxy/${c.proxyRef}.m3u8`,
      '',
    ].join('\n'))
    const parsed = parseInterfaceTxt().flatMap(g => g.channels)
    assert.equal(parsed.length, 1)
    assert.equal(parsed[0].id, buildChannelId({ groupName: '海外', channelName: '代理台', tvgName: '代理台', url: c.url }))
    assert.equal(parsed[0].url, `\${replace}/proxy/${c.proxyRef}.m3u8`)
  })

  // ---- 播放解析 ----
  let proxyOn = true
  const logs = []
  const resolver = cp.createCustomProxyResolver({
    getChannels: () => mgr.proxiedChannels(),
    getVersion: () => mgr.revision,
    proxyEnabled: () => proxyOn,
    log: line => logs.push(line),
  })
  const refOf = name => channelsByName()[name].proxyRef

  await check('有代理：经代理取主清单，交全代理链路；UA / Referer 由服务器带上', async () => {
    connects.length = 0
    seen.length = 0
    const r = await resolver.resolve(refOf('代理台'), { query: {} })
    assert.equal(r.proxyHls, true, r.desc)
    assert.match(r.manifestText, /#EXT-X-STREAM-INF:BANDWIDTH=4000000/)
    assert.equal(r.manifestUrl, 'http://cdn.example/live/master.m3u8?id=1&token=T1')
    assert.ok(seen.some(hit => hit.host === 'cdn.example'), '源站没收到经代理的请求')
    const hit = seen.find(s => s.url.startsWith('/live/master.m3u8'))
    assert.equal(hit.ua, 'Own/1.0')
    assert.equal(hit.referer, 'http://ref.example/')
    // 子清单、分片同样经代理、带同一套请求头
    const media = await resolver.fetchProxyMedia(refOf('代理台'), {}, 'http://cdn.example/live/media.m3u8', { upstreamHeaders: r.upstreamHeaders })
    assert.equal(media.status, 200)
    assert.match(await media.text(), /seg1\.ts/)
    assert.equal(seen.at(-1).ua, 'Own/1.0')
  })

  await check('回看参数接回原地址（原地址不带 ? 时用 ?，带了用 &）', async () => {
    seen.length = 0
    const r = await resolver.resolve(refOf('回看台'), { query: { playseek: '20261108120000-20261108130000' } })
    assert.equal(r.proxyHls, true, r.desc)
    assert.equal(seen.at(-1).url, '/live/media.m3u8?playseek=20261108120000-20261108130000')
    await resolver.resolve(refOf('代理台'), { query: { playseek: 'a-b' } })
    assert.equal(seen.at(-1).url, '/live/master.m3u8?id=1&token=T1&playseek=a-b')
  })

  await check('不是 HLS：302 回原地址交给播放器，读到开头就停', async () => {
    const started = Date.now()
    const r = await resolver.resolve(refOf('裸流台'), { query: {} })
    assert.equal(r.url, 'http://cdn.example/live/raw')
    assert.equal(r.proxyHls, undefined)
    // app.js 据此直接 302，不再由服务器去取一遍（那样会把裸流读满 10 秒才回）
    assert.equal(r.directRedirect, 'not-hls')
    assert.ok(Date.now() - started < 3000, '没在开头停下')
    assert.ok(logs.some(line => /不是 HLS/.test(line)))
  })

  await check('经代理失败：502，不悄悄直连；同一原因不刷屏', async () => {
    logs.length = 0
    const r = await resolver.resolve(refOf('拒绝台'), { query: {} })
    assert.equal(r.url, '')
    assert.equal(r.status, 502)
    assert.equal(r.silent, true)
    assert.match(r.desc, /HTTP 403/)
    await resolver.resolve(refOf('拒绝台'), { query: {} })
    assert.equal(logs.length, 1, logs.join('\n'))
  })

  await check('没有生效代理：302 回原地址（和没勾时一样），不发请求', async () => {
    proxyOn = false
    seen.length = 0
    const r = await resolver.resolve(refOf('代理台'), { query: {} })
    assert.equal(r.url, 'http://cdn.example/live/master.m3u8?id=1&token=T1')
    assert.equal(r.proxyHls, undefined)
    // app.js 据此直接 302：入口在 /proxy/ 下也不能改由服务器直连取清单、转发分片
    assert.equal(r.directRedirect, 'no-proxy')
    assert.equal(seen.length, 0)
    proxyOn = true
  })

  await check('订阅换了签名：引用不变，播放取最新地址', async () => {
    const ref = refOf('代理台')
    const src = mgr.sources.sources[0]
    src.parsedChannels = src.parsedChannels.map(c => c.name === '代理台' ? { ...c, url: c.url.replace('token=T1', 'token=T2') } : c)
    mgr.saveSources()
    assert.equal(refOf('代理台'), ref)
    seen.length = 0
    await resolver.resolve(ref, { query: {} })
    assert.equal(seen.at(-1).url, '/live/master.m3u8?id=1&token=T2')
  })

  await check('关掉开关：旧引用 404，提示刷新订阅', async () => {
    const ref = refOf('直连台A')
    mgr.sources.sources[2].useProxy = false
    mgr.saveSources()
    const r = await resolver.resolve(ref, { query: {} })
    assert.equal(r.status, 404)
    assert.match(r.desc, /刷新订阅/)
    assert.equal(channelsByName()['直连台A'].proxyRef, undefined)
  })

  await check('挂到 resolverFor：模块都不认的 cp- 引用归它，走 channel() 外壳得到全代理结果', async () => {
    registerRefResolver(resolver)
    const ref = refOf('代理台')
    assert.equal(resolverFor(ref), resolver)
    assert.notEqual(resolverFor('12345'), resolver, '咪咕的纯数字仍归咪咕')
    const result = await channel(`/${ref}`, '', '', { key: 't', tag: 't' }, {})
    assert.equal(result.code, 302, result.desc)
    assert.equal(result.proxyHls, true)
    assert.match(result.manifestText, /#EXTM3U/)
    assert.equal(typeof result.upstreamHeaders, 'function')
    assert.equal(result.directRedirect, '')
    // 没有代理：外壳把 directRedirect 带给 app.js，回看参数也接回原地址
    proxyOn = false
    const direct = await channel(`/${ref}?playseek=a-b`, '', '', { key: 't', tag: 't' }, {})
    proxyOn = true
    assert.equal(direct.code, 302, direct.desc)
    assert.equal(direct.directRedirect, 'no-proxy')
    assert.equal(direct.proxyHls, false)
    assert.equal(direct.playURL, 'http://cdn.example/live/master.m3u8?id=1&token=T2&playseek=a-b')
  })

  await check('回看模板：本机入口不带 ?，& 开头的改成 ? 开头，其余原样', () => {
    const ch = { name: 'x', catchup: 'append', catchupSource: '&playseek=${(b)yyyyMMddHHmmss}-${(e)yyyyMMddHHmmss}' }
    assert.equal(cp.catchupForProxyEntry(ch).catchupSource, '?playseek=${(b)yyyyMMddHHmmss}-${(e)yyyyMMddHHmmss}')
    assert.equal(ch.catchupSource.startsWith('&'), true, '不改原对象')
    const plain = { name: 'y', catchupSource: '?playseek=1' }
    assert.equal(cp.catchupForProxyEntry(plain), plain)
    const absolute = { name: 'z', catchup: 'default', catchupSource: 'http://cdn.example/tv?start=${start}' }
    assert.equal(cp.catchupForProxyEntry(absolute), absolute)
    assert.equal(cp.catchupForProxyEntry({ name: 'w' }).catchupSource, undefined)
  })

  await check('拉订阅：undici 的网络错误（TypeError: fetch failed）也按设的次数重试', async () => {
    let calls = 0
    const fetchImpl = async () => {
      calls++
      if (calls === 1) throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) })
      return new Response('#EXTM3U\n#EXTINF:-1,台\nhttp://cdn.example/a.m3u8\n')
    }
    const channels = await fetchAndParseM3u('http://lists.example/retry.m3u', { retries: 1, retryDelayMs: 1, fetchImpl })
    assert.equal(calls, 2)
    assert.equal(channels.length, 1)
    // 地址本身不合法的 TypeError 照旧不重试
    calls = 0
    const bad = async () => { calls++; throw new TypeError('Invalid URL') }
    await assert.rejects(() => fetchAndParseM3u('http://lists.example/bad.m3u', { retries: 2, retryDelayMs: 1, fetchImpl: bad }))
    assert.equal(calls, 1)
  })

  await check('失效检测：会由服务器转发的频道经代理探', async () => {
    // 隧道可能复用上一项建好的连接，不一定有新的 CONNECT；cdn.example 只有经这个代理才到得了源站
    seen.length = 0
    const r = startProbe(0, '海外订阅', [
      { name: '代理台', url: 'http://cdn.example/live/media.m3u8', fetchImpl: cp.customSourceFetch },
    ])
    assert.equal(r.success, true)
    for (let i = 0; i < 100 && getProbeStatus().data.state === 'running'; i++) await new Promise(res => setTimeout(res, 50))
    const status = getProbeStatus().data
    assert.equal(status.summary.alive, 1, JSON.stringify(status))
    assert.ok(seen.some(hit => hit.host === 'cdn.example' && hit.url === '/live/media.m3u8'))
  })

  console.log(`\n全部通过（${passed} 项）`)
} finally {
  for (const timer of rawStreams) clearInterval(timer)
  origin.closeAllConnections?.()
  proxy.closeAllConnections?.()
  origin.close()
  proxy.close()
  rmSync(DATA_DIR, { recursive: true, force: true })
}
process.exit(0)
