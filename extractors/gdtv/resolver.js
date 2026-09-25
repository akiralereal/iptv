/**
 * 广东台短效地址缓存：45 秒后台换票，90 秒硬边界，避免触及实测约两分钟失效点。
 * 自带过期时刻的地址（纪录片的 auth_key，30 分钟）按它自己的有效期换，不必每 45 秒开一次官网页。
 */
import { CHANNEL_BY_ID, channelIdFromRef } from './channels.js'
import { browserSession, isOfficialStreamUrl, streamExpiresAt } from './session.js'

export const STREAM_REFRESH_MS = 45 * 1000
export const STREAM_HARD_TTL_MS = 90 * 1000
export const STREAM_RETRY_MS = 10 * 1000
// 带过期时刻的地址：离过期 5 分钟后台换、2 分钟硬边界。有效期按本机时钟算，最多信 30 分钟
// （官网签发就是 30 分钟），本机时钟慢了也不会拖过真实失效点；算下来不足 10 分钟就按短效票处理。
const EXPIRING_MAX_LIFETIME_MS = 30 * 60 * 1000
const EXPIRING_MIN_LIFETIME_MS = 10 * 60 * 1000
const EXPIRING_REFRESH_LEAD_MS = 5 * 60 * 1000
const EXPIRING_HARD_LEAD_MS = 2 * 60 * 1000

/** 取到地址时刻 → 何时后台换票、何时必须等新票。 */
export function streamSchedule(url, acquiredAt) {
  const expiresAt = streamExpiresAt(url)
  const lifetime = Math.min(expiresAt - acquiredAt, EXPIRING_MAX_LIFETIME_MS)
  if (expiresAt && lifetime >= EXPIRING_MIN_LIFETIME_MS) {
    return {
      refreshAt: acquiredAt + lifetime - EXPIRING_REFRESH_LEAD_MS,
      hardExpiresAt: acquiredAt + lifetime - EXPIRING_HARD_LEAD_MS,
    }
  }
  return { refreshAt: acquiredAt + STREAM_REFRESH_MS, hardExpiresAt: acquiredAt + STREAM_HARD_TTL_MS }
}

export function createResolver({
  capture = (channelId, options) => browserSession.capture(channelId, options),
  close = () => browserSession.close(),
} = {}) {
  const cache = new Map()
  const pending = new Map()
  let generation = 0

  function startRefresh(channelId, options = {}) {
    let current = pending.get(channelId)
    if (current) return current
    const startedInGeneration = generation

    current = Promise.resolve()
      .then(() => capture(channelId, options))
      .then(url => {
        if (startedInGeneration !== generation) throw new Error('广东台续签任务已取消')
        if (!isOfficialStreamUrl(url)) throw new Error('官网没有返回有效的广东台 HLS 地址')
        const acquiredAt = Number(options.now ?? Date.now())
        const entry = {
          url,
          ...streamSchedule(url, acquiredAt),
          retryAt: 0,
          lastError: '',
        }
        cache.set(channelId, entry)
        return entry
      })
      .catch(error => {
        const old = cache.get(channelId)
        if (old) {
          old.retryAt = Number(options.now ?? Date.now()) + STREAM_RETRY_MS
          old.lastError = error?.message || String(error)
        }
        throw error
      })
      .finally(() => {
        if (pending.get(channelId) === current) pending.delete(channelId)
      })
    pending.set(channelId, current)
    return current
  }

  async function resolve(ref, ctx = {}) {
    const channelId = channelIdFromRef(ref)
    if (!channelId) return { url: '', desc: '广东台频道引用格式错误' }

    const now = Number(ctx.now ?? Date.now())
    let entry = cache.get(channelId)
    try {
      if (!entry) {
        entry = await startRefresh(channelId, { timeoutMs: ctx.timeoutMs, now: ctx.now })
      } else if (now >= entry.hardExpiresAt) {
        // 到达硬边界后不能再因失败退避继续下发旧票；本次必须等换票结果。
        entry = await startRefresh(channelId, { timeoutMs: ctx.timeoutMs, now: ctx.now })
      } else if (now >= entry.refreshAt && now >= entry.retryAt) {
        const refresh = startRefresh(channelId, { timeoutMs: ctx.timeoutMs, now: ctx.now })
        refresh.catch(() => {}) // 旧票尚在安全窗口内：后台换票，不阻塞播放器轮询。
      }

      return {
        url: entry.url,
        desc: entry.lastError
          ? `${CHANNEL_BY_ID.get(channelId).name}续签暂时失败，沿用安全窗口内的地址`
          : `${CHANNEL_BY_ID.get(channelId).name}短效播放地址获取成功`,
        // 旧的无 /relay/ 地址也必须进入清单中继，否则一次 302 后就失去自动续签。
        relayHls: true,
      }
    } catch (error) {
      return { url: '', desc: `广东台链接请求失败：${error?.message || String(error)}` }
    }
  }

  function clear() {
    generation++
    cache.clear()
    pending.clear()
    // 管理器的清缓存接口是同步契约；关闭动作自行收尾且内部已有异常兜底。
    Promise.resolve(close()).catch(() => {})
  }

  return { resolve, clear, cache, pending }
}

const resolver = createResolver()

export const resolveChannel = resolver.resolve
export const clearCache = resolver.clear
