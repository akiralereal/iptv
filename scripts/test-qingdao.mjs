#!/usr/bin/env node
/**
 * 青岛广播电视台模块回归测试：ARCVIDEO 分片解密、固定频道表、刷新探测的降级、播放解析、注册表声明。
 * 全部离线；加密样本按 decrypt.js 里记录的官网封装格式逆向构造。
 *
 * 运行： node scripts/test-qingdao.mjs
 */
import assert from 'node:assert/strict'
import { createCipheriv, randomBytes } from 'node:crypto'

import { CHANNELS } from '../extractors/qingdao/channels.js'
import { ARCVIDEO_MAGIC, MASTER_KEY, arcvideoLayout, decryptArcvideo, isArcvideoProtected } from '../extractors/qingdao/decrypt.js'
import { LOGO_URL, buildChannelGroups, fetchChannels, manifestUrlOf, probeManifest, resolveChannel } from '../extractors/qingdao/api.js'
import { getModule, validateModule } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

const TS = 188

function aesCbcEncrypt(key, data) {
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16))
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(data), cipher.final()])
}

/** 构造 packets 个 TS 包的明文：每包同步字节 0x47，其余按位置生成，便于比对。 */
function plainTs(packets) {
  const plain = Buffer.alloc(packets * TS)
  for (let i = 0; i < plain.length; i++) plain[i] = i % TS === 0 ? 0x47 : (i * 31 + 7) & 0xff
  return plain
}

/**
 * 官网封装的逆变换：头 28 字节 + 密文，分片密钥（经固定串加密）插在密文第 (密文第 5 字节 + 1) × 188 处。
 * 明文够长时密钥一定落在密文中间，走解密的主分支。末尾再补一截与官网分片一样的无关尾巴。
 */
function encryptArcvideo(plain, segmentKey) {
  const cipherLength = Math.ceil(plain.length / 16) * 16
  const padded = Buffer.concat([plain, Buffer.alloc(cipherLength - plain.length)])
  const cipher = aesCbcEncrypt(segmentKey, padded)
  const header = Buffer.alloc(28)
  header.write(ARCVIDEO_MAGIC, 0, 'latin1')
  header[18] = 0x30
  header[19] = TS
  header.writeUInt32BE(plain.length, 20)
  const keyOffset = (cipher[4] + 1) * TS
  assert.ok(keyOffset < cipherLength, '样本要足够长，让密钥落在密文中间')
  return Buffer.concat([
    header,
    cipher.subarray(0, keyOffset),
    aesCbcEncrypt(MASTER_KEY, segmentKey),
    cipher.subarray(keyOffset),
    Buffer.alloc(132, 0xaa),
  ])
}

console.log('青岛广播电视台模块测试')

check('解密：按封装格式找到分片密钥，解出整数个 TS 包并丢掉对齐尾巴', () => {
  // 260 包 = 48880 字节；密钥偏移最大 256 × 188 = 48128，一定在密文里
  const plain = plainTs(260)
  const segmentKey = randomBytes(16)
  const encrypted = encryptArcvideo(plain, segmentKey)
  assert.ok(isArcvideoProtected(encrypted))
  const layout = arcvideoLayout(encrypted)
  assert.equal(layout.plainLength, plain.length)
  assert.equal(layout.keyOffset, (encrypted[32] + 1) * TS)
  const decrypted = decryptArcvideo(encrypted)
  assert.equal(decrypted.length, plain.length, '只取明文长度，不带 16 字节对齐的尾巴')
  assert.deepEqual(decrypted, plain)
  // 原 Buffer 不动
  assert.equal(encrypted.subarray(0, 18).toString('latin1'), ARCVIDEO_MAGIC)
})

check('解密：同一格式不同密钥、不同长度各自解得开', () => {
  for (const packets of [300, 2171, 3810]) {
    const plain = plainTs(packets)
    const decrypted = decryptArcvideo(encryptArcvideo(plain, randomBytes(16)))
    assert.deepEqual(decrypted, plain, `${packets} 包`)
  }
})

check('解密：不是封装的数据与残缺封装原样返回，不抛', () => {
  const plainTsBuffer = plainTs(3)
  assert.equal(decryptArcvideo(plainTsBuffer), plainTsBuffer)
  assert.equal(isArcvideoProtected(plainTsBuffer), false)
  const truncated = encryptArcvideo(plainTs(260), randomBytes(16)).subarray(0, 2000)
  assert.equal(decryptArcvideo(truncated), truncated)
  const badLength = encryptArcvideo(plainTs(260), randomBytes(16))
  badLength.writeUInt32BE(1001, 20) // 不是整数个 TS 包
  assert.equal(decryptArcvideo(badLength), badLength)
  assert.equal(decryptArcvideo('not a buffer'), 'not a buffer')
})

check('频道表：五路固定、全代理引用、台标与回看声明齐全', () => {
  const groups = buildChannelGroups()
  assert.deepEqual(groups.map(group => group.name), ['青岛'])
  assert.deepEqual(groups[0].dataList.map(channel => channel.name), ['青岛新闻综合', '青岛生活服务', '青岛影视', '青岛都市', '青岛教育'])
  assert.deepEqual(groups[0].dataList.map(channel => channel.deferredRef), CHANNELS.map(channel => channel.ref))
  for (const channel of groups[0].dataList) {
    assert.equal(channel.proxyHls, true)
    assert.equal(channel.logo, LOGO_URL)
    assert.equal(channel.catchup, 'none')
    assert.equal('url' in channel, false)
  }
  // 官网 QTV-5 页面指向 qtv6at；qtv5at 是台标待机画面，不在表里
  assert.equal(CHANNELS.find(channel => channel.rawName === 'QTV-5').stream, 'qtv6at')
  assert.ok(!CHANNELS.some(channel => channel.stream === 'qtv5at'))
  assert.equal(manifestUrlOf('qtv1at'), 'https://video10.qtv.com.cn/drm/qtv1at/manifest.m3u8')
})

const textResponse = (text, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => text })
const MANIFEST = '#EXTM3U\r\n#EXT-X-VERSION:3\r\n#EXT-X-TARGETDURATION:3\r\n#EXT-X-MEDIA-SEQUENCE:1791511931\r\n#EXTINF:3.000,1791557163.26\r\n1749523/1791511931.ts\r\n#EXTINF:3.000,1791557166.26\r\n1749523/1791511932.ts\r\n'

await checkAsync('刷新：逐路探官网清单；单路失败只记警告、频道照留，全部失败才抛', async () => {
  const urls = []
  const okAll = await fetchChannels({ fetchImpl: async (url, options) => {
    urls.push(String(url))
    assert.match(options.headers['User-Agent'], /Mozilla/)
    return textResponse(MANIFEST)
  } })
  assert.deepEqual(urls, CHANNELS.map(channel => manifestUrlOf(channel.stream)))
  assert.equal(okAll.groups[0].dataList.length, 5)
  assert.deepEqual(okAll.warnings, [])

  const partial = await fetchChannels({ fetchImpl: async url => (
    /qtv3at/.test(String(url)) ? textResponse('<html>404</html>', 404) : textResponse(MANIFEST)
  ) })
  assert.equal(partial.groups[0].dataList.length, 5, '官网抖动不该让台消失')
  assert.equal(partial.warnings.length, 1)
  assert.match(partial.warnings[0], /青岛影视.*HTTP 404/)

  await assert.rejects(
    fetchChannels({ fetchImpl: async () => { throw new Error('断网') } }),
    /全部取不到.*断网/,
  )
  await assert.rejects(probeManifest('qtv1at', { fetchImpl: async () => textResponse('#EXTM3U\n#EXT-X-ENDLIST\n') }), /没有分片/)
  await assert.rejects(probeManifest('qtv1at', { fetchImpl: async () => textResponse('<html>') }), /不是 HLS/)
})

await checkAsync('播放解析：固定官网地址 + 分片解密函数；未知引用回空地址，不抛', async () => {
  const resolved = await resolveChannel('qingdao-5')
  assert.equal(resolved.url, 'https://video10.qtv.com.cn/drm/qtv6at/manifest.m3u8')
  assert.equal(resolved.segmentTransform, decryptArcvideo)
  assert.equal((await resolveChannel('qingdao-9')).url, '')
  assert.equal((await resolveChannel('')).url, '')
  assert.equal((await resolveChannel('gxtv-gxws')).url, '')
})

await checkAsync('注册表：青岛模块声明与城市景观模块分开，只认自己的引用', async () => {
  const module = getModule('qingdao')
  assert.ok(module)
  validateModule(module)
  assert.equal(module.name, '青岛')
  assert.equal(module.outputGroupName, '山东')
  assert.deepEqual(module.capabilities, { cache: 'disk', resolve: true, epg: true, catchup: false })
  assert.equal(module.catalogVersion, 1)
  assert.equal(module.refreshConfigurable, false)
  assert.deepEqual(module.configSchema, [])
  assert.ok(module.epg, '官网节目单接口要挂上')
  assert.equal(module.claimsRef('qingdao-1'), true)
  assert.equal(module.claimsRef('qingdao-5'), true)
  assert.equal(module.claimsRef('qingdao-6'), false)
  assert.equal(module.claimsRef('qtv-1'), false)
  const result = await module.fetch({}, { fetchImpl: async () => textResponse(MANIFEST) })
  assert.deepEqual(result.groups.map(group => group.dataList.length), [5])
  assert.deepEqual(result.meta.warnings, [])
  // 城市景观仍是独立模块，分组名「青岛景观」不被电视频道的「山东」吞掉
  const scenic = getModule('qtv')
  assert.equal(scenic.name, '青岛景观')
  assert.equal(scenic.outputGroupName, '山东')
  assert.deepEqual(scenic.preserveGroupSuffixes, ['景观'])
})

console.log(`\n全部通过：${passed} ✅`)
