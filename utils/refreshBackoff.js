/**
 * 抓取失败的重试退避（进程内存态）。
 *
 * 背景：内置源 / 外部源的「需要刷新」判定只看「有没有缓存 + 距上次成功多久」，
 * 抓取失败会把缓存清掉，于是一个当前抓不到的源在每个 5 分钟 tick 都会被重抓一次，
 * 每次都要起一个 Chromium、把直播页真的播上几十秒。低配机（NAS / 1~2G 内存）
 * 上这就是「卡死、硬盘不停读写」的主因之一。
 *
 * 这里按连续失败次数指数退避：10 → 20 → 40 → 80 … 分钟，上限取该源自己的
 * 刷新间隔（至少 10 分钟）。成功一次即清零。只存内存：重启后启动模式本来就会
 * 抓一次，无需持久化。
 */
// 退避基数默认 10 分钟。mbackoffBaseMinutes 仅供本地测试压缩周期（如 =0.5），生产不要设
const envBase = parseFloat(process.env.mbackoffBaseMinutes)
const DEFAULT_BASE_MINUTES = envBase > 0 ? envBase : 10

export function backoffMinutes(failCount, refreshMinutes, baseMinutes = DEFAULT_BASE_MINUTES) {
  const count = Math.max(1, Number(failCount) || 1)
  const base = Number(baseMinutes) > 0 ? Number(baseMinutes) : DEFAULT_BASE_MINUTES
  const cap = Math.max(base, Number(refreshMinutes) || 0)
  return Math.min(cap, base * 2 ** (count - 1))
}

export class FailureBackoff {
  constructor({ baseMinutes = DEFAULT_BASE_MINUTES } = {}) {
    this.baseMinutes = baseMinutes
    this.entries = new Map() // id → { count, nextRetryAt, lastError }
  }

  /** 记一次失败，返回 { count, waitMinutes, nextRetryAt } 供日志使用。 */
  record(id, refreshMinutes, { now = Date.now(), error = '' } = {}) {
    const prev = this.entries.get(id)
    const count = (prev?.count || 0) + 1
    const waitMinutes = backoffMinutes(count, refreshMinutes, this.baseMinutes)
    const entry = { count, waitMinutes, nextRetryAt: now + waitMinutes * 60 * 1000, lastError: String(error || '') }
    this.entries.set(id, entry)
    return entry
  }

  clear(id) {
    this.entries.delete(id)
  }

  get(id) {
    return this.entries.get(id) || null
  }

  /** 是否仍在退避窗口内（此时自动刷新应跳过）。 */
  isCooling(id, now = Date.now()) {
    const entry = this.entries.get(id)
    return !!entry && now < entry.nextRetryAt
  }
}
