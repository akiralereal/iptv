#!/usr/bin/env node
import assert from 'node:assert/strict'

import yangshipin from '../extractors/yangshipin/index.js'
import { CHANNELS, CHANNEL_BY_REF, buildChannels } from '../extractors/yangshipin/channels.js'
import { createCKey } from '../extractors/yangshipin/ckey.js'
import { isOfficialMediaUrl, requestPlayUrls, selectWorkingManifest } from '../extractors/yangshipin/api.js'
import { CACHE_MS, createResolver } from '../extractors/yangshipin/resolver.js'
import { getModule } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('央视频模块测试')

check('固定输出 63 个公开频道并统一进入央视频分组', () => {
  assert.equal(CHANNELS.length, 63)
  assert.equal(new Set(CHANNELS.map(channel => channel.id)).size, 63)
  assert.equal(buildChannels().length, 63)
  assert.equal(yangshipin.name, '央视频')
  assert.equal(yangshipin.outputGroupName, '央视频')
  // 分片一旦改回经本机转发，平台会对本机去拉分片回 403（实测 relay/302 可播、proxy 不可播）
  assert.equal(yangshipin.channelHlsMode, 'relay')
  assert.equal(getModule('yangshipin'), yangshipin)
})

check('引用严格受频道白名单约束', () => {
  assert.equal(yangshipin.claimsRef('ysp-cctv1'), true)
  assert.equal(yangshipin.claimsRef('ysp-cctv18'), false)
  assert.equal(yangshipin.claimsRef('ysp-cctvfyzq'), false, '拿不到匿名地址的付费频道不能手写引用绕过过滤')
  assert.equal(CHANNEL_BY_REF.get('ysp-cctv1').channelId, '2024078201')
})

check('清晰度档逐频道固定，默认 fhd，剧场频道只认 shd', () => {
  assert.equal(CHANNEL_BY_REF.get('ysp-cctv1').defn, 'fhd')
  assert.equal(CHANNEL_BY_REF.get('ysp-cctvdyjc').defn, 'shd')
  assert.equal(CHANNELS.filter(channel => channel.defn === 'shd').length, 3)
  assert.ok(CHANNELS.every(channel => ['fhd', 'shd'].includes(channel.defn)))
})

check('客户端票据具有固定版本前缀，且同一输入仍含随机会话材料', () => {
  const a = createCKey('2024078201', { now: 1_700_000_000_000 })
  const b = createCKey('2024078201', { now: 1_700_000_000_000 })
  assert.match(a.cKey, /^--01[A-Za-z0-9_-]+$/)
  assert.equal(a.timestamp, 1_700_000_000)
  assert.equal(a.guid.length, 32)
  assert.notEqual(a.cKey, b.cKey)
})

check('只接受央视频/CCTV 官方 HTTPS 媒体域名', () => {
  assert.equal(isOfficialMediaUrl('https://hlslive-tx-cdn.ysp.cctv.cn/a.m3u8'), true)
  assert.equal(isOfficialMediaUrl('http://hlslive-tx-cdn.ysp.cctv.cn/a.m3u8'), false)
  assert.equal(isOfficialMediaUrl('https://ysp.cctv.cn.evil.example/a.m3u8'), false)
  assert.equal(isOfficialMediaUrl('https://evil.example/a.m3u8'), false)
})

await checkAsync('频道自带的清晰度档进入请求，且只接受官方域名的播放地址', async () => {
  const seen = []
  const fetchImpl = async url => {
    seen.push(new URL(url).searchParams.get('defn'))
    return new Response(JSON.stringify({
      iretcode: 0,
      playurl: 'https://hlslive-tx-cdn.ysp.cctv.cn/a.m3u8',
      backurl_list: ['https://evil.example/a.m3u8'],
    }), { status: 200 })
  }
  const { urls } = await requestPlayUrls(CHANNEL_BY_REF.get('ysp-cctvdyjc'), { fetchImpl })
  assert.deepEqual(seen, ['shd'])
  assert.deepEqual(urls, ['https://hlslive-tx-cdn.ysp.cctv.cn/a.m3u8'], '备用地址里的非官方域名必须被丢弃')
  await requestPlayUrls(CHANNEL_BY_REF.get('ysp-cctv1'), { fetchImpl })
  assert.deepEqual(seen, ['shd', 'fhd'])
})

await checkAsync('主 CDN 清单失败后切换备用 CDN，拍平成媒体清单，且全程不试拉分片', async () => {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push(String(url))
    if (String(url).includes('bad.ysp')) return new Response('denied', { status: 403 })
    if (String(url).endsWith('/master.m3u8')) return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia.m3u8\n', { status: 200 })
    if (String(url).endsWith('/media.m3u8')) return new Response('#EXTM3U\n#EXTINF:6,\npart.ts\n', { status: 200 })
    if (String(url).endsWith('/part.ts')) return new Response(Buffer.from([0x47, 0x40, 0x00, 0x10]), { status: 206 })
    return new Response('', { status: 404 })
  }
  const result = await selectWorkingManifest([
    'https://bad.ysp.cctv.cn/live.m3u8',
    'https://good.ysp.cctv.cn/master.m3u8',
  ], { fetchImpl })
  assert.equal(result.url, 'https://good.ysp.cctv.cn/media.m3u8')
  assert.equal(result.sourceUrl, 'https://good.ysp.cctv.cn/master.m3u8', '保留可重新调度的官方入口')
  assert.match(result.text, /part\.ts/)
  // 官方 CDN 对短间隔重复请求回 403：换票时补这一枪分片会在 CDN 正常时把主备全判死。
  assert.equal(calls.some(url => url.endsWith('/part.ts')), false, '选 CDN 阶段不得试拉分片')
})

await checkAsync('清单能取回但没有分片条目的 CDN 视为不可用', () => selectWorkingManifest(
  ['https://empty.ysp.cctv.cn/live.m3u8'],
  { fetchImpl: async () => new Response('#EXTM3U\n#EXT-X-ENDLIST\n', { status: 200 }) },
).then(
  () => { throw new Error('空清单不应通过') },
  error => assert.match(error.message, /主、备用 CDN 均不可用/),
))

await checkAsync('同频道并发解析只取一次票，TTL 到期后自动换票', async () => {
  let requests = 0
  const resolver = createResolver({
    request: async () => { requests++; return { urls: ['https://good.ysp.cctv.cn/live.m3u8'] } },
    select: async () => ({ text: '#EXTM3U\n#EXTINF:6,\na.ts\n', url: 'https://good.ysp.cctv.cn/live.m3u8' }),
  })
  const [a, b] = await Promise.all([
    resolver.resolve('ysp-cctv1', { now: 0 }),
    resolver.resolve('ysp-cctv1', { now: 0 }),
  ])
  assert.equal(requests, 1)
  assert.equal(a.url, b.url)
  assert.match(a.desc, /H\.264/)
  await resolver.resolve('ysp-cctv1', { now: CACHE_MS })
  assert.equal(requests, 2)
})

await checkAsync('每次解析返回新清单，正文不随 5 分钟取票缓存复用，代理层无需重复请求', async () => {
  // 直播清单每 3 秒滚动一次，缓存正文会让播放器在整个 TTL 内反复拿到同一批分片而卡死。
  let requests = 0
  let selects = 0
  const resolver = createResolver({
    request: async () => { requests++; return { urls: ['https://good.ysp.cctv.cn/live.m3u8'] } },
    select: async () => ({ text: `#EXTM3U\n#EXTINF:6,\npart-${++selects}.ts\n`, url: 'https://good.ysp.cctv.cn/live.m3u8' }),
  })
  const result = await resolver.resolve('ysp-cctv1', { now: 0 })
  assert.equal(result.url, 'https://good.ysp.cctv.cn/live.m3u8')
  assert.match(result.manifestText, /part-1\.ts/)
  assert.equal(result.manifestUrl, result.url)
  assert.equal(result.upstreamHeaders?.Referer, 'https://live.cctv.cn/')
  const next = await resolver.resolve('ysp-cctv1', { now: 6000 })
  assert.match(next.manifestText, /part-2\.ts/, '轮询必须拿到滚动后的分片')
  assert.equal(requests, 1, '清单实时刷新不能导致每次都重新取票')
  assert.equal(selects, 2)
  const cached = [...resolver.cache.values()]
  assert.ok(cached.every(entry => !('manifest' in entry) && !('text' in entry) && !('manifestText' in entry)), '缓存条目里不得留存清单正文')
})

await checkAsync('缓存主线失效时可换备用入口，不复用重定向后的临时媒体地址', async () => {
  const urls = ['https://main.ysp.cctv.cn/live.m3u8', 'https://backup.ysp.cctv.cn/live.m3u8']
  let requests = 0
  let selects = 0
  const resolver = createResolver({
    request: async () => { requests++; return { urls } },
    select: async candidates => {
      selects++
      assert.equal(candidates.includes('https://temporary.ysp.cctv.cn/media.m3u8'), false)
      assert.equal(candidates.length, 2)
      if (selects === 3) assert.equal(candidates[0], urls[1], '上次成功的备用入口优先')
      return {
        url: 'https://temporary.ysp.cctv.cn/media.m3u8',
        sourceUrl: urls[selects === 1 ? 0 : 1],
        text: `#EXTM3U\n#EXTINF:6,\npart-${selects}.ts\n`,
      }
    },
  })
  await resolver.resolve('ysp-cctv2', { now: 0 })
  const recovered = await resolver.resolve('ysp-cctv2', { now: 6000 })
  assert.match(recovered.manifestText, /part-2/)
  await resolver.resolve('ysp-cctv2', { now: 12000 })
  assert.equal(requests, 1, '备用可用时不必重新取票')
})

await checkAsync('缓存主备全部 403 时提前换票，同频道并发恢复只换一次', async () => {
  let requests = 0
  let oldCalls = 0
  const resolver = createResolver({
    request: async () => ({ urls: [`https://good.ysp.cctv.cn/ticket-${++requests}.m3u8`] }),
    select: async urls => {
      if (urls[0].includes('ticket-1') && ++oldCalls > 1) throw new Error('清单 HTTP 403')
      return { url: urls[0], text: '#EXTM3U\n#EXTINF:6,\npart.ts\n' }
    },
  })
  await resolver.resolve('ysp-cctv2', { now: 0 })
  const results = await Promise.all([
    resolver.resolve('ysp-cctv2', { now: 6000 }),
    resolver.resolve('ysp-cctv2', { now: 6000 }),
  ])
  assert.equal(requests, 2)
  assert.ok(results.every(result => result.url.endsWith('/ticket-2.m3u8')))
})

await checkAsync('CCTV1 切换 CCTV2 时两台缓存独立，切回也读取最新清单', async () => {
  const requests = []
  let selects = 0
  const resolver = createResolver({
    request: async channel => { requests.push(channel.id); return { urls: [`https://good.ysp.cctv.cn/${channel.id}.m3u8`] } },
    select: async urls => ({ url: urls[0], text: `#EXTM3U\n#EXTINF:6,\npart-${++selects}.ts\n` }),
  })
  for (const [i, ref] of ['ysp-cctv1', 'ysp-cctv2', 'ysp-cctv1'].entries()) {
    const result = await resolver.resolve(ref, { now: i * 6000 })
    assert.ok(result.url.endsWith(`/${ref.slice(4)}.m3u8`))
    assert.match(result.manifestText, new RegExp(`part-${i + 1}\\.ts`))
  }
  assert.deepEqual(requests, ['cctv1', 'cctv2'])
})

await checkAsync('解析失败也绝不抛异常，只回空 url 与原因', async () => {
  // 模块契约：app.js 的 handler 没有顶层 try，抛出等于请求永不 end、客户端挂死。
  const boom = createResolver({ request: async () => { throw new Error('接口 502') }, select: async () => ({}) })
  const failed = await boom.resolve('ysp-cctv1', { now: 0 })
  assert.equal(failed.url, '')
  assert.match(failed.desc, /接口 502/)
  const unknown = await boom.resolve('ysp-not-a-channel', { now: 0 })
  assert.equal(unknown.url, '')
  const noCtx = await boom.resolve('ysp-cctv1')
  assert.equal(noCtx.url, '')
})

console.log(`\n全部通过：${passed} 项`)
