import test from 'node:test'
import assert from 'node:assert/strict'
import { CHANNELS, API, signRequest, shanghaiTime, selectCurrent, mediaUrl, parseManifest, snapshot } from '../extractors/nantong/api.js'
import nantong from '../extractors/nantong/index.js'
import { createRuntime, claimsLocalPath } from '../extractors/nantong/runtime.js'
import { resolverFor, localRequestHandlerFor } from '../extractors/registry.js'

const channel = CHANNELS[2]
const now = Date.parse('2026-10-18T12:05:15Z')
const hls = 'https://nt-hls.ntjoy.com/live/4f5.m3u8?t=1792325115&k=11111111111111111111111111111111'
const row = { id: 'current-program', startTime: '2026-10-18 20:00:00', endTime: '2026-10-18 20:35:00', status: 2, isRecord: 1,
  programStatus: 2, programName: '南通新闻', playUrl: `https://nt-hls.ntjoy.com/live/4f5.flv,${hls},rtmp://nt-hls.ntjoy.com/live/4f5` }
const programs = { currTime: '20261018200515', data: [row] }
const gasket = { state: 1000, data: { rows: [] } }

test('公开网页签名与实际官网脚本生成的固定样本一致', () => {
  const signed = signRequest(API, 'getMenuContentList', { menuId: 'ntw005', idx: 0, size: 16 }, 1792325075180)
  assert.equal(signed.butelSign, 'd1d6f0aa4ea04d45ddd953d7d6d16ae3')
  assert.equal(signed.butelAppkey, 'website')
  assert.notEqual(signRequest(API, 'getBroadcastList', { id: 'other' }, 1792325075180).butelSign, signed.butelSign)
})

test('使用官网当前节目 HLS 和上海时间，禁止使用频道目录裸地址替代', () => {
  const current = selectCurrent(programs, gasket, channel, now)
  assert.equal(current.url, hls)
  assert.equal(current.title, '南通新闻')
  assert.equal(current.endAt, Date.parse('2026-10-18T12:35:00Z'))
  assert.equal(shanghaiTime('20261018200515'), now)
})

test('当前节目改为提示片、录播、未发布、未来或版权节目均拒绝', () => {
  for (const change of [{ playUrl: 'https://cm-vod.ntjoy.com/slate.m3u8' }, { isRecord: 2 }, { programStatus: 1 },
    { status: 1 }, { status: 3 }, { programName: '电视剧' }, { programName: '动画城堡' }, { startTime: '2026-10-18 21:00:00' }]) {
    assert.throws(() => selectCurrent({ ...programs, data: [{ ...row, ...change }] }, gasket, channel, now))
  }
})

test('过期节目、时间不可信、重复在播及播出垫片均不会回退到原直播', () => {
  assert.throws(() => selectCurrent(programs, gasket, channel, now + 180000))
  assert.throws(() => selectCurrent({ ...programs, data: [row, row] }, gasket, channel, now))
  assert.throws(() => selectCurrent(programs, { state: 1000, data: { rows: [{ type: 1 }] } }, channel, now))
  assert.throws(() => selectCurrent(programs, { state: 500 }, channel, now))
  const ending = { ...programs, currTime: '20261018203459' }
  assert.throws(() => selectCurrent(ending, gasket, channel, Date.parse('2026-10-18T12:35:00Z')))
})

test('所有清单和分片必须属于本频道，拒绝跨域、回放、密钥和外部 URI', () => {
  const lease = selectCurrent(programs, gasket, channel, now)
  const segment = '4f5-597441730.ts?ctyun_app=live&ctyun_stream=4f5&ctyun_rate=4067000.000'
  const manifest = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:597441730\n#EXTINF:3,\n' + segment + '\n'
  assert.equal(parseManifest(manifest, lease), manifest)
  for (const raw of [hls.replace('4f5', '4f1'), hls.replace('nt-hls.ntjoy.com', '127.0.0.1'), hls.replace('https:', 'http:'), hls + '&url=http://localhost']) assert.throws(() => mediaUrl(raw, channel))
  for (const bad of [manifest + '#EXT-X-ENDLIST', manifest + '#EXT-X-KEY:METHOD=AES-128', manifest + '#EXT-X-SESSION-KEY:URI="https://evil.example/key"', manifest.replace(segment, 'https://evil.example/a.ts')]) assert.throws(() => parseManifest(bad, lease))
})

test('节目和垫片接口任一个失败时，不能只凭目录可用就放行', async () => {
  await assert.rejects(snapshot(channel, { fetchImpl: async url => url.includes('/nmg/')
    ? Response.json({ state: 1000, data: { rows: [] } }) : new Response('', { status: 403 }) }))
})

test('目录保留江苏三套、官方台标及稳定 ref，不按当前节目开放状态隐藏', async () => {
  const logo = 'https://cm-vod.ntjoy.com/bdcbb0d2-c8a3-4102-a614-335f89323f19.png'
  const result = await nantong.fetch({}, { fetchImpl: async (url, options) => {
    assert.equal(new URLSearchParams(options.body).get('service'), 'getMenuContentList')
    return Response.json({ state: 1000, data: { rows: CHANNELS.map(c => ({
      id: c.upstreamId, title: c.rawName, contentType: 7, channelLogo: logo,
    })) } })
  } })
  assert.equal(result.groups[0].name, '江苏')
  assert.equal(nantong.defaultEnabled ?? true, true)
  assert.equal(nantong.channelHlsMode, 'proxy')
  assert.deepEqual(result.groups[0].dataList.map(c => c.deferredRef), CHANNELS.map(c => c.ref))
  assert.ok(result.groups[0].dataList.every(c => c.logo === logo && c.catchup === 'none'))
  for (const c of CHANNELS) {
    assert.equal(resolverFor(c.ref), nantong)
    assert.equal(localRequestHandlerFor(`/${c.ref}`), nantong)
    assert.equal(localRequestHandlerFor(`/${c.ref}.m3u8`), nantong)
  }
  assert.equal(claimsLocalPath('/nantong-4'), false)
  assert.equal(claimsLocalPath('/nantong-media/http://localhost'), false)
})

test('媒体代理核对节目、租期、TS 内容和鉴权路径，节目切换立即失效', async () => {
  let clock = now, id = 'first', snapshotCalls = 0, mediaCalls = 0
  const ts = Buffer.alloc(188 * 4); [0, 188, 376, 564].forEach(i => { ts[i] = 0x47 })
  const runtime = createRuntime({ now: () => clock,
    snapshotImpl: async c => {
      snapshotCalls++
      return { channel: c, url: hls, programId: id, endAt: now + 20000 }
    },
    fetchImpl: async url => {
      if (url.includes('.ts')) { mediaCalls++; return new Response(ts) }
      return new Response('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:597441730\n#EXTINF:3,\n4f5-597441730.ts?ctyun_stream=4f5\n')
    },
  })
  const playlist = await runtime.handleLocalRequest({ path: '/user/token/nantong-3', accessPrefix: '/password' })
  assert.equal(playlist.status, 200)
  const segment = playlist.body.split('\n').find(line => line.startsWith('/'))
  assert.match(segment, /^\/password\/user\/token\/nantong-media\/[a-f0-9]{24}\.ts$/)
  const path = segment.replace('/password', '')
  assert.equal((await runtime.handleLocalRequest({ path })).status, 200)
  assert.equal(snapshotCalls, 1)
  assert.equal(mediaCalls, 1)
  clock += 4000; id = 'next'
  assert.equal((await runtime.handleLocalRequest({ path })).status, 410)
  assert.equal(mediaCalls, 1, '换档后的旧入口不得请求媒体')
  clock += 20000
  assert.equal((await runtime.handleLocalRequest({ path })).status, 410)
  assert.equal((await runtime.handleLocalRequest({ path: '/nantong-3', method: 'OPTIONS' })).status, 204)
  assert.equal((await runtime.handleLocalRequest({ path: '/nantong-3', method: 'POST' })).status, 405)
})

test('接口失败返回 503、不保留失败缓存，官网恢复后可直接重试', async () => {
  let fail = true, calls = 0
  const runtime = createRuntime({ snapshotImpl: async c => {
    calls++
    if (fail) throw new Error('台方当前节目未开放网络直播')
    return { channel: c, url: hls, programId: 'restored', endAt: Date.now() + 60000 }
  }, fetchImpl: async () => new Response('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:3,\n4f5-1.ts?ctyun_stream=4f5\n') })
  assert.equal((await runtime.handleLocalRequest({ path: '/nantong-3' })).status, 503)
  fail = false
  assert.equal((await runtime.handleLocalRequest({ path: '/nantong-3' })).status, 200)
  assert.equal(calls, 2)
})
