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
// 默认配置：只在「聊天」「生活」两个分类里轮选
const defaults = Object.fromEntries(douyin.configSchema.map(field => [field.key, field.default]))
requested.length = 0
const byDefault = await douyin.fetch(defaults, ctx)
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

const balanced = await douyin.fetch({ order: 'balanced', count: 9, rooms: '999', format: 'hls', quality: 'HD1', minViewers: 0, categories: Object.values(CATEGORIES).join('\n') }, ctx)
const channels = balanced.groups[0].dataList
assert.equal(channels.length, 10)
assert.equal(channels[0].deferredRef, 'douyin-999')
assert.ok(channels.every(channel => channel.relayHls && channel.deferredRef.startsWith('douyin-')))
assert.deepEqual(new Set(channels.slice(1, 9).map(channel => channel.deferredRef)),
  new Set(categories.map((_, index) => `douyin-${index + 1}01`)))

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
