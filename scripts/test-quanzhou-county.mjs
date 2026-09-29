#!/usr/bin/env node
/**
 * 晋江、石狮模块离线测试：两路固定直链频道归入福建，地址在两台融媒体中心自己的域名下、不带签名。
 *
 * 运行： node scripts/test-quanzhou-county.mjs
 */
import assert from 'node:assert/strict'

import county from '../extractors/quanzhou-county/index.js'
import { CHANNELS } from '../extractors/quanzhou-county/channels.js'
import { getModule, resolverFor } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('晋江、石狮模块测试')

check('模块注册为免账号、归入福建的直链模块，挂了节目单', () => {
  assert.equal(getModule('quanzhou-county'), county)
  assert.equal(county.name, '晋江、石狮')
  assert.equal(county.outputGroupName, '福建')
  assert.equal(county.capabilities.resolve, false)
  assert.equal(county.capabilities.epg, true)
  assert.equal(county.capabilities.catchup, false)
  assert.equal(county.channelHlsMode, undefined)
  assert.equal(county.catalogVersion, 1)
  assert.equal(county.refreshConfigurable, false)
  assert.deepEqual(county.configSchema, [])
  assert.equal(resolverFor('quanzhou-county-jinjiang'), null)
})

await checkAsync('输出晋江电视台、石狮新闻综合两路固定直链，晋江带官方台标、石狮留给内置库', async () => {
  const { groups, meta } = await county.fetch()
  assert.equal(groups.length, 1)
  assert.equal(groups[0].name, '福建')
  assert.deepEqual(groups[0].dataList, [
    {
      name: '晋江电视台',
      url: 'https://live.ijjnews.com/jjtv/sd/live.m3u8',
      logo: 'https://filestorage.ijjnews.com/file/storage1-cloudlivemanage/cloudlivemanage/2026/1067/0f5007bcbfe40cd8.jpg',
      opts: ['network-caching=3000'],
      catchup: 'none',
    },
    {
      name: '石狮新闻综合',
      url: 'https://live-new.chinashishi.net/SSTV/sd/live.m3u8',
      opts: ['network-caching=3000'],
      catchup: 'none',
    },
  ])
  assert.deepEqual(meta, { skipped: [], warnings: [] })
})

check('地址都是 https、限定在两台官方域名、不带查询参数', () => {
  const hosts = { jinjiang: 'live.ijjnews.com', shishi: 'live-new.chinashishi.net' }
  for (const channel of CHANNELS) {
    const url = new URL(channel.url)
    assert.equal(url.protocol, 'https:')
    assert.equal(url.hostname, hosts[channel.id])
    assert.match(url.pathname, /^\/[A-Za-z]+\/sd\/live\.m3u8$/)
    assert.equal(url.search, '')
  }
})

console.log(`\n全部通过：${passed} ✅`)
