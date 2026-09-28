#!/usr/bin/env node
import assert from 'node:assert/strict'

import chongqing from '../extractors/chongqing/index.js'
import {
  CHONGQING_LIST_API,
  CHONGQING_RESOLVE_API,
  buildChannels,
  claimsRef,
  clearCache,
  officialAssetUrl,
  officialHlsUrl,
  parseChannelList,
  resolveChannel,
  upstreamHeadersFor,
} from '../extractors/chongqing/api.js'
import { getModule, resolverFor } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }
const response = (body, status = 200) => new Response(
  typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json' } },
)

const rawUrl = 'https://sjlivecdn.cbg.cn/app_2/ls_3.stream/chunklist.m3u8'
const signedUrl = 'https://sjlivecdn7.cbg.cn/app_2/ls_3.stream/chunklist.m3u8?auth_key=short-lived'
const listPayload = {
  code: 0,
  data: {
    lists: [
      { id: 6, title: 'CQTV新闻', tvorfm: 'tv', ios_HDlive_url: rawUrl, thumb: '', thumb_mob: 'https://cmsimg.cbg.cn/2020/07/01/b39ff90b.jpg' },
      { id: 7, title: '重庆广播', tvorfm: 'fm', ios_HDlive_url: rawUrl },
    ],
  },
}

console.log('重庆广电模块测试')

check('模块已注册为免账号的重庆全代理模块', () => {
  assert.equal(getModule('chongqing'), chongqing)
  assert.equal(chongqing.name, '重庆')
  assert.equal(chongqing.category, undefined)
  assert.equal(chongqing.channelHlsMode, 'proxy')
  assert.equal(chongqing.capabilities.catchup, false)
  assert.deepEqual(chongqing.configSchema, [])
  assert.equal(resolverFor('chongqing-6'), chongqing)
  assert.equal(resolverFor('chongqing-6/extra'), null)
})

check('目录只收电视频道，并产出独立重庆分组的延迟引用', () => {
  const rows = parseChannelList(listPayload)
  assert.deepEqual(rows.map(row => [row.id, row.name]), [['6', 'CQTV新闻']])
  assert.equal(buildChannels(rows)[0].logo, 'https://cmsimg.cbg.cn/2020/07/01/b39ff90b.jpg', '台标取官方接口的 thumb_mob')
  assert.equal(parseChannelList({ code: 0, data: { lists: [{ id: 6, title: 'CQTV新闻', tvorfm: 'tv', ios_HDlive_url: rawUrl, thumb_mob: 'https://evil.example/x.jpg' }] } })[0].logo, '', '只收重庆广电图床')
  assert.deepEqual(buildChannels(rows).map(channel => channel.deferredRef), ['chongqing-6'])
  assert.equal(claimsRef('chongqing-text'), false)
})

check('媒体白名单覆盖 HLS、AES 密钥和分片，拒绝任意外部回源', () => {
  assert.equal(officialHlsUrl(rawUrl), rawUrl)
  assert.match(officialAssetUrl('https://sjlivecdn7.cbg.cn/live/a.key'), /a\.key$/)
  assert.match(officialAssetUrl('https://sjlivecdn7.cbg.cn/live/a.ts'), /a\.ts$/)
  assert.deepEqual(upstreamHeadersFor('https://sjlivecdn7.cbg.cn/live/a.ts'), {})
  for (const bad of [
    'http://sjlivecdn.cbg.cn/live/a.m3u8',
    'https://sjlivecdn.cbg.cn.evil.test/live/a.m3u8',
    'https://127.0.0.1/private.m3u8',
  ]) assert.throws(() => officialAssetUrl(bad), /非官方媒体地址/)
  assert.throws(() => upstreamHeadersFor('https://example.com/redirected.ts'), /非官方媒体地址/)
  assert.throws(() => officialHlsUrl('https://sjlivecdn.cbg.cn/live/a.ts'), /不是 HLS/)
})

await checkAsync('抓取目录后播放匿名换签，并短期复用签名', async () => {
  clearCache()
  const calls = []
  const fetchImpl = async raw => {
    const url = new URL(String(raw))
    calls.push(url)
    if (url.href === CHONGQING_LIST_API) return response(listPayload)
    if (url.origin + url.pathname === CHONGQING_RESOLVE_API) {
      assert.equal(url.searchParams.get('url'), rawUrl)
      return response({ code: 0, data: { url: signedUrl } })
    }
    throw new Error(`unexpected URL: ${url.href}`)
  }
  const fetched = await chongqing.fetch({}, { fetchImpl, now: 1777777777000 })
  assert.deepEqual(fetched.groups.map(group => [group.name, group.dataList.length]), [['重庆', 1]])
  const first = await resolveChannel('chongqing-6', { fetchImpl, now: 1777777778000 })
  const second = await resolveChannel('chongqing-6', { fetchImpl, now: 1777777779000 })
  assert.equal(first.url, signedUrl)
  assert.equal(second.url, signedUrl)
  assert.equal(calls.filter(url => url.origin + url.pathname === CHONGQING_RESOLVE_API).length, 1)
  assert.equal(first.upstreamUrlTransform('https://sjlivecdn7.cbg.cn/live/key.bin').endsWith('/key.bin'), true)
})

await checkAsync('接口异常和未知频道只返回说明，不向请求处理器抛错', async () => {
  clearCache()
  const bad = await resolveChannel('chongqing-6', {
    fetchImpl: async () => response('upstream error', 500),
    now: 1777777777000,
  })
  assert.equal(bad.url, '')
  assert.match(bad.desc, /请求失败/)

  clearCache()
  const missing = await resolveChannel('chongqing-999', {
    fetchImpl: async raw => String(raw) === CHONGQING_LIST_API ? response(listPayload) : response({}, 500),
    now: 1777777777000,
  })
  assert.equal(missing.url, '')
  assert.match(missing.desc, /不在官网公开列表/)
})

console.log(`\n全部通过：${passed} ✅`)
