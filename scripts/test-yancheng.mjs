import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import mod from '../extractors/yancheng/index.js'
import { CHANNELS, catalog, mediaUrl, validateManifest } from '../extractors/yancheng/protocol.js'
import { resolveChannel } from '../extractors/yancheng/api.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/yancheng.json', import.meta.url)))
const now = Date.parse('2026-10-23T22:35:00+08:00')
const channel = CHANNELS[0]
const row = fixture.one.find(r => r.time_status === 1)
const manifest = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:24982\n#EXTINF:6.071,\n/sd_sd/1792765472/1792766105965.ts?_upt=41706c161792773305\n'
const fake = (rows = fixture.one) => async (url, options) => {
  if (url.includes('/topic/list?')) return Response.json(fixture.channels)
  if (url.includes('/program/list?')) return Response.json({ error_code: 200, result: rows })
  assert.equal(options.headers.Referer, 'https://www.0515yc.cn/')
  assert.equal(options.redirect, 'manual')
  return new Response(manifest)
}

test('两套官方频道在江苏组，使用稳定引用，不保存签名地址', async () => {
  const result = await mod.fetch({}, { fetchImpl: fake() })
  assert.equal(result.groups[0].name, '江苏')
  assert.deepEqual(result.groups[0].dataList.map(c => c.deferredRef), ['yancheng-1', 'yancheng-2'])
  assert.ok(!JSON.stringify(result).includes('_upt'))
  assert.equal(mod.channelHlsMode, 'proxy')
  assert.equal(mod.capabilities.catchup, false)
  assert.ok(mod.claimsRef('yancheng-1'))
  assert.ok(!mod.claimsRef('yancheng-3'))
})

test('当前节目签名、清单与频道分片校验，保留来源头并限制旧入口', async () => {
  let clock = now
  const result = await resolveChannel(channel.ref, { fetchImpl: fake(), now: () => clock })
  assert.equal(result.url, row.m3u8)
  assert.equal(result.manifestText, manifest)
  const segment = manifest.trim().split('\n').at(-1)
  assert.match(result.upstreamUrlTransform(segment), /^https:\/\/live1yc\.0515yc\.cn\/sd_sd\//)
  assert.equal(result.upstreamHeaders(segment).Origin, 'https://www.0515yc.cn')
  assert.throws(() => result.upstreamHeaders(segment.replace('sd_sd', 'hd_sd')))
  clock += 30000
  assert.throws(() => result.upstreamHeaders(segment), /已过期/)
  const nearEnd = Number(row.end_time_timestamp) * 1000 - 1000
  clock = nearEnd
  const boundary = await resolveChannel(channel.ref, { fetchImpl: fake(), now: () => clock })
  clock += 1000
  assert.throws(() => boundary.upstreamHeaders(segment), /已过期/)
})

test('限制、节目空档、接口失败不回退到裸流，也不抛出异常', async () => {
  for (const rows of [[], [{ ...row, can_play: 0 }], [{ ...row, playing: 0 }], [{ ...row, stream_id: CHANNELS[1].streamId }], [row, row]]) {
    const result = await resolveChannel(channel.ref, { fetchImpl: fake(rows), now: () => now })
    assert.equal(result.url, '')
  }
  assert.equal((await resolveChannel(channel.ref, { fetchImpl: async () => { throw new Error('network https://secret.invalid') } })).url, '')
  assert.equal((await resolveChannel('yancheng-99')).url, '')
  assert.equal((await resolveChannel(channel.ref, { fetchImpl: fake(), now: () => Number(row.end_time_timestamp) * 1000 })).url, '')
})

test('拒绝跨台、未知主机、重定向、回看与改变的 HLS 格式', async () => {
  for (const url of [row.m3u8.replace('live1yc.0515yc.cn', 'evil.invalid'), row.m3u8.replace('/sd/sd/', '/hd/sd/'), row.m3u8.replace('live.m3u8', '1,2.m3u8'), row.m3u8 + '&extra=1', row.m3u8.replace('https:', 'http:')]) assert.throws(() => mediaUrl(url, channel))
  for (const text of [manifest + '#EXT-X-ENDLIST\n', manifest + '#EXT-X-KEY:METHOD=AES-128,URI="https://evil.invalid/key"\n', manifest.replace('/sd_sd/', '/hd_sd/')]) assert.throws(() => validateManifest(text, row.m3u8, channel))
  const rejected = await resolveChannel(channel.ref, { now: () => now, fetchImpl: async url => url.includes('/program/list?') ? Response.json({ error_code: 200, result: fixture.one }) : new Response('', { status: 302, headers: { location: 'https://evil.invalid' } }) })
  assert.equal(rejected.url, '')
  await assert.rejects(catalog({ fetchImpl: async () => Response.json(fixture.channels.slice(0, 1)) }), /不完整/)
})
