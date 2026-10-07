#!/usr/bin/env node
/**
 * 「海外频道」模块（extractors/overseas）与它的频道表 IPTV-overseas.m3u：
 *   - 频道表完整：42 台、台名不重复、只进约定的现有分组、地址都是 https 的固定 HLS；
 *   - 不和精选列表 IPTV.m3u 重复收台；
 *   - 台标：除了暂无出处的 Tennis Channel International，要么写了 tvg-logo，要么内置台标库按台名有图；
 *   - 模块：默认关闭（defaultEnabled: false）、排在注册表最后；先从仓库拉，拉不到用镜像自带的那份；频道排到组尾；
 *   - 标了 x-top-first 的台：写成本机入口，播放时取一次主清单、最高档挪到最前，取不到就 302 回官方地址。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

// 只用镜像自带的那份，测试不连 GitHub；模块在 import 时读这个变量
process.env.moverseasPlaylistUrl = ''

const { getModule, listModules, resolverFor, validateModule } = await import('../extractors/registry.js')
const { loadChannels, PLAYLIST_FILE, LADDERS, claimsRef, createResolver, refForName } = await import('../extractors/overseas/index.js')
const { parsePlaylistContent } = await import('../utils/externalSources.js')
const { moveTrailingChannelsLast } = await import('../utils/channelMerger.js')

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }
const read = path => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

const GROUPS = new Set(['体育', '娱乐时尚', '文旅', '国际', '韩国'])
const module = getModule('overseas')
const CHANNELS = parsePlaylistContent(read(`../${PLAYLIST_FILE}`))

console.log('海外频道模块测试')

check('模块定义合法，默认关闭，排在注册表最后', () => {
  assert.ok(module)
  assert.doesNotThrow(() => validateModule(module))
  assert.equal(module.defaultEnabled, false, '播放器直连海外 CDN，能不能看看播放设备的网络，交给用户打开')
  assert.equal(module.capabilities.resolve, true, '最高档前置的台播放时要转发主清单')
  assert.equal(module.defaultRefreshMinutes, 360, '和精选列表同周期从仓库拉')
  assert.equal(listModules().at(-1).id, 'overseas')
})

check('频道表：42 台、台名不重复、只进约定分组、地址都是 https HLS', () => {
  assert.equal(CHANNELS.length, 42)
  const names = CHANNELS.map(channel => channel.name)
  assert.equal(new Set(names).size, names.length, '台名重复')
  for (const channel of CHANNELS) {
    assert.ok(GROUPS.has(channel.group), `${channel.name} 的分组「${channel.group}」不在约定里`)
    const url = new URL(channel.url)
    assert.equal(url.protocol, 'https:', channel.name)
    assert.match(url.pathname, /\.m3u8$/, channel.name)
  }
})

check('不和精选列表重复收台（在大陆也顺的留在 IPTV.m3u）', () => {
  const featured = parsePlaylistContent(read('../IPTV.m3u'))
  const names = new Set(featured.map(channel => channel.name))
  const urls = new Set(featured.map(channel => channel.url))
  for (const channel of CHANNELS) {
    assert.ok(!names.has(channel.name), `${channel.name} 已在精选列表里`)
    assert.ok(!urls.has(channel.url), `${channel.name} 的地址已在精选列表里`)
  }
})

check('台标：写了 tvg-logo 或内置台标库按台名有图（Tennis Channel International 暂无）', () => {
  const pack = JSON.parse(read('../logo-pack/index.json')).logos
  const missing = CHANNELS.filter(channel => !channel.logo && !pack[channel.name]).map(channel => channel.name)
  assert.deepEqual(missing, ['Tennis Channel International'])
})

await checkAsync('fetch 按分组输出，频道排到组尾、不透传回看参数', async () => {
  const { groups, meta } = await module.fetch()
  assert.deepEqual(meta, { skipped: [], warnings: [] })
  assert.deepEqual(groups.map(group => [group.name, group.dataList.length]),
    [['体育', 13], ['娱乐时尚', 12], ['文旅', 7], ['国际', 9], ['韩国', 1]])
  for (const group of groups) {
    for (const channel of group.dataList) {
      assert.ok(channel.name && (channel.url || channel.deferredRef) && !(channel.url && channel.deferredRef))
      assert.equal(channel.catchup, 'none')
      assert.equal(channel.trailing, true, '要排到所在分组最后')
    }
  }
  const bein = groups[0].dataList.find(channel => channel.name === 'beIN Sports Xtra')
  assert.match(bein.logo, /^https:\/\/image\.xumo\.com\//)
})

check('最高档前置：标了 x-top-first 的 14 台都是官方多档主清单或登记过的单档拼装，ref 按台名生成、互不相同、只归海外频道认领', () => {
  const flagged = CHANNELS.filter(channel => channel.topFirst)
  assert.deepEqual(flagged.map(channel => channel.name).sort(),
    ['Arirang', 'DW English', 'FIFA+', 'FUEL TV', 'France 24 Español', 'Gusto TV', 'MTRSPT1', 'MovieSphere', 'NASA+', 'Qello Concerts', 'TRT World', 'Terra Mater WILD', 'Thai PBS', 'Wipeout Xtra'])
  const refs = flagged.map(channel => refForName(channel.name))
  assert.equal(new Set(refs).size, refs.length, 'ref 不能撞')
  assert.deepEqual(refs.sort(), ['overseas-arirang', 'overseas-dw-english', 'overseas-fifa', 'overseas-france-24-espanol', 'overseas-fuel-tv', 'overseas-gusto-tv', 'overseas-moviesphere', 'overseas-mtrspt1', 'overseas-nasa', 'overseas-qello-concerts', 'overseas-terra-mater-wild', 'overseas-thai-pbs', 'overseas-trt-world', 'overseas-wipeout-xtra'])
  assert.ok(refs.every(ref => claimsRef(ref) && resolverFor(ref) === module))
  assert.ok(!flagged.some(channel => !LADDERS.has(channel.url) && /chunklist|\/\d+\.m3u8$|1080p|master_\d+/.test(channel.url)), '标了的要写主清单，不能写死某一档')
  assert.ok([...LADDERS.keys()].every(url => flagged.some(channel => channel.url === url)), 'LADDERS 登记的地址要和频道表一致，对不上就白登记了')
  assert.match(refForName('上海新闻'), /^overseas-[0-9a-f]{12}$/, '没有英文字母的台名用哈希')
  assert.equal(claimsRef('overseas-thai-pbs/extra'), false)
})

await checkAsync('最高档前置：转发主清单时最高档在前；取不到、不是主清单都 302 回官方地址', async () => {
  const thai = CHANNELS.find(channel => channel.name === 'Thai PBS')
  const master = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="TH",URI="subtitles/subtitle.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=128000,RESOLUTION=256x144,SUBTITLES="subs"',
    'variant_144p.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=7000000,RESOLUTION=1920x1080,SUBTITLES="subs"',
    'variant_1080p.m3u8',
    '',
  ].join('\n')
  let loads = 0
  const load = async () => { loads++; return { channels: CHANNELS } }
  let body = () => new Response(master)
  const resolver = createResolver({ load, fetchImpl: async () => body() })
  const ok = await resolver.resolve('overseas-thai-pbs')
  assert.equal(loads, 1, '重启后头一次播放现读一次频道表')
  assert.equal(ok.url, thai.url)
  assert.equal(ok.relayHls, true)
  assert.equal(ok.manifestUrl, thai.url)
  assert.deepEqual(ok.manifestText.split('\n').filter(line => line.endsWith('.m3u8') && !line.startsWith('#')), ['variant_1080p.m3u8', 'variant_144p.m3u8'])
  assert.match(ok.manifestText, /SUBTITLES,GROUP-ID="subs"/, '字幕轨保留')
  await resolver.resolve('overseas-thai-pbs')
  assert.equal(loads, 1)

  for (const [name, make] of [['上游 403', () => new Response('', { status: 403 })], ['单档媒体清单', () => new Response('#EXTM3U\n#EXTINF:6,\na.ts\n')], ['连不上', () => { throw new Error('ECONNRESET') }]]) {
    body = make
    const fallback = await resolver.resolve('overseas-thai-pbs')
    assert.equal(fallback.url, thai.url, name)
    assert.equal(fallback.relayHls, undefined, `${name}：不带 relayHls，app.js 直接 302`)
    assert.match(fallback.desc, /改由播放器直连/)
  }
  // 单档拼装：France 24 Español 不发请求，1080p 在前、360p 兜底
  body = () => { throw new Error('不该发请求') }
  const spanish = await resolver.resolve('overseas-france-24-espanol')
  assert.equal(spanish.relayHls, true)
  assert.deepEqual(spanish.manifestText.split('\n').filter(line => line.startsWith('https://')).map(url => url.split('/').pop()), ['master_5000.m3u8', 'master_500.m3u8'])
  assert.match(spanish.manifestText, /RESOLUTION=1920x1080\n[^\n]*F24_ES_HI_HLS\/master_5000/)
  const missing = await resolver.resolve('overseas-gone')
  assert.equal(missing.url, '')
  assert.match(missing.desc, /没有这个频道/)
  await resolver.resolve('overseas-gone')
  assert.equal(loads, 1, '频道表一分钟内读过，下架的台不反复重读')
})

await checkAsync('先从仓库拉：拉到就用仓库的（推送即生效），拉不到用镜像自带的并提示', async () => {
  const remote = '#EXTM3U\n#EXTINF:-1 group-title="体育",Test Sports\nhttps://cdn.example/test/playlist.m3u8\n'
  const server = createServer((req, res) => {
    if (req.url === `/${PLAYLIST_FILE}`) { res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' }); res.end(remote) } else { res.writeHead(404); res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const fromRepo = await loadChannels({ url: `${base}/${PLAYLIST_FILE}` })
    assert.equal(fromRepo.from, 'remote')
    assert.deepEqual(fromRepo.channels.map(channel => channel.name), ['Test Sports'])
    assert.deepEqual(fromRepo.warnings, [])

    const fallback = await loadChannels({ url: `${base}/missing.m3u` })
    assert.equal(fallback.from, 'bundled')
    assert.equal(fallback.channels.length, 42)
    assert.match(fallback.warnings[0], /拉不到，先用镜像自带的/)
  } finally {
    server.close()
  }
})

check('任何分组里海外频道都排到最后，跟在精选列表之后（不拆开 France 24 各语种）', () => {
  const input = [{ name: '国际', dataList: [
    { name: 'NEWS1', trailing: true },
    { name: 'France 24 Español', trailing: true },
    { name: 'CNA', source: 'external' },
    { name: 'France 24 Français', source: 'external' },
    { name: 'France 24 English', source: 'external' },
  ] }, { name: '央视频', dataList: [{ name: 'CCTV1综合' }] }]
  const before = JSON.stringify(input)
  const output = moveTrailingChannelsLast(input)
  assert.deepEqual(output[0].dataList.map(channel => channel.name),
    ['CNA', 'France 24 Français', 'France 24 English', 'NEWS1', 'France 24 Español'])
  assert.equal(output[1], input[1], '没有海外台的分组原样返回')
  assert.equal(JSON.stringify(input), before, '不改输入')
})

console.log(`\n全部通过：${passed} ✅`)
