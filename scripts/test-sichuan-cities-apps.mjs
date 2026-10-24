import test from 'node:test'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CHANNELS, createResolver } from '../extractors/sichuan-cities/api.js'
import { officialMedia, dfsxContent, dfsxComponent, ziyangUrl, deyangUrl, panzhihuaRequest, panzhihuaUrl } from '../extractors/sichuan-cities/protocol.js'
import epg, { dateRange, parseProgrammes, parsePanzhihuaProgrammes } from '../extractors/sichuan-cities/epg.js'

const fixtures = JSON.parse(readFileSync(new URL('../extractors/sichuan-cities/fixtures/apps.json', import.meta.url)))
const original = JSON.parse(readFileSync(new URL('../extractors/sichuan-cities/fixtures/official.json', import.meta.url)))
const media = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nsegment.ts\n'
const row = id => CHANNELS.find(row => row.id === id)
const response = value => new Response(typeof value === 'string' ? value : JSON.stringify(value))

test('官方 App 真实结构：10 个新增市州 12 路，精确匹配频道和原始媒体路径', async () => {
  const selected = CHANNELS.filter(row => row.appSource)
  assert.equal(selected.length, 12)
  assert.equal(new Set(selected.map(row => row.city)).size, 10)
  for (const channel of selected) {
    const calls = []
    const resolver = createResolver({ fetchImpl: async (raw, options) => {
      const url = new URL(raw)
      calls.push({ url, options })
      assert.equal(options.headers.Authorization, undefined)
      if (url.pathname.endsWith('.m3u8')) {
        assert.equal(options.headers.tenant, undefined)
        assert.equal(options.headers.Referer, channel.page)
        if (url.hostname === '27.201.147.162') return response(media)
        return response(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\n${url.protocol}//27.201.147.162/${url.hostname}${url.pathname}?wsSession=offline\n`)
      }
      if (channel.kind === 'dfsx') {
        if (url.pathname.endsWith(`/v2/contents/${channel.contentId}`)) return response(fixtures[channel.id])
        assert.equal(raw, `${channel.apiBase}/components`)
        assert.equal(options.method, 'POST')
        assert.deepEqual(JSON.parse(options.body), { lives: [channel.liveId] })
        return response(fixtures[channel.id + 'Live'])
      }
      if (channel.kind === 'cloud') {
        assert.equal(options.headers.tenant, channel.tenant)
        if (url.pathname.endsWith('/node')) {
          assert.deepEqual(JSON.parse(options.body), { nodeId: channel.nodeId })
          return response(fixtures[channel.id])
        }
        assert.equal(channel.signed, true)
        return response(fixtures[channel.id + 'Config'])
      }
      if (channel.kind === 'deyang') {
        assert.equal(raw, 'https://api.deyangnews.cn/cms-api/broadcast/list?mark=tv')
        return response(fixtures.dytv1)
      }
      if (channel.kind === 'panzhihua') {
        if (url.pathname.endsWith('site.sitejson')) return response(fixtures.pzhtv1Config)
        assert.equal(raw, 'https://www.pzhxinwen.cn/rftapi/api/rft/getLiveList')
        assert.equal(options.method, 'POST')
        const params = new URLSearchParams(options.body)
        assert.equal(params.get('siteId'), channel.siteId)
        assert.equal(params.get('type'), '1')
        assert.equal(params.get('userId'), '')
        assert.equal(params.get('appId'), '')
        assert.match(params.get('signature'), /^[a-f0-9]{32}$/)
        return response(fixtures.pzhtv1)
      }
      assert.equal(raw, 'https://appmgr.zyrb.com.cn/tvradio/Tvfront/getTvInfo?tv_id=1')
      return response(fixtures[channel.id])
    } })
    const resolved = await resolver.resolve(channel.ref)
    assert.ok(resolved.url, resolved.desc)
    assert.equal(typeof resolved.upstreamHeaders, 'function')
    assert.equal(Boolean(resolved.manifestText), Boolean(channel.dispatch))
    assert.ok(calls.length > 0)
    assert.throws(() => resolved.upstreamHeaders('https://evil.example/live/segment.ts'))
  }
})

test('拒绝串台、广播、登录拒绝及陌生 CDN；官方公网 IP 调度仍须完整匹配本台目录', () => {
  const gy = row('gytv1'), ms = row('mstv1'), zy = row('zytv1')
  assert.throws(() => dfsxContent({ ...fixtures.gytv1, type: 'audio' }, gy))
  assert.throws(() => dfsxContent({ ...fixtures.gytv1, fields: { live_id: 104601 } }, gy))
  assert.throws(() => dfsxComponent({ lives: [{ id: 104601, type: 1, m3u8_url: gy.media }] }, gy))
  assert.throws(() => dfsxComponent({ lives: [{ id: gy.liveId, type: 2, m3u8_url: gy.media }] }, gy))
  assert.throws(() => ziyangUrl({ code: 401, data: fixtures.zytv1.data }, zy))
  assert.throws(() => ziyangUrl({ code: 200, data: { ...fixtures.zytv1.data, tv_id: 4 } }, zy))
  assert.throws(() => ziyangUrl({ code: 200, data: { ...fixtures.zytv1.data, url: '' } }, zy))
  const source = new URL(ms.media), path = `/${source.hostname}${source.pathname}`
  assert.ok(officialMedia(`http://27.201.147.162${path}`, ms, { asset: true }))
  for (const host of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.169.254', '172.16.0.1', 'evil.example']) {
    assert.throws(() => officialMedia(`http://${host}${path}`, ms, { asset: true }))
  }
  assert.throws(() => officialMedia(`http://27.201.147.162${path.replace('4c0403ef', 'other')}`, ms, { asset: true }))
})

test('阿坝、眉山、南充共用后台时，公开签名配置按租户分开缓存，不能把密钥及域名串给另一台', async () => {
  const counts = { 'YzMyMDA=': 0, 'bTE0MDA=': 0, 'TjEzMDA=': 0 }
  const resolver = createResolver({ fetchImpl: async (raw, options) => {
    const url = new URL(raw), tenant = options.headers.tenant
    if (url.pathname.endsWith('.m3u8')) return response(media)
    if (url.pathname.endsWith('/node')) return response(tenant === 'YzMyMDA=' ? original.aba : tenant === 'bTE0MDA=' ? fixtures.mstv1 : fixtures.nctv1)
    assert.ok(tenant in counts)
    counts[tenant]++
    return response(tenant === 'YzMyMDA=' ? { code: 0, data: { antiTheftChainAddress: 'https://apppull.aba-news.com.cn',
      antiTheftChainKey: Buffer.from('offline-aba').toString('base64') } } : tenant === 'bTE0MDA=' ? fixtures.mstv1Config : fixtures.nctv1Config)
  } })
  for (let repeat = 0; repeat < 2; repeat++) {
    for (const key of ['abtv1', 'mstv1', 'nctv1']) {
      const result = await resolver.resolve(row(key).ref)
      assert.ok(result.url, result.desc)
      assert.equal(new URL(result.url).hostname, new URL(row(key).media).hostname)
    }
  }
  assert.deepEqual(counts, { 'YzMyMDA=': 1, 'bTE0MDA=': 1, 'TjEzMDA=': 1 })
})

test('凉山两套今明官方节目单：上海日期、实际节目时间，空表保留为空；非法参数不联网', async () => {
  assert.deepEqual(epg.channels().map(row => row.key), ['lstv1', 'lstv2', 'pzhtv1'])
  assert.equal(epg.days, 2)
  for (const key of ['lstv1', 'lstv2']) {
    const channel = row(key)
    for (const day of ['20261023', '20261024']) {
      const programmes = await epg.programmes(key, day, { fetchImpl: async (url, options) => {
        assert.equal(url, `${channel.apiBase}/lives/${channel.liveId}/playlists?start=${dateRange(day).date}&limit=1`)
        assert.equal(options.redirect, 'manual')
        return response(fixtures[key + 'Epg'])
      } })
      assert.ok(programmes.length >= 18)
      assert.ok(programmes.some(row => row.title.includes('新闻')))
      assert.ok(programmes.every(row => row.start >= dateRange(day).start && row.stop > row.start))
    }
  }
  assert.deepEqual(parseProgrammes({ '2026-10-23': [] }, '20261023'), [])
  for (const date of ['20260230', '20261301', '2026-10-23', 'invalid']) assert.throws(() => dateRange(date))
  await assert.rejects(epg.programmes('ybtv1', '20261023', { fetchImpl: () => assert.fail() }), /频道无效/)
  await assert.rejects(epg.programmes('lstv1', '20260230', { fetchImpl: () => assert.fail() }), /日期无效/)
})


test('德阳只使用显式 HLS，攀枝花公共签名与电视身份校验，拒绝串台及未知媒体', () => {
  const dy = row('dytv1'), pzh = row('pzhtv1')
  assert.equal(deyangUrl(fixtures.dytv1, dy), dy.media)
  assert.throws(() => deyangUrl({ ...fixtures.dytv1, code: 401 }, dy))
  for (const change of [{ id: 2 }, { mark: 'fm' }, { videoStatus: 0 }, { streamH5: '' }, { streamH5: 'https://evil.example/live.m3u8' }]) {
    assert.throws(() => deyangUrl({ ...fixtures.dytv1, data: [{ ...fixtures.dytv1.data[0], ...change }] }, dy))
  }
  const body = new URLSearchParams(panzhihuaRequest(fixtures.pzhtv1Config, pzh, 1792771200000))
  const expected = createHash('md5').update(['1', pzh.siteId, '', '', '1792771200000', fixtures.pzhtv1Config.apiSign].sort().join('')).digest('hex')
  assert.equal(body.get('signature'), expected)
  assert.equal(body.get('currentTimeMillis'), '1792771200000')
  assert.throws(() => panzhihuaRequest({ ...fixtures.pzhtv1Config, id: 'other' }, pzh))
  assert.throws(() => panzhihuaRequest({ ...fixtures.pzhtv1Config, domain: 'https://evil.example' }, pzh))
  assert.throws(() => panzhihuaRequest({ ...fixtures.pzhtv1Config, apiSign: '' }, pzh))
  for (const change of [{ id: 'other' }, { siteId: 'other' }, { type: 2 }, { status: 0 }, { checkedStatus: 0 }, { url: 'https://evil.example/live.m3u8' }]) {
    assert.throws(() => panzhihuaUrl({ ...fixtures.pzhtv1, list: [{ ...fixtures.pzhtv1.list[0], ...change }] }, pzh))
  }
})

test('攀枝花真实今明 EPG 使用 dateTime 请求，检查日期、频道和上海时间', async () => {
  const channel = row('pzhtv1')
  for (const day of ['20261024', '20261025']) {
    const result = await epg.programmes('pzhtv1', day, { fetchImpl: async (url, options) => {
      if (url.endsWith('site.sitejson')) return response(fixtures.pzhtv1Config)
      assert.equal(url, 'https://www.pzhxinwen.cn/rftapi/api/rft/getEpgInfo')
      assert.equal(options.method, 'POST')
      const params = new URLSearchParams(options.body)
      assert.equal(params.get('dateTime'), dateRange(day).date)
      assert.equal(params.get('channelId'), channel.contentId)
      return response(fixtures['pzhtv1Epg' + day])
    } })
    assert.ok(result.length >= 26)
    assert.ok(result.some(row => row.title.includes('新闻')))
    assert.equal(result[0].start, dateRange(day).start)
    assert.ok(result.every(row => row.stop > row.start && row.start < dateRange(day).stop))
  }
  const fixture = fixtures.pzhtv1Epg20261024
  assert.throws(() => parsePanzhihuaProgrammes({ ...fixture, dateTime: '2026-10-25' }, '20261024', channel))
  assert.throws(() => parsePanzhihuaProgrammes({ ...fixture, list: [{ ...fixture.list[0], channelId: 'other' }] }, '20261024', channel))
  assert.deepEqual(parsePanzhihuaProgrammes({ ...fixture, list: [] }, '20261024', channel), [])
})
