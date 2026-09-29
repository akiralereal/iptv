#!/usr/bin/env node
/**
 * 泉州官方节目单回归测试：按完整日期标签取当天、末档跨零点、重叠截断、没有这天返回空、
 * 人机验证与改版报错、主入口失败依次走备用入口、两路频道各取自己的播放页。样本按 2026-09-25 官网播放页的真实结构裁剪。
 *
 * 运行： node scripts/test-quanzhou-minnan-epg.mjs
 *       TZ=UTC node scripts/test-quanzhou-minnan-epg.mjs
 */
import assert from 'node:assert/strict'

import quanzhouEpg, { dayInfo, epgPages, parseProgrammes } from '../extractors/quanzhou-minnan/epg.js'
import { buildChannels } from '../extractors/quanzhou-minnan/api.js'
import { getModule } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }
const sh = text => Date.parse(`${text.replace(' ', 'T')}+08:00`)

const li = (time, title) => `
                                   <li >
                    <a href="/index/Medias/index/media_id/x/video_id/1/stream_name/mny">
                      <div class="time" style="width:80px;">${time}</div>
                      <div class="state">正在播出...</div>
                      <div class="program">${title}</div>
                    </a>
                  </li>`
const page = days => `<html><body><div class="z-tabs-nav">
${Object.keys(days).map(date => `                    <div class="z-tabs-tab pa-l pa-r ">
                      <div id="day">${date}</div>
                      <div class="week">星期</div>
                    </div>`).join('\n')}
</div><div class="z-tabs-content">
${Object.values(days).map(rows => `               <div class="z-tabs-pane ">\n                <ul class="play-list2">${rows.join('')}</ul></div>`).join('\n')}
               <div class="z-tabs-pane "></div>
</div></body></html>`
const SAMPLE = page({
  '2026-09-24': [li('00:40-01:10', '新闻相拍报'), li('23:51-00:40', '泉州讲古')],
  // 09-25：故意乱序、含同一时刻重复、一条越过下一条开始、HTML 实体
  '2026-09-25': [li('00:25-00:40', '泉城搜go'), li('00:10-00:25', '养生之道'), li('00:10-00:25', '养生之道'),
    li('22:47-23:25', '新闻相拍报'), li('23:20-23:50', '泉州第一炮'), li('23:50-00:10', '泉州美食 &amp; 小吃')],
})

console.log('泉州节目单测试')

check('模块挂上节目单，频道 ref 与取流一致', () => {
  const module = getModule('quanzhou-minnan')
  assert.equal(module.epg, quanzhouEpg)
  assert.equal(module.capabilities.epg, true)
  assert.deepEqual(quanzhouEpg.channels(), [
    { ref: 'quanzhou-news-tv', name: '泉州新闻综合', key: 'news' },
    { ref: 'quanzhou-minnan-tv', name: '泉州闽南语', key: 'mny' },
  ])
  assert.deepEqual(quanzhouEpg.channels().map(c => [c.ref, c.name]), buildChannels().map(c => [c.deferredRef, c.name]))
  assert.equal(quanzhouEpg.days, 1)
})

check('上海日期换算与标签日期格式一致', () => {
  assert.deepEqual(dayInfo('20260925'), { date: '2026-09-25', start: sh('2026-09-25 00:00'), end: sh('2026-09-26 00:00') })
  assert.throws(() => dayInfo('20260931'))
})

check('按日期标签取当天：排序去重、重叠截到下一档、末档跨零点', () => {
  assert.deepEqual(parseProgrammes(SAMPLE, '20260925'), [
    { title: '养生之道', start: sh('2026-09-25 00:10'), stop: sh('2026-09-25 00:25') },
    { title: '泉城搜go', start: sh('2026-09-25 00:25'), stop: sh('2026-09-25 00:40') },
    { title: '新闻相拍报', start: sh('2026-09-25 22:47'), stop: sh('2026-09-25 23:20') },
    { title: '泉州第一炮', start: sh('2026-09-25 23:20'), stop: sh('2026-09-25 23:50') },
    { title: '泉州美食 & 小吃', start: sh('2026-09-25 23:50'), stop: sh('2026-09-26 00:10') },
  ])
  assert.equal(parseProgrammes(SAMPLE, '20260924').at(-1).stop, sh('2026-09-25 00:40'))
})

check('页面没有这一天（明天）返回空；人机验证与改版报错', () => {
  assert.deepEqual(parseProgrammes(SAMPLE, '20260926'), [])
  assert.throws(() => parseProgrammes('<meta name="aliyun_waf_aa">', '20260925'), /人机验证/)
  assert.throws(() => parseProgrammes('<html>改版</html>', '20260925'), /格式异常/)
  assert.throws(() => parseProgrammes(SAMPLE.replace(/class="time"/g, 'class="t"'), '20260925'), /格式异常/)
})

check('每路频道按 wxqz2、www、control-center 的顺序取自己的播放页', () => {
  const media = { news: 'wq95wqbDnMKyd8KiwqzChnt0w5nChcKowoHCoQ', mny: 'wq95wqbDnMKyd8KiwqzChnt0w5nChcKofcKh' }
  for (const key of ['news', 'mny']) {
    assert.deepEqual(epgPages(key), ['wxqz2', 'www', 'control-center'].map(host =>
      `https://${host}.qztv.cn/index/Medias/index/media_id/${media[key]}/stream_name/${key}.html`))
  }
  assert.throws(() => epgPages('other'), /参数非法/)
})

await checkAsync('前面的入口被拦时依次走备用入口；全部失败才抛错', async () => {
  const calls = []
  const pages = epgPages('news')
  const items = await quanzhouEpg.programmes('news', '20260925', {
    fetchImpl: async url => {
      calls.push(url)
      return url === pages[2] ? new Response(SAMPLE) : new Response('<meta name="aliyun_waf_aa">')
    },
  })
  assert.deepEqual(calls, pages)
  assert.equal(items.length, 5)
  await assert.rejects(quanzhouEpg.programmes('mny', '20260925', { fetchImpl: async () => new Response('x', { status: 502 }) }), /HTTP 502/)
  await assert.rejects(quanzhouEpg.programmes('other', '20260925', { fetchImpl: async () => new Response(SAMPLE) }), /参数非法/)
})

console.log(`\n全部通过：${passed} ✅`)
