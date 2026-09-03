#!/usr/bin/env node
/** Issue #114: exercise both subscription output paths against LunaTV's next-line parser. */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildChannels } from '../extractors/yangshipin/channels.js'
import { omitPlayerOnlyOpts } from '../utils/channelOpts.js'

const dir = mkdtempSync(join(tmpdir(), 'iptv-lunatv-'))
process.env.mdataDir = dir
process.env.menableTvgNormalize = 'false'
process.env.menableDisplayNameUnify = 'false'

// MoonTechLab/LunaTV and SzeMeng76/LunaTV src/lib/live.ts, checked 2026-09-03:
// only a non-comment line immediately after EXTINF is accepted as the channel URL.
function lunaChannels(content) {
  const lines = content.split('\n').map(line => line.trim()).filter(Boolean)
  return lines.flatMap((line, i) => line.startsWith('#EXTINF:')
    && lines[i + 1] && !lines[i + 1].startsWith('#')
    ? [{ name: line.match(/,([^,]*)$/)?.[1], url: lines[i + 1] }]
    : [])
}

try {
  const { generateM3u8 } = await import('../utils/playlistConfig.js')
  const { interfaceStr } = await import('../utils/appUtils.js')
  const groups = [{
    name: '央视频',
    channels: buildChannels().map(channel => ({
      name: channel.name, tvgName: channel.name, tvgId: channel.name, logo: '',
      url: `\${replace}/relay/${channel.deferredRef}.m3u8`,
      // Simulate the previous version's cached channels, before the next daily refresh.
      opts: ['network-caching=3000'],
    })),
  }, ...['虎牙', '斗鱼'].map((name, i) => ({
    name,
    channels: [{ name, tvgName: name, tvgId: name, logo: '',
      url: `\${replace}/relay/${i ? 'douyu-9999' : 'huya-660101'}.m3u8`,
      opts: ['network-caching=5000'] }],
  })), {
    name: 'B站',
    channels: [{ name: 'B站测试', tvgName: 'B站测试', tvgId: 'bili', logo: '',
      url: 'https://cdn.example/bili.m3u8?token=test',
      opts: ['http-referrer=https://live.bilibili.com/', 'http-user-agent=Mozilla/5.0',
        'http-origin=https://live.bilibili.com', 'network-caching=3000'] }],
  }, {
    name: '央视',
    channels: [{ name: '咪咕测试', tvgName: '咪咕测试', tvgId: 'migu', logo: '',
      url: '${replace}/608807420' }],
  }]
  const cached = generateM3u8(groups)
  assert.equal(lunaChannels(cached).length, 1, '旧输出只能导入无 opts 的对照频道')
  writeFileSync(join(dir, 'interface.txt'), cached)
  writeFileSync(join(dir, 'my-playlist-config.json'), JSON.stringify({ groupOrder: [] }))
  writeFileSync(join(dir, 'my-playlist-config.renamed.json'), JSON.stringify({
    groupRenameMap: { 央视频: '中央台' },
  }))
  const biliBlock = cached.slice(cached.indexOf('#EXTINF:-1 tvg-id="bili"'), cached.indexOf('#EXTINF:-1 tvg-id="migu"'))
  for (const profile of ['default', 'renamed']) {
    for (const path of ['/', '/m3u', '/interface.m3u', '/interface.txt']) {
      for (const relay of ['', '1', '2']) {
        const output = String(interfaceStr(path, { host: 'localhost:1905' }, '', '', profile, '/u/test-token', relay).content)
        const channels = lunaChannels(output)
        assert.equal(channels.filter(channel => channel.url.includes('/ysp-')).length, 63)
        assert.equal(channels.filter(channel => /\/(?:huya|douyu)-/.test(channel.url)).length, 2)
        assert.ok(channels.every(channel => channel.url.startsWith('http://localhost:1905/u/test-token/')))
        assert.ok(output.includes(biliBlock), '保留 B站完整请求头，不能为了导入而制造无法播放的直链')
        const expectedMigu = relay ? `${relay === '2' ? 'proxy' : 'relay'}/608807420.m3u8` : '608807420'
        assert.ok(output.includes(`/u/test-token/${expectedMigu}`))
        if (profile === 'renamed') assert.ok(output.includes('group-title="中央台"'), '确实走过配置档重生成')
      }
    }
  }
  assert.equal(readFileSync(join(dir, 'interface.txt'), 'utf8'), cached, '输出适配不能改写频道缓存')
  writeFileSync(join(dir, 'interfaceTXT.txt'), '央视频,#genre#\nCCTV1,${replace}/relay/ysp-cctv1.m3u8\n')
  assert.equal(String(interfaceStr('/txt', { host: 'localhost:1905' }, '', '', 'default', '').content),
    '央视频,#genre#\nCCTV1,http://localhost:1905/relay/ysp-cctv1.m3u8\n')
  writeFileSync(join(dir, 'playback.xml'), '<tv></tv>')
  assert.equal(String(interfaceStr('/playback.xml', {}, '', '').content), '<tv></tv>')

  // Preserve unknown/header options, line endings and adjacent channel metadata.
  const crlf = '#EXTM3U\r\n#EXTINF:-1,A\r\n#EXTVLCOPT:network-caching=3000\r\nhttp://a/1\r\n'
  assert.equal(omitPlayerOnlyOpts(crlf), crlf.replace('#EXTVLCOPT:network-caching=3000\r\n', ''))
  for (const opt of ['http-referrer=https://ref.example/', 'unknown=value', 'network-caching=']) {
    const input = `#EXTINF:-1,A\n#EXTVLCOPT:network-caching=1000\n#EXTVLCOPT:${opt}\nhttp://a/1\n`
    assert.equal(omitPlayerOnlyOpts(input), input)
  }
  assert.equal(omitPlayerOnlyOpts(omitPlayerOnlyOpts(cached)), omitPlayerOnlyOpts(cached))
  console.log('LunaTV 订阅回归通过：63 个央视频 + 虎牙/斗鱼、旧缓存、配置档、全部 M3U 入口、鉴权前缀与代理模式；B站请求头保留')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
