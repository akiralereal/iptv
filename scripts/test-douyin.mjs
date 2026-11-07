#!/usr/bin/env node
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import douyin from '../extractors/douyin-live/index.js'
import {
  CATEGORIES, claimsRef, clearResolveCache, diversifiedOrder, fetchRoom, normalizeRoom, officialMediaUrl,
  parseCategoryPage, parseRoomList, pickStream, resolveRoom, selectStream,
} from '../extractors/douyin-live/api.js'
import { pipeFlv } from '../utils/flvProxy.js'
import { CAROUSELS } from '../extractors/douyin-live/carousel.js'
import { getModule, listModules, resolverFor } from '../extractors/registry.js'
import { DEFAULT_GROUP_ORDER } from '../utils/playlistConfig.js'

function flight(value, prefix = 'f:') {
  return `<script>self.__pace_f.push(${JSON.stringify([1, prefix + JSON.stringify(['$', '$L3', null, value])])})</script>`
}

function room(id, category = '', viewers = 100, { flv = true } = {}) {
  const streams = {
    flv_pull_url: flv ? { HD1: `http://pull-flv-l1.douyincdn.com/live/${id}.flv?sign=abc` } : {},
    hls_pull_url_map: { HD1: `http://pull-hls-l1.douyincdn.com/live/${id}/playlist.m3u8?sign=abc` },
  }
  return {
    web_rid: id, avatar: `https://example.com/${id}.jpg`,
    room: {
      id_str: `internal-${id}`, status: 2, title: `${category}直播`,
      owner: { nickname: `主播${id}` }, room_view_stats: { display_value: viewers }, stream_url: streams,
    },
  }
}

const categories = Object.keys(CATEGORIES)
const pages = new Map()
pages.set('/categorynew/4_0', flight({ roomsData: { data: [room('900'), room('901'), room('902')] } }))
for (const [index, category] of categories.entries()) {
  pages.set(`/categorynew/4_${category}`, flight({ roomsData: { data: [room(`${index + 1}01`, category, 100 + index), room(`${index + 1}02`, category, 50 + index)] } }))
}
pages.set('/999', flight({ state: { roomStore: { roomInfo: { web_rid: '999', room: room('999').room } } } }, 'd:'))
pages.set('/888', flight({ state: { roomStore: { roomInfo: { web_rid: '888', room: room('888', '', 100, { flv: false }).room } } } }, 'd:'))
// 未开播的房间页：room 里没有 owner 和 stream_url，主播信息在 anchor
pages.set('/777', flight({ state: { roomStore: { roomInfo: {
  web_rid: '777', anchor: { nickname: '主播777', avatar_thumb: { url_list: ['https://example.com/777.jpg'] } },
  room: { id_str: 'internal-777', status: 4, title: '上一场的标题' },
} } } }, 'd:'))
const requested = []
const fetchImpl = async url => {
  requested.push(new URL(url).pathname)
  const page = pages.get(new URL(url).pathname)
  return { ok: !!page, status: page ? 200 : 404, text: async () => page || '' }
}

assert.equal(getModule('douyin-live'), douyin)
assert.equal(resolverFor('douyin-999'), douyin)
assert.equal(claimsRef('douyin-999'), true)
assert.equal(claimsRef('douyin-999/extra'), false)
assert.equal(listModules().indexOf(douyin), listModules().indexOf(getModule('bilibili-live')) + 1)
assert.equal(DEFAULT_GROUP_ORDER.indexOf('抖音'), DEFAULT_GROUP_ORDER.indexOf('B站') + 1)

assert.equal(normalizeRoom('https://live.douyin.com/999?foo=1'), '999')
assert.equal(normalizeRoom('abc_123'), 'abc_123')
assert.throws(() => normalizeRoom('name.with.dot'))
assert.throws(() => normalizeRoom('https://evil.example/999'))
assert.deepEqual(parseRoomList('# 注释\n999\nhttps://live.douyin.com/999\nabc_123 # 备注'), ['999', 'abc_123'])

assert.deepEqual(parseCategoryPage(pages.get('/categorynew/4_0'), '0').map(row => row.id), ['900', '901', '902'])
const shuffled = [
  { id: '1', roomKey: '1', category: '聊天', viewers: 200 },
  { id: '2', roomKey: '2', category: '聊天', viewers: 100 },
  { id: '3', roomKey: '3', category: '音乐', viewers: 150 },
  { id: '4', roomKey: '4', category: '音乐', viewers: 50 },
]
assert.deepEqual(diversifiedOrder(shuffled).map(row => row.id), ['1', '3', '2', '4'])

assert.equal(officialMediaUrl('http://pull-flv-l1.douyincdn.com/live/1.flv?sign=x'), 'https://pull-flv-l1.douyincdn.com/live/1.flv?sign=x')
assert.throws(() => officialMediaUrl('https://edge.bytefcdnrd.com/live/1.flv'))
assert.equal(officialMediaUrl('https://edge.bytefcdnrd.com/live/1.flv', 'flv', true), 'https://edge.bytefcdnrd.com/live/1.flv')
assert.throws(() => officialMediaUrl('https://pull-flv-l1.douyincdn.com.evil.test/live/1.flv'))
assert.throws(() => officialMediaUrl('https://pull-flv-l1.douyincdn.com/live/1.m3u8'))
assert.equal(selectStream(room('1').room.stream_url, 'FULL_HD1', 'flv').quality, 'HD1')
// 漏发 FLV 的房间：优先 FLV 时改用 HLS，而不是整间跳过
assert.equal(pickStream(room('1', '', 1, { flv: false }).room.stream_url, 'HD1', 'flv').format, 'hls')
assert.equal(pickStream(room('1').room.stream_url, 'HD1', 'flv').format, 'flv')
assert.throws(() => pickStream({ flv_pull_url: {}, hls_pull_url_map: {} }, 'HD1', 'flv'), /没有可用的播放地址/)

// 后台画质选项用抖音网页的中文档位名
assert.deepEqual(douyin.configSchema.find(field => field.key === 'quality').options.map(option => option.label),
  ['蓝光', '超清（推荐）', '高清', '标清'])

const ctx = { fetchImpl, timeoutMs: 1000 }
// 默认只勾「影视（一起看）」，其他分类由用户自选
const defaults = Object.fromEntries(douyin.configSchema.map(field => [field.key, field.default]))
assert.equal(defaults.categories, '一起看')
// 「聊天」「生活」两个分类轮选
requested.length = 0
const byDefault = await douyin.fetch({ ...defaults, categories: '聊天\n生活' }, ctx)
assert.deepEqual(requested.sort(), ['/categorynew/4_101', '/categorynew/4_107'])
assert.deepEqual(new Set(byDefault.groups[0].dataList.map(channel => channel.deferredRef)),
  new Set(['douyin-101', 'douyin-102', 'douyin-701', 'douyin-702']))

const native = await douyin.fetch({ order: 'native', count: 20, rooms: '', format: 'flv', quality: 'HD1' }, ctx)
assert.deepEqual(native.groups[0].dataList.map(channel => channel.deferredRef), ['douyin-900', 'douyin-901', 'douyin-902'])
assert.equal(native.groups[0].name, '抖音')
// 频道名不带内部档位代码
assert.equal(native.groups[0].dataList[0].name, '主播900 · 直播')
assert.ok(native.groups[0].dataList.every(channel => !channel.url && !channel.relayHls))

// FLV 模式下这一刻漏发 FLV 的房间照样收录；地址形态只看配置，播放时再决定用哪种
const hlsOnly = await douyin.fetch({ order: 'native', count: 0, rooms: '888', format: 'flv', quality: 'HD1' }, ctx)
assert.deepEqual(hlsOnly.groups[0].dataList.map(channel => [channel.deferredRef, channel.relayHls]), [['douyin-888', false]])
assert.deepEqual(hlsOnly.meta.warnings, [])

// 未开播的手动房间照样列出、按手填顺序，名字标「未开播」；播放时现查，开播了不用等刷新
{
  const mixed = await douyin.fetch({ order: 'native', count: 0, rooms: '777\n999', format: 'flv', quality: 'HD1' }, ctx)
  assert.deepEqual(mixed.groups[0].dataList.map(c => [c.deferredRef, c.name, c.logo]), [
    ['douyin-777', '主播777 · 未开播', 'https://example.com/777.jpg'],
    ['douyin-999', '主播999 · 直播', ''],
  ])
  assert.deepEqual(mixed.meta.warnings, [])
  const offline = await douyin.fetch({ order: 'native', count: 0, rooms: '777', format: 'hls', quality: 'HD1' }, ctx)
  assert.deepEqual(offline.groups[0].dataList.map(c => [c.deferredRef, c.relayHls]), [['douyin-777', true]])
  const played = await resolveRoom('douyin-777', { ...ctx, config: { format: 'flv', quality: 'HD1' }, now: 1 })
  assert.equal(played.url, '')
  assert.match(played.desc, /未开播/)
  clearResolveCache()
  // 分类抓失败、手填的又都没开播：整轮判失败保上一轮缓存，不能拿「未开播」占位冲掉
  const brokenCtx = { ...ctx, fetchImpl: async url => new URL(url).pathname.startsWith('/categorynew/')
    ? { ok: false, status: 503, text: async () => '' } : fetchImpl(url) }
  await assert.rejects(douyin.fetch({ order: 'balanced', count: 5, rooms: '777', categories: '聊天', format: 'flv', quality: 'HD1' }, brokenCtx), /HTTP 503/)
}

const balanced = await douyin.fetch({ order: 'balanced', count: 9, rooms: '999', format: 'hls', quality: 'HD1', minViewers: 0, categories: Object.values(CATEGORIES).join('\n') }, ctx)
const channels = balanced.groups[0].dataList
assert.equal(channels.length, 10)
assert.equal(channels[0].deferredRef, 'douyin-999')
assert.ok(channels.every(channel => channel.relayHls && channel.deferredRef.startsWith('douyin-')))
assert.deepEqual(new Set(channels.slice(1, 9).map(channel => channel.deferredRef)),
  new Set(categories.map((_, index) => `douyin-${index + 1}01`)))

{
  const filmId = '232551178364'
  const ref = `douyinfilm-${filmId}`
  const accountId = 'MS4wLjABAAAA3JKbNd0WA9IE8RX0PDtj-tTh8q3yvgplHkUmfvoXuNNY1XZW8L1YHrZoUTanL0Hd'
  const showing = { ...room(filmId).room, title: '直播丨𝐂𝐂𝐓𝐕𝟔电影频道🎬', owner: { sec_uid: accountId, nickname: '电影频道云影院' }, has_commerce_goods: false }
  const setFilmRoom = (fields = {}) => pages.set('/' + filmId, flight({ state: { roomStore: { roomInfo: {
    web_rid: filmId, room: { ...showing, ...fields },
  } } } }))
  const config = { ...defaults, categories: '一起看', format: 'hls' }
  assert.ok(douyin.configSchema.find(field => field.key === 'categories').options.some(o => o.value === '一起看'))
  assert.equal(resolverFor(ref), douyin)
  assert.equal(claimsRef('douyinfilm-999'), false)
  setFilmRoom()
  requested.length = 0
  const selected = await douyin.fetch(config, ctx)
  assert.deepEqual(requested, ['/' + filmId])
  assert.deepEqual(selected.groups[0].dataList.map(c => [c.deferredRef, c.relayHls]), [[ref, true]])
  assert.deepEqual((await douyin.fetch({ ...config, minViewers: 101 }, ctx)).groups, [])
  const overlap = flight({ roomsData: { data: [{ web_rid: filmId, room: { ...showing, room_view_stats: { display_value: 500 } } }] } })
  const mixedCtx = { ...ctx, fetchImpl: url => new URL(url).pathname === '/categorynew/4_106'
    ? Promise.resolve(new Response(overlap)) : fetchImpl(url) }
  for (const categories of ['文化\n一起看', '一起看\n文化']) {
    const mixed = await douyin.fetch({ ...config, categories }, mixedCtx)
    assert.deepEqual(mixed.groups[0].dataList.map(c => c.deferredRef), [ref])
  }
  setFilmRoom({ title: '直播｜CCTV6电影频道' })
  assert.equal((await douyin.fetch(config, ctx)).groups[0].dataList[0].deferredRef, ref)
  assert.equal((await resolveRoom(ref, { ...ctx, config, now: 1 })).streamType, 'hls')
  for (const fields of [
    { title: '央影特邀源头服饰厂家 | 双十一甄选', has_commerce_goods: true },
    { has_commerce_goods: true }, { has_commerce_goods: undefined },
    { owner: { nickname: '电影频道云影院', sec_uid: 'other' } },
    { title: '直播丨CCTV6电影频道预告' }, { title: '《天龙八部》全角色配音' },
    { status: 4, stream_url: null },
  ]) {
    setFilmRoom(fields)
    assert.deepEqual((await douyin.fetch(config, ctx)).groups, [])
  }
  setFilmRoom({ title: '服装甄选', has_commerce_goods: true })
  assert.ok((await resolveRoom('douyin-' + filmId, { ...ctx, config, now: 60000 })).url)
  assert.equal((await resolveRoom(ref, { ...ctx, config, now: 60000 })).url, '', '普通房间的缓存不能放行旧影视订阅')
  pages.set('/' + filmId, '<html></html>')
  await assert.rejects(douyin.fetch(config, ctx), /缺少播放数据/)
  clearResolveCache()
}

{
  const config = { ...defaults, categories: '音乐轮播\n综艺轮播\n动画轮播', format: 'hls' }
  const mock = new Map()
  function setRoom(id, fields) {
    const entry = room(id)
    Object.assign(entry.room, fields)
    mock.set('/' + id, flight({ state: { roomStore: { roomInfo: entry } } }))
    return entry
  }
  for (const kind of Object.values(CAROUSELS)) {
    mock.set('/categorynew/4_' + kind.directory, flight({ roomsData: { data: [] } }))
    for (const id of Object.keys(kind.rooms)) setRoom(id, { status: 4 })
  }
  const music = { owner: { sec_uid: CAROUSELS.音乐轮播.rooms['24225754530'] }, has_commerce_goods: true, title: '重温粵语天王歌后经典金曲汇' }
  setRoom('24225754530', music)
  setRoom('32923419266', { owner: { sec_uid: CAROUSELS.综艺轮播.rooms['32923419266'] }, has_commerce_goods: false, title: '《缘来不晚》往期回放合集' })
  setRoom('692362400522', { owner: { sec_uid: CAROUSELS.动画轮播.rooms['692362400522'] }, has_commerce_goods: false, title: '喜羊羊生日直播！' })
  const cartoon = { owner: { sec_uid: 'studio' }, has_commerce_goods: false, title: '原创动画片连播' }
  const found = setRoom('202', cartoon)
  mock.set('/categorynew/4_104', flight({ roomsData: { data: [found, room('500', '真人配音')] } }))
  let cert = { sec_uid: 'studio', enterprise_verify_reason: '动漫制作公司官方账号' }
  const calls = []
  const carouselCtx = { fetchImpl: async url => {
    const u = new URL(url)
    calls.push(u.pathname)
    if (u.hostname === 'www.iesdouyin.com') {
      assert.equal(u.searchParams.get('sec_uid'), 'studio')
      return Response.json({ status_code: 0, user_info: cert })
    }
    return new Response(mock.get(u.pathname), { status: mock.has(u.pathname) ? 200 : 404 })
  } }
  const rooms = await douyin.fetch(config, carouselCtx)
  const refs = rooms.groups[0].dataList.map(r => r.deferredRef)
  assert.deepEqual(new Set(refs), new Set(['douyincarousel-music-24225754530', 'douyincarousel-variety-32923419266', 'douyincarousel-animation-202']))
  assert.ok(rooms.groups[0].dataList.every(r => r.relayHls))
  assert.ok(!calls.includes('/500'))
  calls.length = 0
  const mixed = await douyin.fetch({ ...config, categories: '二次元\n动画轮播' }, carouselCtx)
  assert.equal(calls.filter(p => p === '/categorynew/4_104').length, 1)
  assert.ok(!mixed.groups[0].dataList.some(r => r.deferredRef === 'douyin-202'))
  const ref = 'douyincarousel-animation-202'
  assert.equal(resolverFor(ref), douyin)
  assert.equal((await resolveRoom(ref, { ...carouselCtx, config, now: 1 })).streamType, 'hls')
  setRoom('202', { ...cartoon, title: '原创动画游戏轮播' })
  assert.equal((await resolveRoom(ref, { ...carouselCtx, config, now: 60000 })).url, '')
  setRoom('202', cartoon)
  cert = { sec_uid: 'other', enterprise_verify_reason: '动漫公司' }
  assert.equal((await resolveRoom(ref, { ...carouselCtx, config, now: 80000 })).url, '')
  setRoom('24225754530', { ...music, title: '音乐轮播 · 手表带货' })
  assert.deepEqual((await douyin.fetch({ ...config, categories: '音乐轮播' }, carouselCtx)).groups, [])
  calls.length = 0
  mock.set('/categorynew/4_102', '<html><title>验证码中间页</title></html>')
  await assert.rejects(douyin.fetch({ ...config, categories: '音乐轮播' }, carouselCtx), /验证码/)
  assert.deepEqual(calls, ['/categorynew/4_102'])
  assert.equal(claimsRef('douyincarousel-wrong-202'), false)
  clearResolveCache()
}

const manual = await fetchRoom('999', ctx)
assert.equal(manual.id, '999')
const flv = await resolveRoom('douyin-999', { ...ctx, config: { format: 'flv', quality: 'HD1' } })
const hls = await resolveRoom('douyin-999', { ...ctx, config: { format: 'hls', quality: 'HD1' } })
assert.equal(flv.streamType, 'flv')
assert.equal(typeof flv.validateMediaUrl, 'function')
assert.equal(hls.streamType, 'hls')
assert.equal(hls.relayHls, true)
assert.equal((await resolveRoom('bad-ref', ctx)).url, '')
const fallback = await resolveRoom('douyin-888', { ...ctx, config: { format: 'flv', quality: 'HD1' } })
assert.equal(fallback.streamType, 'hls')
assert.equal(fallback.relayHls, true)
assert.match(fallback.desc, /超清，没有 FLV 改用 HLS/)
clearResolveCache()

// 官方调度跳到白名单外：502，且错误里写明被拒的主机和路径、不带签名参数
{
  let result
  const flv = await resolveRoom('douyin-999', { ...ctx, config: { format: 'flv', quality: 'HD1' } })
  const server = http.createServer(async (req, res) => {
    result = await pipeFlv(flv.url, req, res, flv.validateMediaUrl, {
      fetchImpl: async () => new Response(null, { status: 302, headers: { Location: 'https://edge.unknown-cdn.test/live/999.flv?sign=secret' } }),
    })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`)
  assert.equal(response.status, 502); await response.text()
  server.close()
  assert.equal(result.error, '官方调度跳到未放行的地址 edge.unknown-cdn.test/live/999.flv')
}

console.log('抖音模块测试通过')
