#!/usr/bin/env node
/** 夹具由 2026-10-23 官方真实响应裁剪；短效签名和公开签名配置均换成离线值。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import module from '../extractors/sichuan-cities/index.js'
import { CHANNELS, createResolver, claimsRef } from '../extractors/sichuan-cities/api.js'
import { officialMedia, playUrlFromHtml, nmipUrl, bazhongUrl, abaUrl, signAbaUrl,
  readOfficial, MAX_TEXT_BYTES, BAZHONG_CATALOG, CLOUD_API } from '../extractors/sichuan-cities/protocol.js'
import { getModule, resolverFor } from '../extractors/registry.js'
import { packLogoUrl } from '../utils/logoPack.js'

const fixtures = JSON.parse(readFileSync(new URL('../extractors/sichuan-cities/fixtures/official.json', import.meta.url)))
const config = { code: 0, data: { antiTheftChainAddress: 'https://apppull.aba-news.com.cn',
  antiTheftChainAddressHD: 'https://apppull.aba-news.com.cn ', antiTheftChainKey: Buffer.from('offline-key').toString('base64') } }
const response = body => new Response(typeof body === 'string' ? body : JSON.stringify(body))
const channel = id => CHANNELS.find(row => row.id === id)
const master = (row, raw = row.media) => {
  const original = new URL(row.media), query = new URL(raw).search
  return `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1800000\n${original.protocol}//official-dispatch.100ycdn.com/${original.hostname}${original.pathname}${query}\n`
}
const media = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:2,\nsegment.ts\n'

test('四川市州独立注册、默认开启，18 个市州 25 路固定引用、无登录与回看', async () => {
  assert.equal(getModule(module.id), module)
  assert.notEqual(module.defaultEnabled, false)
  assert.equal(module.channelHlsMode, undefined, '每台按是否要求来源头选择代理方式')
  assert.equal(module.relayProxyCompatible, true)
  assert.equal(module.capabilities.epg, true)
  assert.equal(module.catalogVersion, 3)
  assert.deepEqual(module.configSchema, [])
  const result = await module.fetch()
  assert.equal(result.groups[0].name, '四川')
  assert.equal(result.groups[0].dataList.length, 25)
  assert.equal(new Set(CHANNELS.map(row => row.city)).size, 18)
  assert.equal(result.groups[0].dataList.filter(row => row.proxyHls).length, 7)
  assert.equal(result.groups[0].dataList.filter(row => row.relayHls).length, 18)
  for (const row of result.groups[0].dataList) {
    assert.equal(row.catchup, 'none')
    assert.equal(row.url, undefined)
    assert.equal(resolverFor(row.deferredRef), module)
    assert.ok(!/龙泉|绵阳公共|绵阳科技|宗教/.test(row.name))
  }
  assert.ok(!/wsSecret|antiTheftChainKey/.test(JSON.stringify(result)))
})

test('只认精确引用；失败入口不发请求，不影响成都或省台', async () => {
  const resolver = createResolver({ fetchImpl: () => { throw new Error('unexpected request') } })
  for (const ref of [null, '__proto__', 'mytv1', 'sichuan-cities', 'sichuan-cities-mytv2',
    'sichuan-cities-mytv1/extra', 'sichuan-cities-mytv1?foo=1', 'chengdu-cdtv1']) {
    assert.equal(claimsRef(ref), false)
    assert.equal((await resolver.resolve(ref)).url, '')
  }
  assert.equal(resolverFor('chengdu-cdtv1').id, 'chengdu')
})

test('所有频道的官方标识都有内置备份，订阅不依赖外部台标资料库', async () => {
  for (const row of (await module.fetch()).groups[0].dataList) {
    assert.ok(/^https?:\/\//.test(row.logo), row.name)
    assert.ok(packLogoUrl({ ...row, sourceId: 'xt:sichuan-cities' }, '四川').includes('/logo-pack/'), row.name)
  }
})

test('所有官方真实结构可解析；内江必须跟随网页的 live_id 和官方 AJAX', async () => {
  for (const row of CHANNELS.filter(row => !row.appSource)) {
    const calls = []
    const resolver = createResolver({ now: () => 1792764000000, fetchImpl: async (url, options) => {
      calls.push({ url, options })
      assert.equal(options.redirect, 'manual')
      assert.ok(options.signal instanceof AbortSignal)
      assert.equal(options.headers.Authorization, undefined)
      if (new URL(url).hostname.endsWith('.100ycdn.com')) return response(media)
      if (new URL(url).hostname === new URL(row.media).hostname && (row.id === 'mytv1' || row.kind === 'aba')) {
        assert.equal(options.headers.tenant, undefined)
        return response(master(row, url))
      }
      if (row.kind === 'html') { assert.equal(url, row.page); return response(fixtures[row.id]) }
      if (row.kind === 'nmip') {
        assert.equal(url, new URL(`/cms/home/content?id=${row.contentId}`, row.page).href)
        return response(fixtures[row.contentId])
      }
      if (row.kind === 'bazhong') { assert.equal(url, BAZHONG_CATALOG); return response(fixtures.bazhong) }
      if (row.kind === 'neijiang') {
        if (url === row.page) return response(fixtures.neijiang)
        const endpoint = new URL(url)
        assert.equal(endpoint.origin + endpoint.pathname, 'https://xmt.njrbs.cn/web/video_ajax.php')
        assert.deepEqual(Object.fromEntries(endpoint.searchParams), { live_id: row.media, live_type: '107', aid: '972' })
        return response(fixtures.neijiangApi)
      }
      assert.equal(options.headers.tenant, 'YzMyMDA=')
      if (url.endsWith('/node')) {
        assert.equal(options.method, 'POST')
        assert.deepEqual(JSON.parse(options.body), { nodeId: '1504641996442759169' })
        return response(fixtures.aba)
      }
      assert.equal(url, `${CLOUD_API}content/client/unifiedConfiguration/getUnifiedConfiguration`)
      return response(config)
    } })
    const resolved = await resolver.resolve(row.ref)
    assert.ok(resolved.url, `${row.name}: ${resolved.desc}`)
    assert.ok(new URL(resolved.url).pathname.endsWith(new URL(row.media).pathname))
    assert.equal(resolved.relayHls, true)
    assert.equal(typeof resolved.upstreamHeaders, 'function')
    const headers = resolved.upstreamHeaders(resolved.url)
    assert.equal(headers.Referer, row.page)
    assert.equal(headers.tenant, undefined, '目录及配置请求头不发给 CDN')
    assert.equal(headers.Authorization, undefined)
    assert.throws(() => resolved.upstreamHeaders('https://evil.example/test.ts'), /与频道不符/)
    assert.equal(calls.length, row.kind === 'aba' ? 4 : row.id === 'mytv1' ? 3 : row.kind === 'neijiang' ? 2 : 1)
    if (row.kind === 'aba' || row.id === 'mytv1') assert.equal(resolved.manifestText, media)
  }
})

test('去掉 HTML 注释，拒绝旧源、别台、陌生域、降级 HTTPS 和伪造媒体地址', () => {
  const row = channel('lztv1')
  assert.throws(() => playUrlFromHtml(`<!-- ${row.media} -->`, row), /没有本频道/)
  assert.equal(playUrlFromHtml(`<!-- https://evil.example/test.m3u8 -->${fixtures.lztv1}`, row), row.media)
  for (const raw of [row.media.replace('https:', 'http:'), row.media.replace('channel106011', 'channel103074'),
    row.media.replace('luzhoubs.com', 'luzhoubs.com.evil.example'), row.media.replace('https://', 'https://user:password@'),
    row.media.replace('.com/', '.com:8080/'), row.media + '#hash', 'file:///tmp/test.m3u8',
    'http://127.0.0.1/test.m3u8', 'not a URL']) assert.throws(() => officialMedia(raw, row))
  assert.throws(() => officialMedia(channel('mytv1').media, channel('mytv1')), /未提供当前播放签名/)
  assert.throws(() => officialMedia(row.media.replace('channel106011/', 'channel106011/../channel2/'), row, { asset: true }))
})

test('精确对应官方频道 ID 与电视类型，不把其他目录条目、广播当电视', () => {
  const dz = channel('dztv1'), bz = channel('bztv1'), ab = channel('abtv1')
  assert.throws(() => nmipUrl({ ...fixtures['13560916'], id: 13560089 }, dz), /其他频道/)
  assert.throws(() => nmipUrl({ id: dz.contentId, exdata: { lives: [{ type: 2, m3u8_url: dz.media }] } }, dz), /没有电视直播/)
  assert.throws(() => bazhongUrl({ rs: 500 }, bz), /目录异常/)
  assert.throws(() => bazhongUrl({ rs: 200, data: { channel: [] } }, bz), /没有本频道/)
  assert.throws(() => abaUrl({ code: 0, data: [] }, ab), /没有本频道/)
  assert.throws(() => abaUrl({ code: 401 }, ab), /目录异常/)
})

test('网宿动态节点只接纳同台发布域名和完整频道目录；不接受私网节点', () => {
  for (const id of ['mytv1', 'abtv1']) {
    const row = channel(id), original = new URL(row.media)
    const path = `/${original.hostname}${original.pathname}`
    const good = `${original.protocol}//official-dispatch.100ycdn.com${path}`
    assert.equal(officialMedia(good, row, { asset: true }), good)
    assert.throws(() => officialMedia(good, row), /与频道不符/)
    assert.throws(() => officialMedia(good.replace(original.hostname, 'evil.example'), row, { asset: true }))
    assert.throws(() => officialMedia(good.replace('official-dispatch.100ycdn.com', 'evil.example'), row, { asset: true }))
  }
  const row = channel('mytv1'), path = '/fjgcl.myxwcm.cn/live/9ff5a9b001971000b986a10c00000000/playlist.m3u8'
  assert.equal(officialMedia(`http://211.95.35.136${path}`, row, { asset: true }), `http://211.95.35.136${path}`)
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '198.18.1.1', '224.0.0.1']) {
    assert.throws(() => officialMedia(`http://${ip}${path}`, row, { asset: true }))
  }
})

test('阿坝使用官网公开配置、60 秒十进制时间与路径签名，签名不会写死', () => {
  const row = channel('abtv1'), now = 1792764000000
  const first = new URL(signAbaUrl(row.media, config, row, now))
  assert.equal(first.searchParams.get('wsTime'), '1792764060')
  assert.equal(first.searchParams.get('wsSecret'), createHash('md5').update('offline-key' + first.pathname + '1792764060').digest('hex'))
  assert.notEqual(signAbaUrl(row.media, config, row, now + 61000), first.href)
  const changed = structuredClone(config)
  changed.data.antiTheftChainAddressHD = 'https://evil.example'
  assert.throws(() => signAbaUrl(row.media, changed, row, now), /与媒体不符/)
  assert.throws(() => signAbaUrl(row.media, { code: 0, data: {} }, row, now), /配置异常/)
})

test('目录短缓存与并发合并；活跃会话不在短签到期时强切，CDN 拒绝才按当前时间重建', async () => {
  let clock = 1792764000000, calls = 0, expired = false
  const resolver = createResolver({ now: () => clock, fetchImpl: async url => {
    calls++
    if (new URL(url).hostname.endsWith('.100ycdn.com')) {
      if (expired) { expired = false; return new Response('', { status: 403 }) }
      return response(media)
    }
    if (new URL(url).hostname === 'apppull.aba-news.com.cn') return response(master(channel('abtv1'), url))
    return response(url.endsWith('/node') ? fixtures.aba : config)
  } })
  const row = channel('abtv1')
  const [a, b] = await Promise.all([resolver.resolve(row.ref), resolver.resolve(row.ref)])
  assert.ok(a.url)
  assert.equal(a.url, b.url)
  assert.equal(calls, 5)
  clock += 10000
  const c = await resolver.resolve(row.ref)
  assert.equal(c.url, a.url)
  assert.equal(calls, 6)
  clock += 61000
  const refreshed = await resolver.resolve(row.ref)
  assert.ok(refreshed.url)
  assert.equal(refreshed.url, a.url, '官方短签 60 秒后仍复用合法的 wsSession，保持 TS 时间线')
  assert.equal(calls, 9)
  expired = true
  const renewed = await resolver.resolve(row.ref)
  assert.ok(renewed.url)
  assert.notEqual(renewed.url, a.url, '官方明确拒绝会话后重新申请调度')
  assert.equal(calls, 12)
  assert.throws(() => c.upstreamUrlTransform(channel('abtv2').media), /与频道不符/)
})

test('HTTP 错误、坏 JSON、超大响应、读流失败、超时和网络失败均安全收口', async () => {
  const cases = [
    [() => new Response('', { status: 302 }), /HTTP 302/],
    [() => new Response('', { status: 403 }), /HTTP 403/],
    [() => new Response('<html>bad json</html>'), /无效 JSON/],
    [() => new Response('x', { headers: { 'Content-Length': String(MAX_TEXT_BYTES + 1) } }), /响应过大/],
    [() => new Response('x'.repeat(MAX_TEXT_BYTES + 1)), /响应过大/],
    [() => { throw new DOMException('secret', 'TimeoutError') }, /请求超时/],
    [() => { throw new Error('https://secret.example/key?value=hidden') }, /网络请求失败/],
  ]
  for (const [fetchImpl, reason] of cases) {
    const r = await createResolver({ fetchImpl }).resolve(channel('dztv1').ref)
    assert.equal(r.url, '')
    assert.match(r.desc, reason)
    assert.ok(!/secret\.example|value=hidden/.test(r.desc))
  }
  const brokenBody = new ReadableStream({ start(controller) { controller.error(new Error('broken')) } })
  await assert.rejects(readOfficial('https://www.dzrm.cn/', { fetchImpl: async () => new Response(brokenBody) }), /网络请求失败/)
})

test('仅连接故障重试一次；失败不缓存，后续官方恢复后能重试', async () => {
  let calls = 0
  const resolver = createResolver({ fetchImpl: () => {
    calls++
    if (calls <= 2) throw new Error('socket closed')
    return response(fixtures.lztv1)
  } })
  assert.equal((await resolver.resolve(channel('lztv1').ref)).url, '')
  assert.equal(calls, 2)
  assert.ok((await resolver.resolve(channel('lztv1').ref)).url)
  assert.equal(calls, 3)
})
