// 完整更新间隔（「节目单更新间隔」，单位小时）的取值校验。
//
// 后台输入框、保存接口和环境变量 mupdateInterval 以前都不校验，app.js 直接
// setInterval(fn, parseInt(值) 小时)。填了 0、0.5、负数、非数字，或者超过 596 小时
// （毫秒数超出 32 位），Node 都会把间隔改成 1 毫秒：完整更新每毫秒并发跑一次，日志被
// 「准备更新文件」刷屏，咪咕接口也被狂刷（issue #246）。

export const DEFAULT_UPDATE_INTERVAL_HOURS = 8
// 上限取 7 天：再往上也没意义，每天 00:10 的零点补刷照常会跑（utils/dailyEpgRefresh.js）；
// 而且离 Node 定时器上限（约 596 小时）够远
export const MAX_UPDATE_INTERVAL_HOURS = 168

/**
 * 把配置里的间隔解析成能直接交给 setInterval 的小时数。
 * 填错（不是数字、小于 1）按默认 8 小时，超过上限按上限，小数向下取整。
 * warning 不为空时说明这次没按配置值走，调用方打一行日志。
 */
export function resolveUpdateIntervalHours(raw) {
  const value = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim())
  if (!Number.isFinite(value) || value < 1) {
    return {
      hours: DEFAULT_UPDATE_INTERVAL_HOURS,
      warning: `节目单更新间隔「${raw}」无效（要填 1～${MAX_UPDATE_INTERVAL_HOURS} 小时），已按 ${DEFAULT_UPDATE_INTERVAL_HOURS} 小时更新；请到后台「设置 → 系统配置」改正`,
    }
  }
  if (value > MAX_UPDATE_INTERVAL_HOURS) {
    return {
      hours: MAX_UPDATE_INTERVAL_HOURS,
      warning: `节目单更新间隔「${raw}」超过上限，已按 ${MAX_UPDATE_INTERVAL_HOURS} 小时更新`,
    }
  }
  return { hours: Math.floor(value), warning: null }
}
