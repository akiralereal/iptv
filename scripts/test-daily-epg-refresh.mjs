#!/usr/bin/env node
/**
 * 零点后补刷节目单（utils/dailyEpgRefresh.js）。
 *
 * 不少省台只发当天节目单，完整更新又从启动时起算、不对齐零点，零点后最多空 8 小时。
 *
 * 不变量：
 *  1) 按上海时间算零点，与运行机器的时区无关（Docker 默认 UTC）。
 *  2) 下一次触发总落在上海时间 00:10；正好 00:10 时排到明天，不会连跑两次。
 *  3) 今天零点后已经重新生成过节目单就跳过；前一天的不算。
 *  4) 每次按当时的时钟重排，run 抛错也照常排明天。
 *
 * 运行： node scripts/test-daily-epg-refresh.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import {
  DAILY_EPG_REFRESH_MINUTES, epgBuiltToday, msUntilNextShanghaiMinute, scheduleDailyEpgRefresh, shanghaiDayStart,
} from '../utils/dailyEpgRefresh.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

const at = iso => Date.parse(iso)
const MIN = 60 * 1000
const HOUR = 60 * MIN

console.log('零点后补刷节目单')

check('上海零点与机器时区无关：UTC 16:00 前后分属上海两天', () => {
  assert.equal(shanghaiDayStart(at('2026-11-04T07:20:00+08:00')), at('2026-11-04T00:00:00+08:00'))
  assert.equal(shanghaiDayStart(at('2026-11-03T15:59:59Z')), at('2026-11-03T00:00:00+08:00'))
  assert.equal(shanghaiDayStart(at('2026-11-03T16:00:00Z')), at('2026-11-04T00:00:00+08:00'))
  assert.equal(shanghaiDayStart(at('2026-11-04T00:00:00+08:00')), at('2026-11-04T00:00:00+08:00'))
})

check('默认 00:10', () => assert.equal(DAILY_EPG_REFRESH_MINUTES, 10))

check('下一次落在上海 00:10：零点前、零点后、正好那一刻', () => {
  assert.equal(msUntilNextShanghaiMinute(10, at('2026-11-03T23:30:00+08:00')), 40 * MIN)
  assert.equal(msUntilNextShanghaiMinute(10, at('2026-11-04T00:05:00+08:00')), 5 * MIN)
  assert.equal(msUntilNextShanghaiMinute(10, at('2026-11-04T07:20:00+08:00')), 16 * HOUR + 50 * MIN)
  assert.equal(msUntilNextShanghaiMinute(10, at('2026-11-04T00:10:00+08:00')), 24 * HOUR)
})

check('今天 00:10 后生成过才算刷过', () => {
  const now = at('2026-11-04T00:10:00+08:00')
  assert.equal(epgBuiltToday(0, now), false)
  assert.equal(epgBuiltToday(at('2026-11-03T23:59:59+08:00'), now), false)
  // 00:00～00:10 之间生成完的一轮多半是零点前后取的，有的官方接口还回前一天，照样补刷
  assert.equal(epgBuiltToday(at('2026-11-04T00:00:00+08:00'), now), false)
  assert.equal(epgBuiltToday(at('2026-11-04T00:06:00+08:00'), now), false)
  assert.equal(epgBuiltToday(at('2026-11-04T00:10:00+08:00'), now), true)
  // 机器睡过了零点、白天才醒：凌晨那轮 8 小时更新已经刷过
  assert.equal(epgBuiltToday(at('2026-11-04T03:00:00+08:00'), at('2026-11-04T06:00:00+08:00')), true)
})

await checkAsync('按当时时钟逐日重排，run 抛错也照排明天，停止后不再排', async () => {
  let clock = at('2026-11-04T07:20:00+08:00')
  const timers = []
  const setTimer = (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t }
  const clearTimer = t => { t.cleared = true }
  let runs = 0
  const stop = scheduleDailyEpgRefresh(async () => {
    runs++
    if (runs === 1) throw new Error('上游挂了')
  }, { now: () => clock, setTimer, clearTimer })

  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, 16 * HOUR + 50 * MIN)

  // 第一次触发晚了 3 分钟（定时器不准 / 机器卡了），run 抛错
  clock = at('2026-11-05T00:13:00+08:00')
  await timers[0].fn()
  assert.equal(runs, 1)
  assert.equal(timers.length, 2, 'run 抛错后照样排了明天')
  assert.equal(timers[1].ms, 23 * HOUR + 57 * MIN, '按当时的时钟算，落回 00:10')

  clock = at('2026-11-06T00:10:00+08:00')
  await timers[1].fn()
  assert.equal(runs, 2)
  assert.equal(timers[2].ms, 24 * HOUR)

  stop()
  assert.equal(timers[2].cleared, true)
  await timers[2].fn()
  assert.equal(timers.length, 3, '停止后即使旧定时器回调还在跑也不再排')
})

console.log(`\n${passed} 项通过`)
