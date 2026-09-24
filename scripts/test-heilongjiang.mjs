#!/usr/bin/env node
import assert from 'node:assert/strict'

import heilongjiang from '../extractors/heilongjiang/index.js'
import {
  CHANNELS,
  HLJTV_MEDIA_ORIGIN,
  buildChannels,
  officialHlsUrl,
} from '../extractors/heilongjiang/api.js'
import { getModule, resolverFor } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('黑龙江广电模块测试')

check('模块注册为免账号的直连模块，不声明解析能力', () => {
  assert.equal(getModule('heilongjiang'), heilongjiang)
  assert.equal(heilongjiang.name, '黑龙江')
  assert.equal(heilongjiang.outputGroupName, '黑龙江')
  assert.equal(heilongjiang.capabilities.resolve, false)
  assert.equal(heilongjiang.catalogVersion, 2)
  assert.deepEqual(heilongjiang.configSchema, [])
  // 直连模块不该声明代理路由，也不该认领任何播放引用
  assert.equal(heilongjiang.channelHlsMode, undefined)
  assert.equal(heilongjiang.claimsRef, undefined)
  assert.equal(heilongjiang.resolve, undefined)
  assert.equal(resolverFor('hljws_own'), null)
})

await checkAsync('七套频道给直链而不是延迟引用，且不继承回看', async () => {
  assert.deepEqual(CHANNELS.map(channel => channel.name), [
    '黑龙江卫视', '黑龙江都市', '黑龙江新闻法治', '黑龙江文体',
    '黑龙江少儿', '黑龙江影视', '黑龙江农业科教',
  ])
  const channels = buildChannels()
  assert.equal(channels.length, 7)
  // url 直出：播放器直连官方 CDN，本机不转发媒体，也就没有 deferredRef
  assert.ok(channels.every(channel => channel.url.startsWith(`${HLJTV_MEDIA_ORIGIN}/live/`)))
  assert.ok(channels.every(channel => channel.deferredRef === undefined))
  // 七套都给极光新闻 App 下发的官方频道卡，不留空（LOGO.md 第 4 条）；实验台的研究占位图不进订阅
  assert.ok(channels.every(channel => channel.groupTitle === '黑龙江'))
  assert.ok(channels.every(channel => /^https:\/\/imgcdn\.hljtv\.com\/newscontent-[0-9a-f-]+\.jpeg$/.test(channel.logo)))
  assert.equal(new Set(channels.map(channel => channel.logo)).size, 7, '七张台标必须互不相同')
  assert.ok(channels.every(channel => channel.catchup === 'none'))
  assert.equal(new Set(channels.map(channel => channel.url)).size, 7, '七条地址必须互不相同')
  assert.deepEqual(await heilongjiang.fetch(), {
    groups: [{ name: '黑龙江', dataList: channels }],
    meta: { skipped: [], warnings: [] },
  })
})

check('地址校验锁定官方主机与 4430 端口', () => {
  assert.equal(officialHlsUrl('hljws_own.m3u8'), 'https://idclive.hljtv.com:4430/live/hljws_own.m3u8')
  // 端口是这家的特点：官方业务域名走 4430 而不是 443，写错端口必须拦下
  assert.throws(() => officialHlsUrl('../private/x.m3u8'), /非官方直播地址/)
  assert.throws(() => officialHlsUrl('hljws_own.ts'), /非官方直播地址/)
  assert.throws(() => officialHlsUrl('hljws_own.m3u8?token=x'), /非官方直播地址/)
  assert.throws(() => officialHlsUrl('//evil.test/live/x.m3u8'), /非官方直播地址/)
  assert.throws(() => officialHlsUrl('https://idclive.hljtv.com/live/x.m3u8'), /非官方直播地址/)
  assert.throws(() => officialHlsUrl(''), /非官方直播地址/)
})

console.log(`\n全部通过：${passed} ✅`)
