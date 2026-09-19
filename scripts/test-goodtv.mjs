#!/usr/bin/env node
import assert from 'node:assert/strict'

import goodtv from '../extractors/goodtv/index.js'
import {
  CHANNELS,
  FAIL_RETRY_MS,
  GOODTV_ORIGIN,
  LINE_TTL_MS,
  MEDIA_HOSTS,
  buildChannels,
  candidateTiers,
  claimsRef,
  createResolver,
  officialAssetUrl,
  resolveChannel,
  upstreamHeadersFor,
  validateManifest,
} from '../extractors/goodtv/api.js'
import { getModule, resolverFor } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('GOOD TV 模块测试')

check('模块注册为免账号的台湾全代理模块', () => {
  assert.equal(getModule('goodtv'), goodtv)
  assert.equal(goodtv.name, 'GOOD TV')
  assert.equal(goodtv.outputGroupName, '台湾')
  assert.equal(goodtv.channelHlsMode, 'proxy')
  assert.equal(goodtv.capabilities.catchup, false)
  assert.equal(goodtv.catalogVersion, 1)
  assert.deepEqual(goodtv.configSchema, [])
  assert.equal(resolverFor('goodtv-main'), goodtv)
  assert.equal(resolverFor('goodtv-main/extra'), null)
})

await checkAsync('综合台与真理台归入台湾分组且不继承回看', async () => {
  assert.deepEqual(CHANNELS.map(channel => [channel.ref, channel.name]), [
    ['goodtv-main', 'GOODTV'],
    ['goodtv-truth', 'GOODTV2'],
  ])
  const channels = buildChannels()
  assert.deepEqual(channels.map(channel => channel.deferredRef), CHANNELS.map(channel => channel.ref))
  // 台标留空交给公共台标库按名兜底：官网只有一张站点 logo，两台共用分不出来；
  // 库里恰好收了 GOODTV / GOODTV2 两张，频道名按台名写才能命中
  assert.ok(channels.every(channel => channel.logo === '' && channel.groupTitle === '台湾'))
  assert.ok(channels.every(channel => channel.catchup === 'none'))
  assert.deepEqual(await goodtv.fetch(), {
    groups: [{ name: '台湾', dataList: channels }],
    meta: { skipped: [], warnings: [] },
  })
  assert.equal(claimsRef('goodtv-truth'), true)
  assert.equal(claimsRef('goodtv-radio'), false)
})

const [CLOUDFRONT, AKAMAI] = MEDIA_HOSTS
const SEGMENT_DIR = '../../../../hls-live/streams/goodtv/events/_definst_/liveevent'
const manifestFor = (url, seq = 100) => {
  const stream = new URL(url).pathname.match(/(live-ch\d-\d)\.m3u8$/)[1]
  return ['#EXTM3U', `#EXT-X-MEDIA-SEQUENCE:${seq}`, '#EXT-X-TARGETDURATION:8',
    ...[0, 1, 2].flatMap(index => ['#EXTINF:8,', `${SEGMENT_DIR}/${stream}Num${seq + index}.ts`]), ''].join('\r\n')
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** routes: host -> { delay, status, body }；body 缺省回一份合法清单。calls 记下每次请求的地址。 */
function fakeLines(routes) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push(url)
    const { hostname } = new URL(url)
    const route = typeof routes[hostname] === 'function' ? routes[hostname](url) : routes[hostname]
    if (route?.delay) await sleep(route.delay)
    if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    if (route?.error) throw new Error(route.error)
    const status = route?.status || 200
    return new Response(status === 200 ? (route?.body ?? manifestFor(url)) : 'denied', { status })
  }
  return { calls, fetchImpl }
}

check('候选地址按档位分层：1080p 两条线路在前，720p 两条线路兜底', () => {
  assert.deepEqual(candidateTiers(CHANNELS[0]), [
    [`https://${CLOUDFRONT}/hls-live/goodtv/_definst_/liveevent/live-ch1-3.m3u8`,
      `https://${AKAMAI}/hls-live/goodtv/_definst_/liveevent/live-ch1-3.m3u8`],
    [`https://${CLOUDFRONT}/hls-live/goodtv/_definst_/liveevent/live-ch1-2.m3u8`,
      `https://${AKAMAI}/hls-live/goodtv/_definst_/liveevent/live-ch1-2.m3u8`],
  ])
  assert.match(candidateTiers(CHANNELS[1])[0][1], /akamai-live\.akamaized\.net\/.*\/live-ch2-3\.m3u8$/)
})

check('媒体白名单只放行两条官方线路的分发目录，含分片的相对回跳', () => {
  // 清单里的分片是 ../../../../hls-live/streams/... ，解析后仍在同一前缀下
  for (const manifestUrl of candidateTiers(CHANNELS[0])[0]) {
    const host = new URL(manifestUrl).hostname
    const segment = new URL(`${SEGMENT_DIR}/live-ch1-3Num1.ts`, manifestUrl).href
    assert.equal(officialAssetUrl(segment),
      `https://${host}/hls-live/streams/goodtv/events/_definst_/liveevent/live-ch1-3Num1.ts`)
  }
  for (const bad of [
    'http://dqhxk7sbp7xog.cloudfront.net/hls-live/goodtv/_definst_/liveevent/live-ch1-2.m3u8',
    'https://dqhxk7sbp7xog.cloudfront.net.evil.test/hls-live/live-ch1-2.m3u8',
    'https://cloudfront.net/hls-live/live-ch1-2.m3u8',
    'https://127.0.0.1/hls-live/live-ch1-2.m3u8',
    'https://user:pass@dqhxk7sbp7xog.cloudfront.net/hls-live/live-ch1-2.m3u8',
    'https://dqhxk7sbp7xog.cloudfront.net:444/hls-live/live-ch1-2.m3u8',
    'https://dqhxk7sbp7xog.cloudfront.net/private/live-ch1-2.m3u8',
    'https://dqhxk7sbp7xog.cloudfront.net/hls-live/..%2fprivate/live.m3u8',
    'https://dqhxk7sbp7xog.cloudfront.net/hls-live/live-ch1-2.m3u8#frag',
    // 同一家 CDN 的别的租户、官网的点播线路和大陆不可达的台湾线路都不在白名单里
    'https://akamai-vod.akamaized.net/hls-live/live-ch1-2.m3u8',
    'https://akamai-live.akamaized.net.evil.test/hls-live/live-ch1-2.m3u8',
    'https://akamai-live.akamaized.net/private/live-ch1-2.m3u8',
    'https://live.streamingfast.net/hls-live/goodtv/_definst_/liveevent/live-ch1-3.m3u8',
    'not a url',
  ]) assert.throws(() => officialAssetUrl(bad), /GOOD TV/)
})

check('回源请求头只带官网 Referer，UA 交给代理层', () => {
  for (const url of candidateTiers(CHANNELS[1]).flat()) {
    assert.deepEqual(upstreamHeadersFor(url), { Referer: `${GOODTV_ORIGIN}/` })
    // 真正决定 CloudFront 放行的是 UA；固定对象里声明的 UA 不会生效，所以不声明
    assert.equal('User-Agent' in upstreamHeadersFor(url), false)
  }
  assert.throws(() => upstreamHeadersFor('https://evil.test/hls-live/live.m3u8'), /非官方媒体地址/)
})

check('清单必须带分片且分片全部落在官方目录内', () => {
  const url = candidateTiers(CHANNELS[0])[0][1]
  assert.equal(validateManifest(manifestFor(url), url), manifestFor(url))
  assert.throws(() => validateManifest('<html>blocked</html>', url), /不是 HLS 清单/)
  assert.throws(() => validateManifest('#EXTM3U\n#EXT-X-TARGETDURATION:8\n', url), /没有直播分片/)
  assert.throws(() => validateManifest('#EXTM3U\n#EXTINF:8,\nhttps://evil.test/hls-live/a.ts\n', url), /非官方媒体地址/)
  assert.throws(() => validateManifest('#EXTM3U\n#EXTINF:8,\n../../../../private/a.ts\n', url), /非官方媒体地址/)
})

await checkAsync('首次播放两条线路竞速 1080p，先回的胜出并直接交回清单', async () => {
  const { calls, fetchImpl } = fakeLines({ [CLOUDFRONT]: { delay: 40 }, [AKAMAI]: { delay: 5 } })
  const { resolve } = createResolver({ fetchImpl })
  for (const channel of CHANNELS) {
    calls.length = 0
    const [tier1080] = candidateTiers(channel)
    const resolved = await resolve(channel.ref, { now: 0 })
    assert.equal(resolved.url, tier1080[1])
    assert.equal(resolved.manifestUrl, tier1080[1])
    assert.equal(resolved.manifestText, manifestFor(tier1080[1]))
    assert.match(resolved.desc, new RegExp(channel.name))
    assert.equal(typeof resolved.upstreamHeaders, 'function')
    assert.equal(resolved.upstreamUrlTransform(tier1080[0]), tier1080[0])
    // 1080p 有线路能用就不碰 720p
    assert.deepEqual([...calls].sort(), [...tier1080].sort())
  }
})

await checkAsync('线路缓存期内每次轮询只打当前线路，且清单每次重取', async () => {
  let seq = 100
  const { calls, fetchImpl } = fakeLines({
    [CLOUDFRONT]: url => ({ delay: 5, body: manifestFor(url, seq) }),
    [AKAMAI]: { delay: 40 },
  })
  const { resolve } = createResolver({ fetchImpl })
  const cloudfront = candidateTiers(CHANNELS[0])[0][0]
  assert.equal((await resolve('goodtv-main', { now: 0 })).url, cloudfront)
  calls.length = 0
  seq = 101
  const next = await resolve('goodtv-main', { now: LINE_TTL_MS - 1 })
  assert.deepEqual(calls, [cloudfront])
  assert.match(next.manifestText, /#EXT-X-MEDIA-SEQUENCE:101/)
  // 到期的那次轮询重新两线竞速
  calls.length = 0
  await resolve('goodtv-main', { now: LINE_TTL_MS })
  assert.equal(calls.length, 2)
})

await checkAsync('当前线路出错时同一次轮询内当场换到另一条线路', async () => {
  const routes = { [CLOUDFRONT]: { delay: 5 }, [AKAMAI]: { delay: 40 } }
  const { calls, fetchImpl } = fakeLines(routes)
  const { resolve } = createResolver({ fetchImpl })
  const [cloudfront, akamai] = candidateTiers(CHANNELS[0])[0]
  assert.equal((await resolve('goodtv-main', { now: 0 })).url, cloudfront)
  routes[CLOUDFRONT] = { error: 'connect ETIMEDOUT' }
  calls.length = 0
  const switched = await resolve('goodtv-main', { now: 1000 })
  assert.equal(switched.url, akamai)
  assert.equal(switched.manifestText, manifestFor(akamai))
  // 之后沿用新线路，不再回头试坏掉的那条
  calls.length = 0
  await resolve('goodtv-main', { now: 2000 })
  assert.deepEqual(calls, [akamai])
})

await checkAsync('CloudFront 按播放器标识 403 或回了非清单内容时 Akamai 胜出', async () => {
  for (const broken of [{ status: 403 }, { body: '<html>Request blocked</html>' }]) {
    const { fetchImpl } = fakeLines({ [CLOUDFRONT]: broken, [AKAMAI]: { delay: 20 } })
    const resolved = await createResolver({ fetchImpl }).resolve('goodtv-truth', { now: 0 })
    assert.equal(resolved.url, candidateTiers(CHANNELS[1])[0][1])
  }
})

await checkAsync('1080p 整档取不到时退回 720p，线路缓存到期后重新争取 1080p', async () => {
  let has1080 = false
  const byRendition = url => (/-3\.m3u8$/.test(url) && !has1080 ? { status: 404 } : {})
  const { calls, fetchImpl } = fakeLines({ [CLOUDFRONT]: byRendition, [AKAMAI]: byRendition })
  const { resolve } = createResolver({ fetchImpl })
  const [tier1080, tier720] = candidateTiers(CHANNELS[0])
  const degraded = await resolve('goodtv-main', { now: 0 })
  assert.ok(tier720.includes(degraded.url))
  assert.equal(calls.length, 4)
  has1080 = true
  assert.ok(tier720.includes((await resolve('goodtv-main', { now: 1000 })).url))
  assert.ok(tier1080.includes((await resolve('goodtv-main', { now: LINE_TTL_MS })).url))
})

await checkAsync('同台并发轮询共用一次竞速', async () => {
  const { calls, fetchImpl } = fakeLines({ [CLOUDFRONT]: { delay: 20 }, [AKAMAI]: { delay: 30 } })
  const { resolve } = createResolver({ fetchImpl })
  const results = await Promise.all([1, 2, 3].map(() => resolve('goodtv-main', { now: 0 })))
  assert.equal(calls.length, 2)
  assert.ok(results.every(item => item.url === candidateTiers(CHANNELS[0])[0][0]))
})

await checkAsync('两条线路全挂时给出各自原因，短熔断内不再打上游', async () => {
  const routes = { [CLOUDFRONT]: { status: 403 }, [AKAMAI]: { error: 'getaddrinfo ENOTFOUND' } }
  const { calls, fetchImpl } = fakeLines(routes)
  const { resolve } = createResolver({ fetchImpl })
  const failed = await resolve('goodtv-main', { now: 0 })
  assert.equal(failed.url, '')
  assert.match(failed.desc, /GOODTV链接请求失败：官方线路均不可用/)
  assert.match(failed.desc, /dqhxk7sbp7xog\.cloudfront\.net HTTP 403/)
  assert.match(failed.desc, /akamai-live\.akamaized\.net getaddrinfo ENOTFOUND/)
  assert.equal(calls.length, 4)
  // 播放器的连环重试落在熔断窗口里，一个请求都不发
  calls.length = 0
  assert.equal((await resolve('goodtv-main', { now: FAIL_RETRY_MS - 1 })).url, '')
  assert.equal(calls.length, 0)
  // 另一台不受牵连；窗口过后恢复即可播
  routes[CLOUDFRONT] = {}
  assert.notEqual((await resolve('goodtv-truth', { now: 1 })).url, '')
  assert.equal((await resolve('goodtv-main', { now: FAIL_RETRY_MS })).url, candidateTiers(CHANNELS[0])[0][0])
})

await checkAsync('线路迟迟不回按超时处理，不拖住请求', async () => {
  const { fetchImpl } = fakeLines({ [CLOUDFRONT]: { delay: 200 }, [AKAMAI]: { delay: 200 } })
  const failed = await createResolver({ fetchImpl }).resolve('goodtv-main', { now: 0, timeoutMs: 30 })
  assert.equal(failed.url, '')
  assert.match(failed.desc, /超时/)
})

await checkAsync('非法引用只返回说明，不向请求处理器抛错', async () => {
  const malformed = await resolveChannel('goodtv-radio')
  assert.equal(malformed.url, '')
  assert.match(malformed.desc, /引用格式错误/)
  assert.equal((await resolveChannel('')).url, '')
})

console.log(`\n全部通过：${passed} ✅`)
