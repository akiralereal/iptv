#!/usr/bin/env node
/**
 * 泉州模块离线测试：一路延迟解析频道归入福建，只接受官方签名清单与本频道的 TS 路径，
 * 主入口触发人机验证时走备用入口，每次播放都取新签名。夹具按 2026-09-25 的真实响应裁剪。
 *
 * 运行： node scripts/test-quanzhou-minnan.mjs
 */
import assert from 'node:assert/strict'

import quanzhou from '../extractors/quanzhou-minnan/index.js'
import {
  CHANNEL, PLAYER_PAGE, PLAY_APIS, claimsRef, createResolver, officialManifestUrl,
  officialSegmentUrl, validateManifest,
} from '../extractors/quanzhou-minnan/api.js'
import { getModule, resolverFor } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

const manifestUrl = token => `https://live.qztv.cn/live/mny20260520_lld.m3u8?auth_key=1790319137-0-0-${token.repeat(32)}`
const segment = 'live.qztv.cn_mny20260520_lld-1790318264430.ts'
const playlist = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:123\n#EXT-X-TARGETDURATION:5\n#EXTINF:5.000,\n' + segment + '\n'
const MEDIA_ID = 'wq95wqbDnMKyd8KiwqzChnt0w5nChcKofcKh'

console.log('泉州模块测试')

check('模块注册为免账号、归入福建的全代理模块', () => {
  assert.equal(getModule('quanzhou-minnan'), quanzhou)
  assert.equal(quanzhou.name, '泉州')
  assert.equal(quanzhou.outputGroupName, '福建')
  assert.equal(quanzhou.channelHlsMode, 'proxy')
  assert.equal(quanzhou.relayProxyCompatible, undefined)
  assert.equal(quanzhou.capabilities.resolve, true)
  assert.equal(quanzhou.capabilities.epg, true)
  assert.equal(quanzhou.capabilities.catchup, false)
  assert.equal(quanzhou.catalogVersion, 1)
  assert.deepEqual(quanzhou.configSchema, [])
  assert.equal(resolverFor(CHANNEL.ref), quanzhou)
  assert.equal(resolverFor(`${CHANNEL.ref}/extra`), null)
})

await checkAsync('一路固定频道带官网频道卡，走延迟解析', async () => {
  const { groups } = await quanzhou.fetch()
  assert.equal(groups.length, 1)
  assert.equal(groups[0].name, '福建')
  assert.deepEqual(groups[0].dataList, [{
    name: '泉州闽南语',
    deferredRef: CHANNEL.ref,
    logo: 'https://www.qztv.cn/index/images/home/crad-02.jpg',
    opts: ['network-caching=3000'],
    catchup: 'none',
  }])
  assert.equal(claimsRef(CHANNEL.ref), true)
  assert.equal(claimsRef('other'), false)
})

check('只接受泉州官方频道的签名清单和 TS 分片', () => {
  const url = manifestUrl('a')
  assert.equal(officialManifestUrl(url), url)
  assert.equal(officialSegmentUrl(segment, url), `https://live.qztv.cn/live/${segment}`)
  assert.equal(validateManifest(playlist, url), playlist)
  assert.throws(() => officialManifestUrl(url.replace('live.qztv.cn', 'evil.example')))
  assert.throws(() => officialManifestUrl(url.replace('/live/mny', '/live/news')))
  assert.throws(() => officialManifestUrl(`${url}&extra=1`))
  assert.throws(() => officialSegmentUrl('https://evil.example/live/a.ts', url))
  assert.throws(() => officialSegmentUrl('live.qztv.cn_news-1.ts', url))
  assert.throws(() => validateManifest('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128\n' + playlist, url))
  assert.throws(() => validateManifest('#EXTM3U\n#EXTINF:5,\n' + segment, url))
})

await checkAsync('每次播放都取新签名；主入口遇人机验证时走备用入口，分片以浏览器标识全代理', async () => {
  let token = 'a'
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push(url)
    if (url === PLAY_APIS[0]) {
      assert.equal(init.method, 'POST')
      assert.equal(new URLSearchParams(init.body).get('media_id'), MEDIA_ID)
      return new Response('<meta name="aliyun_waf_aa">')
    }
    if (url === PLAY_APIS[1]) {
      assert.equal(new URLSearchParams(init.body).get('media_id'), MEDIA_ID)
      return new Response(JSON.stringify({ error_code: 0, data: manifestUrl(token) }))
    }
    assert.equal(url, manifestUrl(token))
    return new Response(playlist)
  }
  const resolver = createResolver({ fetchImpl })
  const first = await resolver.resolve(CHANNEL.ref)
  assert.equal(first.url, manifestUrl('a'))
  assert.equal(first.manifestText, playlist)
  assert.equal(first.manifestUrl, manifestUrl('a'))
  assert.equal(first.relayHls, undefined)
  const headers = first.upstreamHeaders(`https://live.qztv.cn/live/${segment}`)
  assert.equal(headers.Referer, PLAYER_PAGE)
  assert.match(headers['User-Agent'], /Chrome/)
  assert.equal(first.upstreamUrlTransform(segment), `https://live.qztv.cn/live/${segment}`)
  token = 'b'
  assert.equal((await resolver.resolve(CHANNEL.ref)).url, manifestUrl('b'))
  assert.equal(calls.filter(url => url === PLAY_APIS[0]).length, 2)
  assert.equal(calls.filter(url => url === PLAY_APIS[1]).length, 2)
})

await checkAsync('非法引用、官网全部要求验证或接口异常时只返回说明', async () => {
  const waf = createResolver({ fetchImpl: async () => new Response('<meta name="aliyun_waf_aa">') })
  const malformed = await waf.resolve('other')
  assert.equal(malformed.url, '')
  assert.match(malformed.desc, /引用格式错误/)
  const blocked = await waf.resolve(CHANNEL.ref)
  assert.equal(blocked.url, '')
  assert.match(blocked.desc, /人机验证/)
  const down = createResolver({ fetchImpl: async () => new Response('down', { status: 502 }) })
  assert.match((await down.resolve(CHANNEL.ref)).desc, /取流失败.*HTTP 502/)
  const empty = createResolver({ fetchImpl: async () => new Response(JSON.stringify({ error_code: 1, data: null })) })
  assert.match((await empty.resolve(CHANNEL.ref)).desc, /没有签发/)
})

console.log(`\n全部通过：${passed} ✅`)
