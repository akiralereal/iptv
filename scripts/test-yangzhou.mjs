#!/usr/bin/env node
/**
 * 扬州模块离线测试：四路固定直链频道归入江苏，地址在扬州新闻网自己的 CDN 域名下、不带签名，
 * 台标留给内置库（官方图是透明底黑字，内置库里铺了白底）。
 *
 * 运行： node scripts/test-yangzhou.mjs
 */
import assert from 'node:assert/strict'

import yangzhou from '../extractors/yangzhou/index.js'
import { CHANNELS } from '../extractors/yangzhou/channels.js'
import { getModule, resolverFor } from '../extractors/registry.js'
import { packLogoUrl } from '../utils/logoPack.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('扬州模块测试')

check('模块注册为免账号、归入江苏的直链模块，挂了节目单', () => {
  assert.equal(getModule('yangzhou'), yangzhou)
  assert.equal(yangzhou.name, '扬州')
  assert.equal(yangzhou.outputGroupName, '江苏')
  assert.equal(yangzhou.capabilities.resolve, false)
  assert.equal(yangzhou.capabilities.epg, true)
  assert.equal(yangzhou.capabilities.catchup, false)
  assert.equal(yangzhou.channelHlsMode, undefined)
  assert.equal(yangzhou.catalogVersion, 1)
  assert.equal(yangzhou.refreshConfigurable, false)
  assert.deepEqual(yangzhou.configSchema, [])
  assert.equal(resolverFor('yangzhou-235'), null)
})

await checkAsync('输出扬州新闻、民生与江都、邗江四路固定直链，不带台标', async () => {
  const { groups, meta } = await yangzhou.fetch()
  assert.equal(groups.length, 1)
  assert.equal(groups[0].name, '江苏')
  assert.deepEqual(groups[0].dataList, [
    { name: '扬州新闻', url: 'https://yztv-wshls.yzbtv.cn/live/8bb.m3u8', opts: ['network-caching=3000'], catchup: 'none' },
    { name: '扬州民生', url: 'https://yztv-wshls.yzbtv.cn/live/8bd.m3u8', opts: ['network-caching=3000'], catchup: 'none' },
    { name: '江都频道', url: 'https://yztv-wshls.yzbtv.cn/live/8c1.m3u8', opts: ['network-caching=3000'], catchup: 'none' },
    { name: '邗江频道', url: 'https://yztv-wshls.yzbtv.cn/live/8c3.m3u8', opts: ['network-caching=3000'], catchup: 'none' },
  ])
  assert.deepEqual(meta, { skipped: [], warnings: [] })
})

check('地址都是 https、限定在官方 CDN 域名、不带签名参数', () => {
  for (const channel of CHANNELS) {
    const url = new URL(channel.url)
    assert.equal(url.protocol, 'https:')
    assert.equal(url.hostname, 'yztv-wshls.yzbtv.cn')
    assert.match(url.pathname, /^\/live\/[0-9a-f]{3}\.m3u8$/)
    assert.equal(url.search, '')
  }
})

check('四路都能在内置台标库里按名找到台标', () => {
  for (const channel of CHANNELS) {
    assert.match(packLogoUrl({ name: channel.name, sourceId: 'xt:yangzhou' }, '江苏'), /\/logo-pack\/.+\.png\?v=[0-9a-f]+$/, channel.name)
  }
})

console.log(`\n全部通过：${passed} ✅`)
