#!/usr/bin/env node
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProvider, DETAIL_GRACE_MS, DETAIL_TTL_MS, normalizeEvent, parsePlaylist, validateSegmentUrl, verifySegment } from '../extractors/gdsport-events/api.js'
import extractor from '../extractors/gdsport-events/index.js'
const dataDir = mkdtempSync(join(tmpdir(), 'iptv-gdsport-test-'))
process.env.mdataDir = dataDir
process.env.mbuiltInSourcesUrl = ''
process.env.mblank = 'true'
after(() => rmSync(dataDir, { recursive: true, force: true }))
const { default: gdtv } = await import('../extractors/gdtv/index.js')
const { getModule, resolverFor } = await import('../extractors/registry.js')
const { ExtractorManager, emptyHealth } = await import('../utils/extractorManager.js')
const { consolidateLocalSportsChannels, consolidateLocalKidsChannels, consolidateLocalEducationChannels } = await import('../utils/channelMerger.js')
const { inlineResolvedManifest } = await import('../utils/appUtils.js')

// 按 2026-10-06 官方目录和直播间详情裁剪；签名常量与分片参数均为离线测试值。
const stream = 'https://gdsport-live6.itouchtv.cn/live/6ac13766b6538609c35136fd.m3u8'
const row = { objectPk: 119575, objectType: 1, status: 1, unfree: 0, needPassword: false,
  mediaId: 35062, mediaName: '广东体育频道plus', title: '林丹杯羽毛球公开赛', allPlayUrl: { hls: stream } }
const manifest = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:123\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n6ac13766b6538609c35136fd-123.ts?txspiseq=123\n'
function mockFetch(state) {
  return async (raw, options) => {
    const url = new URL(raw)
    state.calls?.push(url.pathname)
    if (url.pathname === '/index.m.html') return new Response('<script src="https://sitecdn.itouchtv.cn/sitecdn/m-mj/prod/js/app.abcd.js"></script>')
    if (url.pathname.endsWith('/app.abcd.js')) return new Response('(d,"publicTestSecret");"X-ITOUCHTV-Ca-Key":"publicTestKey"')
    if (url.hostname === 'api.itouchtv.cn') {
      const time = options.headers['X-ITOUCHTV-Ca-Timestamp']
      assert.equal(options.headers['X-ITOUCHTV-Ca-Signature'], createHmac('sha256', 'publicTestSecret').update(`GET\n${url.href}\n${time}\n`).digest('base64'))
      if (url.pathname.endsWith('/channels')) return Response.json({ list: [{ channelName: '直播', kind: 0, channelId: 1641 }] })
      if (url.pathname.endsWith('/channelLives')) return Response.json({ mediaLiveList: state.rows })
      if (url.pathname.endsWith('/mediaLiveDetail')) {
        assert.equal(url.searchParams.get('isStat'), 'false', '播放复核不带观看统计参数')
        if (state.detailDown) return new Response('bad gateway', { status: 502 })
        return Response.json({ mediaLive: state.rows.find(x => String(x.objectPk) === url.searchParams.get('mediaLiveId')) })
      }
    }
    if (url.href === stream) return new Response(manifest)
    throw new Error('未预期的请求')
  }
}

test('赛事模块独立注册，电视与赛事引用分别交给对应模块解析', () => {
  assert.equal(getModule('gdsport-events'), extractor)
  assert.equal(extractor.outputGroupName, '广东')
  assert.equal(resolverFor('gdsport-event-119575'), extractor)
  assert.equal(resolverFor('gdtv-47'), gdtv)
  for (const ref of ['gdsport-event-0', 'gdsport-event-119575/extra', 'gdsport-event-119575?x=1']) assert.equal(extractor.claimsRef(ref), false)
})

test('排除收费、口令、回放与非官方发布者，只保留官方公开在播赛事', () => {
  assert.equal(normalizeEvent(row).id, '119575')
  for (const change of [{ status: 2 }, { unfree: 1 }, { needPassword: true }, { mediaId: 42 }, { mediaName: '其他发布者' }, { objectType: 3 }]) assert.equal(normalizeEvent({ ...row, ...change }), null)
})

test('广东体育电视频道和多场赛事合并到唯一的广东分组，开播加入、结束移除', async () => {
  const state = { rows: [row, { ...row, objectPk: 119576, title: '工BA篮球联赛' }, { ...row, objectPk: 119577, status: 2 }] }
  const ctx = { fetchImpl: mockFetch(state) }, manager = new ExtractorManager()
  // 纯内存实例，不读取或写入部署配置。
  manager.loaded = true
  manager.config.masterSwitchRetired = true
  manager.cache.modules.gdtv = { groups: (await gdtv.fetch()).groups, health: emptyHealth() }
  async function channels() {
    manager.cache.modules['gdsport-events'] = { groups: (await extractor.fetch({}, ctx)).groups, health: emptyHealth() }
    return manager.getValidChannels()
  }
  let groups = await channels()
  assert.deepEqual(groups.map(x => x.name), ['广东'])
  const events = groups[0].dataList.filter(x => x.sourceId === 'xt:gdsport-events')
  assert.deepEqual(events.map(x => x.name), ['广东体育 · 林丹杯羽毛球公开赛', '广东体育 · 工BA篮球联赛'])
  assert.ok(events.every(x => x.relayHls && !x.proxyHls && x.catchup === 'none' && x.groupTitle === '广东'))
  assert.equal(groups[0].dataList.find(x => x.deferredRef === 'gdtv-47').name, '广东体育')
  const retained = events[1].deferredRef
  state.rows = [state.rows[1], { ...row, status: 2 }]
  groups = await channels()
  assert.deepEqual(groups[0].dataList.filter(x => x.sourceId === 'xt:gdsport-events').map(x => x.deferredRef), [retained])
  state.rows = []
  groups = await channels()
  assert.equal(groups[0].dataList.filter(x => x.sourceId === 'xt:gdsport-events').length, 0)
  assert.equal(groups[0].dataList.filter(x => x.sourceId === 'xt:gdtv').length, 17)
})

test('播放时复核官方状态；比赛结束后旧引用也停止提供直播', async () => {
  let clock = 1_000_000
  const state = { rows: [row] }, ctx = { fetchImpl: mockFetch(state), now: () => clock }
  const result = await extractor.resolve('gdsport-event-119575', ctx)
  assert.equal(result.manifestUrl, stream)
  assert.equal(result.manifestText, manifest)
  assert.equal(result.upstreamHeaders(stream).Origin, 'https://gdsport-m.itouchtv.cn')
  assert.throws(() => result.upstreamHeaders('https://example.com/video.ts'))
  state.rows = [{ ...row, status: 2 }]
  clock += DETAIL_TTL_MS
  assert.equal((await extractor.resolve('gdsport-event-119575', ctx)).url, '')
  await assert.rejects(createProvider({ fetchImpl: ctx.fetchImpl }).resolve('119575'), /当前未直播/)
})

test('清单刷新只重取清单：状态按场缓存，详情接口一时失败沿用上次确认的地址', async () => {
  let clock = 1_000_000
  const state = { rows: [row], calls: [] }
  const provider = createProvider({ fetchImpl: mockFetch(state), now: () => clock })
  const details = () => state.calls.filter(path => path.endsWith('/mediaLiveDetail')).length
  await provider.resolve('119575')
  clock += 4000; await provider.resolve('119575')
  clock += 4000; await provider.resolve('119575')
  assert.equal(details(), 1, '30 秒内的清单刷新不再查详情')
  assert.equal(state.calls.filter(path => path.endsWith('.m3u8')).length, 3, '清单每次都重取')

  // 过了缓存期复核时接口 502：接着用上次确认的地址，不让正在看的人断流
  state.detailDown = true
  clock += DETAIL_TTL_MS
  assert.equal((await provider.resolve('119575')).url, stream)
  assert.equal(details(), 2)
  // 一直失败超过宽限期就不再沿用
  clock += DETAIL_GRACE_MS
  await assert.rejects(provider.resolve('119575'), /HTTP 502/)
  // 官方明确说不在播：立刻停，不沿用
  state.detailDown = false
  await provider.resolve('119575')
  state.rows = [{ ...row, status: 2 }]
  clock += DETAIL_TTL_MS
  await assert.rejects(provider.resolve('119575'), /当前未直播/)
})

test('赛事标题里的英文引号、逗号不弄坏播放列表属性', () => {
  const event = normalizeEvent({ ...row, title: '"我是小球王"足球邀请赛,决赛\n' })
  assert.equal(event.name, "'我是小球王'足球邀请赛，决赛")
})

test('只中继清单：分片由播放器直连官方 CDN，全代理版订阅可升级为全代理', async () => {
  // 官方 CDN 不看来源头、分片不带签名（10-06 实测），不必让视频经本机
  assert.equal(extractor.relayProxyCompatible, true, '?relay=2 时清单和分片都经本机，resolve 的分片校验给那条路用')
  const result = await extractor.resolve('gdsport-event-119575', { fetchImpl: mockFetch({ rows: [row] }), now: () => 5_000_000 })
  const relayed = inlineResolvedManifest(result)
  assert.match(relayed, /^https:\/\/gdsport-live6\.itouchtv\.cn\/live\/6ac13766b6538609c35136fd-123\.ts\?txspiseq=123$/m)
})

test('赛事保留在「广东」，同时复制进「体育」；赛事名带少儿、教育的改放对应分组', () => {
  const event = (id, title) => ({ name: `广东体育 · ${title}`, deferredRef: `gdsport-event-${id}`, sourceId: 'xt:gdsport-events' })
  let groups = [{ name: '广东', dataList: [event(1, '林丹杯羽毛球公开赛'), event(2, '少儿足球邀请赛'), event(3, '教育系统篮球联赛')] }]
  groups = consolidateLocalEducationChannels(consolidateLocalKidsChannels(consolidateLocalSportsChannels(groups)))
  const names = name => (groups.find(group => group.name === name)?.dataList || []).map(channel => channel.deferredRef)
  assert.deepEqual(names('广东'), ['gdsport-event-1', 'gdsport-event-2', 'gdsport-event-3'], '广东组始终是完整的')
  assert.deepEqual(names('体育'), ['gdsport-event-1'])
  assert.deepEqual(names('少儿'), ['gdsport-event-2'])
  assert.deepEqual(names('教育'), ['gdsport-event-3'])
})

test('官方 HLS 与 TS 的边界检查拒绝其他源、其他赛事、加密及结束清单', () => {
  assert.equal(parsePlaylist(manifest, stream).segments.length, 1)
  for (const tag of ['#EXT-X-ENDLIST', '#EXT-X-KEY:METHOD=AES-128,URI="key"']) assert.throws(() => parsePlaylist(manifest + tag + '\n', stream))
  for (const url of ['https://example.com/live/6ac13766b6538609c35136fd-1.ts', '/live/other-1.ts', '/live/6ac13766b6538609c35136fd-1.ts?url=https://example.com/']) assert.throws(() => validateSegmentUrl(url, stream))
  const ts = Buffer.alloc(188 * 6); for (let i = 0; i < ts.length; i += 188) ts[i] = 0x47
  assert.equal(verifySegment(ts), ts)
  assert.throws(() => verifySegment(Buffer.from('<html>error</html>')))
})
