#!/usr/bin/env node
/**
 * 第三方订阅自带的回看声明贯通测试（issue #190）。
 *
 * 背景：订阅头声明的是咪咕回看模板 `?playbackbegin=…&playbackend=…`，没在行内声明的
 * 频道都继承它。第三方订阅自带的 `catchup-source="?playseek=…"` 和 `catchup-days` 以前
 * 在解析时被丢掉，频道只能继承咪咕模板：服务端忽略陌生参数照给直播，播放器不报错，
 * 表现为「直接订阅能回放、导入后只有咪咕能回放」。
 *
 * 不变量：
 *  - 解析：行内与订阅文件头的 catchup / catchup-days / catchup-source 都收下，
 *    逐字段行内优先；兼容 Kodi 的别名 catchup-type / tvg-rec / timeshift，SIPTV 的
 *    timeshift="N" 在没声明模式时按 shift 处理；完整地址模板没模式时补成 default；
 *  - 贯通：订阅 → 频道 → interface.txt → 回读 → 配置档重生成 → 对外输出，一路不丢；
 *    组内去重、「复制到分组」的副本也不丢；
 *  - 零回归：没有声明的频道不长出字段、输出逐字节不变、照旧继承订阅头；
 *    模块的 catchup="none"（issue #119）照旧；
 *  - 消毒：模式过白名单、天数只收正整数、模板含引号 / 换行 / 控制字符 / ${replace}
 *    或超长者整条拒收（订阅是不可信输入）。
 *
 * 运行： node scripts/test-catchup.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'iptv-catchup-test-'))
process.env.mdataDir = TMP
process.env.menableTvgNormalize = 'false'
process.env.menableDisplayNameUnify = 'false'

const { parsePlaylistContent, ExternalSourceManager } = await import('../utils/externalSources.js')
const { generateM3u8, parseInterfaceTxt } = await import('../utils/playlistConfig.js')
const { parseCatchupAttrs, resolveCatchup, sanitizeCatchup, renderCatchupAttrs } = await import('../utils/channelCatchup.js')
const { dedupeAllChannels } = await import('../utils/channelMerger.js')
const { interfaceStr } = await import('../utils/appUtils.js')

let passed = 0
const check = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('第三方订阅回看声明贯通测试 (issue #190)')

// issue #190 报告里的原始写法
const PLAYSEEK = '?playseek=${(b)yyyyMMddHHmmss}-${(e)yyyyMMddHHmmss}'
const MIGU_HEADER = '#EXTM3U x-tvg-url="${replace}/playback.xml" catchup="append" catchup-source="?playbackbegin=${(b)yyyyMMddHHmmss}&playbackend=${(e)yyyyMMddHHmmss}"'

try {
  // ---- 解析 ----
  await check('解析：行内 catchup / catchup-days / catchup-source 收进频道（issue #190 原始写法）', () => {
    const [ch] = parsePlaylistContent([
      '#EXTM3U',
      `#EXTINF:-1 tvg-id="CCTV1" tvg-logo="http://l/1.png" catchup="append" catchup-days="7" catchup-source="${PLAYSEEK}" group-title="央视",CCTV-1`,
      'http://example.com/live/cctv1.m3u8',
    ].join('\n'))
    assert.equal(ch.name, 'CCTV-1')
    assert.equal(ch.group, '央视')
    assert.equal(ch.catchup, 'append')
    assert.equal(ch.catchupDays, 7)
    assert.equal(ch.catchupSource, PLAYSEEK)
  })

  await check('解析：只在订阅文件头声明时，对其后所有频道生效', () => {
    const channels = parsePlaylistContent([
      `#EXTM3U x-tvg-url="http://e/epg.xml" catchup="append" catchup-days="3" catchup-source="${PLAYSEEK}"`,
      '#EXTINF:-1 group-title="卫视",A',
      'http://h/a.m3u8',
      '#EXTINF:-1 group-title="卫视",B',
      'http://h/b.m3u8',
    ].join('\n'))
    for (const ch of channels) {
      assert.deepEqual([ch.catchup, ch.catchupDays, ch.catchupSource], ['append', 3, PLAYSEEK], ch.name)
    }
  })

  await check('解析：逐字段行内优先，行内没写的沿用文件头', () => {
    const [ch] = parsePlaylistContent([
      `#EXTM3U catchup="append" catchup-days="3" catchup-source="${PLAYSEEK}"`,
      '#EXTINF:-1 catchup-days="7" group-title="卫视",A',
      'http://h/a.m3u8',
    ].join('\n'))
    assert.equal(ch.catchup, 'append')
    assert.equal(ch.catchupDays, 7)
    assert.equal(ch.catchupSource, PLAYSEEK)
  })

  await check('解析：行内 catchup="none" 关掉文件头的回看，天数和模板一并不带', () => {
    const [ch] = parsePlaylistContent([
      `#EXTM3U catchup="append" catchup-days="3" catchup-source="${PLAYSEEK}"`,
      '#EXTINF:-1 catchup="none" group-title="卫视",A',
      'http://h/a.m3u8',
    ].join('\n'))
    assert.deepEqual(sanitizeCatchup(ch), { catchup: 'none' })
  })

  await check('解析：拼接的多段列表，遇到新的 #EXTM3U 换用新的文件头', () => {
    const [a, b] = parsePlaylistContent([
      `#EXTM3U catchup="append" catchup-source="${PLAYSEEK}"`,
      '#EXTINF:-1 group-title="g",A',
      'http://h/a.m3u8',
      '#EXTM3U x-tvg-url="http://e/epg.xml"',
      '#EXTINF:-1 group-title="g",B',
      'http://h/b.m3u8',
    ].join('\n'))
    assert.equal(a.catchupSource, PLAYSEEK)
    assert.equal('catchupSource' in b, false, '第二段文件头没声明，不得沿用第一段的模板')
  })

  await check('解析：天数兼容别名 tvg-rec / timeshift，catchup-days 优先', () => {
    assert.equal(parseCatchupAttrs('#EXTINF:-1 tvg-rec="5",A').catchupDays, 5)
    assert.equal(parseCatchupAttrs('#EXTINF:-1 timeshift="4",A').catchupDays, 4)
    assert.equal(parseCatchupAttrs('#EXTINF:-1 catchup-days="7" tvg-rec="5",A').catchupDays, 7)
    assert.equal(parseCatchupAttrs('#EXTINF:-1 catchup-days="x" tvg-rec="5",A').catchupDays, 5, '主属性不合法时退到别名')
  })

  await check('解析：属性写在逗号之后（issue #84 写法）也能认出', () => {
    const [ch] = parsePlaylistContent('#EXTINF:-1 tvg-logo="x",catchup="append",catchup-days="2",A\nhttp://h/a.m3u8')
    assert.equal(ch.catchup, 'append')
    assert.equal(ch.catchupDays, 2)
  })

  await check('解析：x-catchup 之类的前缀属性不误中', () => {
    assert.deepEqual(parseCatchupAttrs('#EXTINF:-1 x-catchup="append" x-catchup-days="7",A'), {})
  })

  await check('零回归：没有任何回看声明的频道不长出字段（旧频道对象形状不变）', () => {
    const [ch] = parsePlaylistContent('#EXTM3U\n#EXTINF:-1 group-title="央视",CCTV1\nhttp://h/c.m3u8')
    for (const key of ['catchup', 'catchupDays', 'catchupSource']) assert.equal(key in ch, false, key)
  })

  // ---- 消毒 ----
  await check('消毒：模式过白名单并统一小写，白名单外的丢弃', () => {
    assert.deepEqual(sanitizeCatchup({ catchup: 'Append' }), { catchup: 'append' })
    assert.deepEqual(sanitizeCatchup({ catchup: 'evil' }), {})
    assert.deepEqual(sanitizeCatchup({ catchup: 'default', catchupSource: 'http://h/a.m3u8?start=${start}' }),
      { catchup: 'default', catchupSource: 'http://h/a.m3u8?start=${start}' })
  })

  await check('消毒：天数只收 1～365 的整数', () => {
    for (const bad of ['0', '-1', '7.5', 'abc', '366', '', ' ']) {
      assert.equal(sanitizeCatchup({ catchupDays: bad }).catchupDays, undefined, JSON.stringify(bad))
    }
    assert.equal(sanitizeCatchup({ catchupDays: ' 7 ' }).catchupDays, 7)
    assert.equal(sanitizeCatchup({ catchupDays: 30 }).catchupDays, 30)
  })

  await check('消毒：模板含引号 / 换行 / 控制字符者整条拒收，不撑破 EXTINF', () => {
    for (const bad of [
      '?a="b"',
      '?playseek=1\n#EXTINF:-1 ,注入\nhttp://evil/x.m3u8',
      '?playseek=1\r2',
      '?playseek=\u0000',
    ]) {
      assert.equal(sanitizeCatchup({ catchupSource: bad }).catchupSource, undefined, JSON.stringify(bad))
      assert.equal(renderCatchupAttrs({ catchup: 'append', catchupSource: bad }), ' catchup="append"')
    }
  })

  await check('消毒：模板含逗号拒收，免得回读 interface.txt 时把频道名撑坏', () => {
    // parseInterfaceTxt 按「第一个逗号」切频道名（source-ids 也因此用分号分隔）
    assert.equal(sanitizeCatchup({ catchupSource: '?start=${start},${end}' }).catchupSource, undefined)
    const [ch] = parsePlaylistContent('#EXTINF:-1 catchup="append" catchup-source="?a=1,2" group-title="g",A\nhttp://h/a.m3u8')
    assert.equal(ch.name, 'A')
    assert.equal(renderCatchupAttrs(ch), ' catchup="append"')
  })

  await check('消毒：模板里的 ${replace} 拒收，访问密码 / 令牌不外泄给第三方', () => {
    // 对外输出时 ${replace} 会换成本机地址连同访问前缀（/<pass> 或 /u/<token>）
    assert.equal(sanitizeCatchup({ catchupSource: 'http://evil/?h=${replace}' }).catchupSource, undefined)
  })

  await check('消毒：超长模板拒收', () => {
    assert.equal(sanitizeCatchup({ catchupSource: `?a=${'x'.repeat(2000)}` }).catchupSource, undefined)
  })

  await check('消毒：中间夹空白（含 U+2028 / NBSP / NEL）或以 = 结尾的模板拒收，首尾空白照常去掉', () => {
    // 写回后收尾引号紧跟其后：`…&group-title=` 拼成 `group-title="`，` source-ids=` 会被输出剥离正则吃掉
    for (const bad of ['?a=1 b', '?a=1\u2028b', '?a=1\u00a0b', '?a=1\u0085b', '?playseek=${(b)yyyyMMddHHmmss}&group-title=', '?k=${re source-ids=']) {
      assert.equal(sanitizeCatchup({ catchupSource: bad }).catchupSource, undefined, JSON.stringify(bad))
    }
    assert.equal(sanitizeCatchup({ catchupSource: ` ${PLAYSEEK} ` }).catchupSource, PLAYSEEK)
  })

  await check('resolveCatchup：文件头 none、行内开启时以行内为准', () => {
    assert.deepEqual(resolveCatchup({ catchup: 'none' }, '#EXTINF:-1 catchup="append" catchup-days="7",A'), { catchup: 'append', catchupDays: 7 })
    assert.deepEqual(resolveCatchup({ catchup: 'none' }, '#EXTINF:-1 catchup-days="7",A'), { catchup: 'none' })
  })

  await check('解析：模式兼容 Kodi 的别名 catchup-type，catchup 优先（文件头、行内都认）', () => {
    assert.equal(parseCatchupAttrs('#EXTINF:-1 catchup-type="flussonic",A').catchup, 'flussonic')
    assert.equal(parseCatchupAttrs('#EXTINF:-1 catchup="append" catchup-type="shift",A').catchup, 'append')
    const [ch] = parsePlaylistContent([
      `#EXTM3U catchup-type="append" catchup-source="${PLAYSEEK}"`,
      '#EXTINF:-1 group-title="g",A',
      'http://h/a.m3u8',
    ].join('\n'))
    assert.equal(ch.catchup, 'append')
    assert.equal(ch.catchupSource, PLAYSEEK)
  })

  await check('完整地址模板没有合法模式时补成 default，不让订阅头的 append 把它拼到直播地址后面', () => {
    const TVOD = 'http://cdn.example.com/tvod/a.m3u8?start={utc}&end={utcend}'
    for (const line of [
      `#EXTINF:-1 catchup-days="3" catchup-source="${TVOD}",A`,
      `#EXTINF:-1 catchup="flussonic-dash" catchup-source="${TVOD}",A`,   // 白名单外的模式
    ]) {
      const [ch] = parsePlaylistContent(`${line}\nhttp://cdn.example.com/live/a.m3u8`)
      assert.equal(ch.catchup, 'default', line)
      assert.ok(renderCatchupAttrs(ch).startsWith(' catchup="default"'), renderCatchupAttrs(ch))
    }
    // 查询串模板不补：它本来就是给 append 用的，交给文件头 / 订阅头的模式
    assert.equal(parseCatchupAttrs(`#EXTINF:-1 catchup-source="${PLAYSEEK}",A`).catchup, undefined)
  })

  await check('补模式只在合并后判断一次：文件头的完整地址被行内相对模板盖掉时不补 default，也不挡 timeshift', () => {
    const header = '#EXTM3U catchup-source="http://h/cu/{catchup-id}?s=${(b)yyyyMMddHHmmss}"'
    const parse = line => parsePlaylistContent(`${header}\n${line}\nhttp://h/live/1.m3u8`)[0]
    assert.deepEqual(sanitizeCatchup(parse(`#EXTINF:-1 catchup-source="${PLAYSEEK}",A`)), { catchupSource: PLAYSEEK })
    assert.equal(parse('#EXTINF:-1 timeshift="7",A').catchup, 'shift')
    assert.equal(parse('#EXTINF:-1 group-title="g",A').catchup, 'default', '只有文件头的完整地址模板时照常补 default')
  })

  await check('SIPTV 写法：只有 timeshift="N" 时按 shift 加 N 天；已有模式时只取天数；tvg-rec 只当天数', () => {
    const parse = (header, line) => parsePlaylistContent(`${header}\n${line}\nhttp://h/a.m3u8`)[0]
    assert.deepEqual(sanitizeCatchup(parse('#EXTM3U', '#EXTINF:-1 timeshift="7" group-title="g",A')), { catchup: 'shift', catchupDays: 7 })
    assert.deepEqual(sanitizeCatchup(parse(`#EXTM3U catchup="append" catchup-source="${PLAYSEEK}"`, '#EXTINF:-1 timeshift="7",A')),
      { catchup: 'append', catchupDays: 7, catchupSource: PLAYSEEK })
    assert.deepEqual(sanitizeCatchup(parse('#EXTM3U', '#EXTINF:-1 tvg-rec="3",A')), { catchupDays: 3 })
    assert.equal(renderCatchupAttrs(parse('#EXTM3U', '#EXTINF:-1 timeshift="7",A')), ' catchup="shift" catchup-days="7"')
  })

  // ---- 生成 ----
  await check('生成 m3u：回看属性写进 EXTINF，模板里的 ${(b)…} 原样保留', () => {
    const out = generateM3u8([{
      name: '央视',
      channels: [{ tvgId: 'A', tvgName: 'A', logo: '', name: 'A', url: 'http://h/a.m3u8', catchup: 'append', catchupDays: 7, catchupSource: PLAYSEEK }],
    }])
    assert.ok(out.includes(`#EXTINF:-1 tvg-id="A" tvg-name="A" tvg-logo="" catchup="append" catchup-days="7" catchup-source="${PLAYSEEK}" group-title="央视",A\n`), out)
  })

  await check('零回归：没有声明的频道，生成结果与旧格式逐字节一致', () => {
    const ch = { tvgId: 'CCTV1', tvgName: 'CCTV1', logo: 'http://h/l.png', name: 'CCTV1', url: 'http://h/c.m3u8' }
    const out = generateM3u8([{ name: '央视', channels: [ch] }])
    assert.ok(out.startsWith(`${MIGU_HEADER}\n`), '订阅头不变')
    assert.ok(out.endsWith('#EXTINF:-1 tvg-id="CCTV1" tvg-name="CCTV1" tvg-logo="http://h/l.png" group-title="央视",CCTV1\nhttp://h/c.m3u8\n'), out)
  })

  await check('零回归：模块的 catchup:"none"（issue #119）输出不变', () => {
    assert.equal(renderCatchupAttrs({ catchup: 'none' }), ' catchup="none"')
    assert.equal(renderCatchupAttrs({}), '')
    assert.equal(renderCatchupAttrs({ catchup: 'none', catchupDays: 7, catchupSource: PLAYSEEK }), ' catchup="none"')
  })

  await check('往返：解析 → 生成 → 再解析，回看声明不丢', () => {
    const [first] = parsePlaylistContent(`#EXTINF:-1 catchup="append" catchup-days="7" catchup-source="${PLAYSEEK}" group-title="g",A\nhttp://h/a.m3u8`)
    const regenerated = generateM3u8([{
      name: first.group,
      channels: [{ tvgId: first.name, tvgName: first.name, logo: first.logo, name: first.name, url: first.url, ...sanitizeCatchup(first) }],
    }])
    // 再解析时文件头是咪咕模板，行内必须盖过它
    const [second] = parsePlaylistContent(regenerated)
    assert.deepEqual(sanitizeCatchup(second), sanitizeCatchup(first))
  })

  // ---- 贯通：订阅 → 频道 → interface.txt → 对外输出 ----
  writeFileSync(join(TMP, 'external-sources.json'), JSON.stringify({
    enabled: true, includeInPlaylists: true, updateOnStartup: true,
    sources: [{
      id: 'cu000001', name: '回看订阅', mode: 'subscription', enabled: true,
      subscriptionContent: [
        '#EXTM3U x-tvg-url="http://e/epg.xml"',
        `#EXTINF:-1 catchup="append" catchup-days="7" catchup-source="${PLAYSEEK}" group-title="回看",回看台`,
        'http://h/catchup.m3u8',
        '#EXTINF:-1 group-title="回看",普通台',
        'http://h/plain.m3u8',
      ].join('\n'),
    }],
  }))
  const mgr = new ExternalSourceManager()
  const idx = mgr.sources.sources.findIndex(s => s.id === 'cu000001')

  await check('管理器：本地导入的订阅解析后，频道带上回看声明', async () => {
    const r = await mgr.updateSubscriptionSource(idx)
    assert.equal(r.success, true, r.message)
    const byName = Object.fromEntries(mgr.getValidChannels().flatMap(g => g.dataList).map(c => [c.name, c]))
    assert.deepEqual(sanitizeCatchup(byName['回看台']), { catchup: 'append', catchupDays: 7, catchupSource: PLAYSEEK })
    assert.deepEqual(sanitizeCatchup(byName['普通台']), {})
    assert.equal('catchupSource' in byName['普通台'], false)
  })

  await check('管理器：缓存里被篡改的模板在展开频道时再过一遍消毒', () => {
    mgr.sources.sources[idx].parsedChannels[0].catchupSource = '?a=1\n#EXTINF:-1 ,注入'
    const ch = mgr.getValidChannels().flatMap(g => g.dataList).find(c => c.name === '回看台')
    assert.equal('catchupSource' in ch, false)
    assert.equal(ch.catchup, 'append')
  })

  await check('「复制到分组」的直连副本带上回看声明，坏模板照样过消毒', () => {
    mgr.addSource({ name: '回看台副本', group: '副本组', m3u8Url: 'http://h/catchup.m3u8', enabled: true, autoRefresh: false,
      catchup: 'append', catchupDays: 7, catchupSource: PLAYSEEK })
    mgr.addSource({ name: '普通台副本', group: '副本组', m3u8Url: 'http://h/plain.m3u8', enabled: true, autoRefresh: false })
    mgr.addSource({ name: '坏副本', group: '副本组', m3u8Url: 'http://h/bad.m3u8', enabled: true, autoRefresh: false,
      catchup: 'append', catchupSource: '?a=1"x' })
    const byName = Object.fromEntries(mgr.getValidChannels().flatMap(g => g.dataList).map(c => [c.name, c]))
    assert.deepEqual(sanitizeCatchup(byName['回看台副本']), { catchup: 'append', catchupDays: 7, catchupSource: PLAYSEEK })
    assert.equal('catchup' in byName['普通台副本'], false, '没声明的副本不长出字段')
    assert.deepEqual(sanitizeCatchup(byName['坏副本']), { catchup: 'append' })
  })

  await check('「复制到分组」的副本改了地址后，原地址的回看声明不再输出', () => {
    const copy = mgr.sources.sources.find(s => s.name === '回看台副本')
    copy.m3u8Url = 'http://other.example/live.m3u8'
    const ch = mgr.getValidChannels().flatMap(g => g.dataList).find(c => c.name === '回看台副本')
    assert.deepEqual(sanitizeCatchup(ch), {})
    copy.m3u8Url = 'http://h/catchup.m3u8'
  })

  await check('组内去重：留下的那条没声明回看时，接过被去掉那条的声明；已有声明的不覆盖', () => {
    const groups = [{ name: 'G', dataList: [
      { name: 'X', url: 'http://op/x.m3u8', sourceId: 'ext:a' },
      { name: 'X', url: 'http://op/x.m3u8', sourceId: 'ext:b', catchup: 'append', catchupSource: PLAYSEEK },
      { name: 'Y', url: 'http://op/y.m3u8', sourceId: 'ext:a', catchup: 'none' },
      { name: 'Y', url: 'http://op/y.m3u8', sourceId: 'ext:b', catchup: 'append', catchupSource: PLAYSEEK },
    ] }]
    assert.equal(dedupeAllChannels(groups), 2)
    const [x, y] = groups[0].dataList
    assert.deepEqual(sanitizeCatchup(x), { catchup: 'append', catchupSource: PLAYSEEK })
    assert.deepEqual(x.sourceIds, ['ext:a', 'ext:b'])
    assert.deepEqual(sanitizeCatchup(y), { catchup: 'none' })
  })

  await check('组内去重：留下的那条只写了天数时，接过模式和模板、自己的天数优先', () => {
    const groups = [{ name: 'G', dataList: [
      { name: 'Z', url: 'http://op/z.m3u8', sourceId: 'ext:a', catchupDays: 7 },
      { name: 'Z', url: 'http://op/z.m3u8', sourceId: 'ext:b', catchup: 'append', catchupDays: 3, catchupSource: PLAYSEEK },
    ] }]
    dedupeAllChannels(groups)
    assert.deepEqual(sanitizeCatchup(groups[0].dataList[0]), { catchup: 'append', catchupDays: 7, catchupSource: PLAYSEEK })
  })

  await check('组内去重：第三方订阅撞上咪咕 / 内置频道的去重键时，不能改写它们的回看', () => {
    // 第三方订阅可以把地址写成 migu:<pid>，或照抄内置源的地址
    const groups = [{ name: 'G', dataList: [
      { name: 'CCTV1', pID: '608807420', deferredRef: '608807420', source: 'extractor', sourceId: 'migu' },
      { name: 'CCTV1', url: 'migu:608807420', sourceId: 'ext:x', catchup: 'none' },
      { name: 'CCTV2', playURL: 'http://bi/2.m3u8', source: 'built-in', sourceId: 'bi:x' },
      { name: 'CCTV2', url: 'http://bi/2.m3u8', sourceId: 'ext:x', catchup: 'default', catchupSource: 'http://evil.example/{utc}' },
    ] }]
    assert.equal(dedupeAllChannels(groups), 2)
    for (const ch of groups[0].dataList) assert.deepEqual(sanitizeCatchup(ch), {}, ch.name)
  })

  // interface.txt 按 updateData 的写盘格式（含内部属性 source-ids）
  const interfaceTxt = [
    MIGU_HEADER,
    `#EXTINF:-1 tvg-id="回看台" tvg-name="回看台" tvg-logo="" source-ids="ext:cu000001"${renderCatchupAttrs({ catchup: 'append', catchupDays: 7, catchupSource: PLAYSEEK })} group-title="回看",回看台`,
    'http://h/catchup.m3u8',
    '#EXTINF:-1 tvg-id="普通台" tvg-name="普通台" tvg-logo="" source-ids="ext:cu000001" group-title="回看",普通台',
    'http://h/plain.m3u8',
    `#EXTINF:-1 tvg-id="CCTV1" tvg-name="CCTV1" tvg-logo="" source-ids="ysp"${renderCatchupAttrs({ catchup: 'none' })} group-title="央视频",CCTV1`,
    '${replace}/relay/ysp-cctv1.m3u8',
    '#EXTINF:-1 tvg-id="CCTV2" tvg-name="CCTV2" tvg-logo="" source-ids="migu" group-title="央视",CCTV2',
    '${replace}/608807420',
    '',
  ].join('\n')
  writeFileSync(join(TMP, 'interface.txt'), interfaceTxt)

  await check('回读 interface.txt：回看声明、catchup="none" 都收回频道对象', () => {
    const byName = Object.fromEntries(parseInterfaceTxt().flatMap(g => g.channels).map(c => [c.name, c]))
    assert.deepEqual(sanitizeCatchup(byName['回看台']), { catchup: 'append', catchupDays: 7, catchupSource: PLAYSEEK })
    assert.equal(byName['回看台'].url, 'http://h/catchup.m3u8')
    assert.deepEqual(sanitizeCatchup(byName['普通台']), {})
    assert.deepEqual(sanitizeCatchup(byName['CCTV1']), { catchup: 'none' })
    assert.deepEqual(sanitizeCatchup(byName['CCTV2']), {})
  })

  // 默认档无配置 → 原样直出；renamed 档有配置 → parseInterfaceTxt → applyConfig → generateM3u8 重生成
  writeFileSync(join(TMP, 'my-playlist-config.renamed.json'), JSON.stringify({ groupRenameMap: { 回看: '第三方' } }))
  for (const profile of ['default', 'renamed']) {
    for (const relay of ['', '2']) {
      await check(`对外输出（${profile} 档${relay ? `，relay=${relay}` : ''}）：第三方模板盖过订阅头，其余频道不变`, () => {
        const out = String(interfaceStr('/m3u', { host: 'localhost:1905' }, '', '', profile, '/u/test-token', relay).content)
        const lines = out.split('\n')
        const extinf = name => lines.find(l => l.startsWith('#EXTINF:') && l.endsWith(`,${name}`))
        assert.ok(lines[0].includes('catchup-source="?playbackbegin=${(b)yyyyMMddHHmmss}&playbackend=${(e)yyyyMMddHHmmss}"'), '订阅头的咪咕模板不变，${(b)…} 不被 ${replace} 替换误伤')
        assert.ok(lines[0].includes('x-tvg-url="http://localhost:1905/u/test-token/playback.xml"'))
        assert.ok(extinf('回看台').includes(` catchup="append" catchup-days="7" catchup-source="${PLAYSEEK}" `), extinf('回看台'))
        assert.ok(!/catchup/.test(extinf('普通台')), '没声明的频道照旧继承订阅头')
        assert.ok(extinf('CCTV1').includes(' catchup="none" '))
        assert.ok(!/catchup/.test(extinf('CCTV2')))
        assert.ok(!out.includes('source-ids='), '内部属性照旧剥离')
        if (profile === 'renamed') assert.ok(extinf('回看台').includes('group-title="第三方"'), '确实走过配置档重生成')
        assert.ok(lines.includes('http://h/catchup.m3u8'), '第三方直链不改写')
      })
    }
  }

  // ---- 拼属性攻击（issue #190 审查）：模板借收尾引号冒充属性、借 source-ids 剥离凑出 ${replace} ----
  writeFileSync(join(TMP, 'interface.txt'), [
    MIGU_HEADER,
    // 按 updateData 写盘格式；假设旧版消毒放过了这两条，验证输出侧的剥离正则也不会被骗
    '#EXTINF:-1 tvg-id="Evil" tvg-name="Evil" tvg-logo="" source-ids="ext:ev000001" catchup="default" catchup-source="http://evil.example/c?k=${re source-ids=" group-title="place}",Evil',
    'http://evil.example/live.m3u8',
    '',
  ].join('\n'))
  for (const profile of ['default', 'renamed']) {
    await check(`拼属性攻击（${profile} 档）：输出剥离 source-ids 不跨属性，访问令牌不进第三方模板`, () => {
      const out = String(interfaceStr('/m3u', { host: 'localhost:1905' }, '', '', profile, '/u/SECRET-TOKEN', '').content)
      const evil = out.split('\n').find(l => l.endsWith(',Evil'))
      assert.ok(!/evil\.example[^\n]*SECRET-TOKEN/.test(out), evil)
    })
  }

  await check('拼属性攻击：订阅里的恶意模板在导入时就被拒收，分组照常', () => {
    const channels = parsePlaylistContent([
      '#EXTM3U',
      '#EXTINF:-1 catchup="default" catchup-source="http://evil.example/c?k=${re source-ids=" group-title="place}",Evil',
      'http://evil.example/live.m3u8',
      `#EXTINF:-1 group-title="央视" catchup="append" catchup-source="?playseek=\${(b)yyyyMMddHHmmss}&group-title=",CCTV-A`,
      'http://h/a.m3u8',
    ].join('\n'))
    for (const ch of channels) {
      assert.equal('catchupSource' in ch, false, ch.name)
      assert.equal(renderCatchupAttrs(ch).includes('catchup-source'), false, ch.name)
    }
    assert.equal(channels[1].group, '央视')
  })

  console.log(`\n全部 ${passed} 项通过`)
} finally {
  rmSync(TMP, { recursive: true, force: true })
}
