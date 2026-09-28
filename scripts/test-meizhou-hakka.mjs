#!/usr/bin/env node
/**
 * 梅州模块离线测试：一路固定直链频道归入广东，地址在梅州台自己的域名下、不带签名。
 *
 * 运行： node scripts/test-meizhou-hakka.mjs
 */
import assert from 'node:assert/strict'

import meizhou, { STREAM_URL } from '../extractors/meizhou-hakka/index.js'
import { getModule, resolverFor } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('梅州模块测试')

check('模块注册为免账号、归入广东的直链模块', () => {
  assert.equal(getModule('meizhou-hakka'), meizhou)
  assert.equal(meizhou.name, '梅州')
  assert.equal(meizhou.outputGroupName, '广东')
  assert.equal(meizhou.capabilities.resolve, false)
  assert.equal(meizhou.capabilities.epg, false)
  assert.equal(meizhou.capabilities.catchup, false)
  assert.equal(meizhou.channelHlsMode, undefined)
  assert.equal(meizhou.catalogVersion, 1)
  assert.equal(meizhou.refreshConfigurable, false)
  assert.deepEqual(meizhou.configSchema, [])
  assert.equal(resolverFor('meizhou-hakka'), null)
})

await checkAsync('输出一路固定的客家生活直链，地址限定在梅州台官方域名', async () => {
  const { groups, meta } = await meizhou.fetch()
  assert.equal(groups.length, 1)
  assert.equal(groups[0].name, '广东')
  assert.deepEqual(groups[0].dataList, [{
    name: '梅州客家生活',
    url: STREAM_URL,
    opts: ['network-caching=3000'],
    catchup: 'none',
  }])
  assert.deepEqual(meta, { skipped: [], warnings: [] })
  const url = new URL(STREAM_URL)
  assert.equal(url.protocol, 'https:')
  assert.equal(url.hostname, 'livepull.hellohakka.cn')
  assert.equal(url.pathname, '/live/ch_kejiashenghuo.m3u8')
  assert.equal(url.search, '')
})

console.log(`\n全部通过：${passed} ✅`)
