#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import jlntv from '../extractors/jlntv/index.js'
import jlntvScenic from '../extractors/jlntv/scenic.js'
import {
  API_ORIGIN,
  BROADCAST_CHANNELS,
  SCENIC_CHANNELS,
  buildGroups,
  buildScenicGroups,
  claimsRef,
  claimsScenicRef,
  clearCache,
  decryptJlntvResponse,
  officialAssetUrl,
  officialHlsUrl,
  parseBroadcast,
  resolveChannel,
  scenicStreamKey,
  selectLogos,
  selectSlowTopics,
  selectStreamDetail,
  validateDynamicStreamUrl,
  validateTopicStreamUrl,
} from '../extractors/jlntv/api.js'
import { encryptBase64 } from '../extractors/nmtv/xxtea.js'
import { getModule, resolverFor } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

const now = 1_700_000_000_000
const stream = 'https://hls.avap.jilintv.cn/zqvk7vpj/channel/abc123/index.m3u8?txSecret=0123456789abcdef0123456789abcdef&txTime=70000000'
// 吉林与内蒙古是同一家平台，频道列表的 XXTEA 与密钥都相同：借内蒙古模块的加密函数造离线假列表
const encryptedList = data => JSON.stringify(encryptBase64(JSON.stringify({ code: 0, data }), '5b28bae827e651b3'))
const TV_CIPHER = '3VsyRtE2D+ZKE2fIIw4hf3cgRUNf5T/wevvi6KYB7MwW0XCpD+mZ/iI5rhyppwDH39xMwrjrkKOXBUaXx/Yz9B5CtTOTcducs9+4mpWyAHS+yLQVn005hHpeqsKb+/J8+8B2wv1ziAFer1ybMQyKwcjPwbV0TSI/G7GNNoeWUWjVYeZUiDpLj/FPegHiZylFFhkHEY8zKOQdVqRdg76BZ5nJpoWm+33pHAnZgdT+33v417QBjVykanGFYM25XndCmZXDs9PU3LRXDebvw7gKLRdQsrL+ZegMX9cblf4bW1ggbQ+OWjDAhK+qS5guY+Viue9puSIZvsKUJTaF'

console.log('吉林广电模块测试')

check('电视和慢直播是两个免账号全代理模块：「吉林」与拆出来的「吉林风景」', () => {
  assert.equal(getModule('jlntv'), jlntv)
  assert.equal(jlntv.name, '吉林')
  assert.equal(jlntv.category, undefined)
  assert.equal(jlntv.channelHlsMode, 'proxy')
  assert.equal(jlntv.preserveGroupSuffixes, undefined)
  assert.equal(jlntv.capabilities.catchup, false)
  assert.equal(jlntv.catalogVersion, 3)
  assert.equal(resolverFor('jlntv-satellite'), jlntv)
  assert.equal(resolverFor('jlntv-satellite/extra'), null)

  assert.equal(getModule('jlntv-scenic'), jlntvScenic)
  assert.equal(jlntvScenic.name, '吉林风景')
  assert.equal(jlntvScenic.category, undefined)
  assert.equal(jlntvScenic.channelHlsMode, 'proxy')
  assert.equal(jlntvScenic.outputGroupName, '吉林')
  assert.deepEqual(jlntvScenic.preserveGroupSuffixes, ['风景'])
  assert.deepEqual(jlntvScenic.splitFrom, { id: 'jlntv', groups: ['吉林风景'] })
  assert.equal(jlntvScenic.epg, undefined)
  // 两边各认各的：电视归「吉林」，慢直播归「吉林风景」
  for (const channel of BROADCAST_CHANNELS) assert.equal(resolverFor(channel.ref), jlntv, channel.ref)
  for (const channel of SCENIC_CHANNELS) assert.equal(resolverFor(channel.ref), jlntvScenic, channel.ref)
})

await checkAsync('频道表：吉林 15 路、吉林风景最多 13 路', async () => {
  assert.equal(BROADCAST_CHANNELS.length, 15)
  assert.equal(SCENIC_CHANNELS.length, 13)
  const groups = buildGroups()
  assert.deepEqual(groups.map(group => [group.name, group.dataList.length]), [['吉林', 15]])
  const scenicGroups = buildScenicGroups()
  assert.deepEqual(scenicGroups.map(group => [group.name, group.dataList.length]), [['吉林风景', 13]])
  assert.ok([...groups, ...scenicGroups].flatMap(group => group.dataList).every(channel =>
    channel.deferredRef.startsWith('jlntv-') && channel.catchup === 'none'))
  clearCache()
  const fetched = await jlntv.fetch({}, { fetchImpl: async () => new Response(encryptedList([])), now })
  assert.deepEqual(fetched.groups, groups)
})

// 「吉林风景」按官网直播目录里当前在播的慢直播专题动态收机位，再逐路取一次清单确认在播。
// 假官网：/content/list 是直播目录，/detail/stream/<id> 是专题详情，其余是清单
const LIVE_PLAYLIST = '#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXT-X-MEDIA-SEQUENCE:7\n#EXTINF:3,\na.ts\n'
const hex32 = seed => createHash('md5').update(seed).digest('hex')
// 腾讯云签名地址：频道号按名字造，签名参数与上面的 stream 同款（有效期到 2029 年）
const signed = seed => `https://hls.avap.jilintv.cn/zqvk7vpj/channel/${hex32(seed)}/index.m3u8?txSecret=0123456789abcdef0123456789abcdef&txTime=70000000`
const fixed = name => SCENIC_CHANNELS.find(channel => channel.name === name).url
const legacy = name => SCENIC_CHANNELS.find(channel => channel.name === name)
const topic = (id, title, streams, state = 1) => ({ id, title, state, streams })
const s = (name, playUrl = signed(name)) => ({ name, playUrl })
// 拆分前那一季：频道表里 13 路的原样
const LAST_SEASON = [
  topic('659599', '吉祥新闻慢直播｜秋日吉林', [s('长春市·新民广场'), s('长春市·双阳区'), s('临江市·江心岛'), s('长春市·南湖公园'), s('通化市·浑江')]),
  topic('986656', '云海湖光｜白山慢时光', [s('靖宇县·四海龙湾玛珥湖')]),
  topic('1020462', '吉祥新闻慢直播｜金秋吉林', [s('长春市·碧松净月塔楼'), s('靖宇县·松花江仁义风景区'), s('松原市·查干湖')]),
  // 官网给 http、主画面名字是空格（实测），靠信号标识认回频道表里的固定地址
  topic('1008906', '重温旧时光· 《红男绿女》慢直播', [s(' ', fixed('《红男绿女》慢直播').replace('https:', 'http:'))]),
  topic('750660', '让吉林影像写入中国记忆', [s('', fixed('让吉林影像写入中国记忆').replace('https:', 'http:'))]),
  topic('1050739', '省政府新闻办新闻发布会', [s('发布会')]),
  topic('1040717', '吉祥新闻慢直播｜夏日吉林', [s('已结束机位')], 2),
]
// 2026-11-08 实测的这一季：看敦化挂在三个专题里，仁义挂在两个专题里，白山市·松岭两路同名不同信号
const DUNHUA = 'https://plus-live.jlntv.cn/live/20260923dunhua.m3u8'
const THIS_SEASON = [
  topic('659599', '吉祥新闻慢直播｜ 金秋吉林 共赏山河风华', [s('看敦化', DUNHUA), s('长春市·吉塔'), s('通化市·浑江')]),
  topic('1035504', '吉祥新闻慢直播｜看敦化', [s('看敦化', DUNHUA), s('敦化市·渤海湖公园')]),
  topic('986656', '云海湖光｜白山慢时光', [s('白山市·松岭', signed('松岭A')), s('白山市·松岭', signed('松岭B')), s('靖宇县·松花江仁义风景区', signed('靖宇县·松花江仁义风景区'))]),
  topic('1020462', '吉祥新闻慢直播｜金秋吉林', [s('看敦化', DUNHUA), s('靖宇县·松花江仁义风景区')]),
]
const fakeJilinSite = ({ topics = LAST_SEASON, manifests = {}, listFails = false, detailFails = [] } = {}) => {
  const requests = []
  const fetchImpl = async (raw, options = {}) => {
    const url = new URL(raw)
    requests.push(url.href)
    if (url.origin === API_ORIGIN) {
      if (url.pathname === '/content/list') {
        if (listFails) throw new Error('connect ETIMEDOUT')
        assert.equal(url.searchParams.get('contentType'), 'stream')
        return new Response(encryptedList(topics.map(({ id, title, state }) => ({ id: Number(id), title, state, contentType: 'stream' }))))
      }
      const id = /^\/detail\/stream\/(\d+)$/.exec(url.pathname)?.[1]
      if (detailFails.includes(id)) throw new Error('connect ETIMEDOUT')
      const found = topics.find(item => item.id === id)
      const [main, ...subs] = found.streams
      return new Response(encryptedList({ id, title: found.title, state: found.state, contentType: 'stream', data: { name: main.name, playUrl: main.playUrl, subStreams: subs } }))
    }
    assert.equal(new Headers(options.headers).get('origin'), 'https://www.jlntv.cn')
    const behaviour = manifests[url.href] ?? LIVE_PLAYLIST
    if (behaviour instanceof Error) throw behaviour
    if (typeof behaviour === 'number') return new Response('nope', { status: behaviour })
    return new Response(behaviour)
  }
  return { fetchImpl, requests }
}
const refsOf = result => result.groups.flatMap(group => group.dataList).map(channel => channel.deferredRef)
const namesOf = result => result.groups.flatMap(group => group.dataList).map(channel => channel.name)

await checkAsync('吉林风景：频道表里的机位都还挂着时，13 路原样输出、引用不变；活动直播和已结束的专题不收', async () => {
  clearCache()
  const site = fakeJilinSite()
  const result = await jlntvScenic.fetch({}, { fetchImpl: site.fetchImpl, now })
  assert.deepEqual([...refsOf(result)].sort(), SCENIC_CHANNELS.map(channel => channel.ref).sort())
  assert.deepEqual(new Set(namesOf(result)), new Set(SCENIC_CHANNELS.map(channel => channel.name)))
  assert.deepEqual(result.meta.skipped, [])
  assert.deepEqual(result.meta.warnings, [])
  const details = site.requests.filter(href => href.includes('/detail/stream/'))
  assert.equal(new Set(details).size, details.length, '每个专题只问一次详情')
  assert.ok(!details.some(href => /\/(1050739|1040717)\?/.test(href)), '发布会、已结束的专题不问')
  // 固定地址的两路官网目录里没挂（长白山两路），照旧试清单
  assert.ok(site.requests.includes(fixed('长白山·万达滑雪场')))
  assert.deepEqual(refsOf(result).slice(-2), ['jlntv-slow-jiangjunding', 'jlntv-slow-wanda-ski'])
})

await checkAsync('吉林风景：官网换季后撤下的不显示、新换上的自动收；同一路挂多个专题只出一次，同名不同信号加序号', async () => {
  clearCache()
  const site = fakeJilinSite({ topics: THIS_SEASON })
  const result = await jlntvScenic.fetch({}, { fetchImpl: site.fetchImpl, now })
  assert.deepEqual(namesOf(result), [
    '看敦化', '长春市·吉塔', '通化市·浑江', '敦化市·渤海湖公园',
    '白山市·松岭', '白山市·松岭 2', '靖宇县·松花江仁义风景区',
    '长白山·万达滑雪场将军顶', '《红男绿女》慢直播', '长白山·万达滑雪场', '让吉林影像写入中国记忆',
  ])
  const refs = Object.fromEntries(result.groups[0].dataList.map(channel => [channel.name, channel.deferredRef]))
  // 原来就有的沿用原引用（仁义先出现在 986656，但频道表记的是 1020462，认回原引用、位置不动）
  assert.equal(refs['通化市·浑江'], legacy('通化市·浑江').ref)
  assert.equal(refs['靖宇县·松花江仁义风景区'], legacy('靖宇县·松花江仁义风景区').ref)
  // 新机位：引用只用信号标识摘要，不带专题号
  for (const name of ['看敦化', '长春市·吉塔', '敦化市·渤海湖公园', '白山市·松岭', '白山市·松岭 2']) {
    assert.match(refs[name], /^jlntv-slow-[a-f\d]{10}$/, name)
    assert.equal(claimsScenicRef(refs[name]), true, name)
    assert.equal(resolverFor(refs[name]), jlntvScenic, name)
  }
  assert.notEqual(refs['白山市·松岭'], refs['白山市·松岭 2'])
  assert.deepEqual(result.meta.skipped.map(row => row.name).sort(), [
    '长春市·新民广场', '长春市·双阳区', '临江市·江心岛', '长春市·南湖公园', '靖宇县·四海龙湾玛珥湖', '长春市·碧松净月塔楼', '松原市·查干湖',
  ].sort())
  assert.ok(result.meta.skipped.every(row => row.reason === '官网专题里已撤下这个机位'))
  // 引用每轮一样：用户对新机位做的隐藏、改名也能留住
  clearCache()
  const again = await jlntvScenic.fetch({}, { fetchImpl: fakeJilinSite({ topics: THIS_SEASON }).fetchImpl, now })
  assert.deepEqual(refsOf(again), refsOf(result))

  // 播放：新机位按信号在官网目录里找；看敦化（不带签名的 plus-live）放进媒体白名单
  clearCache()
  const play = await resolveChannel(refs['看敦化'], { fetchImpl: site.fetchImpl, now })
  assert.equal(play.url, DUNHUA)
  assert.equal(play.upstreamUrlTransform('https://plus-live.jlntv.cn/live/20260923dunhua-1.ts'), 'https://plus-live.jlntv.cn/live/20260923dunhua-1.ts')
  assert.equal(play.upstreamHeaders(DUNHUA).Referer, 'https://www.jlntv.cn/streamDetail?contentId=659599&type=stream&id=102')
  const second = await resolveChannel(refs['白山市·松岭 2'], { fetchImpl: site.fetchImpl, now })
  assert.equal(second.url, signed('松岭B'))
  // 机位挪了专题：原专题里没有了，就在当前在播的慢直播专题里找
  clearCache()
  const moved = THIS_SEASON.map(item => item.id === '659599' ? { ...item, streams: item.streams.filter(row => row.name !== '看敦化') } : item)
  const movedPlay = await resolveChannel(refs['看敦化'], { fetchImpl: fakeJilinSite({ topics: moved }).fetchImpl, now })
  assert.equal(movedPlay.url, DUNHUA)
  assert.equal(movedPlay.upstreamHeaders(DUNHUA).Referer, 'https://www.jlntv.cn/streamDetail?contentId=1035504&type=stream&id=102')
  // 哪个专题都没有了：说清楚，不抛
  clearCache()
  const gone = await resolveChannel(refs['长春市·吉塔'], { fetchImpl: fakeJilinSite({ topics: LAST_SEASON }).fetchImpl, now })
  assert.equal(gone.url, '')
  assert.match(gone.desc, /官网已撤下这个慢直播机位/)
  assert.equal(claimsScenicRef('jlntv-slow-659599-xyz'), false)
  assert.equal(claimsScenicRef('jlntv-slow-659599-0123456789'), false)
  clearCache()
})

await checkAsync('吉林风景：机位换了专题引用不变（隐藏、改名留得住），播放时跨专题找得到；老机位按名字认回', async () => {
  clearCache()
  const before = await jlntvScenic.fetch({}, { fetchImpl: fakeJilinSite({ topics: THIS_SEASON }).fetchImpl, now })
  const refsBefore = Object.fromEntries(before.groups[0].dataList.map(channel => [channel.name, channel.deferredRef]))
  // 下一季：「金秋吉林」两个专题撤了，新出的「冬日吉林」排在最前面也挂着看敦化、仁义
  const WINTER = [
    topic('1100001', '吉祥新闻慢直播｜冬日吉林', [s('看敦化', DUNHUA), s('靖宇县·松花江仁义风景区')]),
    ...THIS_SEASON.filter(item => !['659599', '1020462'].includes(item.id)),
  ]
  clearCache()
  const winterSite = fakeJilinSite({ topics: WINTER })
  const after = await jlntvScenic.fetch({}, { fetchImpl: winterSite.fetchImpl, now })
  const refsAfter = Object.fromEntries(after.groups[0].dataList.map(channel => [channel.name, channel.deferredRef]))
  for (const name of ['看敦化', '敦化市·渤海湖公园', '白山市·松岭', '白山市·松岭 2', '靖宇县·松花江仁义风景区']) {
    assert.equal(refsAfter[name], refsBefore[name], name)
  }
  assert.equal(refsAfter['靖宇县·松花江仁义风景区'], legacy('靖宇县·松花江仁义风景区').ref)
  // 刷新记下了挂在哪个专题，播放直接问那个专题
  winterSite.requests.length = 0
  const play = await resolveChannel(refsAfter['看敦化'], { fetchImpl: winterSite.fetchImpl, now: now + 60_000 })
  assert.equal(play.url, DUNHUA)
  assert.equal(play.upstreamHeaders(DUNHUA).Referer, 'https://www.jlntv.cn/streamDetail?contentId=1100001&type=stream&id=102')
  assert.deepEqual(winterSite.requests.map(href => new URL(href).pathname), ['/detail/stream/1100001'])

  // 重启后没有提示：老机位频道表里记的专题（1020462）撤了，到目录里按名字找
  clearCache()
  const renyi = await resolveChannel(legacy('靖宇县·松花江仁义风景区').ref, { fetchImpl: fakeJilinSite({ topics: WINTER }).fetchImpl, now })
  assert.equal(renyi.url, signed('靖宇县·松花江仁义风景区'))
  assert.equal(renyi.upstreamHeaders(renyi.url).Referer, 'https://www.jlntv.cn/streamDetail?contentId=1100001&type=stream&id=102')
  clearCache()
  const cold = await resolveChannel(refsAfter['看敦化'], { fetchImpl: fakeJilinSite({ topics: WINTER }).fetchImpl, now })
  assert.equal(cold.url, DUNHUA)
  // 频道表里的引用都是有名字的，不会被当成新机位的摘要引用
  assert.ok(SCENIC_CHANNELS.every(channel => !/^jlntv-slow-[a-f\d]{10}$/.test(channel.ref)))
  clearCache()
})

await checkAsync('吉林风景：清单 404 / 已结束 / 没分片的这一轮不显示，并记进跳过', async () => {
  clearCache()
  const site = fakeJilinSite({
    manifests: {
      [fixed('长白山·万达滑雪场')]: 404,
      [fixed('《红男绿女》慢直播')]: '#EXTM3U\n#EXTINF:3,\na.ts\n#EXT-X-ENDLIST\n',
      [signed('通化市·浑江')]: '#EXTM3U\n#EXT-X-TARGETDURATION:3\n',
    },
  })
  const result = await jlntvScenic.fetch({}, { fetchImpl: site.fetchImpl, now })
  assert.equal(namesOf(result).length, 10)
  assert.deepEqual(Object.fromEntries(result.meta.skipped.map(row => [row.name, row.reason])), {
    '长白山·万达滑雪场': '清单 HTTP 404',
    '《红男绿女》慢直播': '直播已结束',
    '通化市·浑江': '清单里没有分片',
  })
  assert.deepEqual(result.meta.warnings, [])
})

await checkAsync('吉林风景：固定地址给主清单时跟到媒体清单再判断', async () => {
  clearCache()
  const master = fixed('长白山·万达滑雪场将军顶')
  const media = master.replace('index.m3u8', '1080p/index.m3u8')
  const site = fakeJilinSite({ manifests: {
    [master]: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4228245,RESOLUTION=1920x1080\n1080p/index.m3u8\n',
    [media]: 404,
  } })
  const result = await jlntvScenic.fetch({}, { fetchImpl: site.fetchImpl, now })
  assert.ok(site.requests.includes(media))
  assert.deepEqual(result.meta.skipped, [{ name: '长白山·万达滑雪场将军顶', reason: '清单 HTTP 404' }])
})

await checkAsync('吉林风景：单路超时、5xx、限流照旧保留并提示；目录、专题详情取不到或一路都没确认成就整轮失败、沿用上一轮', async () => {
  clearCache()
  const site = fakeJilinSite({ manifests: {
    [fixed('长白山·万达滑雪场')]: 502,
    [fixed('《红男绿女》慢直播')]: Object.assign(new Error('timeout'), { name: 'TimeoutError' }),
    [signed('通化市·浑江')]: 429,
  } })
  const result = await jlntvScenic.fetch({}, { fetchImpl: site.fetchImpl, now })
  assert.equal(namesOf(result).length, 13, '说不准的不藏（含被限流的）')
  assert.deepEqual(result.meta.skipped, [])
  assert.match(result.meta.warnings[0], /通化市·浑江、《红男绿女》慢直播、长白山·万达滑雪场 这一轮没查成（清单 HTTP 429），照旧保留/)

  clearCache()
  await assert.rejects(() => jlntvScenic.fetch({}, { fetchImpl: fakeJilinSite({ listFails: true }).fetchImpl, now }), /ETIMEDOUT/)
  clearCache()
  await assert.rejects(() => jlntvScenic.fetch({}, { fetchImpl: fakeJilinSite({ detailFails: ['986656'] }).fetchImpl, now }), /ETIMEDOUT/)

  // 清单全连不上（开机时网络还没通）：不能输出「全在」，也不能清空
  clearCache()
  const allUrls = [...LAST_SEASON.flatMap(item => item.streams.map(row => row.playUrl.replace('http:', 'https:'))), ...SCENIC_CHANNELS.filter(c => c.url).map(c => c.url)]
  const down = fakeJilinSite({ manifests: Object.fromEntries(allUrls.map(url => [url, new Error('connect ETIMEDOUT')])) })
  await assert.rejects(() => jlntvScenic.fetch({}, { fetchImpl: down.fetchImpl, now }), /没能确认任何机位.*沿用上一轮/)

  // 官网一个慢直播专题都不挂、固定地址也都 404：合法的空，不报错
  clearCache()
  const allGone = fakeJilinSite({ topics: [], manifests: Object.fromEntries(SCENIC_CHANNELS.filter(c => c.url).map(c => [c.url, 404])) })
  const empty = await jlntvScenic.fetch({}, { fetchImpl: allGone.fetchImpl, now })
  assert.deepEqual(empty.groups, [])
  assert.equal(empty.meta.skipped.length, 13)
  clearCache()
})

check('吉林风景：信号标识认得出同一路的固定地址与签名地址；专题里的地址按主机分别校验', () => {
  const id = '1ceb537a60664ac49649b639e823678c'
  assert.equal(scenicStreamKey(`https://lsfb.avap.jilintv.cn/zqvk7vpj/channel/${id}/index.m3u8`), `channel:${id}`)
  assert.equal(scenicStreamKey(`https://hls.avap.jilintv.cn/zqvk7vpj/channel/${id}/index.m3u8?txSecret=x&txTime=y`), `channel:${id}`)
  assert.equal(scenicStreamKey(DUNHUA), 'plus-live.jlntv.cn/live/20260923dunhua.m3u8')
  assert.equal(validateTopicStreamUrl(DUNHUA, now), DUNHUA)
  assert.equal(validateTopicStreamUrl(fixed('《红男绿女》慢直播').replace('https:', 'http:'), now), fixed('《红男绿女》慢直播'))
  assert.throws(() => validateTopicStreamUrl('https://hls.avap.jilintv.cn/zqvk7vpj/channel/abc/index.m3u8', now), /鉴权/)
  assert.throws(() => validateTopicStreamUrl('https://evil.test/live/a.m3u8', now), /非官方/)
  assert.deepEqual(selectSlowTopics({ data: [
    { id: 1, title: '吉祥新闻慢直播｜冬', state: 1, contentType: 'stream' },
    { id: 2, title: '发布会', state: 1, contentType: 'stream' },
    { id: 750660, title: '让吉林影像写入中国记忆', state: 1, contentType: 'stream' },
    { id: 3, title: '慢直播｜未开始', state: 0, contentType: 'stream' },
    { id: 4, title: '慢直播文章', state: 1, contentType: 'article' },
  ] }).map(item => item.id), ['1', '750660'])
})

check('XXTEA 响应只按数据解密，不执行返回内容', () => {
  assert.deepEqual(decryptJlntvResponse('"TE1nyYDOPQJDbJsvLyJk4Q=="'), { code: 0 })
  assert.throws(() => decryptJlntvResponse('{"data":"process.env"}'), /密文/)
  assert.throws(() => decryptJlntvResponse('not-json'), /JSON/)
})

check('省级频道按 ID、原名、索引和签名有效期四重校验', () => {
  const channel = BROADCAST_CHANNELS[0]
  assert.equal(parseBroadcast(JSON.stringify(TV_CIPHER), channel, { now }), stream)
  assert.throws(() => parseBroadcast(JSON.stringify(TV_CIPHER), {
    ...channel, broadcastId: '1532', rawName: '都市频道',
  }, { now }), /指定电视频道/)
  assert.throws(() => validateDynamicStreamUrl(stream, Number.parseInt('70000000', 16) * 1000), /过期/)
  assert.throws(() => validateDynamicStreamUrl(stream.replace('hls.avap.jilintv.cn', 'evil.test'), now), /非官方/)
})

check('慢直播主机位和子机位都要求内容 ID 与机位名精确匹配', () => {
  const payload = {
    code: 0,
    data: {
      id: '659599', contentType: 'stream',
      data: {
        name: '长春市·新民广场', playUrl: stream,
        subStreams: [{ name: '长春市·双阳区', playUrl: stream }],
      },
    },
  }
  assert.equal(selectStreamDetail(payload, SCENIC_CHANNELS[0], { now }), stream)
  assert.equal(selectStreamDetail(payload, SCENIC_CHANNELS[1], { now }), stream)
  assert.throws(() => selectStreamDetail(payload, { ...SCENIC_CHANNELS[1], streamName: '未知机位' }, { now }), /指定慢直播机位/)
})

check('媒体白名单覆盖清单、密钥和分片，并拒绝任意回源', () => {
  assert.equal(officialHlsUrl(BROADCAST_CHANNELS[6].url), BROADCAST_CHANNELS[6].url)
  assert.match(officialAssetUrl('https://stream2.jlntv.cn/jlcc/sd/segment.ts'), /segment\.ts$/)
  assert.match(officialAssetUrl('https://lsfb.avap.jilintv.cn/zqvk7vpj/channel/abc/key.bin'), /key\.bin$/)
  for (const bad of [
    'http://stream2.jlntv.cn/a.ts',
    'https://stream2.jlntv.cn.evil.test/a.ts',
    'https://127.0.0.1/a.ts',
    'https://user:pass@stream2.jlntv.cn/a.ts',
    'https://stream2.jlntv.cn:444/a.ts',
  ]) assert.throws(() => officialAssetUrl(bad))
  assert.throws(() => officialHlsUrl('https://stream2.jlntv.cn/a.ts'), /不是 HLS/)
})

await checkAsync('播放时请求官方接口、校验请求头并短期复用响应', async () => {
  clearCache()
  let requests = 0
  const fetchImpl = async (raw, options = {}) => {
    const url = new URL(raw)
    assert.equal(url.origin, API_ORIGIN)
    assert.equal(url.pathname, '/broadcast/list')
    assert.equal(url.searchParams.get('type'), '1')
    assert.equal(new Headers(options.headers).get('client-type'), 'web')
    requests++
    return new Response(JSON.stringify(TV_CIPHER))
  }
  const first = await resolveChannel('jlntv-satellite', { fetchImpl, now })
  const second = await resolveChannel('jlntv-satellite', { fetchImpl, now: now + 1000 })
  assert.equal(requests, 1)
  assert.equal(first.url, stream)
  assert.equal(second.url, stream)
  assert.deepEqual(first.upstreamHeaders(stream), {
    Origin: 'https://www.jlntv.cn',
    Referer: 'https://www.jlntv.cn/tv?id=104',
  })
  assert.equal(first.upstreamUrlTransform('https://hls.avap.jilintv.cn/zqvk7vpj/channel/abc123/seg.ts'),
    'https://hls.avap.jilintv.cn/zqvk7vpj/channel/abc123/seg.ts')
})

await checkAsync('固定频道不访问 API，错误也只返回说明而不向请求处理器抛出', async () => {
  const fixed = await resolveChannel('jlntv-changchun', {
    fetchImpl: async () => { throw new Error('固定频道不应请求 API') },
  })
  assert.equal(fixed.url, BROADCAST_CHANNELS.find(channel => channel.ref === 'jlntv-changchun').url)
  assert.equal(claimsRef('jlntv-changchun'), true)
  assert.equal(claimsRef('jlntv-unknown'), false)
  assert.equal(claimsRef('jlntv-slow-chagan-lake'), false)
  assert.equal(claimsScenicRef('jlntv-slow-chagan-lake'), true)
  assert.equal(claimsScenicRef('jlntv-changchun'), false)

  clearCache()
  const failed = await resolveChannel('jlntv-satellite', {
    fetchImpl: async () => new Response('upstream error', { status: 500 }),
    now,
  })
  assert.equal(failed.url, '')
  assert.match(failed.desc, /链接请求失败.*HTTP 500/)
  const malformed = await resolveChannel('jlntv-unknown')
  assert.equal(malformed.url, '')
  assert.match(malformed.desc, /引用格式错误/)
})

console.log(`\n全部通过：${passed} ✅`)
