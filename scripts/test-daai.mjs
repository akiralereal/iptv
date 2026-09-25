#!/usr/bin/env node
import assert from 'node:assert/strict'

import daai from '../extractors/daai/index.js'
import {
  CHANNELS,
  DAAI_ORIGIN,
  DAAI_PAGE,
  buildChannels,
  claimsRef,
  officialAssetUrl,
  resolveChannel,
  upstreamHeadersFor,
} from '../extractors/daai/api.js'
import { getModule, resolverFor } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('大爱电视模块测试')

check('模块注册为免账号的台湾全代理模块', () => {
  assert.equal(getModule('daai'), daai)
  assert.equal(daai.name, '大爱电视')
  assert.equal(daai.outputGroupName, '台湾')
  assert.equal(daai.channelHlsMode, 'proxy')
  assert.equal(daai.capabilities.catchup, false)
  // 2：两台补上官方频道卡台标，老部署启动时要重建频道表缓存
  assert.equal(daai.catalogVersion, 2)
  assert.deepEqual(daai.configSchema, [])
  assert.equal(resolverFor('daai-tv1'), daai)
  assert.equal(resolverFor('daai-tv1/extra'), null)
})

await checkAsync('两路固定频道归入台湾分组且不继承回看', async () => {
  assert.deepEqual(CHANNELS.map(channel => [channel.ref, channel.name]), [
    ['daai-tv1', '大爱一台'],
    ['daai-tv2', '大爱二台'],
  ])
  const channels = buildChannels()
  assert.deepEqual(channels.map(channel => channel.deferredRef), CHANNELS.map(channel => channel.ref))
  // 台标用官方频道配置里的分台频道卡，两台各一张、不共用
  assert.deepEqual(channels.map(channel => channel.logo), [
    'https://s3.hicloud.net.tw/daaiapp/images/ch1.jpg',
    'https://s3.hicloud.net.tw/daaiapp/images/ch3.jpg',
  ])
  assert.ok(channels.every(channel => channel.groupTitle === '台湾'))
  assert.ok(channels.every(channel => channel.catchup === 'none'))
  assert.deepEqual(await daai.fetch(), {
    groups: [{ name: '台湾', dataList: channels }],
    meta: { skipped: [], warnings: [] },
  })
  assert.equal(claimsRef('daai-tv2'), true)
  assert.equal(claimsRef('daai-tv3'), false)
})

check('媒体白名单只放行两个官方推流域名的直播目录', () => {
  assert.equal(
    officialAssetUrl('https://pulltv1.wanfudaluye.com/live/tv1-1788255143.ts?txspiseq=105688339992643727975'),
    'https://pulltv1.wanfudaluye.com/live/tv1-1788255143.ts?txspiseq=105688339992643727975',
  )
  assert.equal(officialAssetUrl(' https://pulltv2.wanfudaluye.com/live/tv2.m3u8 '), 'https://pulltv2.wanfudaluye.com/live/tv2.m3u8')
  for (const bad of [
    'http://pulltv1.wanfudaluye.com/live/tv1.m3u8',
    'https://pulltv1.wanfudaluye.com.evil.test/live/tv1.m3u8',
    'https://wanfudaluye.com/live/tv1.m3u8',
    'https://127.0.0.1/live/tv1.m3u8',
    'https://user:pass@pulltv1.wanfudaluye.com/live/tv1.m3u8',
    'https://pulltv1.wanfudaluye.com:444/live/tv1.m3u8',
    'https://pulltv1.wanfudaluye.com/private/tv1.m3u8',
    'https://pulltv1.wanfudaluye.com/live/..%2fprivate/tv1.m3u8',
    'https://pulltv1.wanfudaluye.com/live/tv1.m3u8#frag',
    'not a url',
  ]) assert.throws(() => officialAssetUrl(bad), /大爱电视/)
})

check('回源请求头只补官网 Referer/Origin，且先过白名单', () => {
  assert.deepEqual(upstreamHeadersFor('https://pulltv1.wanfudaluye.com/live/tv1.m3u8'), {
    Referer: DAAI_PAGE,
    Origin: DAAI_ORIGIN,
  })
  // UA 由代理层统一给出：模块声明也不会生效，故这里不声明
  assert.equal('User-Agent' in upstreamHeadersFor('https://pulltv2.wanfudaluye.com/live/tv2.m3u8'), false)
  assert.throws(() => upstreamHeadersFor('https://evil.test/live/tv1.m3u8'), /非官方媒体地址/)
})

await checkAsync('解析直接给出固定官方地址，不打任何网络', async () => {
  const fetchImpl = async () => { throw new Error('不应请求') }
  for (const channel of CHANNELS) {
    const resolved = await resolveChannel(channel.ref, { fetchImpl })
    assert.equal(resolved.url, channel.url)
    assert.match(resolved.desc, new RegExp(channel.name))
    assert.equal(typeof resolved.upstreamHeaders, 'function')
    assert.equal(resolved.upstreamUrlTransform('https://pulltv1.wanfudaluye.com/live/tv1-1.ts'),
      'https://pulltv1.wanfudaluye.com/live/tv1-1.ts')
    // 地址是常量，没有签名可缓存，也就不该交回本轮清单
    assert.equal('manifestText' in resolved, false)
    assert.equal('manifestUrl' in resolved, false)
  }
})

await checkAsync('非法引用只返回说明，不向请求处理器抛错', async () => {
  const malformed = await resolveChannel('daai-tv9')
  assert.equal(malformed.url, '')
  assert.match(malformed.desc, /引用格式错误/)
  assert.equal((await resolveChannel('')).url, '')
})

console.log(`\n全部通过：${passed} ✅`)
