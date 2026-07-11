#!/usr/bin/env node
/**
 * m3u #EXTINF 频道名解析回归测试（issue #84）
 *
 * 不变量（parsePlaylistContent → parseM3uContent）：
 *  - 频道显示名取「最后一个属性引号之后的逗号」之后的部分，属性（tvg-* / group-title）
 *    无论写在逗号前还是逗号后都不会被吞进名字；
 *  - 干净的名字才能安全回填进 tvg-id="..."，否则名字里的引号/逗号会破坏服务端生成的
 *    EXTINF 整行语法，导致该频道播放异常；
 *  - URL 原样保留（不做任何实体解码，&timestamp 不得变成 ×tamp）。
 *
 * 触发场景：有的源把 group-title 写在逗号之后
 *   #EXTINF:-1 tvg-id="X" tvg-logo="...",group-title="央视",CCTV1综合
 * 旧的「取第一个逗号之后」会把 group-title="央视" 一并当成名字——本测试守住修复。
 *
 * 运行： node scripts/test-m3u-parse.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { parsePlaylistContent } from '../utils/externalSources.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('m3u #EXTINF 频道名解析回归测试 (issue #84)')

check('group-title 写在逗号之后：名字不吞属性、分组正确（修复点）', () => {
  const m3u = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="CCTV1综合" tvg-name="CCTV1综合" tvg-logo="http://h/x.webp",group-title="央视",CCTV1综合',
    'http://gslbmgsplive.miguvideo.com/x.m3u8?pid=2028597139&timestamp=20260710&SecurityKey=1',
  ].join('\n')
  const [ch] = parsePlaylistContent(m3u)
  assert.equal(ch.name, 'CCTV1综合')          // 不是 'group-title="央视",CCTV1综合'
  assert.equal(ch.group, '央视')
  assert.equal(ch.logo, 'http://h/x.webp')
  assert.ok(!ch.name.includes('group-title='), '名字不得含属性碎片')
  assert.ok(!ch.name.includes('"'), '名字不得含裸引号（否则破坏 tvg-id="..."）')
})

check('标准写法：group-title 在逗号之前照常解析', () => {
  const m3u = '#EXTINF:-1 tvg-id="a" tvg-logo="l" group-title="央视",CCTV1综合\nhttp://h/a.m3u8'
  const [ch] = parsePlaylistContent(m3u)
  assert.equal(ch.name, 'CCTV1综合')
  assert.equal(ch.group, '央视')
})

check('无任何属性：名字取第一个逗号之后', () => {
  const [ch] = parsePlaylistContent('#EXTINF:-1,湖南卫视\nhttp://h/b.m3u8')
  assert.equal(ch.name, '湖南卫视')
})

check('名字自身含逗号：属性之后整段都算名字', () => {
  const [ch] = parsePlaylistContent('#EXTINF:-1 group-title="电影",Movie, HD\nhttp://h/c.m3u8')
  assert.equal(ch.name, 'Movie, HD')
  assert.equal(ch.group, '电影')
})

check('URL 原样保留：&timestamp 不被改写成 ×tamp', () => {
  const url = 'http://h/x.m3u8?pid=2028597139&timestamp=20260710&lt=2&notin=x'
  const [ch] = parsePlaylistContent(`#EXTINF:-1 group-title="央视",CCTV1综合\n${url}`)
  assert.equal(ch.url, url)
})

console.log(`\n全部通过：${passed}/5 ✅`)
