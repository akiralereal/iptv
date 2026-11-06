import assert from 'node:assert/strict'

import { getModule, resolverFor } from '../extractors/registry.js'
import {
  buildChannels,
  catalogPageUrl,
  normalizeCatalog,
} from '../extractors/livechina/api.js'
import { createResolver, STREAM_TTL_MS } from '../extractors/livechina/resolver.js'
import {
  isOfficialPageUrl,
  isOfficialStreamUrl,
  manifestUrlFromVdn,
} from '../extractors/livechina/session.js'

const pageUrl = 'https://livechina.cctv.com/live_zb/LIVE5456.html?pageid=5456&tag=MicroLiveType&isPlaying=ahhs01'
const streamUrl = 'https://gcalic.v.myalicdn.com/gc/ahhs01_1/index.m3u8'
const row = {
  id: 'ahhs01',
  name: '甲岗拉姆雪山及县城湿地',
  region: '西藏',
  pageUrl,
  logo: 'https://p5.img.cctvpic.com/scene/live/pic/example.jpg',
}

{
  const url = new URL(catalogPageUrl(2))
  assert.equal(url.hostname, 'api.cntv.cn')
  assert.equal(url.searchParams.get('serviceId'), 'livechina')
  assert.equal(url.searchParams.get('p'), '2')
  assert.equal(url.searchParams.get('t'), 'json')
}

{
  const payload = {
    code: 200,
    data: [
      {
        region: '西藏',
        signalList: [
          { channelId: row.id, name: row.name, livePublishUrl: pageUrl, showImage: row.logo },
          { channelId: row.id, name: '重复', livePublishUrl: pageUrl },
          { channelId: 'evil', name: '恶意地址', livePublishUrl: 'https://evil.example/LIVE1.html?isPlaying=evil' },
        ],
      },
      { region: '江苏', signalList: [] },
    ],
  }
  assert.deepEqual(normalizeCatalog(payload), [row])
  assert.deepEqual(normalizeCatalog({ code: 500, data: payload.data }), [])
  assert.deepEqual(buildChannels([row]), [{
    name: '西藏｜甲岗拉姆雪山及县城湿地',
    deferredRef: 'livechina-ahhs01',
    proxyHls: true,
    logo: row.logo,
    opts: ['network-caching=3000'],
  }])
}

assert.equal(isOfficialPageUrl(pageUrl, row.id), true)
assert.equal(isOfficialPageUrl(pageUrl, 'wrong'), false)
assert.equal(isOfficialStreamUrl(streamUrl), true)
assert.equal(
  isOfficialStreamUrl('https://ldncctvwbcdbyte.volcfcdn.com/ldncctvwbcd/cdrmldcctv13_1/index.m3u8?b=200-2100'),
  true,
)
assert.equal(isOfficialStreamUrl('https://evil.example/gc/ahhs01_1/index.m3u8'), false)
// 2026-11 VDN 新地址：主腾讯、备百度
assert.equal(isOfficialStreamUrl('https://hlslive1-txy-21.live.cntv.cn/livechina/ahhs01/index.m3u8'), true)
assert.equal(isOfficialStreamUrl('https://hlslive1-bd-21.a.bdydns.com/livechina/ahhs01/index.m3u8'), true)
assert.equal(isOfficialStreamUrl('https://hlslive1-txy-21.live.cntv.cn.evil.example/livechina/ahhs01/index.m3u8'), false)
assert.equal(isOfficialStreamUrl('https://hlslive1-txy-21.live.cntv.cn/livechina/../admin/index.m3u8'), false)
assert.equal(isOfficialStreamUrl('https://hlslive1-txy-21.live.cntv.cn/other/ahhs01/index.m3u8'), false)
assert.equal(manifestUrlFromVdn({
  ack: 'yes', status: '1', play: '1',
  manifest: { hls_nd: 'https://hlslive1-txy-21.live.cntv.cn/livechina/zjwzblt/index.m3u8' },
  backup: { hls_nd: 'https://hlslive1-bd-21.a.bdydns.com/livechina/zjwzblt/index.m3u8' },
}), 'https://hlslive1-txy-21.live.cntv.cn/livechina/zjwzblt/index.m3u8')
assert.equal(manifestUrlFromVdn({ ack: 'yes', status: '1', play: '1', manifest: { hls_nd: streamUrl } }), streamUrl)
assert.equal(manifestUrlFromVdn({ ack: 'no', status: '20', play: '0', manifest: { hls_nd: streamUrl } }), '')

{
  let captures = 0
  let closes = 0
  const resolver = createResolver({
    getRows: async () => [row],
    capture: async () => { captures++; return streamUrl },
    close: async () => { closes++ },
  })
  const now = 1_720_000_000_000
  const first = await resolver.resolve('livechina-ahhs01', { now })
  const cached = await resolver.resolve('livechina-ahhs01', { now: now + STREAM_TTL_MS - 1 })
  const refreshed = await resolver.resolve('livechina-ahhs01', { now: now + STREAM_TTL_MS })
  assert.equal(first.url, streamUrl)
  assert.equal(cached.url, streamUrl)
  assert.equal(refreshed.url, streamUrl)
  assert.equal(captures, 2)
  assert.equal((await resolver.resolve('livechina-missing', { now })).url, '')
  assert.equal((await resolver.resolve('livechina-bad/path', { now })).url, '')
  resolver.clear()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(closes, 1)
}

{
  const module = getModule('livechina')
  assert.ok(module)
  assert.equal(module.outputGroupName, '央视景观')
  assert.equal(module.channelHlsMode, 'proxy')
  assert.equal(module.capabilities.resolve, true)
  assert.equal(resolverFor('livechina-ahhs01')?.id, 'livechina')
  assert.equal(resolverFor('livechina-ahhs01/extra'), null)
}

console.log('✓ 央视直播中国目录、地址边界、VDN 解析、缓存与注册测试通过')
