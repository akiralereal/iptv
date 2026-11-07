#!/usr/bin/env node
/**
 * 宁夏模块离线测试：三套固定直链归入「宁夏」，地址限定在两个官方域名；每轮按本机出口
 * 选放行的域名，频道身份始终钉在 hls.nxhhy.cn 的地址上（issue #233）。
 *
 * 运行： node scripts/test-ningxia.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import ningxia from '../extractors/ningxia/index.js'
import {
  CHANNELS, DEFAULT_MEDIA_HOST, MEDIA_HOSTS, buildChannels, officialHlsUrl, pickMediaHost, probeHost,
} from '../extractors/ningxia/api.js'
import { getModule, resolverFor } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

const OLD = 'hls.nxhhy.cn'
const NEW = 'hls.ningxiahuangheyun.com'

/** 按域名给出 'pass' | 'blocked' | 'error' | 其他状态码，模拟腾讯云 WAF 按出口放行。 */
function fakeCdn(verdicts, seen = []) {
  return async (url, options = {}) => {
    seen.push({ url, options })
    const { hostname } = new URL(url)
    const verdict = verdicts[hostname]
    if (verdict === 'error') throw new Error('connect ETIMEDOUT')
    if (verdict === 'pass') {
      return new Response(null, { status: 302, headers: { location: '/live/nxws1M/index.m3u8?session=abc' } })
    }
    if (verdict === 'blocked') return new Response('<title>WAF拦截页面</title>', { status: 403 })
    return new Response('', { status: Number(verdict) || 500 })
  }
}

const urlsOf = channels => channels.map(channel => channel.url)

console.log('宁夏模块测试')

check('模块注册为免账号、归入宁夏的直链模块，挂着官方节目单', () => {
  assert.equal(getModule('ningxia'), ningxia)
  assert.equal(ningxia.name, '宁夏')
  assert.equal(ningxia.outputGroupName, '宁夏')
  assert.equal(ningxia.capabilities.resolve, false)
  assert.equal(ningxia.capabilities.epg, true)
  assert.equal(ningxia.capabilities.catchup, false)
  assert.equal(ningxia.channelHlsMode, undefined)
  // 2：加了按出口选域名与 identityUrl，升级后启动时要立刻重抓
  assert.equal(ningxia.catalogVersion, 2)
  assert.equal(ningxia.defaultRefreshMinutes, 360)
  assert.equal(ningxia.refreshConfigurable, false)
  assert.deepEqual(ningxia.configSchema, [])
  assert.equal(typeof ningxia.epg.programmes, 'function')
  assert.equal(resolverFor('ningxia-nxws'), null)
  assert.deepEqual(MEDIA_HOSTS, [OLD, NEW])
  assert.equal(DEFAULT_MEDIA_HOST, OLD)
})

await checkAsync('只有新域名放行（#233 报告人那种网络）：三台都换到新域名，身份仍是旧地址', async () => {
  const seen = []
  const { groups, meta } = await ningxia.fetch({}, { fetchImpl: fakeCdn({ [OLD]: 'blocked', [NEW]: 'pass' }, seen) })
  assert.equal(groups.length, 1)
  assert.equal(groups[0].name, '宁夏')
  assert.deepEqual(groups[0].dataList, [
    { name: '宁夏卫视', url: `https://${NEW}/live/nxws1M.m3u8`, identityUrl: `https://${OLD}/live/nxws1M.m3u8`, groupTitle: '宁夏', opts: ['network-caching=3000'], catchup: 'none' },
    { name: '宁夏公共', url: `https://${NEW}/live/nxgg1M.m3u8`, identityUrl: `https://${OLD}/live/nxgg1M.m3u8`, groupTitle: '宁夏', opts: ['network-caching=3000'], catchup: 'none' },
    { name: '宁夏文旅', url: `https://${NEW}/live/nxwl1M.m3u8`, identityUrl: `https://${OLD}/live/nxwl1M.m3u8`, groupTitle: '宁夏', opts: ['network-caching=3000'], catchup: 'none' },
  ])
  assert.deepEqual(meta, { skipped: [], warnings: [] })
  assert.deepEqual(CHANNELS.map(channel => channel.key), ['nxws', 'nxgg', 'nxwl'])
  // 每个域名只探一次宁夏卫视入口，不跟随跳转、带浏览器 UA
  assert.deepEqual(seen.map(row => row.url).sort(), [`https://${NEW}/live/nxws1M.m3u8`, `https://${OLD}/live/nxws1M.m3u8`])
  assert.ok(seen.every(row => row.options.redirect === 'manual' && /Mozilla/.test(row.options.headers['User-Agent'])))
})

await checkAsync('都放行、只放行旧域名、都被 WAF 拦：用官方在用的旧域名', async () => {
  for (const verdicts of [
    { [OLD]: 'pass', [NEW]: 'pass' },
    { [OLD]: 'pass', [NEW]: 'blocked' },
    { [OLD]: 'blocked', [NEW]: 'blocked' },
  ]) {
    const { groups } = await ningxia.fetch({}, { fetchImpl: fakeCdn(verdicts) })
    assert.deepEqual(urlsOf(groups[0].dataList), CHANNELS.map(c => `https://${OLD}/live/${c.stream}`), JSON.stringify(verdicts))
  }
})

await checkAsync('探测说不准（超时 / 断网）时沿用上一轮选的域名；都被明确拦下才回默认', async () => {
  assert.deepEqual(await pickMediaHost({ fetchImpl: fakeCdn({ [OLD]: 'blocked', [NEW]: 'error' }), previous: NEW }),
    { host: NEW, results: { [OLD]: 'blocked', [NEW]: 'error' } })
  assert.equal((await pickMediaHost({ fetchImpl: fakeCdn({ [OLD]: 'error', [NEW]: 'error' }), previous: NEW })).host, NEW)
  assert.equal((await pickMediaHost({ fetchImpl: fakeCdn({ [OLD]: 'error', [NEW]: 'error' }) })).host, OLD)
  assert.equal((await pickMediaHost({ fetchImpl: fakeCdn({ [OLD]: 'blocked', [NEW]: 'blocked' }), previous: NEW })).host, OLD)
  assert.equal((await pickMediaHost({ fetchImpl: fakeCdn({ [OLD]: 'error', [NEW]: 'error' }), previous: 'evil.example' })).host, OLD)

  // 模块自己记着上一轮：先选到新域名，下一轮新域名超时、旧域名仍被拦，就别换回去
  await ningxia.fetch({}, { fetchImpl: fakeCdn({ [OLD]: 'blocked', [NEW]: 'pass' }) })
  const { groups } = await ningxia.fetch({}, { fetchImpl: fakeCdn({ [OLD]: 'blocked', [NEW]: 'error' }) })
  assert.ok(urlsOf(groups[0].dataList).every(url => url.startsWith(`https://${NEW}/`)))
  await ningxia.fetch({}, { fetchImpl: fakeCdn({ [OLD]: 'pass', [NEW]: 'pass' }) })
})

await checkAsync('探测只认跳到同域名直播路径下的 302', async () => {
  assert.equal(await probeHost(OLD, { fetchImpl: fakeCdn({ [OLD]: 'pass' }) }), 'pass')
  assert.equal(await probeHost(OLD, { fetchImpl: fakeCdn({ [OLD]: 'blocked' }) }), 'blocked')
  assert.equal(await probeHost(OLD, { fetchImpl: fakeCdn({ [OLD]: 'error' }) }), 'error')
  assert.equal(await probeHost(OLD, { fetchImpl: fakeCdn({ [OLD]: 200 }) }), 'error')
  assert.equal(await probeHost(OLD, { fetchImpl: fakeCdn({ [OLD]: 502 }) }), 'error')
  const elsewhere = async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/live/x.m3u8' } })
  assert.equal(await probeHost(OLD, { fetchImpl: elsewhere }), 'error')
  const otherPath = async () => new Response(null, { status: 302, headers: { location: '/login' } })
  assert.equal(await probeHost(OLD, { fetchImpl: otherPath }), 'error')
  const hanging = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
  assert.equal(await probeHost(NEW, { fetchImpl: hanging, timeoutMs: 20 }), 'error')
  await assert.rejects(() => probeHost('evil.example', { fetchImpl: fakeCdn({}) }), /非官方直播地址/)
})

check('换到新域名后频道 ID 不变，隐藏和改名设置照样生效', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nx-identity-'))
  try {
    const channels = buildChannels(NEW)
    const text = '#EXTM3U\n' + channels.map(c => `#EXTINF:-1 tvg-name="${c.name}" identity-url="${encodeURIComponent(c.identityUrl)}" group-title="宁夏",${c.name}\n${c.url}\n`).join('')
    writeFileSync(join(dir, 'interface.txt'), text)
    const script = `
      import assert from 'node:assert/strict';
      import { parseInterfaceTxt, buildChannelId, applyConfig } from './utils/playlistConfig.js';
      const channels = ${JSON.stringify(channels)};
      const groups = parseInterfaceTxt();
      for (const c of channels) {
        // 改动前播放列表里写的就是旧域名直链、没有 identity-url：ID 由旧地址算出
        const oldId = buildChannelId({groupName:'宁夏',channelName:c.name,tvgName:c.name,url:c.identityUrl});
        const entry = groups[0].channels.find(x=>x.name===c.name);
        assert.equal(entry.id, oldId);
        assert.equal(entry.url, c.url);
        assert.ok(entry.url.startsWith('https://${NEW}/live/'));
        const key = '宁夏::' + oldId;
        const hidden = applyConfig(groups,{hiddenChannels:[key]});
        assert.ok(!hidden.flatMap(g=>g.channels).some(x=>x.id===oldId));
        const renamed = applyConfig(groups,{channelRenameMap:{[key]:'自定义名称'}});
        assert.ok(renamed.flatMap(g=>g.channels).some(x=>x.id===oldId&&x.name==='自定义名称'));
      }
    `
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: new URL('..', import.meta.url), env: { ...process.env, mdataDir: dir }, stdio: 'pipe',
    })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

check('频道表只放行两个官方域名下的直播入口', () => {
  assert.equal(officialHlsUrl('nxws1M.m3u8'), `https://${OLD}/live/nxws1M.m3u8`)
  assert.equal(officialHlsUrl('nxws1M.m3u8', NEW), `https://${NEW}/live/nxws1M.m3u8`)
  assert.throws(() => officialHlsUrl('nxws1M.m3u8', 'evil.example'))
  assert.throws(() => officialHlsUrl('nxws1M.m3u8', 'web.ningxiahuangheyun.com'))
  assert.throws(() => officialHlsUrl('../record/live/nxws.m3u8'))
  assert.throws(() => officialHlsUrl('nxws1M.m3u8?session=x'))
  assert.throws(() => officialHlsUrl('https://evil.example/live/nxws1M.m3u8'))
  assert.throws(() => officialHlsUrl('nxws.ts'))
})

console.log(`\n全部通过：${passed} ✅`)
