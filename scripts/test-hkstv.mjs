#!/usr/bin/env node
import assert from 'node:assert/strict'

import hkstv from '../extractors/hkstv/index.js'
import {
  CHANNEL,
  ENTRY_HARD_TTL_MS,
  HKSTV_CHANNEL_API,
  HKSTV_PLAYER_API,
  buildChannels,
  claimsRef,
  createResolver,
  firstVariant,
  officialAssetUrl,
  officialHlsUrl,
  upstreamHeadersFor,
  parseDefaultChannel,
  parsePlayerResponse,
  requestEntry,
  validateHls,
} from '../extractors/hkstv/api.js'
import { getModule, resolverFor } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }
const response = (body, status = 200, headers = {}) => new Response(
  typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers },
)

const SOURCE_ID = 'mutfysrq'
const ENTRY_URL = `https://webcast.hkstv.tv/livestream/${SOURCE_ID}/playlist.m3u8`
const playerUrlFor = sourceId => `${HKSTV_PLAYER_API}/${sourceId}?mode=live&protocal=hls`
const channelPayload = (overrides = {}) => ({
  data: { id: 12, sourceid: SOURCE_ID, channel: '香港卫视', ...overrides },
})
// 官网入口是一层 master，里面只有一条带 hls_ctx 的子清单
const master = (ctx, sourceId = SOURCE_ID) => '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,AVERAGE-BANDWIDTH=1\n'
  + `/livestream/${sourceId}/playlist.m3u8?hls_ctx=${ctx}\n`
const media = (sequence, ctx) => `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n`
  + `#EXT-X-TARGETDURATION:15\n#EXTINF:10.000, no desc\nplaylist-${sequence}.ts?hls_ctx=${ctx}\n`

/** 完整上游：频道接口 → 播放器接口 → master → 子清单；每次取 master 换一个 hls_ctx。 */
function upstream({ entryUrl = ENTRY_URL, channel = channelPayload() } = {}) {
  const state = { entryRequests: 0, masterRequests: 0, mediaRequests: 0 }
  const fetchImpl = async url => {
    if (url === HKSTV_CHANNEL_API) { state.entryRequests++; return response(channel) }
    if (url.startsWith(HKSTV_PLAYER_API)) {
      return response({ livetime: '1789208971378', url: entryUrl.replace(/^https:/, 'http:') })
    }
    if (url.includes('hls_ctx=')) {
      state.mediaRequests++
      return response(media(179000 + state.mediaRequests, `ctx${state.masterRequests}`))
    }
    state.masterRequests++
    return response(master(`ctx${state.masterRequests}`, new URL(url).pathname.split('/')[2]))
  }
  return { state, fetchImpl }
}

console.log('香港卫视模块测试')

check('模块注册为免账号的香港中继模块', () => {
  assert.equal(getModule('hkstv'), hkstv)
  assert.equal(hkstv.name, '香港卫视')
  assert.equal(hkstv.category, undefined)
  assert.equal(hkstv.outputGroupName, '香港')
  assert.equal(hkstv.channelHlsMode, 'relay')
  assert.equal(hkstv.relayProxyCompatible, true)
  assert.equal(hkstv.capabilities.catchup, false)
  // 官网節目單走独立的 epg.js（见 test-hkstv-epg.mjs）
  assert.equal(hkstv.capabilities.epg, true)
  assert.equal(hkstv.catalogVersion, 1)
  assert.deepEqual(hkstv.configSchema, [])
  assert.equal(resolverFor(CHANNEL.ref), hkstv)
  assert.equal(resolverFor('hkstv-live/extra'), null)
  assert.equal(resolverFor('hkstv'), null)
})

await checkAsync('官网单路直播输出到香港分组，不继承全局回看', async () => {
  const channels = buildChannels()
  assert.deepEqual(channels.map(channel => channel.deferredRef), ['hkstv-live'])
  assert.equal(channels[0].name, '香港卫视')
  assert.equal(channels[0].logo, 'https://hkstv.tv/images/logos/hks-logo-red.png')
  assert.equal(channels[0].catchup, 'none')
  assert.equal(claimsRef('hkstv-live'), true)
  assert.equal(claimsRef('hkstv-live2'), false)
  const result = await hkstv.fetch()
  assert.deepEqual(result.groups, [{ name: '香港', dataList: channels }])
})

check('官网响应解析严格：sourceid 消毒、HTTP 升 HTTPS、路径必须对上本轮频道', () => {
  const channel = parseDefaultChannel(channelPayload())
  assert.deepEqual(channel, { sourceId: SOURCE_ID, name: '香港卫视', providerChannelId: 12 })
  assert.equal(parseDefaultChannel(channelPayload({ channel: '  ' })).name, '香港卫视')
  assert.throws(() => parseDefaultChannel('{broken'), /有效 JSON/)
  assert.throws(() => parseDefaultChannel(channelPayload({ sourceid: '../evil' })), /有效 sourceid/)
  assert.throws(() => parseDefaultChannel({ data: {} }), /有效 sourceid/)

  assert.equal(
    parsePlayerResponse({ url: `http://webcast.hkstv.tv/livestream/${SOURCE_ID}/playlist.m3u8` }, SOURCE_ID),
    ENTRY_URL,
  )
  assert.equal(parsePlayerResponse({ data: { url: ENTRY_URL } }, SOURCE_ID), ENTRY_URL)
  assert.throws(() => parsePlayerResponse({ url: 'https://evil.test/live.m3u8' }, SOURCE_ID), /非官方媒体地址/)
  assert.throws(
    () => parsePlayerResponse({ url: 'https://webcast.hkstv.tv/livestream/other/playlist.m3u8' }, SOURCE_ID),
    /非本频道的媒体路径/,
  )
  assert.throws(() => parsePlayerResponse({}, SOURCE_ID), /没有返回直播地址/)
})

check('媒体白名单覆盖清单、子清单与分片，并拒绝任意外部地址', () => {
  assert.equal(officialHlsUrl(ENTRY_URL), ENTRY_URL)
  assert.equal(officialHlsUrl(`${ENTRY_URL}?hls_ctx=abc`), `${ENTRY_URL}?hls_ctx=abc`)
  assert.match(officialAssetUrl(`https://webcast.hkstv.tv/livestream/${SOURCE_ID}/playlist-1.ts?hls_ctx=abc`), /playlist-1\.ts/)
  assert.equal(validateHls(media(1, 'abc'), `${ENTRY_URL}?hls_ctx=abc`).startsWith('#EXTM3U'), true)
  assert.deepEqual(upstreamHeadersFor(ENTRY_URL), { Referer: 'https://hkstv.tv/' })
  assert.equal(firstVariant(master('abc'), ENTRY_URL), `${ENTRY_URL}?hls_ctx=abc`)
  assert.equal(firstVariant(media(1, 'abc'), ENTRY_URL), null)
  for (const bad of [
    `http://webcast.hkstv.tv/livestream/${SOURCE_ID}/playlist.m3u8`,
    `https://webcast.hkstv.tv.evil.test/livestream/${SOURCE_ID}/playlist.m3u8`,
    `https://user:pass@webcast.hkstv.tv/livestream/${SOURCE_ID}/playlist.m3u8`,
    'https://hkstv.tv/livestream/x/playlist.m3u8',
    'https://webcast.hkstv.tv/private/a.ts',
  ]) assert.throws(() => officialAssetUrl(bad))
  assert.throws(() => officialHlsUrl(`https://webcast.hkstv.tv/livestream/${SOURCE_ID}/index.m3u8`), /有效 HLS 入口/)
  assert.throws(() => validateHls('#EXTM3U\n#EXTINF:4,\nhttps://example.com/a.ts\n', ENTRY_URL), /非官方媒体地址/)
  assert.throws(() => validateHls('<html>', ENTRY_URL), /不是 HLS 清单/)
})

await checkAsync('取入口是频道接口加播放器接口两跳，且拒绝重定向与超大响应', async () => {
  const seen = []
  const entry = await requestEntry({
    fetchImpl: async (url, options) => {
      seen.push(url)
      assert.equal(options.redirect, 'manual')
      assert.equal(options.headers.Referer, 'https://hkstv.tv/')
      return url === HKSTV_CHANNEL_API
        ? response(channelPayload())
        : response({ url: ENTRY_URL })
    },
  })
  assert.deepEqual(seen, [HKSTV_CHANNEL_API, playerUrlFor(SOURCE_ID)])
  assert.deepEqual(entry, { sourceId: SOURCE_ID, streamUrl: ENTRY_URL })

  await assert.rejects(requestEntry({
    fetchImpl: async () => response('', 302, { Location: 'https://example.com/' }),
  }), /不安全的重定向/)
  await assert.rejects(requestEntry({
    fetchImpl: async () => response('upstream down', 503),
  }), /HTTP 503/)
  await assert.rejects(requestEntry({
    fetchImpl: async () => response('x'.repeat(512 * 1024 + 1)),
  }), /响应过大/)
})

await checkAsync('master 在服务端拍平成媒体清单，每次播放都重新取，但入口只取一次', async () => {
  const { state, fetchImpl } = upstream()
  const resolver = createResolver({ fetchImpl })
  const first = await resolver.resolve('hkstv-live', { now: 1_000 })
  const second = await resolver.resolve('hkstv-live', { now: 2_000 })

  assert.equal(first.url, ENTRY_URL)
  assert.equal(first.relayHls, true)
  assert.match(first.manifestText, /#EXTINF:/)
  assert.doesNotMatch(first.manifestText, /#EXT-X-STREAM-INF/)
  assert.equal(first.manifestUrl, `${ENTRY_URL}?hls_ctx=ctx1`)
  assert.equal(second.manifestUrl, `${ENTRY_URL}?hls_ctx=ctx2`)
  assert.notEqual(first.manifestText, second.manifestText)
  assert.equal(state.entryRequests, 1)
  assert.equal(state.mediaRequests, 2)
  assert.equal(
    first.upstreamUrlTransform(`https://webcast.hkstv.tv/livestream/${SOURCE_ID}/playlist-1.ts?hls_ctx=ctx1`),
    `https://webcast.hkstv.tv/livestream/${SOURCE_ID}/playlist-1.ts?hls_ctx=ctx1`,
  )
  assert.throws(() => first.upstreamUrlTransform('https://example.com/a.ts'))
  assert.deepEqual(first.upstreamHeaders(ENTRY_URL), { Referer: 'https://hkstv.tv/' })
  assert.equal(first.upstreamHeaders(ENTRY_URL)['User-Agent'], undefined, '固定对象里的 UA 不生效，别声明')
  assert.throws(() => first.upstreamHeaders('https://example.com/a.ts'), /非官方媒体地址/)
})

await checkAsync('并发播放请求共享同一次入口查询', async () => {
  const { state, fetchImpl } = upstream()
  const resolver = createResolver({ fetchImpl })
  const results = await Promise.all([
    resolver.resolve('hkstv-live', { now: 1_000 }),
    resolver.resolve('hkstv-live', { now: 1_000 }),
  ])
  assert.ok(results.every(result => result.url === ENTRY_URL))
  assert.equal(state.entryRequests, 1)
})

await checkAsync('入口接口短暂失败时沿用上次成功入口并退避，超过硬期限才报错', async () => {
  const { fetchImpl } = upstream()
  let apiDown = false
  let entryRequests = 0
  const resolver = createResolver({
    fetchImpl: async (url, options) => {
      if (url !== HKSTV_CHANNEL_API) return fetchImpl(url, options)
      entryRequests++
      return apiDown ? response('temporary failure', 503) : fetchImpl(url, options)
    },
  })
  await resolver.resolve('hkstv-live', { now: 1_000 })
  apiDown = true
  const stale = await resolver.resolve('hkstv-live', { now: 1_001 + 10 * 60 * 1000 })
  const backedOff = await resolver.resolve('hkstv-live', { now: 1_002 + 10 * 60 * 1000 })
  assert.equal(stale.url, ENTRY_URL)
  assert.equal(backedOff.url, ENTRY_URL)
  assert.equal(entryRequests, 2, '退避窗口内不再打上游')

  const expired = await resolver.resolve('hkstv-live', { now: 1_001 + ENTRY_HARD_TTL_MS })
  assert.equal(expired.url, '')
  assert.match(expired.desc, /请求失败.*HTTP 503/)
})

await checkAsync('官网换台后旧入口失效时立即重取入口', async () => {
  const oldSourceId = 'oldsrcid'
  let entryRequests = 0
  const fetchImpl = async url => {
    if (url === HKSTV_CHANNEL_API) {
      entryRequests++
      return response(channelPayload({ sourceid: entryRequests === 1 ? oldSourceId : SOURCE_ID }))
    }
    if (url.startsWith(HKSTV_PLAYER_API)) {
      const sourceId = new URL(url).pathname.split('/').pop()
      return response({ url: `https://webcast.hkstv.tv/livestream/${sourceId}/playlist.m3u8` })
    }
    if (url.includes(oldSourceId)) return response('gone', 404)
    if (url.includes('hls_ctx=')) return response(media(9, 'ctxnew'))
    return response(master('ctxnew'))
  }
  const resolver = createResolver({ fetchImpl })
  const recovered = await resolver.resolve('hkstv-live', { now: 1_000 })
  assert.equal(recovered.url, ENTRY_URL)
  assert.match(recovered.manifestText, /MEDIA-SEQUENCE:9/)
  assert.equal(entryRequests, 2)
})

await checkAsync('清缓存时在途旧请求不会覆盖新结果', async () => {
  const otherEntry = 'https://webcast.hkstv.tv/livestream/othersrc/playlist.m3u8'
  let entryRequests = 0
  let releaseFirst
  const firstResponse = new Promise(resolve => { releaseFirst = resolve })
  const fetchImpl = async url => {
    if (url === HKSTV_CHANNEL_API) {
      entryRequests++
      if (entryRequests === 1) return firstResponse
      return response(channelPayload())
    }
    if (url.startsWith(HKSTV_PLAYER_API)) {
      const sourceId = new URL(url).pathname.split('/').pop()
      return response({ url: `https://webcast.hkstv.tv/livestream/${sourceId}/playlist.m3u8` })
    }
    if (url.includes('hls_ctx=')) return response(media(1, 'ctx'))
    return response(master('ctx', new URL(url).pathname.split('/')[2]))
  }
  const resolver = createResolver({ fetchImpl })
  const oldRequest = resolver.resolve('hkstv-live', { now: 1_000 })
  assert.equal(entryRequests, 1)
  resolver.clear()
  const newResult = await resolver.resolve('hkstv-live', { now: 1_000 })
  releaseFirst(response(channelPayload({ sourceid: 'othersrc' })))
  const oldResult = await oldRequest
  const cachedResult = await resolver.resolve('hkstv-live', { now: 2_000 })
  assert.equal(newResult.url, ENTRY_URL)
  assert.equal(oldResult.url, otherEntry)
  assert.equal(cachedResult.url, ENTRY_URL, '旧世代结果不得写回新缓存')
  assert.equal(entryRequests, 2)
})

await checkAsync('非法引用和上游异常只返回说明，不向请求处理器抛错', async () => {
  const resolver = createResolver({
    fetchImpl: async url => {
      if (url === HKSTV_CHANNEL_API) return response('upstream error', 500)
      throw new Error('不应请求媒体')
    },
  })
  const malformed = await resolver.resolve('hkstv-other')
  assert.equal(malformed.url, '')
  assert.match(malformed.desc, /引用格式错误/)
  const failed = await resolver.resolve('hkstv-live', { now: 1_000 })
  assert.equal(failed.url, '')
  assert.match(failed.desc, /请求失败.*HTTP 500/)

  const timedOut = await resolver.resolve('hkstv-live', { now: 2_000, timeoutMs: 5 })
  assert.equal(timedOut.url, '')
})

console.log(`\n全部通过：${passed} ✅`)
