#!/usr/bin/env node
import assert from 'node:assert/strict'
import dalian from '../extractors/dalian/index.js'
import {
  buildChannelGroups,
  normalizeChannels,
  officialStreamUrl,
  probeLive,
  requestMediaToken,
  ticketPlaintext,
} from '../extractors/dalian/api.js'
import { generateSm2KeyPair, sm2Decrypt, sm2Encrypt } from '../extractors/dalian/sm2.js'

let passed = 0
const check = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }
const fixedScalar = value => () => Buffer.from(value.toString(16).padStart(64, '0'), 'hex')

console.log('大连云模块测试')

await check('SM2 使用客户端所需 C1C2C3 格式并通过完整性校验', () => {
  const pair = generateSm2KeyPair({ randomBytesImpl: fixedScalar(1n) })
  const cipher = sm2Encrypt(pair.publicKey, '大连云', { randomBytesImpl: fixedScalar(2n) })
  assert.match(pair.publicKey, /^04[0-9a-f]{128}$/)
  assert.match(cipher, /^[0-9a-f]+$/)
  assert.equal(sm2Decrypt(pair.privateKey, cipher).toString('utf8'), '大连云')
  assert.throws(() => sm2Decrypt(pair.privateKey, `${cipher.slice(0, -1)}0`), /integrity check/)
})

await check('匿名媒体令牌交换加密四个参数并解密服务端响应', async () => {
  const now = 1_700_000_000_000
  const server = generateSm2KeyPair({ randomBytesImpl: fixedScalar(3n) })
  const fetchImpl = async rawUrl => {
    const url = new URL(rawUrl)
    assert.equal(url.origin, 'https://wan-dlrm.dlrm.cn')
    assert.equal(url.pathname, '/app/security/token')
    const plain = Object.fromEntries(['type', 'key', 'secret', 'publicKey'].map(key => [
      key, sm2Decrypt(server.privateKey, url.searchParams.get(key)).toString('utf8'),
    ]))
    assert.equal(plain.type, 'app')
    assert.equal(plain.key, 'mediax-dev-app')
    assert.equal(plain.secret, '367bde41-4eae-4c59-b151-47fc1ce83153')
    assert.match(plain.publicKey, /^04[0-9a-f]{128}$/)
    const data = sm2Encrypt(plain.publicKey, JSON.stringify({
      type: 'app', token: 'app.test.123', timeout: now + 300_000, deltime: now + 600_000,
    }), { randomBytesImpl: fixedScalar(4n) })
    return { ok: true, status: 200, url: url.href, json: async () => ({ status: 0, data: `04${data}`, message: '操作成功' }) }
  }
  const auth = await requestMediaToken({
    now, fetchImpl, serverPublicKey: server.publicKey, randomBytesImpl: fixedScalar(2n), timeoutMs: 1000,
  })
  assert.equal(auth.token, 'app.test.123')
  assert.equal(auth.timeout, now + 300_000)
})

await check('票据时间与当前客户端一致向前校正三小时', () => {
  assert.deepEqual(JSON.parse(ticketPlaintext('app.test', 1_700_000_000_000)), {
    token: 'app.test', timestamp: 1_700_010_800_000, secret: '367bde41-4eae-4c59-b151-47fc1ce83153',
  })
})

await check('只接受官方 CDN、固定 UUID HLS 路径和未过期腾讯签名', () => {
  const now = 1_700_000_000_000
  const good = 'https://livepull.dlrm.cn/dlrm/2e80d3a1-b700-48de-8186-5f704308709f.m3u8?txSecret=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&txTime=8FA8000E'
  assert.equal(officialStreamUrl(good, now), good)
  assert.equal(officialStreamUrl(good.replace('livepull.dlrm.cn', 'evil.example'), now), '')
  assert.equal(officialStreamUrl(`${good}&redirect=https://evil.example`, now), '')
  assert.equal(officialStreamUrl(good.replace('8FA8000E', '00000001'), now), '')
})

await check('目录固定过滤测试、研发、购物、改名及非官方地址', () => {
  const base = id => `https://livepull.dlrm.cn/dlrm/00000000-0000-0000-0000-${String(id).padStart(12, '0')}.m3u8?txSecret=${'a'.repeat(64)}&txTime=8FA8000E`
  const payload = { status: 0, data: { channels: [
    { id: 9, siteID: 1, type: 1, name: '文体频道', liveUrl: base(9), icon: 'https://nginx-dlrm.dlrm.cn/dlrm/site1/resource/tv/dlrm/logo.jpg' },
    { id: 7, siteID: 1, type: 1, name: '新闻综合频道', liveUrl: base(7) },
    { id: 8, siteID: 1, type: 1, name: '生活购物频道', liveUrl: base(8) },
    { id: 10, siteID: 1, type: 1, name: '测试电视频道', liveUrl: base(10) },
    { id: 19, siteID: 1, type: 1, name: '研发推流频道', liveUrl: base(19) },
    { id: 7, siteID: 1, type: 1, name: '新闻综合频道', liveUrl: base(7).replace('livepull.dlrm.cn', 'third.example') },
  ] } }
  assert.deepEqual(normalizeChannels(payload, 1_700_000_000_000).map(row => [row.id, row.name]), [
    [7, '大连新闻综合'], [9, '大连文体'],
  ])
})

await check('HLS 探测要求真实媒体分片且分片仍在官方域名', async () => {
  const row = { url: `https://livepull.dlrm.cn/dlrm/${'1'.repeat(8)}-${'1'.repeat(4)}-${'1'.repeat(4)}-${'1'.repeat(4)}-${'1'.repeat(12)}.m3u8?txSecret=${'a'.repeat(64)}&txTime=8FA8000E` }
  const goodFetch = async url => ({
    ok: true, status: 200, url: String(url),
    text: async () => '#EXTM3U\n#EXTINF:2.4,\n11111111-1111-1111-1111-111111111111-123.ts?txspiseq=1\n',
  })
  assert.equal(await probeLive(row, { fetchImpl: goodFetch, timeoutMs: 1000 }), true)
  const badFetch = async url => ({
    ok: true, status: 200, url: String(url),
    text: async () => '#EXTM3U\n#EXTINF:2.4,\nhttps://evil.example/segment.ts\n',
  })
  await assert.rejects(() => probeLive(row, { fetchImpl: badFetch, timeoutMs: 1000 }), /正在产出/)
})

await check('大连频道追加到辽宁频道并固定走完整 HLS 代理', () => {
  const groups = buildChannelGroups([
    { id: 7, name: '大连新闻综合', logo: '', url: 'x' },
    { id: 8, name: '大连生活', logo: '', url: 'y' },
  ])
  assert.deepEqual(groups.map(group => group.name), ['辽宁'])
  assert.deepEqual(groups[0].dataList.map(channel => channel.deferredRef), ['dalian-7', 'dalian-8'])
  assert.ok(groups[0].dataList.every(channel => channel.proxyHls === true))
})

await check('模块不暴露配置且引用范围拒绝路径注入与内部频道', () => {
  assert.deepEqual(dalian.configSchema, [])
  assert.equal(dalian.claimsRef('dalian-7'), true)
  assert.equal(dalian.claimsRef('dalian-10'), false)
  assert.equal(dalian.claimsRef('dalian-../../secret'), false)
})

console.log(`\n${passed} 项测试全部通过`)
