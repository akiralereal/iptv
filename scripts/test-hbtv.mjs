#!/usr/bin/env node
import assert from 'node:assert/strict'

import { parseChannelPage, UPSTREAM_HEADERS } from '../extractors/hbtv/api.js'
import { buildChannels, CHANNELS, channelIdFromRef } from '../extractors/hbtv/channels.js'
import { createResolver } from '../extractors/hbtv/resolver.js'
import { isOfficialResolvedUrl } from '../extractors/hbtv/session.js'
import { inlineResolvedManifest } from '../utils/appUtils.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('湖北长江云模块测试')

const now = 1_780_000_000_000
const expiry = Math.floor(now / 1000) + 1800
const auth = id => `${expiry}-${id.padEnd(32, 'a')}-0-${id.padEnd(32, 'b')}`
const thumbBase = 'https://m.hbtv.com.cn/t/site/10008/6fd52b21978e4534397ad7bea6ec6b0d/assets/2023_live_audio/images/live/'
// 官网直播页实际的图标文件名（垄上是 lspd，不跟流路径走）
const thumbFile = { 431: 'hbws', 432: 'hbjs', 433: 'hbzh', 435: 'hbys', 437: 'hbjy', 438: 'lspd' }
const thumb = channel => `${thumbBase}${thumbFile[channel.id]}.png`
const html = CHANNELS.map(channel => `{
  id: ${channel.id},
  name: "${channel.rawName}",
  stream: "https://live21-cjy.hbtv.com.cn/new-hbtv/${channel.streamPath}.m3u8?auth_key=${auth(channel.id)}",
  active: false,
  thumb: "${thumb(channel)}"
}`).join(',')

check('官网页严格解析固定六套 ID、名称、路径与到期时间', () => {
  const rows = parseChannelPage(html, now)
  assert.equal(rows.length, 6)
  assert.deepEqual(rows.map(row => row.id), ['431', '432', '433', '435', '437', '438'])
  assert.ok(rows.every(row => row.expiresAt === expiry * 1000))
  assert.equal(parseChannelPage(html.replace('new-hbjy.m3u8', 'other.m3u8'), now).length, 5)
})

check('频道输出固定全代理，引用白名单不误认其它直播', () => {
  const channels = buildChannels(parseChannelPage(html, now))
  assert.equal(channels.length, 6)
  assert.ok(channels.every(channel => channel.proxyHls === true))
  assert.equal(channelIdFromRef('hbtv-431'), '431')
  assert.equal(channelIdFromRef('hbtv-434'), '')
})

check('台标取官网直播页同一条目的 thumb，只收长江云域名，缺了留空', () => {
  const channels = buildChannels(parseChannelPage(html, now))
  assert.deepEqual(channels.map(channel => channel.logo), CHANNELS.map(thumb))
  assert.equal(channels[0].logo, `${thumbBase}hbws.png`)
  assert.equal(channels[5].logo, `${thumbBase}lspd.png`)

  // 缺 thumb 的条目不能借用下一套频道的图
  const noThumb = html.replace(`thumb: "${thumb(CHANNELS[0])}"`, 'cover: ""')
  const rows = parseChannelPage(noThumb, now)
  assert.equal(rows.length, 6)
  assert.equal(rows[0].logo, '')
  assert.equal(rows[1].logo, thumb(CHANNELS[1]))

  const foreign = parseChannelPage(html.replace(thumb(CHANNELS[1]), 'https://evil.example/hbjs.png'), now)
  assert.equal(foreign[1].logo, '')
  const plainHttp = parseChannelPage(html.replace(thumb(CHANNELS[2]), thumb(CHANNELS[2]).replace('https:', 'http:')), now)
  assert.equal(plainHttp[2].logo, thumb(CHANNELS[2]))

  assert.ok(buildChannels().every(channel => channel.logo === ''))
})

check('只接受带三段防盗链参数的湖北官方 CDN 清单', () => {
  assert.equal(isOfficialResolvedUrl(
    'https://live21-cjy.hbtv.com.cn/new-hbtv/new-hbws.m3u8?auth_key=a&extrakey=b&aalook=c',
  ), true)
  assert.equal(isOfficialResolvedUrl('https://evil.example/new-hbtv/new-hbws.m3u8?auth_key=a&extrakey=b&aalook=c'), false)
})

await checkAsync('解析器把浏览器清单与防盗链请求头交给全代理层', async () => {
  const rows = parseChannelPage(html, now)
  let captured = ''
  const resolver = createResolver({
    getRows: async () => rows,
    capture: async url => {
      captured = url
      return {
        url: 'https://live21-cjy.hbtv.com.cn/new-hbtv/new-hbws.m3u8?auth_key=a&extrakey=b&aalook=c',
        text: '#EXTM3U\n#EXTINF:5,\nseg.ts?auth_key=a',
      }
    },
    close: async () => {},
  })
  const out = await resolver.resolve('hbtv-431', { now })
  assert.match(captured, /new-hbws\.m3u8/)
  assert.equal(out.manifestText.startsWith('#EXTM3U'), true)
  assert.deepEqual(out.upstreamHeaders, UPSTREAM_HEADERS)
  assert.equal(out.relayHls, true)
})

check('内联浏览器清单仍按真实 CDN 基址改写相对分片', () => {
  const out = inlineResolvedManifest({
    playURL: 'https://unused.example/a.m3u8',
    manifestUrl: 'https://live21-cjy.hbtv.com.cn/new-hbtv/new-hbws.m3u8?auth_key=a&extrakey=b&aalook=c',
    manifestText: '#EXTM3U\n#EXTINF:5,\nseg.ts?auth_key=a',
  })
  assert.ok(out.includes('https://live21-cjy.hbtv.com.cn/new-hbtv/seg.ts?auth_key=a'))
  assert.equal(inlineResolvedManifest({ manifestText: '<html>403</html>', manifestUrl: 'https://x.test/a' }), null)
})

console.log(`\n全部通过：${passed}/6 ✅`)
