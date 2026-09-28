#!/usr/bin/env node
/**
 * 澳门莲花卫视官方节目单回归测试：周标签对日期、结束时间推算、跨周返回空、格式异常报错、频道 ref 对齐。
 * 全部离线；样本按 2026-09-25 官网「節目單」页的真实结构裁剪（本周 09-21 一 … 09-27 日）。
 *
 * 运行： node scripts/test-lotustv-epg.mjs
 *       TZ=UTC node scripts/test-lotustv-epg.mjs
 */
import assert from 'node:assert/strict'

import lotustvEpg, { EPG_PAGE, dayInfo, parseProgrammes } from '../extractors/lotustv/epg.js'
import { CHANNEL } from '../extractors/lotustv/channels.js'
import { getModule } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }
const sh = text => Date.parse(`${text.replace(' ', 'T')}+08:00`)

const item = (time, a, b) => `
                <div class="item">
                  <p class="time">${time}</p>
                  <p class="name">
                    <span>${a}</span>
                    ${b == null ? '' : `<span>${b}\n</span>`}
                  </p>
                </div>`
const WEEK = [21, 22, 23, 24, 25, 26, 27]
const NAMES = ['一', '二', '三', '四', '五', '六', '日']
const DAYS = [
  [item('01:07', '經典影院', '拳王阿里'), item('22:24', '經典影院', '現金')],
  [item('00:17', '經典影院', '狙擊職業殺手')],
  [item('00:58', '經典影院', '局內人')],
  [item('00:02', '經典影院', '天馬')],
  // 09-25：故意乱序、含同一时刻重复、第二段为空、HTML 实体
  [item('02:55', '經典影院', '空中監獄'), item('00:56', '經典影院', '非常時期'), item('02:55', '經典影院', '空中監獄'),
    item('21:45', '《Music Bridge Macau》', '第七十二期'), item('20:00', '蓮花新聞', ''), item('22:04', '經典影院', '獵殺紅色十月 &amp; 續')],
  [item('00:25', '經典影院', '電子情書')],
  [item('23:10', '經典影院', '布魯克斯先生')],
]
const page = (week = WEEK, days = DAYS) => `<html><body><div class="programme-body">
        <div class="weekday" id="weekdayTab">
${week.map((d, i) => `          <p data-id="${i}" class="${i === 4 ? 'active' : ''}">\n            <span>${d}</span>\n            <span>${NAMES[i]}</span>\n          </p>`).join('\n')}
        </div>
${days.map((rows, i) => `                    <div data-id="${i}" class="programme-content ${i === 4 ? 'active' : ''}">
                          <div class="programme-view">${rows.join('')}
                              </div>
                      </div>`).join('\n')}
</div></body></html>`

console.log('澳门莲花卫视节目单测试')

check('模块挂上节目单，频道 ref 与取流一致', () => {
  const module = getModule('lotustv')
  assert.equal(module.epg, lotustvEpg)
  assert.equal(module.capabilities.epg, true)
  assert.deepEqual(lotustvEpg.channels(), [{ ref: CHANNEL.ref, name: '澳门莲花卫视', key: 'lotustv' }])
  assert.equal(module.claimsRef(CHANNEL.ref), true)
})

check('上海日期换算到周内序号与本周一日号，跨月也对', () => {
  assert.deepEqual(dayInfo('20260925'), { start: sh('2026-09-25 00:00'), end: sh('2026-09-26 00:00'), weekday: 4, monday: 21 })
  assert.equal(dayInfo('20260927').weekday, 6)
  assert.equal(dayInfo('20261001').monday, 28)
  assert.throws(() => dayInfo('20260231'))
  assert.throws(() => dayInfo('2026-09-25'))
})

check('按开始时间排序去重，结束取下一档，末档接次日首档', () => {
  const items = parseProgrammes(page(), '20260925')
  assert.deepEqual(items, [
    { title: '經典影院 非常時期', start: sh('2026-09-25 00:56'), stop: sh('2026-09-25 02:55') },
    { title: '經典影院 空中監獄', start: sh('2026-09-25 02:55'), stop: sh('2026-09-25 20:00') },
    { title: '蓮花新聞', start: sh('2026-09-25 20:00'), stop: sh('2026-09-25 21:45') },
    { title: '《Music Bridge Macau》 第七十二期', start: sh('2026-09-25 21:45'), stop: sh('2026-09-25 22:04') },
    { title: '經典影院 獵殺紅色十月 & 續', start: sh('2026-09-25 22:04'), stop: sh('2026-09-26 00:25') },
  ])
})

check('周日末档到 24:00；不在本页这一周的日子返回空数组', () => {
  assert.deepEqual(parseProgrammes(page(), '20260927'),
    [{ title: '經典影院 布魯克斯先生', start: sh('2026-09-27 23:10'), stop: sh('2026-09-28 00:00') }])
  assert.deepEqual(parseProgrammes(page(), '20260928'), [])
  assert.deepEqual(parseProgrammes(page(), '20260918'), [])
})

check('改版或空页报错，不当成「当天没发」', () => {
  assert.throws(() => parseProgrammes('<html>maintenance</html>', '20260925'), /格式异常/)
  assert.throws(() => parseProgrammes(page(WEEK.slice(0, 6)), '20260925'), /格式异常/)
  assert.throws(() => parseProgrammes(page(WEEK, DAYS.map(() => [])), '20260925'), /格式异常/)
})

await checkAsync('请求官网节目单页，HTTP 错误抛出、参数非法拒绝', async () => {
  let seen
  const items = await lotustvEpg.programmes('lotustv', '20260925', {
    fetchImpl: async (url, init) => { seen = { url, init }; return new Response(page()) },
  })
  assert.equal(seen.url, EPG_PAGE)
  assert.equal(seen.init.redirect, 'manual')
  assert.equal(items.length, 5)
  await assert.rejects(lotustvEpg.programmes('lotustv', '20260925', { fetchImpl: async () => new Response('x', { status: 503 }) }), /HTTP 503/)
  await assert.rejects(lotustvEpg.programmes('other', '20260925', { fetchImpl: async () => new Response(page()) }), /参数非法/)
})

console.log(`\n全部通过：${passed} ✅`)
