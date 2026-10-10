#!/usr/bin/env node
/**
 * 频道级播放选项（#EXTVLCOPT）贯通测试。
 *
 * 背景：B 站、虎牙一类直播源带防盗链，播放器不发 Referer 直接 403。这类信息
 * 塞不进 EXTINF 属性，只能靠 EXTINF 与播放地址之间的 #EXTVLCOPT 行传给播放器。
 *
 * 不变量：
 *  - 解析：订阅里的 #EXTVLCOPT 收进频道的 opts，不再被当成注释丢掉；
 *  - 回读：interface.txt 回读时 opts 行不得被误当成播放地址（这是最容易踩的坑——
 *    旧实现假定 EXTINF 的下一行就是地址）；
 *  - 生成：opts 必须夹在 EXTINF 和地址之间，顺序不能颠倒；
 *  - 零回归：不带 opts 的频道，输出与改动前逐字节一致；
 *  - 消毒：opts 来自第三方订阅（不可信），键名过白名单、含换行者整条拒收，
 *    防止一条 opt 撑开成任意 M3U 指令；
 *  - txt：diyp/TVBox 格式放不下请求头，依赖 opts 的频道整条跳过而不是写成死链。
 *
 * 运行： node scripts/test-channel-opts.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { parsePlaylistContent } from '../utils/externalSources.js'
import { generateM3u8, generateTxt } from '../utils/playlistConfig.js'
import { collectOptsUntilUrl, sanitizeOpts, renderOpts, needsOpts } from '../utils/channelOpts.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('频道级播放选项 (#EXTVLCOPT) 贯通测试')

const REF = 'http://ref.example/'

check('解析：订阅里的 #EXTVLCOPT 收进 opts，地址不被 opt 行顶掉', () => {
  const m3u = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-logo="http://h/l.png" group-title="赛事",[原画] 主播 · 标题',
    `#EXTVLCOPT:http-referrer=${REF}`,
    '#EXTVLCOPT:http-user-agent=Mozilla/5.0',
    'https://cdn.example/live.m3u8?expires=1',
  ].join('\n')
  const [ch] = parsePlaylistContent(m3u)
  assert.equal(ch.url, 'https://cdn.example/live.m3u8?expires=1')
  assert.deepEqual(ch.opts, [`http-referrer=${REF}`, 'http-user-agent=Mozilla/5.0'])
  assert.equal(ch.group, '赛事')
})

check('解析：不带 opts 的频道不长出 opts 字段（旧频道对象形状不变）', () => {
  const [ch] = parsePlaylistContent('#EXTINF:-1 group-title="央视",CCTV1\nhttp://h/c.m3u8')
  assert.equal('opts' in ch, false)
})

check('回读：opts 行不被误当成播放地址（collectOptsUntilUrl 定位）', () => {
  const lines = [
    '#EXTINF:-1 group-title="赛事",A',
    `#EXTVLCOPT:http-referrer=${REF}`,
    'https://cdn.example/a.m3u8',
  ]
  const { opts, urlIndex } = collectOptsUntilUrl(lines, 0)
  assert.equal(urlIndex, 2)                       // 不是 1（那是 opt 行）
  assert.deepEqual(opts, [`http-referrer=${REF}`])
})

check('回读：EXTINF 之后没有地址时 urlIndex 为 -1，不越界抓下一条频道', () => {
  const lines = ['#EXTINF:-1 group-title="x",A', `#EXTVLCOPT:http-referrer=${REF}`]
  assert.equal(collectOptsUntilUrl(lines, 0).urlIndex, -1)
})

check('生成 m3u：opts 夹在 EXTINF 和地址之间，顺序正确', () => {
  const out = generateM3u8([{
    name: '赛事',
    channels: [{ tvgId: 'A', tvgName: 'A', logo: '', name: 'A', url: 'http://h/a.m3u8', opts: [`http-referrer=${REF}`] }],
  }])
  const lines = out.trim().split('\n')
  assert.ok(lines[1].startsWith('#EXTINF:'))
  assert.equal(lines[2], `#EXTVLCOPT:http-referrer=${REF}`)
  assert.equal(lines[3], 'http://h/a.m3u8')
})

check('零回归：不带 opts 的频道，生成结果与旧格式逐字节一致', () => {
  const ch = { tvgId: 'CCTV1', tvgName: 'CCTV1', logo: 'http://h/l.png', name: 'CCTV1', url: 'http://h/c.m3u8' }
  const out = generateM3u8([{ name: '央视', channels: [ch] }])
  const expected = '#EXTINF:-1 tvg-id="CCTV1" tvg-name="CCTV1" tvg-logo="http://h/l.png" group-title="央视",CCTV1\nhttp://h/c.m3u8\n'
  assert.ok(out.endsWith(expected), out)
})

check('往返：解析 → 生成 → 再解析，opts 与地址都不丢', () => {
  const src = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-logo="" group-title="赛事",A',
    `#EXTVLCOPT:http-referrer=${REF}`,
    'https://cdn.example/a.m3u8',
  ].join('\n')
  const [first] = parsePlaylistContent(src)
  const regenerated = generateM3u8([{
    name: first.group,
    channels: [{ tvgId: first.name, tvgName: first.name, logo: first.logo, name: first.name, url: first.url, opts: first.opts }],
  }])
  const [second] = parsePlaylistContent(regenerated)
  assert.equal(second.url, first.url)
  assert.deepEqual(second.opts, first.opts)
})

check('消毒：白名单外的键被丢弃（订阅是不可信输入）', () => {
  assert.deepEqual(sanitizeOpts(['http-referrer=http://a/', 'program=/bin/sh', 'demux=x']), ['http-referrer=http://a/'])
})

check('消毒：含换行的 opt 整条拒收，而不是剔掉换行后留用', () => {
  // 剔换行会把注入内容粘成一条语法合法、值却是垃圾的 Referer，播放器照发不误、
  // 结果静默播不了。整条丢弃才能让频道以「没有请求头」的确定状态失败。
  const out = renderOpts(['http-referrer=http://a/\n#EXTINF:-1 ,注入\nhttp://evil/x.m3u8'])
  assert.equal(out, '', out)
})

check('消毒：超长 opt 被拒收，不灌进每一行播放列表', () => {
  assert.deepEqual(sanitizeOpts([`http-user-agent=${'x'.repeat(2000)}`]), [])
})

check('消毒：缺值、缺等号、重复项都被清掉', () => {
  assert.deepEqual(sanitizeOpts(['http-referrer=', 'http-referrer', '=x', 'http-referrer=http://a/', 'http-referrer=http://a/']),
    ['http-referrer=http://a/'])
})

check('txt：只带 network-caching 的频道必须保留（回归：曾被误判成依赖请求头）', () => {
  // network-caching 是播放器缓冲毫秒数，不是请求头，缺了它频道照播不误。
  // 公开 IPTV 源里 #EXTVLCOPT:network-caching=1000 是极常见写法，把它算成
  // 「依赖请求头」会让一大批本来好好的频道从 txt 订阅里凭空消失。
  const out = generateTxt([{
    name: '央视',
    channels: [{ name: 'CCTV1', url: 'http://h/1.m3u8', opts: ['network-caching=1000'] }],
  }])
  assert.ok(out.includes('CCTV1,http://h/1.m3u8'), out)
})

check('needsOpts：只认请求头类的键，播放器提示不算', () => {
  assert.equal(needsOpts({ opts: ['network-caching=1000'] }), false, 'network-caching 不是请求头')
  assert.equal(needsOpts({ opts: ['http-referrer=http://a/'] }), true)
  assert.equal(needsOpts({ opts: ['http-user-agent=x'] }), true)
  assert.equal(needsOpts({ opts: ['http-origin=http://a/'] }), true)
  assert.equal(needsOpts({ opts: ['network-caching=1000', 'http-referrer=http://a/'] }), true, '混合时按请求头算')
})

check('渲染侧不受影响：network-caching 照常写进 m3u', () => {
  assert.equal(renderOpts(['network-caching=1000']), '#EXTVLCOPT:network-caching=1000\n')
})

check('txt：依赖 opts 的频道整条跳过，普通频道照常输出', () => {
  const out = generateTxt([{
    name: '赛事',
    channels: [
      { name: '带头的', url: 'http://h/a.m3u8', opts: [`http-referrer=${REF}`] },
      { name: '普通的', url: 'http://h/b.m3u8' },
    ],
  }])
  assert.ok(!out.includes('带头的'), 'txt 放不下请求头，写进去必定 403')
  assert.ok(out.includes('普通的,http://h/b.m3u8'))
})

check('txt：整组都依赖 opts 时不留空分组头，其余分组照常', () => {
  const out = generateTxt([
    { name: '全带头', channels: [{ name: 'A', url: 'http://h/a.m3u8', opts: ['http-user-agent=x'] }] },
    { name: '空组', channels: [] },
    { name: '普通', channels: [{ name: 'B', url: 'http://h/b.m3u8' }] },
  ])
  assert.equal(out, '普通,#genre#\nB,http://h/b.m3u8\n')
})

check('needsOpts：只认清洗后仍有效的 opts', () => {
  assert.equal(needsOpts({ url: 'x' }), false)
  assert.equal(needsOpts({ opts: [] }), false)
  assert.equal(needsOpts({ opts: ['program=/bin/sh'] }), false, '被消毒掉的不算依赖请求头')
  assert.equal(needsOpts({ opts: [`http-referrer=${REF}`] }), true)
})

console.log(`\n全部通过：${passed}/17 ✅`)
