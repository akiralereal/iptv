#!/usr/bin/env node
/**
 * 写盘守卫回归测试（issue #129「我的频道是空」）
 *
 * 守卫一的原话是「关键源（咪咕）本轮一条频道都没取到，宁可保留现有播放列表也不覆盖」，
 * 但它原来无条件 return false，于是**没有现有播放列表可保**的用户被钉死在零频道：
 * 首次部署时内置源 + 抓取模块抓到三百多条频道，却因为咪咕不通而一个字节都没写出来，
 * 「我的频道」全空、/interface.m3u 吐「获取失败」，每轮刷新重复同一个结局、永不自愈。
 *
 * 这里锁住「到底什么情况下才值得保」这条判定：有该源的频道才保，没有就照常生成；
 * 升级上来、还没有 source-ids 标记的老列表无从判断，保守按「有」处理。
 *
 * 运行： node scripts/test-playlist-write-guard.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'

// updateData 这条 import 链上挂着读盘的单例（外部源 / 抓取模块管理器）；
// 把数据目录指到临时目录再引入，别碰到真实部署的配置
process.env.mdataDir = `${process.env.TMPDIR || '/tmp'}/iptv-test-write-guard-${process.pid}`
process.env.mbuiltInSourcesUrl = ''
const { preservableShortfall, playlistSourceIds } = await import('../utils/updateData.js')

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }

const MIGU = { id: 'migu', name: '咪咕视频', sourceId: 'migu' }
const SZTV = { id: 'sztv', name: '深圳', sourceId: 'xt:sztv' }

/** 一份最小播放列表：每条频道按 updateData 的写法带 source-ids */
const playlist = (...sourceIdLists) => '#EXTM3U\n' + sourceIdLists.map((ids, i) =>
  `#EXTINF:-1 tvg-id="频道${i}" tvg-name="频道${i}" tvg-logo="" source-ids="${ids}" group-title="央视",频道${i}\n` +
  `http://example.com/${i}.m3u8\n`).join('')

console.log('播放列表写盘守卫测试')

check('source-ids 解析：分号分隔、多条频道、去重', () => {
  assert.deepEqual([...playlistSourceIds(playlist('migu', 'ext:abc;migu', 'xt:sztv'))].sort(),
    ['ext:abc', 'migu', 'xt:sztv'])
  assert.deepEqual([...playlistSourceIds('')], [])
  assert.deepEqual([...playlistSourceIds(undefined)], [])
  // 空值不该混进来（source-ids="" 或尾随分号）
  assert.deepEqual([...playlistSourceIds(playlist('', 'migu;'))], ['migu'])
})

check('首次部署（没有 interface.txt）：没有可保的，照常生成', () => {
  assert.deepEqual(preservableShortfall([MIGU], ''), [], '这正是 issue #129：不生成就永远是空列表')
  assert.deepEqual(preservableShortfall([MIGU], '   \n '), [])
  assert.deepEqual(preservableShortfall([MIGU], undefined), [])
})

check('现有列表里有该源的频道：保留，不覆盖（原有保护不变）', () => {
  assert.deepEqual(preservableShortfall([MIGU], playlist('migu', 'ext:abc')), [MIGU])
  // 与其它源并列写在同一条频道上也算
  assert.deepEqual(preservableShortfall([MIGU], playlist('ext:abc;migu')), [MIGU])
})

check('现有列表有标记但不含该源：上一轮也是缺它生成的，照常生成', () => {
  // 咪咕长期不可达的部署（海外 / 软路由分流）：保留只会把播放列表永久冻结，
  // 此后加订阅源、改频道配置触发的重新生成全部被挡
  assert.deepEqual(preservableShortfall([MIGU], playlist('ext:abc', 'xt:sztv')), [])
})

check('多个 critical 源：只保命中的那个，另一个不拦', () => {
  assert.deepEqual(preservableShortfall([MIGU, SZTV], playlist('xt:sztv')), [SZTV])
  assert.deepEqual(preservableShortfall([MIGU, SZTV], playlist('migu', 'xt:sztv')), [MIGU, SZTV])
  assert.deepEqual(preservableShortfall([MIGU, SZTV], playlist('ext:abc')), [])
})

check('老列表（升级上来、无 source-ids 标记）：无从判断，保守保留', () => {
  const legacy = '#EXTM3U\n#EXTINF:-1 tvg-id="CCTV1" group-title="央视",CCTV1\nhttp://example.com/1\n'
  assert.deepEqual(preservableShortfall([MIGU], legacy), [MIGU], '行为与改动前逐字一致')
  assert.deepEqual(preservableShortfall([MIGU, SZTV], legacy), [MIGU, SZTV])
})

console.log(`\n全部通过：${passed}/6 ✅`)
