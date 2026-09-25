#!/usr/bin/env node
/**
 * 宁夏模块离线测试：三套固定直链归入「宁夏」，地址限定在官方域名。
 *
 * 运行： node scripts/test-ningxia.mjs
 */
import assert from 'node:assert/strict'

import ningxia from '../extractors/ningxia/index.js'
import { CHANNELS, officialHlsUrl } from '../extractors/ningxia/api.js'
import { getModule, resolverFor } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('宁夏模块测试')

check('模块注册为免账号、归入宁夏的直链模块，挂着官方节目单', () => {
  assert.equal(getModule('ningxia'), ningxia)
  assert.equal(ningxia.name, '宁夏')
  assert.equal(ningxia.outputGroupName, '宁夏')
  assert.equal(ningxia.capabilities.resolve, false)
  assert.equal(ningxia.capabilities.epg, true)
  assert.equal(ningxia.capabilities.catchup, false)
  assert.equal(ningxia.channelHlsMode, undefined)
  assert.equal(ningxia.catalogVersion, 1)
  assert.equal(ningxia.refreshConfigurable, false)
  assert.deepEqual(ningxia.configSchema, [])
  assert.equal(typeof ningxia.epg.programmes, 'function')
  assert.equal(resolverFor('ningxia-nxws'), null)
})

await checkAsync('输出三套固定直链，地址是官方入口', async () => {
  const { groups, meta } = await ningxia.fetch()
  assert.equal(groups.length, 1)
  assert.equal(groups[0].name, '宁夏')
  assert.deepEqual(groups[0].dataList, [
    { name: '宁夏卫视', url: 'https://hls.nxhhy.cn/live/nxws1M.m3u8', groupTitle: '宁夏', opts: ['network-caching=3000'], catchup: 'none' },
    { name: '宁夏公共', url: 'https://hls.nxhhy.cn/live/nxgg1M.m3u8', groupTitle: '宁夏', opts: ['network-caching=3000'], catchup: 'none' },
    { name: '宁夏文旅', url: 'https://hls.nxhhy.cn/live/nxwl1M.m3u8', groupTitle: '宁夏', opts: ['network-caching=3000'], catchup: 'none' },
  ])
  assert.deepEqual(meta, { skipped: [], warnings: [] })
  assert.deepEqual(CHANNELS.map(channel => channel.key), ['nxws', 'nxgg', 'nxwl'])
})

check('频道表只放行官方域名下的直播入口', () => {
  assert.throws(() => officialHlsUrl('../record/live/nxws.m3u8'))
  assert.throws(() => officialHlsUrl('nxws1M.m3u8?session=x'))
  assert.throws(() => officialHlsUrl('https://evil.example/live/nxws1M.m3u8'))
  assert.throws(() => officialHlsUrl('nxws.ts'))
})

console.log(`\n全部通过：${passed} ✅`)
