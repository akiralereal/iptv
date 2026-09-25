#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import sichuan from '../extractors/sichuan/index.js'
import {
  SICHUAN_AUTH_API,
  SICHUAN_IMAGE_BASE,
  SICHUAN_LIVE_API,
  SICHUAN_LIVE_DETAIL_API,
  SICHUAN_LIVE_MEDIA_HEADERS,
  SICHUAN_MEDIA_HEADERS,
  SICHUAN_PAGE,
  applySichuanSecret,
  buildChannels,
  buildLiveChannels,
  claimsRef,
  clearCache,
  officialAssetUrl,
  officialLogoUrl,
  parseChannelList,
  parseCredential,
  parseLiveList,
  resolveChannel,
  upstreamHeadersFor,
} from '../extractors/sichuan/api.js'
import { getModule, resolverFor } from '../extractors/registry.js'
import { redactConfig, resolveConfig, validateConfig } from '../utils/extractorManager.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }
const response = (body, status = 200) => new Response(
  typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json' } },
)

const rows = [
  {
    id: '1016553',
    name: '四川卫视',
    rawUrl: 'https://tvshowf.scgczm.com/live/sctv1.m3u8',
    logo: 'https://kscgc.scgchc.com/sctv/1/image/public/202107/sctv1.png',
  },
  {
    id: '1970689144638746626',
    name: '四川卫视4K超高清SDR',
    rawUrl: 'https://hmmslivef.scgczm.com/live/4ksctv1.m3u8',
    logo: 'https://kscgc.scgchc.com/layout/image/2025/09/24/4k.png',
  },
]
// 与官网目录同形：老频道 squareImg 是相对路径，新频道是完整地址；对象里还嵌着 dept 等子对象。
const catalogObject = (row, extra = {}) => ({
  id: row.id,
  name: row.name,
  playAddress: row.rawUrl,
  createTime: '2024-06-18 10:46:37',
  ...extra,
  allowPlay: 1,
  dept: [{ id: '2100187697667940353', itemId: row.id, itemType: 4, deptName: row.name }],
  itemType: 4,
})
const fixtureHtml = `before${JSON.stringify([
  catalogObject(rows[0], {
    squareImg: '/sctv/1/image/public/202107/sctv1.png',
    pcover: '/sctv/1/image/public/201801/sctv1-cover.jpg',
  }),
  catalogObject(rows[1], {
    squareImg: rows[1].logo,
    pcover: 'https://kscgc.scgchc.com/layout/image/2025/09/24/4k-cover.png',
  }),
])}after`
const liveEvent = {
  id: '2096229462308356097',
  title: '跟着赛事去旅行',
  cover: 'https://kscgc.scgchc.com/live/event.jpg',
}
const liveUrl = 'https://mmslivef.scgchc.com/live/18287.m3u8?auth_key=signed'

console.log('四川广电模块测试')

check('模块注册为需账号的四川全代理模块', () => {
  assert.equal(getModule('sichuan'), sichuan)
  assert.equal(sichuan.category, 'account')
  assert.equal(sichuan.channelHlsMode, 'proxy')
  assert.equal(sichuan.capabilities.catchup, false)
  assert.equal(sichuan.helper, 'sichuan-token')
  assert.equal(sichuan.helperSection, '四川官网登录')
  assert.equal(resolverFor('sichuan-1016553'), sichuan)
  assert.equal(resolverFor('sichuan-1016553/extra'), null)
})

check('输入支持裸 Token、Bearer、当前键名与完整账号 JSON', () => {
  assert.equal(parseCredential('plain-token'), 'plain-token')
  assert.equal(parseCredential('Bearer bearer-token'), 'bearer-token')
  assert.equal(parseCredential('{"access_token":"json-token"}'), 'json-token')
  assert.equal(
    parseCredential('scgc_userAccountInfo=%7B%22access_token%22%3A%22encoded-token%22%7D'),
    'encoded-token',
  )
  assert.throws(() => parseCredential('{"nickname":"tester"}'), /没有 access_token/)
  const stored = validateConfig(sichuan, { accessToken: 'secret-token' }).config
  const redacted = redactConfig(sichuan, resolveConfig(sichuan, stored))
  assert.equal(redacted.config.accessToken, '')
  assert.equal(redacted.secretsSet.accessToken, true)
  assert.equal(JSON.stringify(redacted).includes('secret-token'), false)
})

check('频道目录排除购物并生成稳定的延迟引用', () => {
  const html = fixtureHtml + JSON.stringify({
    id: '9', name: '星空购物', playAddress: 'https://tvshowf.scgczm.com/live/shop.m3u8',
  })
  const parsed = parseChannelList(html)
  assert.deepEqual(parsed, rows)
  assert.deepEqual(buildChannels(parsed).map(channel => channel.deferredRef), [
    'sichuan-1016553',
    'sichuan-1970689144638746626',
  ])
  assert.deepEqual(buildChannels(parsed).map(channel => channel.logo), rows.map(row => row.logo))
  assert.equal(claimsRef('sichuan-text'), false)
})

check('频道图标取官网目录 squareImg，相对路径按官网图床补全，缺字段不借下一台', () => {
  assert.equal(SICHUAN_IMAGE_BASE, 'https://kscgc.scgchc.com/')
  assert.equal(officialLogoUrl('/sctv/1/image/a.png'), 'https://kscgc.scgchc.com/sctv/1/image/a.png')
  assert.equal(officialLogoUrl('https://kscgc.sctv-tf.com/sctv/b.png'), 'https://kscgc.sctv-tf.com/sctv/b.png')
  assert.equal(officialLogoUrl(''), '')
  assert.equal(officialLogoUrl('javascript:alert(1)'), '')
  const noSquare = { id: '1016554', name: '经济频道', rawUrl: 'https://tvshowf.scgczm.com/live/sctv2.m3u8' }
  const bare = { id: '1016555', name: '文化旅游', rawUrl: 'https://tvshowf.scgczm.com/live/sctv3.m3u8' }
  const html = JSON.stringify({
    tv: [
      catalogObject(noSquare, { pcover: '/sctv/1/image/public/201809/economy.png' }),
      catalogObject(bare),
      catalogObject(rows[0], { squareImg: '/sctv/1/image/public/202107/sctv1.png' }),
    ],
  })
  assert.deepEqual(parseChannelList(html).map(row => row.logo), [
    'https://kscgc.scgchc.com/sctv/1/image/public/201809/economy.png',
    '',
    rows[0].logo,
  ])
  // 官网 RSC 负载里的 JSON 是转义过的，解析前会还原。
  const escaped = JSON.stringify(JSON.stringify([catalogObject(rows[0], { squareImg: '/sctv/1/image/public/202107/sctv1.png' })]))
  assert.equal(parseChannelList(escaped)[0].logo, rows[0].logo)
})

check('活动目录生成同一四川分组使用的动态引用', () => {
  const parsed = parseLiveList({ rs: 200, data: [liveEvent, liveEvent, { id: 'bad', title: '' }] })
  assert.deepEqual(parsed, [{ id: liveEvent.id, name: liveEvent.title, cover: liveEvent.cover }])
  assert.equal(buildLiveChannels(parsed)[0].deferredRef, `sichuan-live-${liveEvent.id}`)
  assert.equal(claimsRef(`sichuan-live-${liveEvent.id}`), true)
  assert.equal(claimsRef(`sichuan-live-${liveEvent.id}/extra`), false)
})

check('媒体白名单覆盖清单、密钥和分片，并固定携带官网来源头', () => {
  assert.match(officialAssetUrl('https://tvshowf.scgczm.com/live/a.ts?auth_key=x'), /a\.ts/)
  assert.match(officialAssetUrl('https://hmmslivef.scgczm.com/live/a.key'), /a\.key$/)
  assert.match(officialAssetUrl(liveUrl), /18287\.m3u8/)
  assert.deepEqual(upstreamHeadersFor('https://tvshowf.scgczm.com/live/a.ts'), SICHUAN_MEDIA_HEADERS)
  assert.deepEqual(upstreamHeadersFor(liveUrl), SICHUAN_LIVE_MEDIA_HEADERS)
  for (const bad of [
    'http://tvshowf.scgczm.com/live/a.ts',
    'https://tvshowf.scgczm.com.evil.test/live/a.ts',
    'https://127.0.0.1/private.ts',
  ]) assert.throws(() => officialAssetUrl(bad), /非官方媒体地址/)
  assert.throws(() => upstreamHeadersFor('https://example.com/redirected.ts'), /非官方媒体地址/)
})

await checkAsync('配置 Token 后抓取频道，并在播放时动态换签', async () => {
  clearCache()
  const accessToken = 'account-token'
  const secret = '1788667000-1-0-testsecret'
  const calls = []
  const fetchImpl = async (raw, options = {}) => {
    const url = new URL(String(raw))
    calls.push({ url, headers: options.headers || {} })
    if (url.href === SICHUAN_PAGE) {
      // 真实页面至少 8 个频道；测试补齐 8 条以覆盖结构保护。
      const eight = Array.from({ length: 8 }, (_, index) => ({
        id: String(1016553 + index),
        name: `四川频道${index + 1}`,
        playAddress: `https://tvshowf.scgczm.com/live/sctv${index + 1}.m3u8`,
        squareImg: `/sctv/1/image/public/202107/sctv${index + 1}.png`,
      })).map(JSON.stringify).join('')
      return response(eight)
    }
    if (url.href === SICHUAN_LIVE_API) return response({ rs: 200, data: [liveEvent] })
    if (url.href === `${SICHUAN_LIVE_DETAIL_API}/${liveEvent.id}`) {
      return response({ rs: 200, data: { ...liveEvent, status: 1, stream: [{ address: liveUrl }] } })
    }
    if (url.href === liveUrl) return response('#EXTM3U\n#EXTINF:6,\nsegment.ts\n')
    if (url.origin + url.pathname === SICHUAN_AUTH_API) {
      assert.equal(url.searchParams.get('streamName'), '/live/sctv1.m3u8')
      assert.equal(options.headers.authorization, `bearer ${accessToken}`)
      return response({ rs: 200, data: { secret } })
    }
    throw new Error(`unexpected URL: ${url.href}`)
  }
  const fetched = await sichuan.fetch({ accessToken }, { fetchImpl, now: 1788666000000 })
  assert.equal(fetched.groups[0].name, '四川')
  assert.equal(fetched.groups[0].dataList.length, 9)
  assert.equal(fetched.groups[0].dataList[0].logo, 'https://kscgc.scgchc.com/sctv/1/image/public/202107/sctv1.png')
  assert.equal(fetched.groups[0].dataList.at(-1).deferredRef, `sichuan-live-${liveEvent.id}`)
  assert.equal(fetched.groups[0].dataList.at(-1).logo, liveEvent.cover)
  const resolved = await resolveChannel('sichuan-1016553', {
    config: { accessToken }, fetchImpl, now: 1788666001000,
  })
  assert.equal(resolved.url, applySichuanSecret(rows[0].rawUrl, secret))
  assert.deepEqual(resolved.upstreamHeaders(resolved.url), SICHUAN_MEDIA_HEADERS)
  assert.equal(resolved.upstreamUrlTransform('https://tvshowf.scgczm.com/live/a.ts'), 'https://tvshowf.scgczm.com/live/a.ts')
  const liveResolved = await resolveChannel(`sichuan-live-${liveEvent.id}`, { fetchImpl })
  assert.equal(liveResolved.url, liveUrl)
  assert.deepEqual(liveResolved.upstreamHeaders(liveResolved.url), SICHUAN_LIVE_MEDIA_HEADERS)
  assert.equal(calls.filter(call => call.url.origin + call.url.pathname === SICHUAN_AUTH_API).length, 1)
})

await checkAsync('缺少凭据时只隐藏固定频道，活动有则显示、无则不显示', async () => {
  clearCache()
  const fetchImpl = async raw => {
    assert.equal(String(raw), SICHUAN_LIVE_API)
    return response({ rs: 200, data: [] })
  }
  const fetched = await sichuan.fetch({}, { fetchImpl })
  assert.deepEqual(fetched.groups, [])
  assert.match(fetched.meta.warnings.join('\n'), /尚未配置/)
  const resolved = await resolveChannel('sichuan-1016553', { config: {} })
  assert.equal(resolved.url, '')
  assert.match(resolved.desc, /需要先在后台关联/)
})

check('后台包含四川官网书签工具且不会把 Token 写入播放地址', () => {
  const admin = readFileSync(new URL('../web/admin.html', import.meta.url), 'utf8')
  assert.match(admin, /sichuanBookmarklet/)
  assert.match(admin, /scgc_useraccountinfo/)
  assert.match(admin, /获取四川 Token/)
})

console.log(`\n全部通过：${passed} ✅`)
