#!/usr/bin/env node
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'iptv-redbull-test-'))
process.env.mdataDir = dir
process.env.mblank = 'true'
process.env.mbuiltInSourcesUrl = ''
after(() => rmSync(dir, { recursive: true, force: true }))
const { Provider, createTransport, parseBootstrap, safeUrl, checkManifest, refFor, idFor, isPublicLive, MEDIA_HOSTS, API_HOSTS } = await import('../extractors/redbull/api.js')
const { default: module, buildGroups } = await import('../extractors/redbull/index.js')
const { resolverFor, proxyModules } = await import('../extractors/registry.js')
const { dropSupersededFeatured } = await import('../utils/channelMerger.js')
const { ExtractorManager } = await import('../utils/extractorManager.js')
const { inlineResolvedManifest } = await import('../utils/appUtils.js')
const { toProxyManifest } = await import('../utils/hlsProxy.js')
const { packLogoUrl } = await import('../utils/logoPack.js')
const { hostCoveredBy } = await import('../utils/outboundProxy.js')
// 按 2026-11-07 官方响应裁剪。ID/字段结构真实，流和会话中不带生产票据。
const channel = { id: 'rrn:content:video-channels:c81f8686-ab67-4965-ba04-5f6658bb96cc', title: 'World of Red Bull', content_type: 'video_channel', playable: true, badges: [{ type: 'on_now' }] }
const event = { id: 'rrn:content:live-videos:f0ee7f41-1e0e-4abd-a4d2-b84d89a29f21', title: 'Finals Centre Court', subheading: 'FIP World Cup', content_type: 'live_program', playable: true, badges: [{ type: 'live' }], start_time: '2026-11-07T11:00:00Z' }
const session = { country_code: 'us', locale: 'en_US', category: 'personal_computer', os_family: 'linux', device_group: 'web' }
const flight = JSON.stringify({ session: { ...session, token: 'DO_NOT_KEEP' }, api_ids: { epg_product: 'epg', live_calendar_product: 'calendar' }, rails: [{ id: 'live', label: 'Live Now' }] })
const html = [flight.slice(0, 75), flight.slice(75)].map(s => `<script>self.__next_f.push([1,${JSON.stringify(s)}])</script>`).join('')
const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Spanish",LANGUAGE="es",URI="es.m3u8"\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",URI="subs.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,AUDIO="audio",SUBTITLES="subs"\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,AUDIO="audio",SUBTITLES="subs"\nhigh.m3u8\n'
const media = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:321\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\n321.m4s\n'
function fixture(state = {}) {
  state.items ||= [event]; state.calls ||= []
  return async (raw, options) => {
    const url = new URL(raw), path = decodeURIComponent(url.pathname)
    state.calls.push({ path, host: url.hostname, method: options.method, range: options.headers?.Range })
    if (url.hostname === 'www.redbull.tv') return new Response(html)
    if (path.includes('/products/dynamic/')) return Response.json(state.dynamic || state.items.find(x => path.endsWith(x.id)) || channel)
    if (path.endsWith('/epg')) return Response.json({ collections: [{ id: 'channels' }] })
    if (path.endsWith('/channels')) return Response.json({ cards: state.channels || [channel], meta: {} })
    if (path.endsWith('/live')) {
      if (state.catalogDown) return new Response('unavailable', { status: 502 })
      return Response.json({ cards: state.items, meta: state.meta || {} })
    }
    if (path.includes('/collections/') && url.searchParams.has('offset')) return Response.json({ cards: [], meta: {} })
    if (path.includes('/products/')) return Response.json(path.endsWith(event.id) ? event : channel)
    if (path.includes('/init/')) return Response.json({ manifest_type: 'hls', manifest_url: 'https://play.redbull.com/test/master.m3u8' })
    if (path.endsWith('/master.m3u8')) return new Response(master)
    if (path.endsWith('.m3u8')) return new Response(media + (state.ended ? '#EXT-X-ENDLIST\n' : ''))
    if (path.endsWith('.m4s')) return new Response(new Uint8Array([1,2,3]), { status: options.headers?.Range ? 206 : 200 })
    throw new Error('Unexpected fixture request: ' + path)
  }
}
test('海外默认关闭，代理声明覆盖所有取址和媒体主机，稳定 ID 不依赖目录缓存', async () => {
  assert.equal(module.category, 'overseas'); assert.equal(module.defaultEnabled, false)
  assert.ok(proxyModules().includes(module)); assert.equal(module.channelHlsMode, 'proxy')
  for (const host of [...MEDIA_HOSTS, ...API_HOSTS]) assert.ok(hostCoveredBy(host, module.proxyHosts), host)
  assert.equal(idFor(refFor(event.id)), event.id)
  assert.equal(resolverFor(refFor(event.id)), module)
  for (const suffix of ['/extra', '?x=1', '\n', '"']) assert.equal(module.claimsRef(refFor(event.id) + suffix), false)
  const manager = new ExtractorManager(); assert.equal(manager.isModuleEnabled(module), false)
  assert.ok((await new Provider({ fetchImpl: fixture(), now: () => Date.parse('2026-11-07T12:00Z') }).resolve(refFor(event.id))).url)
})
test('分段网页只保留匿名地区参数，不持久化官网票据', () => {
  const result = parseBootstrap(html)
  assert.deepEqual(result.session, session); assert.doesNotMatch(JSON.stringify(result), /DO_NOT_KEEP/)
  assert.throws(() => parseBootstrap('new structure'), /会话/)
})
test('动态赛事预告→开播→结束/回放，刷新结果和已收藏入口均遵循当前状态', async () => {
  let now = Date.parse('2026-11-07T12:00Z')
  const state = { items: [{ ...event, badges: [{ type: 'upcoming' }] }] }
  const p = new Provider({ fetchImpl: fixture(state), now: () => now })
  assert.deepEqual((await p.discover()).items.map(x => x.id), [channel.id])
  state.items = [event]
  assert.equal((await p.discover()).items.length, 2)
  await p.resolve(refFor(event.id))
  now += 16000
  state.items = [{ ...event, badges: [{ type: 'replay_available' }] }]
  assert.deepEqual((await p.discover()).items.map(x => x.id), [channel.id])
  await assert.rejects(p.resolve(refFor(event.id)), /已结束/)
  const groups = buildGroups((await p.discover()).items)
  assert.equal(groups[0].dataList[0].catchup, 'none')
  assert.equal(buildGroups([{ ...event, eventTitle: 'Gazir Contra Todos 2026 ', title: ' Gazir  livestream' }])[1].dataList[0].name,
    '红牛 Gazir Contra Todos 2026 · Gazir livestream', '官方标题首尾空格不进频道名')
  assert.match(packLogoUrl({ ...groups[0].dataList[0], sourceId: 'xt:redbull' }), /logo-pack/)
})
test('集合 live 滞后时动态接口优先，未来开始、收费和播放权限均排除', async () => {
  const p = new Provider({ fetchImpl: fixture({ dynamic: { ...event, badges: [{ type: 'replay_available' }] } }), now: () => Date.parse('2026-11-07T12:00Z') })
  assert.equal((await p.discover()).items.length, 1)
  for (const change of [{ playable: false }, { content_entitlements: ['pay'] }, { links: [{ action: 'play', content_entitlements: ['login'] }] }, { start_time: '2099-01-01' }]) assert.equal(isPublicLive({ ...event, ...change }), false)
})
test('目录失败不返回伪造空列表；分页目标、重复游标与不完整分页受控', async () => {
  const state = {}, p = new Provider({ fetchImpl: fixture(state) })
  await p.bootstrap()
  for (const meta of [{ next: 'https://evil.test/collections/1' }, { next: '/collections/v5.1/rbtv/en_US/us/live' }, { total: 4 }]) {
    state.meta = meta
    await assert.rejects(p.collection('live'), /分页/)
  }
  state.catalogDown = true
  await assert.rejects(p.discover(), /502/)
})
test('解析合并并发与短缓存，过期后重新核验，已封口 HLS 不作为直播', async () => {
  let now = Date.parse('2026-11-07T12:00Z'); const state = {}
  const p = new Provider({ fetchImpl: fixture(state), now: () => now })
  await Promise.all([p.resolve(refFor(event.id)), p.resolve(refFor(event.id))])
  assert.equal(state.calls.filter(x => x.path.includes('/init/')).length, 1)
  state.ended = true; now += 16000
  await assert.rejects(p.resolve(refFor(event.id)), /已经结束/)
})
test('主项目清单代理保留最高档、独立英西音轨、字幕及初始化段，全部改成本机入口', async () => {
  const p = new Provider({ fetchImpl: fixture(), now: () => Date.parse('2026-11-07T12:00Z') })
  const result = await p.resolve(refFor(event.id))
  assert.ok(result.manifestText.indexOf('high.m3u8') < result.manifestText.indexOf('low.m3u8'))
  const proxied = toProxyManifest(inlineResolvedManifest(result), refFor(event.id), undefined, undefined, result.upstreamUrlTransform)
  assert.match(proxied, /LANGUAGE="es"/); assert.match(proxied, /TYPE=SUBTITLES/)
  assert.doesNotMatch(proxied, /https:\/\//)
  assert.match(toProxyManifest(media.replaceAll('init.mp4','https://play.redbull.com/init.mp4').replace('321.m4s','https://play.redbull.com/321.m4s'), refFor(event.id)), /URI="s[a-f0-9]+\.mp4"/)
})
test('媒体/接口逐跳白名单，加密拒绝；Range 与 HEAD 使用同一出站函数', async () => {
  assert.throws(() => safeUrl('https://play.redbull.com.evil.test/a'), /官方链路/)
  assert.throws(() => safeUrl('http://play.redbull.com/a'), /官方链路/)
  const io = createTransport({ fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://evil.test/a.m3u8' } }) })
  await assert.rejects(io.media('https://play.redbull.com/a.m3u8'), /官方链路/)
  for (const key of ['#EXT-X-KEY:METHOD=AES-128,URI="key"', '#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="key"']) assert.throws(() => checkManifest('#EXTM3U\n' + key), /加密/)
  assert.ok(checkManifest('#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n'))
  const state = {}, transport = createTransport({ fetchImpl: fixture(state) })
  assert.equal((await transport.media('https://play.redbull.com/321.m4s', { headers: { Range: 'bytes=0-2' } })).status, 206)
  await transport.media('https://play.redbull.com/321.m4s', { method: 'HEAD' })
  assert.deepEqual(state.calls.map(x => x.method), ['GET','HEAD'])
})
test('删除内置旧频道及远程/缓存残留；用户自建同名订阅仍保留', () => {
  assert.doesNotMatch(readFileSync(new URL('../IPTV.m3u', import.meta.url),'utf8'), /,Red Bull TV\r?\n/)
  assert.deepEqual(dropSupersededFeatured([{ name: '空组' }]), [{ name: '空组' }])
  const own = { name: 'Red Bull TV', sourceId: 'ext:mine' }
  const groups = dropSupersededFeatured([{ name: '体育', dataList: [{ name: 'Red Bull TV', builtInSubscription: true }, own] }, ...buildGroups([channel])])
  assert.deepEqual(groups[0].dataList, [own]); assert.equal(groups[1].dataList.length, 1)
  assert.equal(dropSupersededFeatured([{ name: '体育', dataList: [{ name: 'Red Bull TV', builtInSubscription: true }] }])[0].dataList.length, 0)
})
test('模块解析错误转为有界响应，不向主项目抛异常或泄漏上游地址', async () => {
  const result = await module.resolve(refFor(event.id), { fetchImpl: async () => { throw new Error('https://play.redbull.com/a?secret=hidden') } })
  assert.equal(result.status, 502); assert.equal(result.url, ''); assert.doesNotMatch(result.desc, /secret/)
})

test('数小时追加式赛事清单裁成滑动窗口，多场次/多音轨并播不淘汰刚输出的代理地址', async () => {
  const { liveWindow } = await import('../extractors/redbull/hls.js')
  const { lookup } = await import('../utils/hlsProxy.js')
  let text = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:1\n#EXT-X-DISCONTINUITY-SEQUENCE:7\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-MAP:URI="https://play.redbull.com/init.mp4"\n'
  for (let i=1; i<=2400; i++) text += `${i===1500?'#EXT-X-DISCONTINUITY\n':''}#EXT-X-PROGRAM-DATE-TIME:2026-11-07T12:00:00Z\n#EXTINF:6,\nhttps://play.redbull.com/${i}.m4s\n`
  const clipped=liveWindow(text)
  assert.match(clipped, /#EXT-X-MEDIA-SEQUENCE:2371\n/)
  assert.match(clipped, /#EXT-X-DISCONTINUITY-SEQUENCE:8\n/)
  assert.match(clipped, /#EXT-X-MAP:/)
  assert.doesNotMatch(clipped, /PLAYLIST-TYPE/)
  assert.equal((clipped.match(/#EXTINF:/g)||[]).length,30)
  const keys=[]
  for (let i=0;i<24;i++) keys.push(...toProxyManifest(clipped,`event-${i}`).matchAll(/\b(s[a-f0-9]{16})\./g))
  for (const match of keys) assert.ok(lookup(match[1]), '所有刚输出的分片/初始化段仍在共享登记表')
  assert.match(liveWindow(text+'#EXT-X-ENDLIST\n'), /#EXT-X-ENDLIST/)
  assert.throws(()=>liveWindow(text.replace('#EXTINF:6,','#EXT-X-BYTERANGE:10\n#EXTINF:6,')),/结构已变化/)
  const { validateManifest } = await import('../extractors/redbull/api.js')
  assert.throws(()=>validateManifest('#EXTM3U\n#EXT-X-MEDIA:URI="https://evil.test/audio.m3u8"\n','https://play.redbull.com/master.m3u8'),/官方链路/)
})

test('主项目管理器：分组、稳定 ID、全代理、赛事下线与模块开关同步生效', async () => {
  const state={items:[event]}, ctx={fetchImpl:fixture(state),now:()=>Date.parse('2026-11-07T12:00Z')}
  const manager=new ExtractorManager()
  manager.loaded=true; manager.config.masterSwitchRetired=true
  manager.config.modules.redbull={enabled:true}
  async function refresh() {
    manager.cache.modules.redbull={groups:(await module.fetch({},ctx)).groups,health:{}}
    return manager.getValidChannels().filter(g=>g.name.startsWith('红牛'))
  }
  let groups=await refresh()
  assert.deepEqual(groups.map(g=>g.name),['红牛轮播','红牛赛事'])
  const all=groups.flatMap(g=>g.dataList)
  assert.ok(all.every(c=>c.proxyHls && c.sourceId==='xt:redbull' && c.catchup==='none'))
  const stable=all[0].deferredRef
  state.items=[]; groups=await refresh()
  assert.equal(groups.flatMap(g=>g.dataList).length,1)
  assert.equal(groups[0].dataList[0].deferredRef,stable)
  manager.config.modules.redbull.enabled=false
  assert.equal(manager.getValidChannels().filter(g=>g.name.startsWith('红牛')).length,0)
})

test('官方在播集合返回活动卡时，展开多球场并排除预告与回放', async () => {
  const activity={id:'rrn:content:event-profiles:4304f1ca-8602-4c96-9ae5-5622d4ea3870',title:'FIP World Cup',content_type:'stop',badges:[{type:'live'}]}
  const court2={...event,id:'rrn:content:live-videos:b8d58282-6803-44a0-a632-e704744aeb46',title:'Finals Secondary Court'}
  const future={...event,id:'rrn:content:live-videos:7aecb298-0ee2-4531-afd5-c7b22cfbf504',badges:[{type:'upcoming'}]}
  const programme=[event,court2,future], base=fixture({items:[activity]})
  const fetchImpl=async (raw,options)=>{
    const path=decodeURIComponent(new URL(raw).pathname)
    if (path.includes('/products/dynamic/')) return Response.json(programme.find(p=>path.endsWith(p.id)) || channel)
    if (path.includes('/products/') && path.endsWith(activity.id)) return Response.json({...activity,collections:[{id:activity.id+':live_programs'}]})
    if (path.endsWith(':live_programs')) return Response.json({cards:programme,meta:{}})
    return base(raw,options)
  }
  const result=await new Provider({fetchImpl,now:()=>Date.parse('2026-11-07T12:00Z')}).discover()
  assert.deepEqual(result.items.map(x=>x.id),[channel.id,event.id,court2.id])
  assert.equal(buildGroups(result.items)[1].dataList.length,2)
  assert.match(buildGroups(result.items)[1].dataList[0].name,/FIP World Cup/)
})
