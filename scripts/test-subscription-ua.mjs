#!/usr/bin/env node
/**
 * 订阅源自定义 User-Agent（issue #170）。
 *
 * 背景：有些订阅要特定 UA 才肯返回列表，有些频道的 CDN 也按 UA 放行。
 * 订阅源设置里加了 userAgent（拉订阅用）和 playWithUserAgent（播放也带上）。
 *
 * 不变量：
 *  - 拉取：填了 UA 就用它拉订阅，留空/不合法回落默认 UA；
 *  - 播放：勾了「播放时也带上」才补 #EXTVLCOPT:http-user-agent；不勾则输出与改动前一致；
 *  - 订阅里频道自带的 UA 不被整源统一填的覆盖；rtp/udp 等非 HTTP 地址不补；
 *  - 消毒：含换行/控制字符的 UA 整条作废，不得撑开 M3U 指令，也不得让 node-fetch 抛错；
 *  - 失效检测按频道该带的 UA 去探，不再一律用浏览器 UA 误判失效。
 *
 * 运行： node scripts/test-subscription-ua.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'iptv-sub-ua-test-'))
process.env.mdataDir = TMP

const { ExternalSourceManager, fetchAndParseM3u } = await import('../utils/externalSources.js')
const { cleanUserAgent, withUserAgent, userAgentOf, needsOpts } = await import('../utils/channelOpts.js')
const { generateM3u8 } = await import('../utils/playlistConfig.js')
const { startProbe, getProbeStatus } = await import('../utils/sourceProbe.js')

const GATE_UA = 'GateUA/1.0 (test)'
const PLAYLIST = [
  '#EXTM3U',
  '#EXTINF:-1 group-title="测试",UA 台',
  'http://HOST/live/ua.m3u8',
  '#EXTINF:-1 group-title="测试",自带 UA 台',
  '#EXTVLCOPT:http-user-agent=Own/2.0',
  'http://HOST/live/own.m3u8',
  '#EXTINF:-1 group-title="测试",组播台',
  'rtp://239.0.0.1:5000',
].join('\n')

// 只认 GATE_UA 的小服务：订阅和频道都按 UA 放行，其余一律 403
const seenUa = []
const server = http.createServer((req, res) => {
  seenUa.push(req.headers['user-agent'])
  if (req.headers['user-agent'] !== GATE_UA) { res.writeHead(403); res.end('forbidden'); return }
  if (req.url === '/sub.m3u') {
    res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' })
    res.end(PLAYLIST.replaceAll('HOST', `127.0.0.1:${server.address().port}`))
    return
  }
  res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
  res.end('#EXTM3U\n')
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`

let passed = 0
const check = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('订阅源自定义 User-Agent 测试')

try {
  await check('消毒：去首尾空白；含换行/控制字符、超长者作废', () => {
    assert.equal(cleanUserAgent('  okhttp/3.15  '), 'okhttp/3.15')
    assert.equal(cleanUserAgent(''), '')
    assert.equal(cleanUserAgent(undefined), '')
    assert.equal(cleanUserAgent('a\n#EXTINF:-1,注入'), '')
    assert.equal(cleanUserAgent('a\u0000b'), '')
    assert.equal(cleanUserAgent('x'.repeat(2000)), '')
  })

  await check('补 UA：http(s) 补上，自带 UA 不覆盖，非 HTTP 不补，不改入参', () => {
    const own = ['http-user-agent=Own/2.0']
    assert.deepEqual(withUserAgent(undefined, GATE_UA, 'http://h/a.m3u8'), [`http-user-agent=${GATE_UA}`])
    assert.deepEqual(withUserAgent(['http-referrer=http://r/'], GATE_UA, 'https://h/a.m3u8'),
      ['http-referrer=http://r/', `http-user-agent=${GATE_UA}`])
    assert.equal(withUserAgent(own, GATE_UA, 'http://h/a.m3u8'), own)
    assert.deepEqual(own, ['http-user-agent=Own/2.0'])
    assert.equal(withUserAgent(undefined, GATE_UA, 'rtp://239.0.0.1:5000'), undefined)
    assert.equal(withUserAgent(undefined, '', 'http://h/a.m3u8'), undefined)
    assert.equal(withUserAgent(undefined, 'a\nb', 'http://h/a.m3u8'), undefined)
    assert.equal(userAgentOf(own), 'Own/2.0')
  })

  await check('拉取：默认 UA 被订阅方拒（403），填了 UA 就拉得到', async () => {
    await assert.rejects(fetchAndParseM3u(`${BASE}/sub.m3u`), /HTTP 403/)
    const channels = await fetchAndParseM3u(`${BASE}/sub.m3u`, { userAgent: `  ${GATE_UA} ` })
    assert.equal(channels.length, 3)
    assert.equal(seenUa.at(-1), GATE_UA)
  })

  await check('拉取：UA 含换行时回落默认 UA，而不是让请求抛 Invalid header', async () => {
    await assert.rejects(fetchAndParseM3u(`${BASE}/sub.m3u`, { userAgent: 'x\r\nX-Evil: 1' }), /HTTP 403/)
    assert.match(seenUa.at(-1), /^Mozilla\/5\.0/)
  })

  // ---- 走管理器：拉订阅 → 展开成频道 → 生成 m3u ----
  writeFileSync(join(TMP, 'external-sources.json'), JSON.stringify({
    enabled: true, includeInPlaylists: true, updateOnStartup: true,
    sources: [{
      id: 'ua000001', name: 'UA 订阅', mode: 'subscription', enabled: true,
      subscriptionUrl: `${BASE}/sub.m3u`, userAgent: GATE_UA, playWithUserAgent: false,
    }],
  }))
  const mgr = new ExternalSourceManager()
  const src = () => mgr.sources.sources[0]
  const byName = () => Object.fromEntries(mgr.getValidChannels().flatMap(g => g.dataList).map(c => [c.name, c]))

  await check('管理器：导入时用源里填的 UA 拉订阅', async () => {
    const r = await mgr.updateSubscriptionSource(0)
    assert.equal(r.success, true, r.message)
    assert.equal(src().parsedChannels.length, 3)
  })

  await check('不勾「播放时也带上」：频道不长出 opts，输出与改动前一致', () => {
    const ch = byName()
    assert.equal('opts' in ch['UA 台'], false)
    assert.deepEqual(ch['自带 UA 台'].opts, ['http-user-agent=Own/2.0'])
  })

  await check('勾上：http 频道补 UA、自带的不变、组播不补；改开关不必重新拉订阅', () => {
    src().playWithUserAgent = true
    const ch = byName()
    assert.deepEqual(ch['UA 台'].opts, [`http-user-agent=${GATE_UA}`])
    assert.deepEqual(ch['自带 UA 台'].opts, ['http-user-agent=Own/2.0'])
    assert.equal('opts' in ch['组播台'], false)
    assert.equal(needsOpts(ch['UA 台']), true)       // TXT 侧会跳过它
    assert.equal(needsOpts(ch['组播台']), false)     // 组播台仍留在 TXT 里
    // 解析结果本身不被污染：关掉开关就回到原样
    assert.equal('opts' in src().parsedChannels[0], false)
  })

  await check('生成 m3u：UA 行夹在 EXTINF 与地址之间', () => {
    const c = byName()['UA 台']
    const out = generateM3u8([{ name: '测试', channels: [{ tvgId: 'x', tvgName: 'x', logo: '', name: c.name, url: c.url, opts: c.opts }] }])
    const lines = out.trim().split('\n')
    assert.equal(lines[2], `#EXTVLCOPT:http-user-agent=${GATE_UA}`)
    assert.equal(lines[3], c.url)
  })

  await check('失效检测：按频道该带的 UA 去探，填了 UA 的源不再被误判失效', async () => {
    const url = `${BASE}/live/ua.m3u8`
    const r = startProbe(0, 'UA 订阅', [
      { name: '带 UA', url, userAgent: GATE_UA },
      { name: '不带 UA', url },
    ])
    assert.equal(r.success, true)
    let st
    for (let i = 0; i < 100; i++) {
      st = getProbeStatus().data
      if (st.state === 'done') break
      await new Promise(res => setTimeout(res, 50))
    }
    assert.equal(st.state, 'done')
    assert.equal(st.summary.alive, 1)
    assert.deepEqual(st.dead.map(d => d.name), ['不带 UA'])
  })

  console.log(`\n全部通过（${passed} 项）`)
} finally {
  server.close()
  rmSync(TMP, { recursive: true, force: true })
}
