#!/usr/bin/env node
/**
 * 宁夏模块离线测试：三套固定直链归入「宁夏」，地址限定在官方域名；
 * 精选列表 IPTV.m3u 过渡期保留的同名三条，名字与地址必须和模块一字不差，才会被组内去重收掉、不出现两份。
 *
 * 运行： node scripts/test-ningxia.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import ningxia from '../extractors/ningxia/index.js'
import { CHANNELS, buildChannels, officialHlsUrl } from '../extractors/ningxia/api.js'
import { getModule, resolverFor } from '../extractors/registry.js'
import { dedupeAllChannels } from '../utils/channelMerger.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('宁夏模块测试')

check('模块注册为免账号、归入宁夏的直链模块，挂着官方节目单', () => {
  assert.equal(getModule('ningxia'), ningxia)
  assert.equal(ningxia.name, '宁夏')
  assert.equal(ningxia.outputGroupName, '宁夏')
  assert.equal(ningxia.capabilities.resolve, false)
  assert.equal(ningxia.capabilities.epg, true)
  assert.equal(ningxia.capabilities.catchup, false)
  assert.equal(ningxia.channelHlsMode, undefined)
  assert.equal(ningxia.catalogVersion, 1)
  assert.equal(ningxia.refreshConfigurable, false)
  assert.deepEqual(ningxia.configSchema, [])
  assert.equal(typeof ningxia.epg.programmes, 'function')
  assert.equal(resolverFor('ningxia-nxws'), null)
})

await checkAsync('输出三套固定直链，地址是官方入口', async () => {
  const { groups, meta } = await ningxia.fetch()
  assert.equal(groups.length, 1)
  assert.equal(groups[0].name, '宁夏')
  assert.deepEqual(groups[0].dataList, [
    { name: '宁夏卫视', url: 'https://hls.nxhhy.cn/live/nxws1M.m3u8', groupTitle: '宁夏', opts: ['network-caching=3000'], catchup: 'none' },
    { name: '宁夏公共', url: 'https://hls.nxhhy.cn/live/nxgg1M.m3u8', groupTitle: '宁夏', opts: ['network-caching=3000'], catchup: 'none' },
    { name: '宁夏文旅', url: 'https://hls.nxhhy.cn/live/nxwl1M.m3u8', groupTitle: '宁夏', opts: ['network-caching=3000'], catchup: 'none' },
  ])
  assert.deepEqual(meta, { skipped: [], warnings: [] })
  assert.deepEqual(CHANNELS.map(channel => channel.key), ['nxws', 'nxgg', 'nxwl'])
})

check('频道表只放行官方域名下的直播入口', () => {
  assert.throws(() => officialHlsUrl('../record/live/nxws.m3u8'))
  assert.throws(() => officialHlsUrl('nxws1M.m3u8?session=x'))
  assert.throws(() => officialHlsUrl('https://evil.example/live/nxws1M.m3u8'))
  assert.throws(() => officialHlsUrl('nxws.ts'))
})

check('精选列表过渡期保留的宁夏三条与模块名字、地址一致，组内去重后只剩模块那份', () => {
  const m3u = readFileSync(fileURLToPath(new URL('../IPTV.m3u', import.meta.url)), 'utf8')
  const block = m3u.split('# === BEGIN 宁夏官方直播 ===')[1]?.split('# === END 宁夏官方直播 ===')[0]
  if (!block) return // 已从精选列表删掉就不用再核对
  const listed = []
  const lines = block.split(/\r?\n/).map(line => line.trim())
  for (let i = 0; i < lines.length; i++) {
    const name = /^#EXTINF:[^,]*,(.+)$/.exec(lines[i])?.[1]
    if (name) listed.push({ name: name.trim(), url: lines[i + 1] })
  }
  const moduleRows = buildChannels()
  assert.deepEqual(listed, moduleRows.map(({ name, url }) => ({ name, url })))
  const group = {
    name: '宁夏',
    dataList: [
      ...moduleRows.map(row => ({ ...row, sourceId: 'xt:ningxia' })),
      ...listed.map(row => ({ ...row, sourceId: 'ext:iptv' })),
    ],
  }
  assert.equal(dedupeAllChannels([group]), 3)
  assert.deepEqual(group.dataList.map(row => row.sourceId), ['xt:ningxia', 'xt:ningxia', 'xt:ningxia'])
  assert.ok(group.dataList.every(row => row.sourceIds.includes('ext:iptv')))
})

console.log(`\n全部通过：${passed} ✅`)
