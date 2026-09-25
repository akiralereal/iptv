import { CHANNEL_BY_REF } from './channels.js'
import { requestPlayUrls, selectWorkingManifest, UPSTREAM_HEADERS } from './api.js'

/**
 * 只缓存官方主备入口，绝不把清单正文按取票 TTL 缓存。
 *
 * 直播媒体清单里只有 3 个分片、每 3 秒滚动一次，缓存正文等于让播放器在整个 TTL 内
 * 反复拿到同一批分片：播完这十几秒就没有下一片，画面直接卡死，且那批分片早已被
 * CDN 回收，重取只会 403。每次解析都实时取清单，并直接交给代理层下发，
 * 避免「选线探测成功后立即再取一次」触发 CDN 403。只合并同频道正在进行的请求。
 *
 * 5 分钟远短于接口自报的 vkey_renew_interval（实测 14400 秒）；但 CDN 仍可能
 * 提前拒绝旧地址，因此每次取清单都能换备用入口，全部失败时提前换票。
 * 相比原先 20 秒又把取票请求降到 1/15，60 路同放也不会打爆官方接口。
 */
export const CACHE_MS = 5 * 60 * 1000

/**
 * 换票后主备 CDN 仍全部 403 = 本机出口正被官方限流。此后该频道 30 秒内直接回失败、
 * 不再打官方：播放器失败后是毫秒级连环重试，每次重试在这里要打 6~8 枪（缓存入口 +
 * 两轮换票 × 主备），只会把限流越拖越久。
 *
 * 30 秒取自共享实例的真实日志（两天 1487 次 403）：同频道相邻两次失败 54% 间隔不到
 * 1 秒，30~60 秒的只占 1%。按日志回放，冷却 5/15/30/60/120 秒分别挡掉 54/59/65/65/66%
 * 的上游请求——30 秒之后再加长几乎不再多挡，只会让官方恢复后观众白等。
 * 只认「全部 403」：超时、版权停播等失败照旧每次实打，不因一次抖动封掉一个台。
 */
export const FORBIDDEN_COOLDOWN_MS = 30 * 1000

export function createResolver({ request = requestPlayUrls, select = selectWorkingManifest } = {}) {
  const cache = new Map()
  const pending = new Map()
  const cooling = new Map()

  function remember(ref, urls, manifest, expiresAt) {
    // 保存取票接口给的入口；CDN 重定向后的临时媒体地址可能很快失效，不能
    // 将它作为未来 5 分钟唯一的取流地址。成功的主/备入口优先尝试。
    const preferred = urls.includes(manifest.sourceUrl) ? manifest.sourceUrl : urls[0]
    cache.set(ref, {
      url: manifest.url,
      urls: [...new Set([preferred, ...urls])],
      expiresAt,
    })
  }

  async function acquire(ref, channel, ctx) {
    let current = pending.get(ref)
    if (current) return current
    current = (async () => {
      let lastError
      const cached = cache.get(ref)
      if (cached && Number(ctx.now ?? Date.now()) < cached.expiresAt) {
        try {
          const manifest = await select(cached.urls, ctx)
          remember(ref, cached.urls, manifest, cached.expiresAt)
          return manifest
        } catch (error) {
          lastError = error
          cache.delete(ref)
        }
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const { urls } = await request(channel, ctx)
          const manifest = await select(urls, ctx)
          remember(ref, urls, manifest, Number(ctx.now ?? Date.now()) + CACHE_MS)
          return manifest
        } catch (error) {
          lastError = error
        }
      }
      throw lastError
    })().finally(() => {
      if (pending.get(ref) === current) pending.delete(ref)
    })
    pending.set(ref, current)
    return current
  }

  async function resolve(ref, ctx = {}) {
    const key = String(ref || '')
    const channel = CHANNEL_BY_REF.get(key)
    if (!channel) return { url: '', desc: '央视频频道引用格式错误' }
    const now = Number(ctx.now ?? Date.now())
    const cooled = cooling.get(key)
    if (cooled && now < cooled.until) {
      const seconds = Math.ceil((cooled.until - now) / 1000)
      return { url: '', desc: `${channel.name}链接请求失败：官方 CDN 刚回 403（疑似限流），冷却中，${seconds} 秒后再向官方请求` }
    }
    cooling.delete(key)
    try {
      const manifest = await acquire(key, channel, ctx)
      // 只返回本次请求刚取回的正文；缓存条目里没有正文，下次轮询会重新拉取。
      return {
        url: manifest.url,
        manifestText: manifest.text,
        manifestUrl: manifest.url,
        upstreamHeaders: UPSTREAM_HEADERS,
        desc: `${channel.name} H.264 播放地址获取成功`,
      }
    } catch (error) {
      // AbortError 的原生文案是英文的 This operation was aborted，直接抛进日志没人看得懂
      const reason = error?.name === 'AbortError' ? '请求超时' : (error?.message || String(error))
      if (error?.allForbidden) {
        cooling.set(key, { until: now + FORBIDDEN_COOLDOWN_MS })
        return { url: '', desc: `${channel.name}链接请求失败：${reason}，${FORBIDDEN_COOLDOWN_MS / 1000} 秒内暂停向官方请求` }
      }
      return { url: '', desc: `${channel.name}链接请求失败：${reason}` }
    }
  }

  function clear() {
    cache.clear()
    pending.clear()
    cooling.clear()
  }

  return { resolve, clear, cache, pending, cooling }
}

const resolver = createResolver()
export const resolveChannel = resolver.resolve
export const clearCache = resolver.clear
