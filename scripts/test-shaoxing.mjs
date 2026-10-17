/** 官网响应结构按 2026-10-17 实测裁剪；新域名、路径及签名均为离线夹具。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import shaoxing from '../extractors/shaoxing/index.js'
import { getModule, resolverFor } from '../extractors/registry.js'
import { inlineResolvedManifest } from '../utils/appUtils.js'
import { CHANNELS, LIST_API, requestCatalog, resolveChannel } from '../extractors/shaoxing/api.js'
import { mediaUrl, parseManifest, createMediaClient } from '../extractors/shaoxing/media.js'

const channel = CHANNELS[0]
const oldUrl = 'http://live.shaoxing.com.cn/video/s10001-sxhb/index.m3u8'
const newUrl = 'https://new-cdn.example.com/renamed/news/live?token=fresh'
const playlist = segment => `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:10\n#EXT-X-TARGETDURATION:7\n#EXTINF:5.99,\n${segment}\n`
const manifest = playlist('10.ts')
const ts = Buffer.alloc(188 * 6)
for (let i = 0; i < 6; i++) ts[i * 188] = 0x47
const row = { id: '78', name: '新闻综合', live_type: '1', access_type: '1', play_control: '1', play_url: oldUrl }
const lookupImpl = async () => [{ address: '93.184.216.34', family: 4 }]
function fixture({ detail = row, catalog = [row], control = { state: false }, media = () => new Response(manifest) } = {}) {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push(url)
    assert.equal(options.redirect, 'manual')
    if (url.includes('/stream?')) return detail instanceof Response ? detail : Response.json(detail)
    if (url === LIST_API) return Response.json({ state: true, data: catalog })
    if (url.includes('/getcontrol?')) return Response.json(control)
    if (options.headers?.Range) return new Response(ts, { status: 206 })
    return media(url, options)
  }
  return { calls, fetchImpl, lookupImpl }
}

test('主项目默认启用、浙江分组和中继/全代理契约保持不变', async () => {
  assert.equal(getModule('shaoxing'), shaoxing)
  assert.notEqual(shaoxing.defaultEnabled, false)
  assert.equal(shaoxing.outputGroupName, '浙江')
  assert.equal(shaoxing.channelHlsMode, 'relay')
  assert.equal(shaoxing.relayProxyCompatible, true)
  const { groups } = await shaoxing.fetch()
  assert.deepEqual(groups[0].dataList.map(row => row.name), ['绍兴新闻综合', '绍兴公共', '绍兴文化影视'])
  for (const row of groups[0].dataList) {
    assert.equal(resolverFor(row.deferredRef), shaoxing)
    assert.equal(row.catchup, 'none')
    assert.match(row.logo, /^https:\/\/img\.shaoxing\.com\.cn\//)
  }
  assert.equal(resolverFor(channel.ref + '/extra'), null)
  const result = await resolveChannel(channel.ref, fixture())
  assert.equal(result.url, oldUrl)
  assert.match(inlineResolvedManifest(result), /http:\/\/live\.shaoxing\.com\.cn\/video\/s10001-sxhb\/10\.ts/)
})

test('从官网精确识别三套电视，允许 ID 迁移，拒绝广播、未知台和复用 ID', async () => {
  const catalog = [{ ...row, id: '178', play_url: newUrl },
    { ...row, id: '999', name: '未知电视' }, { ...row, id: '75', name: '公共频道', live_type: '2' },
    { ...row, id: '74', name: '其他电视' }]
  const found = await requestCatalog(fixture({ catalog }))
  assert.deepEqual(found.map(item => item.ref), ['shaoxing-news'])
  assert.equal(found[0].url, newUrl)
  assert.equal(shaoxing.claimsRef('shaoxing-radio'), false)
})

test('每次播放发现新域名/路径/HTTPS，清单与分片签名完整保留', async () => {
  let current = oldUrl
  const fx = fixture({ media: () => new Response(playlist('../chunks/frame.ts?auth=seg-token')) })
  const fetchImpl = async (url, options) => url.includes('/stream?') ? Response.json({ ...row, play_url: current }) : fx.fetchImpl(url, options)
  assert.equal((await resolveChannel(channel.ref, { ...fx, fetchImpl })).url, oldUrl)
  current = newUrl
  const changed = await resolveChannel(channel.ref, { ...fx, fetchImpl })
  assert.equal(changed.url, newUrl)
  const segment = changed.upstreamUrlTransform('../chunks/frame.ts?auth=seg-token')
  assert.equal(segment, 'https://new-cdn.example.com/renamed/chunks/frame.ts?auth=seg-token')
  assert.throws(() => changed.upstreamUrlTransform('https://unrelated.example.com/track.ts'))
})

test('详情旧地址失效时，自动从官方目录找到新地址和新频道 ID', async () => {
  const fx = fixture({ catalog: [{ ...row, id: '178', play_url: newUrl }], media: url => url === oldUrl ? new Response('', { status: 404 }) : new Response(manifest) })
  const result = await resolveChannel(channel.ref, fx)
  assert.equal(result.url, newUrl)
  assert.ok(fx.calls.some(url => url.includes('getcontrol?stream_id=178&')))
  const missing = fixture({ detail: new Response('', { status: 404 }), catalog: [{ ...row, id: '178', play_url: newUrl }] })
  assert.equal((await resolveChannel(channel.ref, missing)).url, newUrl)
})

test('官网播控优先；当前播控无效时不会改播旧的基础信号', async () => {
  assert.equal((await resolveChannel(channel.ref, fixture({ control: { state: true, data: newUrl } }))).url, newUrl)
  const fx = fixture({ control: { state: true, data: newUrl }, media: () => new Response('not live', { status: 404 }) })
  assert.equal((await resolveChannel(channel.ref, fx)).url, '')
  assert.ok(!fx.calls.includes(oldUrl))
})

test('支持官网选用的公共 CDN 跳转及多档 HLS，优先验证最高码率', async () => {
  const final = 'https://delivery.example.com/new/master.m3u8?sig=m'
  const fx = fixture({ detail: { ...row, play_url: newUrl }, media: url => {
    if (url === newUrl) return new Response(null, { status: 302, headers: { Location: final } })
    if (url === final) return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900\nhigh.m3u8?sig=h\n')
    return new Response(manifest)
  } })
  const result = await resolveChannel(channel.ref, fx)
  assert.equal(result.url, 'https://delivery.example.com/new/high.m3u8?sig=h')
  assert.ok(!fx.calls.some(url => url.includes('low.m3u8')))
})

test('清单、媒体片和 TLS 校验失败都拒绝发布地址', async () => {
  for (const text of ['<html>error</html>', manifest + '#EXT-X-ENDLIST', manifest + '#EXT-X-KEY:METHOD=AES-128', manifest + '#EXT-X-MAP:URI="init.mp4"']) {
    assert.throws(() => parseManifest(text, oldUrl))
    assert.equal((await resolveChannel(channel.ref, fixture({ media: () => new Response(text) }))).url, '')
  }
  const fx = fixture()
  const fetchImpl = async (url, options) => options.headers?.Range ? new Response('not a video') : fx.fetchImpl(url, options)
  assert.equal((await resolveChannel(channel.ref, { ...fx, fetchImpl })).url, '')
  const cert = fixture({ media: () => { throw new Error('certificate has expired') } })
  assert.equal((await resolveChannel(channel.ref, cert)).url, '')
})

test('公网保护覆盖官网地址、清单分片、DNS 与重定向，拒绝本机和私网', async () => {
  for (const raw of ['file:///etc/passwd', 'http://127.0.0.1/x', 'http://[::1]/x', 'https://localhost/x', 'http://user:password@cdn.example.com/x', 'https://a.local/x']) assert.throws(() => mediaUrl(raw))
  let fetched = false
  const client = createMediaClient({ lookupImpl: async () => [{ address: '10.0.0.1', family: 4 }], fetchImpl: async () => { fetched = true } })
  await assert.rejects(client.request(newUrl), /非公网/)
  assert.equal(fetched, false)
  const redirect = fixture({ media: () => new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/admin' } }) })
  assert.equal((await resolveChannel(channel.ref, redirect)).url, '')
  const segment = fixture({ media: () => new Response(playlist('http://127.0.0.1/private.ts')) })
  assert.equal((await resolveChannel(channel.ref, segment)).url, '')
  for (const address of ['127.0.0.1', '169.254.169.254', '192.168.1.1', '::1', '::ffff:127.0.0.1', 'fe80::1']) {
    const guarded = createMediaClient({ fetchImpl: async () => { throw new Error('must not fetch') }, lookupImpl: async () => [{ address }] })
    await assert.rejects(guarded.request(newUrl), /非公网/)
  }
})

test('跳转与响应大小有上限，未验证资源不允许登记到代理', async () => {
  const loop = fixture({ media: () => new Response(null, { status: 302, headers: { Location: newUrl } }) })
  assert.equal((await resolveChannel(channel.ref, loop)).url, '')
  const large = fixture({ media: () => new Response('x'.repeat(512 * 1024 + 1)) })
  assert.equal((await resolveChannel(channel.ref, large)).url, '')
  assert.throws(() => createMediaClient().allowResource(newUrl))
})
