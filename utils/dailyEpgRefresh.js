// 零点后补刷节目单。
//
// 不少省台官方只发当天的节目单（江苏、河南、海南、青岛、南通、宁夏、陕西、深圳……，见 EPG.md），
// 而完整更新默认 8 小时一次、从服务启动时起算，不对齐零点。零点后到下一轮之前，这些台在播放器里
// 一整段都是空的（2026-11-04 07:20 作者实例 37 个频道只有前一天的节目），用户看到的就是
// 「节目单经常更新失败」。所以每天北京时间零点过一点额外跑一次完整更新——体育「昨天/今天/明天」
// 分组也是按更新那一刻的日期标的，同一轮一起翻过来。
//
// 按上海时间算，与运行机器（Docker 默认 UTC）的时区无关：节目单的日期本来就是上海日期。

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

// 00:10：给官方接口留几分钟换日，零点整去取，有的还回前一天
export const DAILY_EPG_REFRESH_MINUTES = 10

/** 上海时间当天 00:00 的毫秒时间戳。 */
export function shanghaiDayStart(now = Date.now()) {
  const local = Number(now) + SHANGHAI_OFFSET_MS
  return local - (((local % DAY_MS) + DAY_MS) % DAY_MS) - SHANGHAI_OFFSET_MS
}

/** 距下一个上海时间「当天第 minutes 分钟」还有多少毫秒；正好在那一刻算到明天。 */
export function msUntilNextShanghaiMinute(minutes, now = Date.now()) {
  const target = shanghaiDayStart(now) + minutes * 60 * 1000
  return target > now ? target - now : target + DAY_MS - now
}

/**
 * 今天 00:10 之后已经重新生成过节目单（启动、8 小时那一轮、后台手动刷新都算）就不必再跑。
 * 门槛是 00:10 不是 00:00：00:00～00:10 之间生成完的那一轮，节目单多半是零点前或刚过零点取的，
 * 正是上面说的「有的还回前一天」。
 */
export function epgBuiltToday(lastBuiltAt, now = Date.now(), minutes = DAILY_EPG_REFRESH_MINUTES) {
  return Number(lastBuiltAt) >= shanghaiDayStart(now) + minutes * 60 * 1000
}

/**
 * 每天上海时间 minutes 分钟时执行一次 run。每次都按当时的时钟重新算下一次，
 * 不用 24 小时的 setInterval：机器睡眠、改时间之后照样落在零点后。
 *
 * @returns {() => void} 停止
 */
export function scheduleDailyEpgRefresh(run, {
  minutes = DAILY_EPG_REFRESH_MINUTES,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let timer = null
  let stopped = false
  const arm = () => {
    if (stopped) return
    timer = setTimer(async () => {
      try {
        await run()
      } catch {
        // run 自己打日志；这里只保证明天照常排上
      }
      arm()
    }, msUntilNextShanghaiMinute(minutes, now()))
    timer?.unref?.()
  }
  arm()
  return () => {
    stopped = true
    if (timer) clearTimer(timer)
  }
}
