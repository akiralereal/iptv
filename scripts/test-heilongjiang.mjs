#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import heilongjiang from '../extractors/heilongjiang/index.js'
import {
  CHANNELS,
  HLJTV_MEDIA_ORIGIN,
  buildChannels,
  officialHlsUrl,
  refOf, mediaUrl, resolveChannel,
} from '../extractors/heilongjiang/api.js'
import { MEDIA_HOST, createAddressResolver } from '../extractors/heilongjiang/transport.js'
import { getModule, resolverFor } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('黑龙江广电模块测试')

check('默认服务器转发，保留播放器直连选项；旧目录版本自动更新', () => {
  assert.equal(getModule('heilongjiang'), heilongjiang)
  assert.equal(heilongjiang.name, '黑龙江')
  assert.equal(heilongjiang.outputGroupName, '黑龙江')
  assert.equal(heilongjiang.capabilities.resolve, true)
  assert.equal(heilongjiang.catalogVersion, 3)
  assert.equal(heilongjiang.configSchema[0].default, 'proxy')
  assert.equal(heilongjiang.channelHlsModeForConfig({}), 'proxy')
  assert.equal(heilongjiang.channelHlsModeForConfig({ networkMode: 'direct' }), undefined)
  assert.equal(resolverFor(refOf(CHANNELS[0])), heilongjiang)
  assert.equal(resolverFor('hljws_own'), null)
  assert.equal(heilongjiang.claimsRef('heilongjiang-unknown'), false)
})

await checkAsync('七套默认使用本机引用；台名、台标及无回看约定保留', async () => {
  assert.deepEqual(CHANNELS.map(channel => channel.name), [
    '黑龙江卫视', '黑龙江都市', '黑龙江新闻法治', '黑龙江文体',
    '黑龙江少儿', '黑龙江影视', '黑龙江农业科教',
  ])
  const channels = buildChannels()
  assert.equal(channels.length, 7)
  assert.ok(channels.every(channel => channel.url === undefined && channel.proxyHls === true))
  assert.ok(channels.every(channel => heilongjiang.claimsRef(channel.deferredRef)))
  // 七套都给极光新闻 App 下发的官方频道卡，不留空（LOGO.md 第 4 条）；实验台的研究占位图不进订阅
  assert.ok(channels.every(channel => channel.groupTitle === '黑龙江'))
  assert.ok(channels.every(channel => /^https:\/\/imgcdn\.hljtv\.com\/newscontent-[0-9a-f-]+\.jpeg$/.test(channel.logo)))
  assert.equal(new Set(channels.map(channel => channel.logo)).size, 7, '七张台标必须互不相同')
  assert.ok(channels.every(channel => channel.catchup === 'none'))
  assert.equal(new Set(channels.map(channel => channel.deferredRef)).size, 7)
  assert.deepEqual(await heilongjiang.fetch(), {
    groups: [{ name: '黑龙江', dataList: channels }],
    meta: { skipped: [], warnings: [] },
  })
})

await checkAsync('直连模式仍输出原官方地址，不带代理标记', async () => {
  const config = { networkMode: 'direct' }
  const channels = (await heilongjiang.fetch(config)).groups[0].dataList
  assert.deepEqual(channels, buildChannels(config))
  assert.ok(channels.every(channel => channel.url.startsWith(`${HLJTV_MEDIA_ORIGIN}/live/`)
    && !channel.proxyHls && !channel.deferredRef))
})

check('旧直链升级代理后，频道 ID、隐藏和改名设置仍生效；播放地址使用新入口', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hlj-identity-'))
  try {
    const channels = buildChannels()
    const text = '#EXTM3U\n' + channels.map(c => `#EXTINF:-1 tvg-name="${c.name}" identity-url="${encodeURIComponent(c.identityUrl)}" group-title="黑龙江",${c.name}\n\${replace}/proxy/${c.deferredRef}.m3u8\n`).join('')
    writeFileSync(join(dir, 'interface.txt'), text)
    const script = `
      import assert from 'node:assert/strict';
      import { parseInterfaceTxt, buildChannelId, applyConfig } from './utils/playlistConfig.js';
      const channels = ${JSON.stringify(channels)};
      const groups = parseInterfaceTxt();
      for (const c of channels) {
        const oldId = buildChannelId({groupName:'黑龙江',channelName:c.name,tvgName:c.name,url:c.identityUrl});
        const entry = groups[0].channels.find(x=>x.name===c.name);
        assert.equal(entry.id, oldId);
        assert.ok(entry.url.includes('/proxy/' + c.deferredRef));
        const key = '黑龙江::' + oldId;
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

check('媒体白名单只接受七路官方清单与分片，拒绝其它主机/路径/端口', () => {
  const root = `${HLJTV_MEDIA_ORIGIN}/live/`
  assert.equal(mediaUrl(`${root}hljws_own-2416482.ts`), `${root}hljws_own-2416482.ts`)
  for (const raw of ['http://idclive.hljtv.com:4430/live/hljws_own.m3u8',
    'https://idclive.hljtv.com/live/hljws_own.m3u8', `${root}unknown.m3u8`,
    `${root}hljws_own-1.ts?url=http://localhost/`, `${root}../private/hljws_own-1.ts`,
    `${root}hljws_own-1.ts#x`, 'https://user@idclive.hljtv.com:4430/live/hljws_own.m3u8',
    'https://idclive.hljtv.com.evil.test:4430/live/hljws_own.m3u8']) assert.throws(() => mediaUrl(raw))
})

const playlist = sequence => `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n#EXTINF:19.543, no desc\nhljws_own-${sequence}.ts\n`
const ref = refOf(CHANNELS[0])
await checkAsync('每次取实时清单并强制分片代理，不缓存过期直播窗口', async () => {
  let count = 0
  const fetchImpl = async (url, options) => {
    assert.equal(url, officialHlsUrl(CHANNELS[0].stream))
    assert.equal(options.redirect, 'manual')
    return new Response(playlist(2416482 + count++))
  }
  const one = await resolveChannel(ref, { fetchImpl })
  const two = await resolveChannel(ref, { fetchImpl })
  assert.equal(one.proxyHls, true)
  assert.ok(one.manifestText.includes('2416482'))
  assert.ok(two.manifestText.includes('2416483'))
  assert.equal(one.upstreamUrlTransform, mediaUrl)
})

await checkAsync('失败明确返回 502，不抛出、不退回已知失败的直链；未知频道 404', async () => {
  const responses = [() => new Response('unavailable', { status: 503 }), () => new Response('<html>error</html>'),
    () => new Response(playlist(1).replace('hljws_own-1.ts', 'https://evil.test/1.ts')),
    () => new Response(playlist(1) + '#EXT-X-KEY:METHOD=AES-128,URI="http://127.0.0.1/key"'),
    () => new Response(playlist(1) + '#'.repeat(256 * 1024)),
    () => { throw new Error('connect timeout') }]
  for (const fetchImpl of responses) {
    const result = await resolveChannel(ref, { fetchImpl })
    assert.equal(result.status, 502)
    assert.equal(result.url, '')
  }
  assert.equal((await resolveChannel('unknown')).status, 404)
})

const dnsReply = (address = '111.43.174.247', ttl = 60, name = MEDIA_HOST) => new Response(JSON.stringify({
  Status: 0, Answer: [{ type: 1, name, data: address, TTL: ttl }],
}))
await checkAsync('正常系统 DNS 直接使用，完全不查公共 DNS', async () => {
  const dns = createAddressResolver({ lookupImpl: async () => [{ address: '111.43.174.247' }],
    dnsFetch: () => { throw new Error('不该访问 DoH') } })
  assert.equal(await dns.address(), '111.43.174.247')
})

await checkAsync('fake-IP 自动改查真实地址；并发合并，按 DNS TTL 更新，不写死 IP', async () => {
  let time = 0, calls = 0
  const dns = createAddressResolver({ now: () => time,
    lookupImpl: async () => [{ address: '198.18.0.233' }],
    dnsFetch: async (url, options) => {
      assert.equal(new URL(url).searchParams.get('name'), MEDIA_HOST)
      assert.equal(options.redirect, 'error')
      return dnsReply(++calls === 1 ? '111.43.174.247' : '111.43.174.248', 2)
    } })
  assert.deepEqual(await Promise.all([dns.address(), dns.address(), dns.address()]), Array(3).fill('111.43.174.247'))
  assert.equal(calls, 1)
  time = 1999
  assert.equal(await dns.address(), '111.43.174.247')
  time = 2001
  assert.equal(await dns.address(), '111.43.174.248')
  assert.equal(calls, 2)
  dns.clear()
  await dns.address()
  assert.equal(calls, 3)
})

await checkAsync('DNS 失败后可恢复；公共 DNS 不能把连接导向内网或无关域名', async () => {
  const missing = async () => { throw new Error('ENOTFOUND') }
  let calls = 0
  const retry = createAddressResolver({ lookupImpl: missing, dnsFetch: async () =>
    ++calls === 1 ? new Response('', { status: 503 }) : dnsReply() })
  await assert.rejects(retry.address(), /HTTP 503/)
  assert.equal(await retry.address(), '111.43.174.247')
  for (const ip of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.169.254', '198.18.0.233', '::1']) {
    const dns = createAddressResolver({ lookupImpl: missing, dnsFetch: async () => dnsReply(ip) })
    await assert.rejects(dns.address(), /没有可用/)
  }
  const wrong = createAddressResolver({ lookupImpl: missing, dnsFetch: async () => dnsReply(undefined, 60, 'evil.test') })
  await assert.rejects(wrong.address(), /没有可用/)
})

console.log(`\n全部通过：${passed} ✅`)
